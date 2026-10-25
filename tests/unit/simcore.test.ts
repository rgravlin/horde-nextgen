import { describe, expect, it } from 'vitest';
import { hashWorld } from '../../src/sim/hash';
import { IDLE_FRAME, createInputFrame, packFrame, resetFrame, unpackFrame, type InputFrame } from '../../src/sim/input';
import { createSpatialHash, queryRadius, rebuild } from '../../src/sim/spatialHash';
import { queryEnemies, step } from '../../src/sim/step';
import { createRng, next, nextInt, nextU32, range, seedRng } from '../../src/sim/rng';
import {
  Ev,
  POOL_CAPS,
  TUNE,
  alloc,
  clearEvents,
  countAlive,
  countEvents,
  createPool,
  createWorld,
  eventSlot,
  findEvent,
  pushEvent,
  release,
  type World,
} from '../../src/sim/world';

function runReplay(seed: number, codes: Uint32Array, arenaHalf = 20): World {
  const w = createWorld(seed, { arenaHalf });
  const frame = createInputFrame();
  for (let i = 0; i < codes.length; i++) {
    unpackFrame(codes[i], frame);
    step(w, frame);
  }
  return w;
}

function buildCodes(count: number, fill: (tick: number, frame: InputFrame) => void): Uint32Array {
  const codes = new Uint32Array(count);
  const frame = createInputFrame();
  for (let i = 0; i < count; i++) {
    resetFrame(frame);
    fill(i, frame);
    codes[i] = packFrame(frame);
  }
  return codes;
}

describe('rng', () => {
  it('repeats the same sequence for the same seed and a different one for another seed', () => {
    const draw = (seed: number): number[] => {
      const r = createRng(seed);
      const out: number[] = [];
      for (let i = 0; i < 16; i++) out.push(nextU32(r));
      return out;
    };

    expect(draw(12345)).toEqual(draw(12345));
    expect(draw(12345)).not.toEqual(draw(12346));
  });

  it('keeps its state in the world-held Uint32Array and re-seeds back to the same run', () => {
    const r = createRng(7);
    expect(r.s).toBeInstanceOf(Uint32Array);
    expect(r.s.length).toBe(4);

    const first = [nextU32(r), nextU32(r)];
    seedRng(r, 99);
    nextU32(r);
    seedRng(r, 7);
    expect([nextU32(r), nextU32(r)]).toEqual(first);
  });

  it('stays in range and covers the interval', () => {
    const r = createRng(2026);
    let low = Infinity;
    let high = -Infinity;
    let inRange = true;

    for (let i = 0; i < 4000; i++) {
      const u = next(r);
      if (u < 0 || u >= 1) inRange = false;
      if (u < low) low = u;
      if (u > high) high = u;
      const n = nextInt(r, 5);
      if (!Number.isInteger(n) || n < 0 || n >= 5) inRange = false;
      const v = range(r, -3, 3);
      if (v < -3 || v >= 3) inRange = false;
    }

    expect(inRange).toBe(true);
    expect(high - low).toBeGreaterThan(0.95);
    expect(nextInt(r, 0)).toBe(0);
  });
});

