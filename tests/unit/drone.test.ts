/**
 * The drone's orbit position, checked as one answer with three callers.
 *
 * The orbit maths used to sit inline in `systems/drone.ts`, with nothing beside it to draw or
 * to read, and this file is the seam a drawn drone and a `__forgeState()` read are meant to
 * come through: both have to take the point the muzzle was loosed from rather than work one out
 * again. Two copies of `cos`/`sin` are free to disagree about the radius, the centre or the
 * bearing, and then the companion is drawn somewhere its own rounds did not come from — the same
 * seam `tests/unit/facing.test.ts` was written for, one layer over. So the checks below are
 * pairwise, and each is written to fail on the drift it rules out:
 *
 * - the rounds a run really loosed, held against `droneOrbit` tick for tick. A round's start is
 *   read out of the event ring because it is the one place it survives: by the end of the tick
 *   the projectile pass has already moved the pool, and the drone pushed the muzzle it started at
 *   into `Ev.Shot`. Put the sim's orbit back inline with a different radius and these fail.
 * - the same origins as geometry, measured against the player they are supposed to circle:
 *   exactly `ORBIT_R` off the *player*, and far enough round the ring during a run that one
 *   fixed dot could not be the answer either.
 * - and the helper on its own, since that is how a view calls it: a ring centred on whoever it is
 *   handed, one answer per (tick, player), and written into the scratch it was given rather than
 *   into a fresh object per call. Change the helper to disagree with the sim and these fail,
 *   which is the half the round checks cannot see.
 *
 * Every fixture runs with both hands empty, auto-fire off and nobody shooting back, which is what
 * makes a muzzle unambiguous: nothing but the drone can write the player's shot pool, and an
 * enemy round arrives with `a` = -1 out of a different pool. The one pass-order fact the
 * comparisons lean on is that the player's travel happens before the drone's pass and nothing
 * after it moves the player (`step.ts`), so the player position read at the end of a tick is the
 * one read in the middle of it — the walking test holds that by keeping the origin on the ring at
 * every tick of a run where the player is moving.
 */

import { describe, expect, it } from 'vitest';

