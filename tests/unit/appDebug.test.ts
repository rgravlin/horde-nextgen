/**
 * `__forgeDebug.givePowerup(id, tier)`: the door that puts a card on a scripted run.
 *
 * The door exists because a scenario cannot shop. The three cards on offer at a level-up are dealt
 * out of the pool at random and a step list can only press keys and click things, so a scene that
 * wants the ward drone has to say so rather than hope to be handed it. It takes a *tier* for the
 * same reason it takes an id: a card only means something at one. The companion's rounds-a-volley
 * is its tier, so a door that handed out one copy whatever was asked could put a drone on a floor
 * but could not put a difference on one, and every check that compares a run with the card against
 * a run without it would be measuring a fixed 1.
 *
 * So the checks below are about the tier arriving, and about it arriving the way a pick would:
 *
 * - the volley a run looses, counted out of the event ring, held against the tier that was asked
 *   for. `stats.drone` is read by the companion's pass and nowhere else, so the count is the
 *   effect rather than a number beside it, and the paired control run (the card left on the floor)
 *   is what makes the count mean the card.
 * - where the rounds start. Granting the card has to leave the companion shooting off the ring
 *   `droneOrbit` answers, not off the player it circles — which is the seam `drone.test.ts` pins
 *   from the sim side and `drone.spec.ts` from the drawn one; here it is pinned from the door, so
 *   a grant that skipped the pass would not read as a grant.
 * - a timed card's clock, which only comes along if the grant goes through `grantPowerup`. Writing
 *   the tier straight into the array would leave the clock at 0, and `recomputeStats` skips a
 *   timed card with no clock, so the run would read granted in the tiers and ungranted in play.
 * - and refusals: no such card, a tier above the ceiling, one the run already holds, one that is
 *   not a whole number. Each answers false with the run *unchanged* — fingerprinted and compared,
 *   not merely asserted not to have thrown — because a part-grant reported as done is a different
 *   run than the one the scenario asked for, which is the failure this door is here to prevent.
 *
 * Every fixture runs with both hands empty, auto-fire off and only melee bodies on the floor, for
 * the reason `drone.test.ts` gives: that is what makes a round's origin and a volley's size mean
 * the companion rather than somebody else's gun.
 */

import { describe, expect, it } from 'vitest';

import { enemyIndex } from '../../src/content/enemies';
import { POWERUPS, baseStats } from '../../src/content/powerups';
import { WEAPONS } from '../../src/content/weapons';
import { createApp } from '../../src/game/app';
import { createDebug, type DebugHost } from '../../src/game/appDebug';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { hashWorld } from '../../src/sim/hash';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { grantPowerup } from '../../src/sim/systems/pickups';
import { droneOrbit, type Point } from '../../src/sim/systems/drone';
import { Ev, createWorld, eventAt, type World } from '../../src/sim/world';

/**
 * The gun the companion copies, which is also how its `Ev.Shot` entries are marked (`a`).
 *
 * Read off the table rather than written down: a round whose `a` is anything else is somebody
 * else's, and the empty hands below are what makes that reading hold.
 */
const DRONE_GUN = WEAPONS.findIndex((def) => def.id === 'pistol');

/** The card's index in `POWERUPS`, which is where the run keeps its tiers. Keeps ids out of the assertions. */
function card(id: string): number {
  const at = POWERUPS.findIndex((def) => def.id === id);
  expect(at, `the table should hold a '${id}'`).toBeGreaterThanOrEqual(0);
  return at;
}

/** The door over one world — which is all it reads, through the host's `world()`. */
function doorOver(w: World) {
  const host: DebugHost = {
    world: () => w,
    frame: createInputFrame(),
    restart: () => {},
    arenaRun: () => {},
    arm: () => {},
    backend: 'none',
    now: () => 0,
  };
  return createDebug(host);
}

/**
 * A running arena whose only gun is the companion's, with eight bodies inside its reach.
 *
 * Both hands start empty and auto-fire is off, so every round in the air came from the companion;
 * the bodies are chasers, who answer with their bodies, so nothing shoots back at the player and a
 * run that survives to the last tick is a run whose rounds are all readable. Eight at 5 m keeps
 * somebody within the companion's 14 m for most of a run — it spends a volley on what the query
 * finds, and on an empty floor there is no round to count.
 */