describe('spatial hash', () => {
  it('finds neighbours within the radius and excludes far ones', () => {
    const h = createSpatialHash(-10, -10, 10, 10, 2, 64);
    const x = new Float32Array([0, 1.4, 8, 1.9, 1.9]);
    const y = new Float32Array([0, 0.2, 0, 1.9, -1.9]);
    rebuild(h, x, y, null, x.length);
    expect(h.count).toBe(5);

    const out = new Int32Array(16);
    const n = queryRadius(h, x, y, null, 0, 0, 2, out);

    // 0 and 1 are inside 2 m. 2 is outside the scanned cells. 3 and 4 sit in
    // scanned cells but outside the radius, so the exact distance test drops them.
    expect(Array.from(out.subarray(0, n)).sort()).toEqual([0, 1]);
  });

  it('skips dead slots', () => {
    const p = createPool('enemies', 8);
    const h = createSpatialHash(-10, -10, 10, 10, 2, 8);
    const near = alloc(p);
    p.x[near] = 0;
    p.y[near] = 0;
    const alsoNear = alloc(p);
    p.x[alsoNear] = 0.5;
    p.y[alsoNear] = 0;
    const out = new Int32Array(8);

    rebuild(h, p.x, p.y, p.alive, p.cap);
    expect(queryRadius(h, p.x, p.y, p.alive, 0, 0, 1, out)).toBe(2);

    release(p, alsoNear);
    rebuild(h, p.x, p.y, p.alive, p.cap);
    expect(queryRadius(h, p.x, p.y, p.alive, 0, 0, 1, out)).toBe(1);
    expect(countAlive(p)).toBe(1);
    expect(p.count).toBe(1);
  });

  it('reports a full output buffer instead of truncating silently', () => {
    const h = createSpatialHash(-10, -10, 10, 10, 2, 64);
    const x = new Float32Array([0, 0.1, 0.2, 0.3, 0.4]);
    const y = new Float32Array([0, 0, 0, 0, 0]);
    rebuild(h, x, y, null, x.length);

    const out = new Int32Array(3);
    expect(queryRadius(h, x, y, null, 0, 0, 1, out)).toBe(3);
    expect(h.queryOverflow).toBe(1);
  });

  it('keeps a grid smaller than the pool from losing real neighbours', () => {
    // createWorld sizes the grid to the pool; this pins the smaller-grid
    // configuration the API allows: truncation is reported, and the entities that
    // ARE indexed stay reachable.
    const p = createPool('enemies', 6);
    const h = createSpatialHash(-10, -10, 10, 10, 2, 4, 6);
    const xs = [-9.9, -9.9, 0, 0, 6, 6];
    const ys = [-9.9, -9.9, 0, 0, 0, 0];
    for (let i = 0; i < xs.length; i++) {
      const slot = alloc(p);
      p.x[slot] = xs[i];
      p.y[slot] = ys[i];
    }

    rebuild(h, p.x, p.y, p.alive, p.cap);
    expect(h.count).toBe(4);
    expect(h.overflow).toBe(2);

    const out = new Int32Array(16);
    expect(queryRadius(h, p.x, p.y, p.alive, 0, 0, 0.5, out)).toBe(2);
    expect(queryRadius(h, p.x, p.y, p.alive, 6, 0, 0.5, out)).toBe(0);
  });

  it('is rebuilt by step, so a moved enemy is found where it now is', () => {
    const w = createWorld(1, { arenaHalf: 20 });
    const i = alloc(w.enemies);
    w.enemies.x[i] = 5;
    w.enemies.y[i] = 5;

    step(w, IDLE_FRAME);
    expect(queryEnemies(w, 5, 5, 1)).toBe(1);

    w.enemies.x[i] = -14;
    w.enemies.y[i] = -14;
    step(w, IDLE_FRAME);
    expect(queryEnemies(w, 5, 5, 1)).toBe(0);
    expect(queryEnemies(w, -14, -14, 1)).toBe(1);
  });
});

describe('movement', () => {
  it('walks in the input direction at 6 m/s', () => {
    const w = createWorld(2);
    const f = createInputFrame();
    f.moveX = 1;
    const before = w.player.x;

    step(w, f);

    expect(w.player.x).toBeGreaterThan(before);
    expect(w.player.y).toBe(before);
    expect(Math.hypot(w.player.vx, w.player.vy)).toBeCloseTo(TUNE.moveSpeed, 5);
    expect(w.player.x).toBeCloseTo(before + TUNE.moveSpeed / 60, 6);
  });

  it('moves up when moveY is positive and down when it is negative', () => {
    const up = createWorld(3);
    const fUp = createInputFrame();
    fUp.moveY = 1;
    step(up, fUp);
    expect(up.player.y).toBeGreaterThan(0);

    const down = createWorld(3);
    const fDown = createInputFrame();
    fDown.moveY = -1;
    step(down, fDown);
    expect(down.player.y).toBeLessThan(0);
  });

  it('normalises a diagonal instead of making it sqrt2 faster', () => {
    const w = createWorld(4);
    const f = createInputFrame();
    f.moveX = 1;
    f.moveY = 1;

    step(w, f);

    expect(Math.hypot(w.player.vx, w.player.vy)).toBeCloseTo(TUNE.moveSpeed, 5);
    expect(w.player.vx).toBeCloseTo(w.player.vy, 6);
  });

  it('scales an analogue stick by how far it is pushed', () => {
    const w = createWorld(5);
    const f = createInputFrame();
    f.moveX = 0.5;

    step(w, f);

    expect(Math.hypot(w.player.vx, w.player.vy)).toBeCloseTo(TUNE.moveSpeed * 0.5, 5);
  });

  it('stands still on the idle frame', () => {
    const w = createWorld(6);
    w.player.vx = 3;
    step(w, IDLE_FRAME);
    expect(w.player.vx).toBe(0);
    expect(w.player.vy).toBe(0);
  });

  it('never lets the player leave the arena', () => {
    const w = createWorld(7, { arenaHalf: 6 });
    const f = createInputFrame();
    f.moveX = 1;
    f.moveY = 1;
    const limit = 6 - TUNE.playerRadius;
    let inside = true;

    for (let i = 0; i < 400; i++) {
      step(w, f);
      if (Math.abs(w.player.x) > limit + 1e-9 || Math.abs(w.player.y) > limit + 1e-9) inside = false;
    }

    expect(inside).toBe(true);
    // It really ran: it ends parked in the far corner, playerRadius inside it.
    expect(w.player.x).toBeGreaterThan(limit - 1e-6);
    expect(w.player.y).toBeGreaterThan(limit - 1e-6);
  });

  it('keeps a dash inside the arena too', () => {
    const w = createWorld(8, { arenaHalf: 6 });
    w.player.x = 5;
    const f = createInputFrame();
    f.moveX = 1;
    f.dash = true;
    const limit = 6 - TUNE.playerRadius;
    let inside = true;

    for (let i = 0; i < 200; i++) {
      step(w, f);
      if (w.player.x > limit + 1e-9) inside = false;
    }

    expect(inside).toBe(true);
    expect(w.player.x).toBeLessThanOrEqual(limit + 1e-9);
  });
});

