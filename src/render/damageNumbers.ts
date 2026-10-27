/**
 * Damage numbers: the read half of `Ev.Damage` (DESIGN.md "Motion").
 *
 * A hundred and twenty-eight floating numbers, each one a DOM node that lives 0.6 s, rises 0.6 m
 * and fades out, pinned to the point on the floor where the hit landed. They are DOM rather than
 * canvas text for the reason the design brief gives: the type has to stay crisp at any resolution
 * scale, and a 1,000-body frame is already asking a lot of the draw path.
 *
 * Three things keep this a read-only layer:
 *
 * - It never writes a game value. It reads the event ring through its own cursor (the ring is a
 *   broadcast; see `EventRing`) and the numbers come from the events, not from the pools, so a
 *   number says what the hit paid rather than what the body has left.
 * - The pool is fixed and the elements are built up front, so a heavy horde spends numbers, never
 *   nodes: a hit with no free slot and no neighbour to merge into is dropped, and counted.
 * - Neighbours merge. DESIGN.md asks for that by name ("numbers merge under a heavy horde so they
 *   never pile up into clutter"), and a merge is a sum into a live number near the same point,
 *   which is also what keeps a shotgun's eight pellets reading as one event.
 *
 * The pool's size and the reach of that merge are one decision, not two, and they were wrong
 * together. A number holds its slot for `NUMBER_LIFE`, so sixty-four slots clear about one number
 * every thirty-odd frames at 60 Hz: a sweep that wanted forty labels got one. And while the
 * merge was wider than a body, a number spent its whole life as a magnet for everything nearby, so
 * that sweep read as one label saying "280" in the middle of a pack — which says nothing about the
 * forty hits it swallowed. Hence a pool that can hold a volley and the sweep after it, and a merge
 * that folds up one event rather than one neighbourhood.
 *
 * The plate is what makes them readable. Every number sits on a dark Void tab at DESIGN.md's
 * panel alpha with a 1px hairline around it, and that tab replaces the `text-shadow` blur this
 * layer used to carry. Two reasons for the swap. The brief keeps CSS glow and blur stacks off the
 * playfield ("Avoid"), and a blur is not separation over a bloomed explosion anyway — the shadow
 * is the same dark as the halo it is meant to escape. A plate is separation, because it holds its
 * contrast whether the floor behind it is a fireball or unlit concrete, and it costs the
 * compositor a small quad instead of a blur pass.
 *
 * The styling is inline rather than a class in `src/ui/styles.css` because this file lives on the
 * render side of the render/ui line and must not reach across it for a stylesheet (ARCHITECTURE.md
 * "Hard rules"): one element, two colours and two sizes is not worth a dependency between the
 * layers. It is written once per slot when the pool is built, so a busy frame still spends one
 * transform and one opacity per live number, plate or no plate.
 *
 * Like the rest of `render`, this is optional and guarded: with no host element — a headless run,
 * a unit test, a page without an overlay — it builds a layer that does nothing but count.
 */

import { Vector3, type Camera } from 'three/webgpu';

import { Ev, type World } from '../sim/world';

/** How long a number lives, in seconds (DESIGN.md: "fade over 600 ms"). */
export const NUMBER_LIFE = 0.6;

/** How far it rises over that life, in metres (DESIGN.md: "float up 0.6 m"). */
export const NUMBER_RISE = 0.6;

/**
 * The pool's size: `ARCHITECTURE.md`'s "damage numbers 128".
 *
 * Sized by turnover, not by taste. A number lives `NUMBER_LIFE` (0.6 s, 36 frames), so the pool
 * only clears `cap / 36` numbers a frame however busy the frame is: sixty-four was one every
 * thirty-odd frames, and a shotgun's eight pellets spent the lot. A hundred and twenty-eight clears
 * three and a half a frame — over two hundred labels a second — and still costs one fixed pass over
 * the slots per hit rather than anything that grows with the crowd.
 */
export const NUMBER_CAP = 128;

/**
 * Numbers a single rendered frame may start, whatever the tick's event ring says.
 *
 * A quarter of the pool, and counted in numbers rather than hits (see `readNumberEvents`): it
 * exists to keep one enormous frame from spending the layer on its first millisecond, not to
 * ration a volley that would have merged anyway.
 */