function arena(seed: number): World {
  const w = createWorld(seed);
  w.slots[0].weapon = -1;
  w.slots[1].weapon = -1;
  w.autoFire = false;
  w.player.hp = 100_000;

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const at = spawnEnemy(w, enemyIndex('chaser'), Math.cos(a) * 5, Math.sin(a) * 5);
    expect(at, `a body at ${Math.cos(a) * 5},${Math.sin(a) * 5}`).toBeGreaterThanOrEqual(0);
    // Enough HP that a round hitting one is not also the reason it stops being a target, which is
    // what lets a volley's size be read as the tier rather than as however many bodies were left.
    w.enemies.hp[at] = 400;
  }
  return w;
}

/** One round the companion loosed: the tick that loosed it, and where it started. */
interface Round {
  /** The tick, as `world.tick` reads once the step that loosed it has finished. */
  tick: number;
  x: number;
  y: number;
  /** Where the player stood for that tick, which is what the ring is centred on. */
  px: number;
  py: number;
}

/**
 * Step `ticks` and take every companion round's start out of the tick that loosed it.
 *
 * The event ring is the one place a round's *start* survives: by the end of the tick the projectile
 * pass has moved the pool, and the companion pushed the muzzle it began at into `Ev.Shot`.
 */
function rounds(w: World, ticks: number): Round[] {
  const frame = createInputFrame();
  const out: Round[] = [];
  for (let t = 0; t < ticks; t++) {
    resetFrame(frame);
    const before = w.events.written;
    step(w, frame);
    for (let at = before; at < w.events.written; at++) {
      const i = eventAt(w, at);
      if (i < 0) continue; // overwritten inside one long tick: not this tick's evidence
      if (w.events.type[i] !== Ev.Shot) continue;
      // Both halves of "this round is the companion's", asserted rather than used to filter: a
      // round from anywhere else would otherwise be counted as one of his.
      expect(w.events.a[i], 'nothing but the companion fires in these fixtures').toBe(DRONE_GUN);
      expect(w.events.b[i], 'and it names a round rather than a beam').toBeGreaterThanOrEqual(0);
      out.push({ tick: w.tick, x: w.events.x[i], y: w.events.y[i], px: w.player.x, py: w.player.y });
    }
  }
  expect(w.slots.every((hand) => hand.weapon < 0), 'and the hands stayed empty').toBe(true);
  expect(w.enemyShots.count, 'and nobody shot back').toBe(0);
  expect(w.over, 'and the run was still running').toBe(false);
  return out;
}

/** The largest single-tick volley in a run: the tier, counted off the floor rather than off the stat. */
function biggestVolley(fired: Round[]): number {
  const perTick = new Map<number, number>();
  for (const r of fired) perTick.set(r.tick, (perTick.get(r.tick) ?? 0) + 1);
  let biggest = 0;
  for (const n of perTick.values()) if (n > biggest) biggest = n;
  return biggest;
}

/** Which sides of the player the rounds were loosed from — one bit per axis, per round. */
function sides(fired: Round[]): Set<number> {
  const seen = new Set<number>();
  for (const r of fired) {
    seen.add((r.x - r.px >= 0 ? 1 : 0) | (r.y - r.py >= 0 ? 2 : 0));
  }
  return seen;
}

/** Nothing a refused door did may have changed: the tiers, the clocks and the folded block. */
function untouched(w: World): void {
  expect([...w.powerTiers].every((tier) => tier === 0), 'no card on the run').toBe(true);
  expect(w.powerTime.every((left) => left === 0), 'and no dose on a clock').toBe(true);
  expect(w.stats, 'and the block still folded from nothing').toEqual(baseStats());
}

