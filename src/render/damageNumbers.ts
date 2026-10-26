/**
 * Damage numbers: the read half of `Ev.Damage` (DESIGN.md "Motion").
 *
 * Sixty-four floating numbers, each one a DOM node that lives 0.6 s, rises 0.6 m and fades out,
 * pinned to the point on the floor where the hit landed. They are DOM rather than canvas text
 * for the reason the design brief gives: the type has to stay crisp at any resolution scale,
 * and a 1,000-body frame is already asking a lot of the draw path.
 *
 * Three things keep this a read-only layer:
 *
 * - It never writes a game value. It reads the event ring through its own cursor (the ring is a
 *   broadcast; see `EventRing`) and the numbers come from the events, not from the pools, so a
 *   number says what the hit paid rather than what the body has left.
 * - Sixty-four is the whole pool and the elements are built up front, so a heavy horde spends
 *   numbers, never nodes: a hit with no free slot and no neighbour to merge into is dropped.
 * - Neighbours merge. DESIGN.md asks for that by name ("numbers merge under a heavy horde so
 *   they never pile up into clutter"), and a merge is a sum into a live number near the same
 *   point, which is also what keeps a shotgun's eight pellets reading as one event.
 *
 * The styling is inline rather than a class in `src/ui/styles.css` because this file lives on the
 * render side of the render/ui line and must not reach across it for a stylesheet (ARCHITECTURE.md
 * "Hard rules"): one element, two colours and two sizes is not worth a dependency between the
 * layers.
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

/** The pool's size: `ARCHITECTURE.md`'s "damage numbers 64". */
export const NUMBER_CAP = 64;

/** Numbers a single rendered frame may start, whatever the tick's event ring says. */
export const NUMBER_BUDGET = 12;

/**
 * How close a hit has to land to join a number already on the way up, in metres.
 *
 * A metrey and a bit: wide enough that one shotgun's spread of pellets becomes one number, and
 * narrow enough that two bodies two metres apart stay two facts.
 */
export const MERGE_RADIUS = 1.35;

/** What a number's height above its point is when it starts, in metres. */
const START_HEIGHT = 1.05;

/** A number this old has nothing left to say and stops costing a DOM write. */
const FADE_OUT = 0.18;

/** Where a number's text stops being worth redrawing, in HP. */
const MERGE_LIMIT = 9999;

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
 * Returns false when the pool is full and no live number is close enough to join: the hit still
 * happened and is still counted in the score, it just did not get a label.
 */
export function pushNumber(pool: NumberPool, x: number, y: number, amount: number, crit: boolean): boolean {
  if (amount <= 0) return false;

  // The merge search doubles as the free-slot search, so a full pool costs one pass.
  let free = -1;
  let near = -1;
  let best = MERGE_RADIUS * MERGE_RADIUS;
  for (let i = 0; i < pool.cap; i++) {
    if (pool.life[i] <= 0) {
      if (free < 0) free = i;
      continue;
    }
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
    budget--;
    pushNumber(pool, ring.x[slot], ring.y[slot], amount, ring.b[slot] !== 0);
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
      node.style.cssText =
        'position:absolute;left:0;top:0;display:none;will-change:transform,opacity;' +
        'text-shadow:0 1px 2px rgba(0,0,0,.85);';
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
        // CSS slide that would drift off the thing it belongs to.
        node.style.transform = `translate(${left.toFixed(1)}px,${top.toFixed(1)}px) scale(${(1 + age * 0.1).toFixed(2)})`;
      }
    },
  };
}