export const NUMBER_BUDGET = NUMBER_CAP >> 2;

/**
 * How close a hit has to land to join a number already on the way up, in metres.
 *
 * About one body width, and that is the unit: the horde's bodies are 0.24–0.68 m in radius and
 * keep some 0.7 m of separation from each other, so a hit inside this radius is the same body hit
 * twice or two bodies touching, while two bodies that stand apart stay two facts. It is also under
 * a tenth of the floor the camera covers, so numbers that do not merge still do not print on top of
 * each other.
 */
export const MERGE_RADIUS = 0.7;

/**
 * How long a number stays a merge target, in seconds of its own life.
 *
 * The other half of the rule, and the one that decides what a merge *means*: "these hits are one
 * event", not "this patch of floor has a number". Two 60 ms beats (DESIGN.md's hit flash) is long
 * enough for a volley to land — pellets fan out, so a shotgun's eight arrive spread over a few
 * frames — and short enough that the next fight at the same spot gets its own label instead of
 * feeding a number that has been rising since the first one.
 */
export const MERGE_WINDOW = 0.12;

/** What a number's height above its point is when it starts, in metres. */
const START_HEIGHT = 1.05;

/** A number this old has nothing left to say and stops costing a DOM write. */
const FADE_OUT = 0.18;

/** Where a number's text stops being worth redrawing, in HP. */
const MERGE_LIMIT = 9999;

/**
 * The plate's fill: Void at the alpha DESIGN.md gives a UI panel (`#0B0D14` at 72%).
 *
 * Not fully opaque, because a plate that hides the floor hides the thing the number is about: a
 * merge over a chokepoint still has to show the bodies it counted. At 72% the brightest thing a
 * number ever sits on — a white-hot bloom core behind the tab — still leaves better than 5:1
 * between the glyphs and the tab's own fill.
 */
const PLATE = 'rgba(11,13,20,0.72)';

/**
 * The plate's hairline: Alien Cyan, the palette's UI hairline, at a quarter of its strength.
 *
 * The line is not decoration. Over unlit concrete the fill alone has almost no contrast with the
 * floor, so the tab's edge — and with it the question "is this one number or three" — would go
 * with it. One colour for every tab, deliberately: the crit is already bigger and Hazard yellow,
 * and a rim that only changes hue says nothing a person can read off a moving crowd.
 */
const HAIRLINE = 'rgba(46,242,255,0.28)';

/** The plate's box: 1px of line, 3px of air, 2px of rounding. Written once per slot, never per frame. */
const PLATE_CSS = `padding:1px 3px;background:${PLATE};border:1px solid ${HAIRLINE};border-radius:2px;`;

/** The layer's state, one slot per number. Fixed-size, and never reallocated. */
export interface NumberPool {
  readonly cap: number;
  /** Where it grew from, in world coordinates. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** How far above that point it has got, in metres. */
  readonly h: Float32Array;
  /** Seconds of life left; at or below zero the slot is free. */
  readonly life: Float32Array;
  /** The HP it shows. */
  readonly amount: Int32Array;
  /** Whether the crit roll paid off, which is the bigger, yellow number. */
  readonly crit: Uint8Array;
  /** Live slots, counted as they are taken and spent. */
  count: number;
  /** This frame's cursor into the event ring, as an absolute event index. */
  read: number;
  /** Numbers dropped because the pool was full and nothing nearby would take them. */
  dropped: number;
}

export function createNumberPool(cap: number = NUMBER_CAP): NumberPool {
  return {
    cap,
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    h: new Float32Array(cap),
    life: new Float32Array(cap),
    amount: new Int32Array(cap),
    crit: new Uint8Array(cap),
    count: 0,
    read: 0,
    dropped: 0,
  };
}

/**
 * Spend one tick's worth of life and let every number rise.
 *
 * The rise is linear and the fade is not, which is the shape of the thing: a number should be
 * at full strength while it is readable and then go, rather than dimming out of legibility a
 * third of the way in.
 */
export function advanceNumbers(pool: NumberPool, dt: number): void {
  if (dt <= 0) return;
  for (let i = 0; i < pool.cap; i++) {
    const left = pool.life[i];
    if (left <= 0) continue;
    const next = left - dt;
    if (next <= 0) {
      pool.life[i] = 0;
      pool.count--;
      continue;
    }
    pool.life[i] = next;
    pool.h[i] += (NUMBER_RISE * dt) / NUMBER_LIFE;
  }
}