describe('the tier a card is granted at', () => {
  it('puts the companion in at the tier it was asked for, and the volley is that tier', () => {
    // One round a volley is the companion at tier 1 and three is him at tier 3, which is the only
    // way this file can tell the door apart from a door that always granted one copy: the stat and
    // the rounds have to move together, and the control run has to show neither.
    const one = arena(7);
    expect(doorOver(one).givePowerup('drone', 1)).toBe(true);
    expect(one.stats.drone, 'the rounds-a-volley stat the pass reads').toBe(1);
    expect(biggestVolley(rounds(one, 400)), 'one round a volley at tier 1').toBe(1);

    const three = arena(7);
    expect(doorOver(three).givePowerup('drone', 3)).toBe(true);
    expect(three.stats.drone).toBe(3);
    expect(biggestVolley(rounds(three, 400)), 'and three at tier 3').toBe(3);

    // The control: the same arena, the same seed, the card left on the floor. Without it the two
    // counts above would only say that a run looses rounds.
    const none = arena(7);
    expect(none.stats.drone, 'no card, so no companion').toBe(0);
    expect(rounds(none, 400), 'and nothing fired').toHaveLength(0);
  });

  it('looses the rounds it granted from the ring, not off the player', () => {
    const w = arena(7);
    expect(doorOver(w).givePowerup('drone', 3)).toBe(true);
    const fired = rounds(w, 400);
    expect(fired.length, 'a companion over a pack looses a lot of rounds').toBeGreaterThan(20);

    const probe: Point = { x: 0, y: 0 };
    for (const r of fired) {
      const at = droneOrbit(r.tick, r.px, r.py, probe);
      // Exact, and `Math.fround` is the storage format rather than a tolerance chosen to fit: the
      // ring is kept in float32, so one answer written twice is bit-identical with itself, while a
      // second copy of the orbit maths is free to pick another radius or bearing and is out by
      // centimetres at least.
      expect(r.x, `tick ${r.tick}: the round started at the shared answer`).toBe(Math.fround(at.x));
      expect(r.y, `tick ${r.tick}: and nowhere else`).toBe(Math.fround(at.y));
      // The flat answer this door used to be able to fall back to — a muzzle at the player's own
      // body, which is what a grant that never reached the pass would look like from out here — is
      // 0 m out, not one ring out.
      const off = Math.hypot(r.x - r.px, r.y - r.py);
      expect(off, `tick ${r.tick}: one ring out, not at the body it circles`).toBeGreaterThan(1);
    }

    expect(sides(fired).size, 'and the ring was travelled, not stood on').toBe(4);
  });

  it('doses a timed card at the tier it was asked for, clock and all', () => {
    // Adrenaline folds a multiplier *and* runs a clock, and both come out of `grantPowerup`, so
    // this is the check that the door goes through the sim's grant instead of writing the tier it
    // was handed. A bare `powerTiers[i] = 2` leaves the clock at 0, `recomputeStats` skips a timed
    // card whose clock is 0, and the run reads granted while it plays ungranted.
    const w = arena(7);
    expect(doorOver(w).givePowerup('adrenaline', 2)).toBe(true);
    const at = card('adrenaline');
    expect(POWERUPS[at].kind, 'the card this test is about is a timed one').toBe('timed');
    expect(w.powerTiers[at], 'two tiers').toBe(2);
    expect(w.powerTime[at], 'dosed for its 20 s').toBeCloseTo(20, 6);
    expect(w.stats.dmg, '1 + 0.45 per tier, at tier 2').toBeCloseTo(1.9, 6);
    expect(w.stats.speed, 'and the rest of the dose, not a fraction of it').toBeCloseTo(1.3, 6);

    // A window, not a permanent: past the 20 s the fold is back off the block, which is only
    // possible because the grant put the dose on a clock in the first place.
    const frame = createInputFrame();
    for (let t = 0; t < 1205; t++) {
      resetFrame(frame);
      step(w, frame);
    }
    expect(w.powerTime[at], 'the clock ran out').toBe(0);
    expect(w.stats.dmg, 'and the block folded again without it').toBe(1);
  });
});