import { enemyIndex } from '../../src/content/enemies';
import { POWERUPS } from '../../src/content/powerups';
import { WEAPONS } from '../../src/content/weapons';
import { createInputFrame, resetFrame, type InputFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { grantPowerup } from '../../src/sim/systems/pickups';
import { ORBIT_R, droneOrbit, type Point } from '../../src/sim/systems/drone';
import { Ev, createWorld, eventAt, type World } from '../../src/sim/world';

/**
 * The gun the drone copies, which is also how its `Ev.Shot` entries are marked (`a`).
 *
 * Read rather than written down: the pistol is index 0 today, and if a hand ever held one the
 * empty-hands assertions in `origins` are what stop its rounds being read as the drone's.
 */
const DRONE_GUN = WEAPONS.findIndex((def) => def.id === 'pistol');

/** One round's start, beside the player it was loosed from. */
interface Round {
  /** The tick that loosed it: `world.tick` once the step that ran it has finished. */
  tick: number;
  /** Where the round started, which is the question under test. */
  x: number;
  y: number;
  /** Where the player stood for that tick. */
  px: number;
  py: number;
}

/** Which quarters of the ring about the player the origins reach — one bit per side, per origin. */
function quarters(fired: Round[]): Set<number> {
  const seen = new Set<number>();
  for (const r of fired) {
    const dx = r.x - r.px;
    const dy = r.y - r.py;
    seen.add((dx >= 0 ? 1 : 0) | (dy >= 0 ? 2 : 0));
  }
  return seen;
}

/**
 * A run whose only gun is the companion: both hands empty, auto-fire off, and enough HP that
 * staying alive is not what the test is about. Empty hands are what make a round's origin mean
 * something, and `drone` is the stat the pass reads, so it arrives through the card that buys it.
 */
function droneRun(seed: number, tier: number): World {
  const w = createWorld(seed);
  w.slots[0].weapon = -1;
  w.slots[1].weapon = -1;
  w.autoFire = false;
  w.player.hp = 100_000;

  const drone = POWERUPS.findIndex((p) => p.id === 'drone');
  expect(drone, 'the ward drone card is what buys the companion').toBeGreaterThanOrEqual(0);
  for (let t = 0; t < tier; t++) {
    expect(grantPowerup(w, drone), `the drone grants up to tier ${tier}`).toBe(true);
  }
  expect(w.stats.drone, '`drone` is the rounds-a-volley stat the pass reads').toBe(tier);
  expect(w.slots.every((hand) => hand.weapon < 0), 'the run starts with both hands empty').toBe(true);
  return w;
}

/** Put a chaser down through the spawner, on enough HP to survive long enough to be shot at. */
function put(w: World, x: number, y: number): void {
  const i = spawnEnemy(w, enemyIndex('chaser'), x, y);
  expect(i, `a body at ${x},${y}`).toBeGreaterThanOrEqual(0);
  w.enemies.hp[i] = 400;
}

/**
 * Step a world tick by tick and take every drone round's origin out of the tick that loosed it.
 *
 * The event ring is where a round's *start* still lives: the drone pushes `Ev.Shot` with the
 * muzzle it loosed from, while the projectile pass has already moved the pool by the time the
 * tick ends, and a comparison against the pool would be comparing the round to where it got to.
 */
function origins(w: World, ticks: number, fill?: (f: InputFrame) => void): Round[] {
  const frame = createInputFrame();
  const out: Round[] = [];
  for (let t = 0; t < ticks; t++) {
    resetFrame(frame);
    if (fill) fill(frame);
    const before = w.events.written;
    step(w, frame);
    for (let at = before; at < w.events.written; at++) {
      const i = eventAt(w, at);
      if (i < 0) continue; // overwritten inside one long tick: not this tick's evidence
      if (w.events.type[i] !== Ev.Shot) continue;
      // The three halves of "this round is the drone's": it names the copied gun rather than
      // -1 (an enemy bolt), it names a slot rather than -1 (a hitscan or a beam has no round to
      // name), and the hands stayed empty, which is checked after the run.
      expect(w.events.a[i], 'nothing but the drone fires in these fixtures').toBe(DRONE_GUN);
      expect(w.events.b[i], 'and it names a round rather than a beam').toBeGreaterThanOrEqual(0);
      out.push({ tick: w.tick, x: w.events.x[i], y: w.events.y[i], px: w.player.x, py: w.player.y });
    }
  }
  expect(w.slots.every((hand) => hand.weapon < 0), 'and the hands stayed empty').toBe(true);
  expect(w.enemyShots.count, 'and nobody shot back: the fixture bodies are melee').toBe(0);
  expect(w.over, 'and the run was still running: a dead player stops the drone').toBe(false);
  return out;
}

describe('the rounds a run loosed, against the shared answer', () => {
  const probe: Point = { x: 0, y: 0 };

  it('looses every round from the point droneOrbit answers for that tick', () => {
    const w = droneRun(7, 3);
    for (let i = 0; i < 10; i++) put(w, Math.cos(i * 0.8) * 7, Math.sin(i * 0.8) * 7);

    const fired = origins(w, 400);
    expect(fired.length, 'a drone over a pack looses a lot of rounds').toBeGreaterThan(20);

    for (const r of fired) {
      const at = droneOrbit(r.tick, r.px, r.py, probe);
      // Exact rather than approximate, and `Math.fround` is the storage format, not a tolerance
      // chosen to fit: the ring keeps a float32 pair, so one answer written twice is
      // bit-identical with itself, while any other radius, centre or bearing is out by
      // centimetres at least.
      expect(r.x, `tick ${r.tick}: the muzzle x is the shared answer`).toBe(Math.fround(at.x));
      expect(r.y, `tick ${r.tick}: the muzzle y is the shared answer`).toBe(Math.fround(at.y));
    }
  });

  it('keeps that point off the player, so a drone drawn on the body is a different answer', () => {
    const w = droneRun(8, 2);
    for (let i = 0; i < 10; i++) put(w, Math.cos(i * 0.8) * 7, Math.sin(i * 0.8) * 7);

    const fired = origins(w, 400);
    expect(fired.length, 'and there are rounds to read').toBeGreaterThan(20);

    for (const r of fired) {
      // The ring, measured on the rounds: a muzzle written from the player's own position —
      // which is what "no drone to look at" would look like — is 0 m out, not `ORBIT_R`.
      const off = Math.hypot(r.x - r.px, r.y - r.py);
      expect(off, `tick ${r.tick}: on a ring of ${ORBIT_R} m about the player`).toBeCloseTo(ORBIT_R, 5);
      expect(off, `tick ${r.tick}: and clear of the player's own 0.4 m`).toBeGreaterThan(1);
    }

    // The ring is travelled, too: the muzzle reaches all four quarters of it during a run, so
    // a picture that drew one fixed dot would disagree with most of the run's rounds. Read off
    // the rounds rather than off the helper, so it says something about the drone.
    expect(quarters(fired).size, 'the muzzle visits every side of the player').toBe(4);
  });

  it('follows a player who is walking, so the ring is centred on them and not on the arena', () => {
    const w = droneRun(9, 3);
    // A corridor east, because the drone only spends a volley on a body inside 14 m of the
    // player, and a run worth reading needs somebody within that as the player travels.
    for (let i = 0; i < 14; i++) put(w, 6 + i * 3, i % 2 === 0 ? 1.4 : -1.4);

    const fired = origins(w, 400, (f) => {
      f.moveX = 1;
    });

    // The walk is the point: once the player is 20 m from the arena's centre, a ring drawn
    // about that centre is nowhere near the muzzle it is supposed to match, so a helper that
    // left the player's position out cannot pass this.
    expect(w.player.x, 'the player crossed most of the arena').toBeGreaterThan(20);
    expect(fired.length, 'and the drone shot on the way').toBeGreaterThan(12);

    for (const r of fired) {
      const at = droneOrbit(r.tick, r.px, r.py, probe);
      expect(r.x, `tick ${r.tick}: the ring came with the player`).toBe(Math.fround(at.x));
      expect(r.y, `tick ${r.tick}: and stayed on it`).toBe(Math.fround(at.y));
      // And the ring is the player's own, not the room's: read with the agreement checks alone,
      // a source that put the muzzle 1.35 m about the middle of the arena would agree with
      // itself all the way across the floor. A player 20 m from that middle is out of reach of
      // it, which is what this measures.
      const off = Math.hypot(r.x - r.px, r.y - r.py);
      expect(off, `tick ${r.tick}: on a ring of ${ORBIT_R} m about the player`).toBeCloseTo(ORBIT_R, 5);
    }
  });
});

describe('droneOrbit on its own, which is how a view calls it', () => {
  it('is a ring about whoever it is handed, and walks all the way round it', () => {
    // 200 ticks is a little over a full turn of the ring, which is what makes "every side" a
    // question this can answer.
    const at: Point[] = [];
    for (let t = 0; t < 200; t++) at.push({ ...droneOrbit(t, 5, -3, { x: 0, y: 0 }) });

    for (const p of at) {
      expect(Math.hypot(p.x - 5, p.y + 3), 'every answer is on the ring').toBeCloseTo(ORBIT_R, 9);
    }
    const sides = new Set(at.map((p) => (p.x >= 5 ? 1 : 0) | (p.y >= -3 ? 2 : 0)));
    expect(sides.size, 'and it reaches every side of the player it was handed').toBe(4);
  });

  it('moves with the player it is handed, and takes their position seriously', () => {
    for (const t of [0, 1, 7, 37, 61, 199]) {
      const here = droneOrbit(t, 0, 0, { x: 0, y: 0 });
      const there = droneOrbit(t, -12.5, 8.25, { x: 0, y: 0 });
      expect(there.x - here.x, `tick ${t}: the whole ring moved east`).toBeCloseTo(-12.5, 9);
      expect(there.y - here.y, `tick ${t}: and north`).toBeCloseTo(8.25, 9);
    }
  });

  it('is the same answer every time, written into the scratch it was given', () => {
    // A view that blends two ticks asks twice a frame, and `loop.test.ts` counts what the frame
    // loop allocates, so the pair comes out of the caller's object rather than a new one.
    const scratch: Point = { x: 0, y: 0 };
    for (const [tick, px, py] of [
      [0, 0, 0],
      [24, 3, -4],
      [400, -17.5, 22.25],
    ] as const) {
      const first = { ...droneOrbit(tick, px, py, scratch) };
      expect(droneOrbit(tick, px, py, scratch), `tick ${tick}: and goes into the scratch`).toBe(
        scratch,
      );
      expect(scratch.x, `tick ${tick}: the same x when asked again`).toBe(first.x);
      expect(scratch.y, `tick ${tick}: the same y when asked again`).toBe(first.y);
    }
  });

  it('is far enough from its own answer one tick back that a stale read cannot pass', () => {
    // The teeth in the equality checks above. A view that drew the drone where it was last
    // frame, or a state read taken a tick behind the muzzle, is the other way this seam goes
    // wrong, and it would slip through if one tick of orbit were smaller than the float32 the
    // event ring stores in. It is not: a tick turns the bearing 0.05 rad, which is 67 mm of
    // chord, and every round here is required to notice.
    const w = droneRun(10, 3);
    for (let i = 0; i < 10; i++) put(w, Math.cos(i * 0.8) * 7, Math.sin(i * 0.8) * 7);
    const fired = origins(w, 400);
    expect(fired.length, 'and there are rounds to read').toBeGreaterThan(20);

    const scratch: Point = { x: 0, y: 0 };
    for (const r of fired) {
      const now = { ...droneOrbit(r.tick, r.px, r.py, scratch) };
      const last = droneOrbit(r.tick - 1, r.px, r.py, scratch);
      const gap = Math.hypot(now.x - last.x, now.y - last.y);
      expect(gap, `tick ${r.tick}: one tick behind is a different point`).toBeGreaterThan(1e-3);
    }
  });
});