/**
 * Put one number in the pool, or add to one that is already on its way up.
 *
 * A hit joins a number when that number is still inside its own volley — younger than
 * `MERGE_WINDOW` — and closer than `MERGE_RADIUS`. Both halves are needed: the radius alone makes
 * every number in a crowd into a drain for the hits around it, and the window alone makes
 * everything within reach of one point into one number.
 *
 * Returns false when the pool is full and no live number will take the hit: the hit still happened
 * and is still counted in the score, it just did not get a label.
 */
export function pushNumber(pool: NumberPool, x: number, y: number, amount: number, crit: boolean): boolean {
  if (amount <= 0) return false;

  // A number is a merge target while its life is above this, which is its age measured from the
  // other end: `life` is what the pool already keeps, so the window costs no second array.
  const fresh = NUMBER_LIFE - MERGE_WINDOW;
  // The merge search doubles as the free-slot search, so a full pool costs one pass.
  let free = -1;
  let near = -1;
  let best = MERGE_RADIUS * MERGE_RADIUS;
  for (let i = 0; i < pool.cap; i++) {
    if (pool.life[i] <= 0) {
      if (free < 0) free = i;
      continue;
    }
    if (pool.life[i] <= fresh) continue;
    const dx = pool.x[i] - x;
    const dy = pool.y[i] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best && pool.amount[i] + amount <= MERGE_LIMIT) {
      best = d2;
      near = i;
    }
  }

  if (near >= 0) {
    pool.amount[near] += amount;
    if (crit) pool.crit[near] = 1;
    return true;
  }
  if (free < 0) {
    pool.dropped++;
    return false;
  }

  pool.x[free] = x;
  pool.y[free] = y;
  pool.h[free] = START_HEIGHT;
  pool.life[free] = NUMBER_LIFE;
  pool.amount[free] = amount;
  pool.crit[free] = crit ? 1 : 0;
  pool.count++;
  return true;
}

/**
 * Drain this frame's share of the event ring into the pool.
 *
 * The cursor is the layer's own: the ring is a broadcast that nothing drains, so the particle
 * field and audio each keep a place in `written` and this is a third one. Events the ring has
 * already overwritten are counted, not guessed at, and the per-frame budget is what keeps a
 * twelve-barrel frame from spending the whole pool on its first millisecond.
 *
 * The budget is counted in numbers, not in hits, which is the only honest unit: a merged hit costs
 * the frame nothing to draw, so charging it would make the merge rule ration the hits that needed
 * a label of their own.
 */
export function readNumberEvents(pool: NumberPool, world: World): void {
  const ring = world.events;
  const total = ring.written;
  let at = pool.read;
  const oldest = total - ring.count;
  if (at < oldest) {
    pool.dropped += oldest - at;
    at = oldest;
  }

  let budget = NUMBER_BUDGET;
  for (; at < total; at++) {
    const slot = at % ring.cap;
    if (ring.type[slot] !== Ev.Damage) continue;
    if (budget <= 0) {
      pool.dropped++;
      continue;
    }
    const amount = ring.a[slot];
    if (amount <= 0) continue;
    // A hit that wants a number of its own spends the frame's share whether or not a slot was
    // left for it: the budget bounds what a frame draws, not what it counts, so a frame that fell
    // behind says so in `dropped` instead of quietly getting behinder.
    const live = pool.count;
    const placed = pushNumber(pool, ring.x[slot], ring.y[slot], amount, ring.b[slot] !== 0);
    if (!placed || pool.count > live) budget--;
  }
  pool.read = total;
}

/** Scratch, reused every call: the projection must not allocate per number. */
const _point = new Vector3();

export interface NumberLayer {
  /** The overlay's root, or null when there was no host to draw into. */
  readonly element: HTMLElement | null;
  /** The pool this layer draws, and where a test can look at it. */
  readonly pool: NumberPool;
  /** Drain the ring, spend a frame's life, and move what is still up. */
  tick(world: World, dt: number, camera: Camera, width: number, height: number): void;
}