describe('what the door refuses', () => {
  it('refuses a card that is not on the table, and changes nothing', () => {
    const w = arena(7);
    const at = doorOver(w);
    // A name off the table is a refused grant rather than a card nobody asked for: `giveWeapon`
    // refuses on the same terms, and the same reason is what keeps a typo from becoming a buff.
    expect(at.givePowerup('jetpack', 3)).toBe(false);
    expect(at.givePowerup('', 1)).toBe(false);
    untouched(w);
  });

  it('refuses a tier the card does not reach, and does not grant part of it', () => {
    const w = arena(7);
    const at = doorOver(w);
    expect(POWERUPS[card('drone')].maxTier, 'the companion tops out at five').toBe(5);
    // Six was not available, so six is not what the run gets: half of a grant is a different run
    // than the one that was asked for, with a `true` on top of it.
    expect(at.givePowerup('drone', 6)).toBe(false);
    untouched(w);

    // And the refusal was about the six rather than about the card: the ceiling itself is grantable.
    expect(at.givePowerup('drone', 5)).toBe(true);
    expect(w.powerTiers[card('drone')]).toBe(5);
    expect(w.stats.drone).toBe(5);
  });

  it('refuses a tier the run already holds, and a tier that is not a tier', () => {
    const w = arena(7);
    const at = doorOver(w);
    expect(at.givePowerup('drone', 3)).toBe(true);
    const before = hashWorld(w);

    // `3` is what the run already holds, so the call could only do nothing; below the ceiling and
    // above what is held is the same nothing from the other side. Both have to say so, because a
    // door that reported `true` while doing nothing is how a scripted scene believes it owns a
    // different run than the one it is standing in.
    for (const tier of [3, 2, 1, 0, -1, 1.5, NaN, Infinity]) {
      expect(at.givePowerup('drone', tier), `tier ${String(tier)}`).toBe(false);
    }
    expect(w.powerTiers[card('drone')], 'and the run stayed at three').toBe(3);
    expect(hashWorld(w), 'no call above touched the run').toBe(before);
  });
});

describe('the door as a scene sets a scene up with it', () => {
  it('runs the run the same number of level-up picks would have run', () => {
    const door = arena(7);
    const picks = arena(7);
    expect(doorOver(door).givePowerup('drone', 3)).toBe(true);
    const drone = card('drone');
    for (let t = 0; t < 3; t++) {
      expect(grantPowerup(picks, drone), 'three picks of the same card').toBe(true);
    }
    // Identical before a single tick runs, so what the two runs do next is about the door.
    expect(hashWorld(door), 'the tiers, the clocks and the block are one door').toBe(
      hashWorld(picks),
    );

    const played = (w: World): number => {
      const frame = createInputFrame();
      for (let t = 0; t < 400; t++) {
        resetFrame(frame);
        step(w, frame);
      }
      return hashWorld(w);
    };
    const armed = played(door);
    expect(played(picks), 'so 400 ticks later they are still one run').toBe(armed);

    // The teeth in the equality above: the run the door said no to is a different run, which is
    // the only way to read "refused, and nothing happened" as different from "granted at six".
    const refused = arena(7);
    expect(doorOver(refused).givePowerup('drone', 6)).toBe(false);
    expect(played(refused), 'and a refusal leaves the run alone').not.toBe(armed);
  });

  it('reaches the state a scenario reads back, at the tier it went in at', () => {
    // `__forgeState().powerups` is what a browser scenario asserts on and what `drone.spec.ts`
    // uses to tell the armed run from its control, and it lists a card with its tier. So the tier
    // has to survive the trip from `__forgeDebug` through the sim's grant into the snapshot —
    // which is the whole chain, app and all, that the unit fixtures above shorten.
    const app = createApp({ view: null, hud: null, seed: 5, backend: 'none', storage: null });
    expect(app.state().powerups, 'a fresh run owns no cards').toEqual([]);

    expect(app.debug.givePowerup('drone', 2)).toBe(true);
    expect(app.state().powerups).toEqual([{ id: 'drone', tier: 2 }]);

    // A refused tier reports in the state the same way the absence of one does, which is what the
    // control half of `drone.spec.ts` reads.
    const other = createApp({ view: null, hud: null, seed: 5, backend: 'none', storage: null });
    expect(other.debug.givePowerup('drone', 9)).toBe(false);
    expect(other.state().powerups).toEqual([]);
  });
});