describe('dash', () => {
  it('gives a 22 m/s burst with i-frames, then falls back to walking speed', () => {
    const w = createWorld(9);
    const f = createInputFrame();
    f.moveX = 1;
    f.dash = true;

    step(w, f);

    expect(w.player.dashTime).toBeCloseTo(TUNE.dashTime, 10);
    expect(w.player.iframes).toBeCloseTo(TUNE.dashIframes, 10);
    expect(w.player.dashCd).toBeCloseTo(TUNE.dashCooldown, 10);
    expect(Math.hypot(w.player.vx, w.player.vy)).toBeCloseTo(TUNE.dashSpeed, 5);
    expect(findEvent(w, Ev.Dash)).toBeGreaterThanOrEqual(0);

    // Half a second later the burst and the invulnerability have both expired.
    const idle = createInputFrame();
    for (let i = 0; i < 30; i++) step(w, idle);
    expect(w.player.dashTime).toBe(0);
    expect(w.player.iframes).toBe(0);
    expect(Math.hypot(w.player.vx, w.player.vy)).toBe(0);
  });

  it('keeps i-frames past the end of the burst', () => {
    const w = createWorld(10);
    const f = createInputFrame();
    f.moveX = 1;
    f.dash = true;
    for (let i = 0; i < 11; i++) step(w, f);

    expect(w.player.dashTime).toBeGreaterThan(0);
    expect(w.player.iframes).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) step(w, IDLE_FRAME);
    expect(w.player.dashTime).toBe(0);
    expect(w.player.iframes).toBeGreaterThan(0);
  });

  it('respects the 1.5 s cooldown while the button is held', () => {
    const w = createWorld(11);
    const f = createInputFrame();
    f.moveX = 1;
    f.dash = true;

    for (let i = 0; i < 60; i++) step(w, f);
    expect(countEvents(w, Ev.Dash)).toBe(1);
    for (let i = 0; i < 60; i++) step(w, f);
    expect(countEvents(w, Ev.Dash)).toBe(2);
    for (let i = 0; i < 120; i++) step(w, f);
    expect(countEvents(w, Ev.Dash)).toBe(3);
  });

  it('will not spend a dash while the cooldown is running', () => {
    const w = createWorld(12);
    const f = createInputFrame();
    f.moveX = 1;
    f.dash = true;

    for (let i = 0; i < 10; i++) step(w, f);

    expect(countEvents(w, Ev.Dash)).toBe(1);
    expect(w.player.dashCd).toBeGreaterThan(1.3);
  });

  it('dashes toward the aim when there is no movement input', () => {
    const w = createWorld(13);
    const f = createInputFrame();
    f.dash = true;
    f.aimX = 0;
    f.aimY = 1;

    step(w, f);

    expect(w.player.vy).toBeCloseTo(TUNE.dashSpeed, 5);
    expect(w.player.vx).toBeCloseTo(0, 5);
  });

  it('does not burn the cooldown when there is nowhere to dash', () => {
    const w = createWorld(14);
    w.player.aimX = 0;
    w.player.aimY = 0;
    const f = createInputFrame();
    f.dash = true;

    step(w, f);

    expect(countEvents(w, Ev.Dash)).toBe(0);
    expect(w.player.dashCd).toBe(0);
    expect(w.player.iframes).toBe(0);
  });
});

