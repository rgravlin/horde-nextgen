import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PerspectiveCamera } from 'three/webgpu';

import { Ev, createWorld, pushEvent } from '../../src/sim/world';
import {
  MERGE_RADIUS,
  MERGE_WINDOW,
  NUMBER_BUDGET,
  NUMBER_CAP,
  advanceNumbers,
  createNumberPool,
  createNumbers,
  pushNumber,
  readNumberEvents,
} from '../../src/render/damageNumbers';

/**
 * The damage-number layer's two rules, pinned on their own (DESIGN.md "Motion": numbers "float up
 * 0.6 m and fade over 600 ms", and "numbers merge under a heavy horde so they never pile up into
 * clutter").
 *
 * What this file exists to catch is the layer going quiet: a pool too small, or a merge rule wide
 * enough to swallow a whole crowd into one number, both read as *no numbers* on screen rather
 * than as wrong ones, and no screenshot of a frozen frame can tell those apart. So everything here
 * is measured in what survives a burst — how many numbers there are, what they add up to, and
 * whether they reach the screen — not in how they look.
 *
 * The burst is fed in through a small `World`'s event ring wherever the rule under test is the
 * drain's (budget, cursor) and through `pushNumber` directly wherever it is the pool's, so a
 * failure says which of the two moved.
 */

/**
 * A `document` small enough to hold in your head, for the one test that has to prove a number
 * reaches the screen.
 *
 * `vitest.config.ts` runs the unit tests with no DOM (TECH.md: "unit tests ... run headless in
 * Node"), so the layer's `typeof document !== 'undefined'` guard is false and it builds nothing —
 * correct for a headless run, useless as a check that a real page gets numbers. These two fakes
 * give the layer the *shape* of an overlay: a host that takes a child, and a node whose `style`
 * and `textContent` record what the layer last wrote, which is the only thing a paint has to be
 * judged by.
 */
class FakeNode {
  style: Record<string, string> = {};
  className = '';
  textContent = '';
  children: FakeNode[] = [];
  appendChild(node: FakeNode): FakeNode {
    this.children.push(node);
    return node;
  }
}

class FakeDocument {
  createElement(): FakeNode {
    return new FakeNode();
  }
}

/** Install the fake page for one call, and put `globalThis` back exactly as it was. */
function withFakePage<T>(run: () => T): T {
  const key = 'document' as keyof typeof globalThis;
  const had = key in globalThis;
  const before = globalThis[key];
  (globalThis as unknown as Record<string, unknown>).document = new FakeDocument();
  try {
    return run();
  } finally {
    if (had) (globalThis as unknown as Record<string, unknown>).document = before;
    else delete (globalThis as unknown as Record<string, unknown>).document;
  }
}

/**
 * The plate's fill, read back out of the inline style, or null when the number has no plate.
 *
 * Read rather than compared to the literal the layer writes, so the test says what the plate has
 * to be — dark, translucent — and fails if it stops being either.
 */
function plateFill(css: string): [number, number, number, number] | null {
  const found = /background:rgba\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)/.exec(css);
  if (found === null) return null;
  return [Number(found[1]), Number(found[2]), Number(found[3]), Number(found[4])];
}

