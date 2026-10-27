import { describe, expect, it } from 'vitest';

import { PerspectiveCamera } from 'three/webgpu';

import { Ev, createWorld, pushEvent } from '../../src/sim/world';
import {
  MERGE_RADIUS,
  NUMBER_BUDGET,
  NUMBER_CAP,
  NUMBER_LIFE,
  NUMBER_RISE,
  advanceNumbers,
  createNumberPool,
  createNumbers,
  pushNumber,
  readNumberEvents,
} from '../../src/render/damageNumbers';

/**
 * The number pool: 128 slots, one per floating number, and the rules that spend them.
 *
 * Cut out of `quality.test.ts` with the file too big to read at once; nothing here changed but
 * where it lives. The pair of files is deliberate: this one drives the pure pool and the ring
 * drain, `damageNumbers.test.ts` drives the layer that paints them and the seam that hands it an
 * overlay. Both matter because the failure mode is silence — a number that never appears is not a
 * wrong picture, it is no picture, and a screenshot of a quiet frame proves nothing.
 */

// ---------------------------------------------------------------------------
// damage numbers
// ---------------------------------------------------------------------------

describe('the damage-number pool', () => {
  it('is a fixed pool, sized once at build time', () => {
    // ARCHITECTURE.md's "damage numbers 128": a heavy horde spends numbers, never DOM nodes. How
    // big the pool is, and what happens at its edge, is `tests/unit/damageNumbers.test.ts`.
    const pool = createNumberPool();
    expect(pool.cap).toBe(NUMBER_CAP);
    expect(pool.count).toBe(0);
    expect(createNumberPool(4).x).toHaveLength(4);
  });

  it('refuses a number that is not damage', () => {
    const pool = createNumberPool();
    expect(pushNumber(pool, 0, 0, 0, false)).toBe(false);
    expect(pushNumber(pool, 0, 0, -5, false)).toBe(false);
    expect(pool.count).toBe(0);
  });

  it('caps at the pool and counts what it dropped', () => {
    const pool = createNumberPool(4);
    // Ten points spread far enough apart that none of them can merge.
    for (let i = 0; i < 10; i++) {
      pushNumber(pool, i * 20, 0, 10, false);
    }
    expect(pool.count).toBe(4);
    expect(pool.dropped).toBe(6);
    expect(pool.count).toBeLessThanOrEqual(pool.cap);
  });

  it('merges a hit that lands next to a number already on the way up', () => {
    // DESIGN.md: "numbers merge under a heavy horde so they never pile up into clutter". One
    // shotgun's eight pellets is one event on screen, so eight pushes must give one number.
    const pool = createNumberPool();
    for (let i = 0; i < 8; i++) {
      pushNumber(pool, 0, 0, 7, false);
    }
    expect(pool.count).toBe(1);
    expect(pool.amount[0]).toBe(56);
    expect(pool.dropped).toBe(0);
  });

  it('keeps two bodies two metres apart as two numbers', () => {
    const pool = createNumberPool();
    expect(pushNumber(pool, 0, 0, 7, false)).toBe(true);
    expect(pushNumber(pool, MERGE_RADIUS * 2, 0, 7, false)).toBe(true);
    expect(pool.count).toBe(2);
    expect(pool.amount[0]).toBe(7);
    expect(pool.amount[1]).toBe(7);
  });

  it('carries a crit into the number it merged into', () => {
    // The bigger yellow type is the whole point of merging: a crit inside a shotgun burst still
    // has to read as a crit.
    const pool = createNumberPool();
    pushNumber(pool, 0, 0, 7, false);
    pushNumber(pool, 0.2, 0.1, 40, true);
    expect(pool.count).toBe(1);
    expect(pool.crit[0]).toBe(1);
  });

  it('stops merging once the number would run past four digits', () => {
    const pool = createNumberPool();
    pushNumber(pool, 0, 0, 9_990, false);
    expect(pushNumber(pool, 0.1, 0, 20, false)).toBe(true);
    expect(pool.count).toBe(2);
    expect(pool.amount[0]).toBe(9_990);
  });

  it('rises 0.6 m over 0.6 s and then frees the slot', () => {
    const pool = createNumberPool();
    pushNumber(pool, 0, 0, 10, false);
    const start = pool.h[0];

    // Half its life: half the rise, and still alive.
    advanceNumbers(pool, NUMBER_LIFE / 2);
    expect(pool.life[0]).toBeCloseTo(NUMBER_LIFE / 2, 6);
    expect(pool.h[0]).toBeCloseTo(start + NUMBER_RISE / 2, 4);

    // All of it: the slot is free again, so a long run cannot leak numbers.
    advanceNumbers(pool, NUMBER_LIFE);
    expect(pool.life[0]).toBe(0);
    expect(pool.count).toBe(0);
  });

  it('spends nothing on a frame that ran no steps', () => {
    const pool = createNumberPool();
    pushNumber(pool, 0, 0, 10, false);
    advanceNumbers(pool, 0);
    // `life` lives in a Float32Array, so compare the value rather than its bits.
    expect(pool.life[0]).toBeCloseTo(NUMBER_LIFE, 6);
    expect(pool.h[0]).toBeCloseTo(1.05, 5);
  });

  it('drains the event ring once, and only the damage in it', () => {
    const world = createWorld(7, { eventCap: 64 });
    const pool = createNumberPool();
    pushEvent(world, Ev.Damage, 12, 0, 1, 1);
    pushEvent(world, Ev.Kill, 3, 0, 2, 2);
    pushEvent(world, Ev.Damage, 5, 1, 9, 9);

    readNumberEvents(pool, world);
    expect(pool.count).toBe(2);
    expect(pool.amount[0]).toBe(12);
    expect(pool.crit[0]).toBe(0);
    // The second event carries its crit flag in `b`.
    expect(pool.crit[1]).toBe(1);

    // The cursor moved, so a second read of a quiet ring adds nothing.
    readNumberEvents(pool, world);
    expect(pool.count).toBe(2);
  });

  it('counts what it never got, instead of guessing at it', () => {
    const world = createWorld(7, { eventCap: 8 });
    const pool = createNumberPool();
    // 40 damage events through a ring of 8, none of them read: 32 were overwritten before this
    // consumer ever looked, and that has to be a number, not a silence (AGENTS.md).
    for (let i = 0; i < 40; i++) pushEvent(world, Ev.Damage, 10, 0, i * 5, 0);
    readNumberEvents(pool, world);
    expect(pool.dropped).toBeGreaterThanOrEqual(32);

    // And past the per-frame budget the rest is dropped for the frame, not silently deferred.
    const world2 = createWorld(8, { eventCap: 64 });
    const pool2 = createNumberPool();
    for (let i = 0; i < NUMBER_BUDGET + 6; i++) pushEvent(world2, Ev.Damage, 4, 0, i * 20, 40);
    readNumberEvents(pool2, world2);
    expect(pool2.count).toBe(NUMBER_BUDGET);
    expect(pool2.dropped).toBe(6);
  });

  it('runs headless, and allocates nothing per frame', () => {
    // No host element: a unit test, a headless run. The maths still has to run — that is what
    // lets this file exist at all — and it must not grow a pool or a node as it goes.
    const layer = createNumbers(null);
    expect(layer.element).toBeNull();

    const world = createWorld(9);
    const pool = layer.pool;
    const before = { x: pool.x, y: pool.y, h: pool.h, life: pool.life, amount: pool.amount };
    const camera = new PerspectiveCamera(40, 16 / 9, 0.1, 200);
    camera.position.set(0, 15, 20);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    for (let i = 0; i < 120; i++) {
      // The ring's `b` is a number: the reader treats anything but 0 as a crit.
      pushEvent(world, Ev.Damage, 3 + (i % 7), i % 3 === 0 ? 1 : 0, (i % 11) * 1.7, (i % 5) * 2.3);
      expect(() => layer.tick(world, 1 / 30, camera, 1280, 720)).not.toThrow();
      expect(pool.count).toBeLessThanOrEqual(pool.cap);
    }

    // Same buffers, same objects, 120 frames later.
    expect(layer.pool).toBe(pool);
    expect(pool.x).toBe(before.x);
    expect(pool.y).toBe(before.y);
    expect(pool.h).toBe(before.h);
    expect(pool.life).toBe(before.life);
    expect(pool.amount).toBe(before.amount);
  });
});