describe('input frames', () => {
  it('round-trips a frame through one Uint32', () => {
    const f = createInputFrame();
    f.moveX = 1;
    f.moveY = -1;
    f.aimX = -0.5;
    f.aimY = 0.75;
    f.fire = true;
    f.dash = true;
    f.swap = true;
    f.pick = 2;
    const code = packFrame(f);

    expect(Number.isInteger(code)).toBe(true);
    expect(code).toBeGreaterThanOrEqual(0);
    expect(code).toBeLessThanOrEqual(0xffffffff);

    const back = createInputFrame();
    unpackFrame(code, back);
    expect(back.moveX).toBe(1);
    expect(back.moveY).toBe(-1);
    expect(back.fire).toBe(true);
    expect(back.dash).toBe(true);
    expect(back.swap).toBe(true);
    expect(back.pick).toBe(2);
    expect(back.aimX).toBeCloseTo(-0.5, 3);
    expect(back.aimY).toBeCloseTo(0.75, 3);
  });

  it('keeps the card pick bits clear of the direction and aim bits', () => {
    const f = createInputFrame();
    f.moveX = 1;
    f.moveY = 1;
    f.pick = 3;
    const back = createInputFrame();
    unpackFrame(packFrame(f), back);
    expect(back.pick).toBe(3);
    expect(back.moveX).toBe(1);
    expect(back.moveY).toBe(1);
  });

  it('gives an idle frame no input at all, and cannot be written through', () => {
    const back = createInputFrame();
    unpackFrame(packFrame(IDLE_FRAME), back);
    expect(back).toEqual({
      moveX: 0,
      moveY: 0,
      aimX: 0,
      aimY: 0,
      fire: false,
      dash: false,
      swap: false,
      pick: 0,
    });
    expect(Object.isFrozen(IDLE_FRAME)).toBe(true);
  });
});

describe('pools', () => {
  it('builds the caps from config and honours smaller ones', () => {
    const full = createWorld(15);
    expect(full.enemies.cap).toBe(POOL_CAPS.enemies);
    expect(full.shots.cap).toBe(POOL_CAPS.projectiles);
    expect(full.enemyShots.cap).toBe(POOL_CAPS.enemyProjectiles);
    expect(full.shards.cap).toBe(POOL_CAPS.shards);

    const small = createWorld(15, { enemies: 4 });
    expect(small.enemies.cap).toBe(4);
    expect(small.shots.cap).toBe(POOL_CAPS.projectiles);
  });

  it('hands out the lowest slot first and reuses a freed slot before a fresh one', () => {
    const p = createPool('enemies', 4);
    expect(alloc(p)).toBe(0);
    expect(alloc(p)).toBe(1);
    expect(alloc(p)).toBe(2);
    release(p, 1);
    expect(alloc(p)).toBe(1);
    expect(alloc(p)).toBe(3);
    expect(alloc(p)).toBe(-1);
    expect(p.count).toBe(4);
    expect(countAlive(p)).toBe(4);
  });

  it('gives back a cleared slot', () => {
    const p = createPool('shots', 2);
    const a = alloc(p);
    p.x[a] = 12;
    p.hp[a] = 40;
    p.kind[a] = 7;
    release(p, a);
    const b = alloc(p);
    expect(b).toBe(a);
    expect(p.x[b]).toBe(0);
    expect(p.hp[b]).toBe(0);
    expect(p.kind[b]).toBe(0);
  });

  it('ignores a double release', () => {
    const p = createPool('enemies', 2);
    const a = alloc(p);
    release(p, a);
    release(p, a);
    expect(p.count).toBe(0);
    expect(p.freeCount).toBe(2);
  });
});