/**
 * Bring the layer up.
 *
 * `host` is the `#ui` overlay; without one — a unit test, a headless run — the same object comes
 * back with `element: null` and a `tick` that only does the maths, which is what lets the pool
 * and the merge rule be tested in plain Node.
 */
export function createNumbers(
  host: HTMLElement | null,
  pool: NumberPool = createNumberPool(),
): NumberLayer {
  const hasDom = host !== null && typeof document !== 'undefined';

  let root: HTMLElement | null = null;
  const nodes: HTMLElement[] = [];

  if (host !== null && hasDom) {
    root = document.createElement('div');
    root.className = 'numbers';
    // Inline rather than in `src/ui/styles.css`: see the header. `pointer-events: none` is not
    // decoration — a layer that eats clicks would take the mouse-aim away from the game.
    root.style.cssText =
      'position:absolute;inset:0;overflow:hidden;pointer-events:none;' +
      'font:600 14px/1 "IBM Plex Mono",ui-monospace,monospace;';
    for (let i = 0; i < pool.cap; i++) {
      const node = document.createElement('span');
      // The plate belongs to the slot, not to the number: written once here, so the frame a hit
      // lands still spends one transform and one opacity. Rounding rather than DESIGN.md's cut
      // corners, which would want a `clip-path` per tab to take 2 px off a corner.
      node.style.cssText =
        'position:absolute;left:0;top:0;display:none;will-change:transform,opacity;' + PLATE_CSS;
      root.appendChild(node);
      nodes.push(node);
    }
    host.appendChild(root);
  }

  /** What each slot's node was last told, so a quiet frame writes nothing. */
  const shown = new Int32Array(pool.cap);
  const lived = new Float32Array(pool.cap);

  function paint(i: number, text: string, big: boolean): void {
    const node = nodes[i];
    if (node === undefined) return;
    if (shown[i] === 0) {
      node.style.display = 'block';
      node.style.color = big ? '#f2b233' : '#e8ecf5';
      node.style.fontSize = big ? '20px' : '14px';
      node.textContent = text;
      shown[i] = 1;
      lived[i] = -1;
    } else if (node.textContent !== text) {
      node.textContent = text;
    }
  }

  function hide(i: number): void {
    const node = nodes[i];
    if (node === undefined) return;
    if (shown[i] !== 0) {
      node.style.display = 'none';
      shown[i] = 0;
    }
  }

  return {
    element: root,
    pool,

    tick(world, dt, camera, width, height): void {
      readNumberEvents(pool, world);
      advanceNumbers(pool, dt);

      if (root === null || width <= 0 || height <= 0) return;

      for (let i = 0; i < pool.cap; i++) {
        const life = pool.life[i];
        if (life <= 0) {
          hide(i);
          continue;
        }

        _point.set(pool.x[i], pool.h[i], -pool.y[i]);
        _point.project(camera);
        // `project` hands back NDC, and a point behind the camera lands outside it: the one
        // check that matters here is that the number is in front of the lens and on the screen.
        if (_point.z > 1 || _point.x < -1.05 || _point.x > 1.05 || _point.y < -1.05 || _point.y > 1.05) {
          hide(i);
          continue;
        }

        const left = (_point.x * 0.5 + 0.5) * width;
        const top = (0.5 - _point.y * 0.5) * height;
        paint(i, String(pool.amount[i]), pool.crit[i] !== 0);

        const node = nodes[i];
        if (node === undefined) continue;

        const age = 1 - life / NUMBER_LIFE;
        const fade = life < FADE_OUT ? life / FADE_OUT : 1;
        if (lived[i] !== fade) {
          node.style.opacity = fade.toFixed(2);
          lived[i] = fade;
        }
        // One transform write per live number, and the rise is part of it: the height is already
        // in the projection, so the number leaves the floor as a projected point rather than as a
        // CSS slide that would drift off the thing it belongs to. The second translate hangs the
        // tab from its own middle, which is what keeps a four-digit merge over the body it came
        // from instead of sliding away to the right as it grows.
        node.style.transform =
          `translate(${left.toFixed(1)}px,${top.toFixed(1)}px) translate(-50%,-50%)` +
          ` scale(${(1 + age * 0.1).toFixed(2)})`;
      }
    },
  };
}