/** The game's own rig (TECH.md "Camera"): 40° FOV, 55° pitch, 22 m out, over a 16:9 page. */
function rig(): PerspectiveCamera {
  const camera = new PerspectiveCamera(40, 16 / 9, 0.5, 220);
  const distance = 22;
  const pitch = (55 * Math.PI) / 180;
  camera.position.set(0, distance * Math.sin(pitch), distance * Math.cos(pitch));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

const STEP = 1 / 60;

/**
 * Points spread wider than `MERGE_RADIUS`, which is the definition of "not one volley".
 *
 * They sit inside the middle of what the rig can see rather than anywhere on the floor, because
 * two of these tests count what reaches the screen, and a number projected off the edge is not a
 * missing number but a camera pointing elsewhere.
 */
function spread(n: number, gap: number): Array<[number, number]> {
  const perRow = 5;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    out.push([(col - (perRow - 1) / 2) * gap, (row - 1.5) * gap]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the merge rule
// ---------------------------------------------------------------------------

describe('the merge rule', () => {
  it('gives every hit that lands clear of the others its own number', () => {
    // Twenty bodies hit in one frame, each at least `MERGE_RADIUS` from its neighbours: a plasma
    // sweep across a crowd. None of them may be dropped for want of a slot, and none may be
    // folded into a number that belongs to a different body.
    const hits = spread(20, MERGE_RADIUS * 2.2);
    const pool = createNumberPool();
    for (const [x, y] of hits) {
      expect(pushNumber(pool, x, y, 9, false)).toBe(true);
    }

    expect(pool.count).toBe(20);
    expect(pool.dropped).toBe(0);
  });

  it('keeps a hit on the next body over as its own fact', () => {
    // One body width. The horde's separation is about this wide, so a rule that merged here would
    // spend a whole pack on one number and the screen would say "nine damage" while ninety landed.
    const pool = createNumberPool();
    expect(pushNumber(pool, 0, 0, 9, false)).toBe(true);
    expect(pushNumber(pool, 1.2, 0, 9, false)).toBe(true);
    expect(pushNumber(pool, 0, 1.2, 9, false)).toBe(true);

    expect(pool.count).toBe(3);
    expect(pool.amount[0]).toBe(9);
  });

  it('collapses one volley at one point into one number that is the sum', () => {
    // Eight shotgun pellets and the round behind them, all inside one body's silhouette: one
    // number, and the number is the whole volley.
    const volley = [12, 9, 11, 14, 9, 12, 13, 10];
    const jitter = [
      [0, 0],
      [0.1, -0.1],
      [-0.15, 0.05],
      [0.05, 0.2],
      [-0.2, -0.1],
      [0.2, 0.1],
      [-0.05, 0.15],
      [0.15, -0.2],
    ];

    const pool = createNumberPool();
    for (let i = 0; i < volley.length; i++) {
      const [dx, dy] = jitter[i];
      expect(pushNumber(pool, dx, dy, volley[i], i === 3)).toBe(true);
    }

    expect(pool.count).toBe(1);
    expect(pool.amount[0]).toBe(90);
    // The crit inside the burst still reads as a crit, which is the reason a merge is a sum and
    // not a discard.
    expect(pool.crit[0]).toBe(1);
    expect(pool.dropped).toBe(0);
  });

  it('stops merging into a number once its volley is over', () => {
    // The other half of the rule. A merge is "these hits are one event", so it has to expire: a
    // second fight at the same spot half a second later is a second fact, and a number that stays
    // a merge target for its whole 0.6 s of life spends the whole crowd on one label.
    const pool = createNumberPool();
    pushNumber(pool, 0, 0, 20, false);
    advanceNumbers(pool, MERGE_WINDOW + STEP);
    expect(pushNumber(pool, 0, 0, 30, false)).toBe(true);

    expect(pool.count).toBe(2);
    expect(pool.amount[0]).toBe(20);
    expect(pool.amount[1]).toBe(30);
  });

  it('merges inside the window, next door', () => {
    // The window on its own is not the rule: while the volley is still landing, the second hit
    // joins the first even a whole body-width away from it, which is what a pellet fan looks like.
    const pool = createNumberPool();
    pushNumber(pool, 0, 0, 20, false);
    advanceNumbers(pool, MERGE_WINDOW - STEP);
    expect(pushNumber(pool, MERGE_RADIUS * 0.8, 0, 30, false)).toBe(true);

    expect(pool.count).toBe(1);
    expect(pool.amount[0]).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// the frame's budget
// ---------------------------------------------------------------------------

describe('the per-frame budget', () => {
  it('drains a crowd-density burst without dropping it', () => {
    // The burst arrives through the ring, as it does in a frame: twenty-four damage events from
    // one frame of a plasma sweep over a packed lane, each landing far enough from its neighbours
    // to be its own fact. Twenty-four is above anything one weapon measured on a 1,500-body floor
    // (a singularity's implosion, the worst frame in the game, starts seventeen), and a budget of
    // a dozen spent half of it before the frame was drawn — while a pool of sixty-four, turning
    // over one slot every thirty-odd frames, had nowhere to put the rest.
    const hits = spread(24, MERGE_RADIUS * 3);
    const world = createWorld(0xda7e, { arenaHalf: 60, eventCap: 1024 });
    for (const [x, y] of hits) pushEvent(world, Ev.Damage, 7, 0, x, y);

    const pool = createNumberPool();
    readNumberEvents(pool, world);

    expect(pool.count).toBe(24);
    expect(pool.dropped).toBe(0);

    // And the headroom is deliberate, not a fixture that happens to fit: a frame may start a
    // quarter of the pool, and the pool is big enough to hold that burst and still show the sweep
    // that follows it.
    expect(NUMBER_BUDGET).toBeGreaterThanOrEqual(24);
    expect(NUMBER_BUDGET).toBeLessThanOrEqual(NUMBER_CAP);
    expect(NUMBER_CAP).toBeGreaterThanOrEqual(128);
  });

  it('spends the budget on numbers, not on hits', () => {
    // Sixty hits that all land inside one cluster are one number; the budget is for the numbers a
    // frame has to draw, so a merged burst must not eat the frame's share and leave the hits on
    // the far side of the arena with nothing.
    const world = createWorld(0xb0bb, { arenaHalf: 60, eventCap: 1024 });
    for (let i = 0; i < 60; i++) pushEvent(world, Ev.Damage, 5, 0, 0, 0);
    for (const [x, y] of spread(20, MERGE_RADIUS * 3)) pushEvent(world, Ev.Damage, 6, 0, x + 30, y);

    const pool = createNumberPool();
    readNumberEvents(pool, world);

    expect(pool.dropped).toBe(0);
    expect(pool.count).toBe(21);
    expect(pool.amount[0]).toBe(300);
  });

  it('leaves a full pool counting drops instead of silently losing the hit', () => {
    // Over a full pool with nothing nearby to join, the hit is still counted: `dropped` is the
    // only way a check can tell "no room" from "nothing happened".
    const pool = createNumberPool(4);
    const hits = spread(9, 6);
    for (let i = 0; i < hits.length; i++) {
      const [x, y] = hits[i];
      expect(pushNumber(pool, x, y, 4, false)).toBe(i < 4);
    }

    expect(pool.count).toBe(4);
    expect(pool.dropped).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// the layer, over a fake overlay
// ---------------------------------------------------------------------------

describe('the layer', () => {
  it('puts a number on the screen for every one in the burst', () => {
    // The point of the whole file: numbers are on by default, so a frame of real gunfire has to
    // end with real numbers on the page. Driven through `createNumbers` with a fake host and the
    // game's own camera, because the pool alone cannot tell a number that faded off the edge from
    // a number that was never drawn.
    const host = new FakeNode();
    const world = createWorld(0xd0de, { arenaHalf: 60, eventCap: 1024 });
    for (const [x, y] of spread(20, MERGE_RADIUS * 2.2)) pushEvent(world, Ev.Damage, 11, 0, x, y);

    const layer = withFakePage(() => {
      const built = createNumbers(host as unknown as HTMLElement);
      built.tick(world, STEP, rig(), 1280, 720);
      return built;
    });

    expect(layer.element).not.toBeNull();
    // One node per slot, built before the first frame: the layer spends numbers, never nodes.
    expect(host.children[0]!.children.length).toBe(NUMBER_CAP);

    const painted = host.children[0]!.children.filter((node) => node.style.display === 'block');
    expect(painted.length).toBe(20);
    expect(painted.every((node) => node.style.transform.includes('px'))).toBe(true);
    expect(layer.pool.count).toBe(20);
    expect(layer.pool.dropped).toBe(0);
  });

  it('hangs every number on a dark plate rather than a blur', () => {
    // Legibility, pinned where it can be checked. DESIGN.md keeps CSS glow and blur stacks off the
    // playfield, so what separates a number from a bloomed explosion or an acid pool is a dark tab
    // behind it, not a shadow — and a screenshot of a frozen frame cannot tell either way, which
    // is why this reads the styles back off the fake page.
    const host = new FakeNode();
    const world = createWorld(0xd0de, { arenaHalf: 60, eventCap: 1024 });
    for (const [x, y] of spread(20, MERGE_RADIUS * 2.2)) pushEvent(world, Ev.Damage, 11, 0, x, y);

    const layer = withFakePage(() => {
      const built = createNumbers(host as unknown as HTMLElement);
      built.tick(world, STEP, rig(), 1280, 720);
      return built;
    });

    const painted = host.children[0]!.children.filter((node) => node.style.display === 'block');
    expect(painted.length).toBe(20);
    expect(layer.pool.count).toBe(20);

    // Dark, so light glyphs stay light, and not fully opaque, so the floor the number is about
    // still shows through it.
    const fills = painted.map((node) => plateFill(node.style.cssText));
    expect(fills.every((fill) => fill !== null), 'a number reached the screen with no plate').toBe(true);
    expect(fills.every((f) => Math.max(f![0], f![1], f![2]) < 64 && f![3] > 0.5 && f![3] < 1)).toBe(true);
    // The blur the plate replaces, and the one DESIGN.md forbids over the playfield.
    expect(painted.every((node) => !node.style.cssText.includes('text-shadow'))).toBe(true);
    // And the tab hangs from the point the hit landed at, so a long merge grows over its own body
    // instead of sliding away to the right as it grows.
    expect(painted.every((node) => node.style.transform.includes('translate(-50%,-50%)'))).toBe(true);
  });

  it('reads the ring through its own cursor and never rewinds it', () => {
    // Two frames of fire, drained by the same layer. The cursor is the layer's place in a
    // broadcast that nothing drains, so frame two starts where frame one stopped: a number per
    // hit, once each, and no echo of frame one's.
    const host = new FakeNode();
    const layer = createNumbers(host as unknown as HTMLElement);
    const world = createWorld(0xc0de, { arenaHalf: 60, eventCap: 1024 });
    const camera = rig();

    for (const [x, y] of spread(20, MERGE_RADIUS * 2.2)) pushEvent(world, Ev.Damage, 3, 0, x, y);
    layer.tick(world, STEP, camera, 1280, 720);
    const first = layer.pool.count;

    for (const [x, y] of spread(20, MERGE_RADIUS * 2.2)) pushEvent(world, Ev.Damage, 3, 0, x, y + 20);
    layer.tick(world, STEP, camera, 1280, 720);

    expect(first).toBe(20);
    expect(layer.pool.count).toBe(40);
    expect(layer.pool.dropped).toBe(0);
  });

  it('builds nothing when it has no host, and still counts', () => {
    // A headless run and a page with no overlay take this path. The maths still has to run — that
    // is what lets this file exist — and `element: null` is how the caller knows there is nothing
    // to draw, which is also what the settings toggle leans on.
    const layer = createNumbers(null);
    const world = createWorld(0x5, { arenaHalf: 60, eventCap: 1024 });
    for (const [x, y] of spread(20, MERGE_RADIUS * 2.2)) pushEvent(world, Ev.Damage, 8, 0, x, y);

    layer.tick(world, STEP, rig(), 1280, 720);

    expect(layer.element).toBeNull();
    expect(layer.pool.count).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// the wiring
// ---------------------------------------------------------------------------

describe('the page', () => {
  it('hands the layer the overlay and the toggle', () => {
    // This is the bug the numbers actually had: the layer was built with no host, so it counted
    // every hit into a pool no one ever read, and the damage-numbers toggle had nothing to turn
    // off. `createNumbers` cannot be reached from a Node test (it lives behind a canvas and a
    // GPU), so the seam itself is pinned here — the same way `purity.test.ts` pins the import
    // rule by reading the source.
    const main = readFileSync(join(fileURLToPath(new URL('../../', import.meta.url)), 'src/main.ts'), 'utf8');
    const options = main.match(/function viewOptions\([\s\S]*?\n\}/);

    expect(options, 'viewOptions is where the settings reach the renderer').not.toBeNull();
    expect(options![0]).toContain('damageNumbers: settings.damageNumbers');
    expect(options![0]).toMatch(/overlay: (ui|host)/);
  });
});