describe('event ring', () => {
  it('drops the oldest event when it is full and counts the loss', () => {
    const w = createWorld(16, { eventCap: 4 });
    for (let i = 0; i < 3; i++) pushEvent(w, Ev.Dash, i, 0, 0, 0);
    for (let i = 0; i < 5; i++) pushEvent(w, Ev.Shot, i, 0, 1, 2);

    expect(w.events.count).toBe(4);
    expect(w.events.dropped).toBe(4);
    expect(countEvents(w, Ev.Dash)).toBe(0);
    expect(countEvents(w, Ev.Shot)).toBe(4);

    const types: number[] = [];
    const payload: number[] = [];
    for (let k = 0; k < w.events.count; k++) {
      const slot = eventSlot(w, k);
      expect(slot).toBeGreaterThanOrEqual(0);
      types.push(w.events.type[slot]);
      payload.push(w.events.a[slot]);
    }
    // Oldest first, and the four newest pushes survived.
    expect(types).toEqual([Ev.Shot, Ev.Shot, Ev.Shot, Ev.Shot]);
    expect(payload).toEqual([1, 2, 3, 4]);

    clearEvents(w);
    expect(w.events.count).toBe(0);
    expect(findEvent(w, Ev.Shot)).toBe(-1);
    expect(eventSlot(w, 0)).toBe(-1);
  });
});

describe('determinism', () => {
  it('gives the same hash for the same seed and the same input log', () => {
    const codes = buildCodes(240, (i, f) => {
      f.moveX = 1;
      f.moveY = i > 120 ? -1 : 0;
      f.fire = true;
      f.dash = i === 5 || i === 190;
    });

    const a = runReplay(1337, codes);
    const b = runReplay(1337, codes);

    expect(a.tick).toBe(240);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it('gives a different hash for a different input log', () => {
    const straight = buildCodes(240, (i, f) => {
      f.moveX = 1;
      f.dash = i === 5;
    });
    const zigzag = buildCodes(240, (i, f) => {
      f.moveX = i < 120 ? 1 : -1;
      f.dash = i === 5;
    });

    const a = runReplay(1337, straight);
    const b = runReplay(1337, zigzag);

    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });

  it('fingerprints the pools and the rng, not only the player', () => {
    const a = createWorld(17);
    const b = createWorld(17);
    for (const w of [a, b]) {
      const i = alloc(w.enemies);
      w.enemies.x[i] = 3;
      w.enemies.y[i] = -2;
      w.enemies.hp[i] = 30;
      const s = alloc(w.shots);
      w.shots.vx[s] = 40;
      w.shots.life[s] = 1.5;
    }
    expect(hashWorld(a)).toBe(hashWorld(b));

    b.enemies.x[0] = 3.5;
    expect(hashWorld(a)).not.toBe(hashWorld(b));
    b.enemies.x[0] = 3;
    expect(hashWorld(a)).toBe(hashWorld(b));

    release(b.enemies, 0);
    expect(hashWorld(a)).not.toBe(hashWorld(b));

    const c = createWorld(17);
    const d = createWorld(17);
    nextU32(d.rng);
    expect(hashWorld(c)).not.toBe(hashWorld(d));
  });

  it('replays a seeded horde to the same hash, with the hash rebuilt every tick', () => {
    const seedHorde = (seed: number): World => {
      const w = createWorld(seed, { arenaHalf: 20 });
      for (let i = 0; i < 60; i++) {
        const slot = alloc(w.enemies);
        if (slot < 0) break;
        w.enemies.x[slot] = range(w.rng, -19, 19);
        w.enemies.y[slot] = range(w.rng, -19, 19);
        w.enemies.hp[slot] = 20;
      }
      const codes = buildCodes(120, (tick, f) => {
        f.moveX = tick % 40 < 20 ? 1 : -1;
        f.moveY = 0.5;
        f.dash = tick === 30 || tick === 100;
      });
      const frame = createInputFrame();
      for (let i = 0; i < codes.length; i++) {
        unpackFrame(codes[i], frame);
        step(w, frame);
      }
      return w;
    };

    const a = seedHorde(4242);
    const b = seedHorde(4242);

    expect(a.enemies.count).toBe(60);
    expect(a.enemies.count).toBe(b.enemies.count);
    expect(hashWorld(a)).toBe(hashWorld(b));
    // The grid was rebuilt on the last tick, so a query sees the live horde.
    expect(a.hash.count).toBe(60);
  });

  it('keeps the hash an unsigned 32-bit integer', () => {
    const w = runReplay(99, buildCodes(60, () => {}));
    const h = hashWorld(w);
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});