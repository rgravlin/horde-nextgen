/**
 * How a run earns the ward drone: a crate a chapter puts down, on a route, at a place.
 *
 * Every other test in the drone's corner of the suite *hands the companion to the fixture* —
 * `drone.test.ts` and `droneView.test.ts` call `grantPowerup`, the browser spec used
 * `__forgeDebug.givePowerup`. That is the right way to test a mechanism and no way at all to ask
 * whether a player can ever have one, and before this file the answer was mostly no: the only
 * door into the drone was the level-up offer, three cards drawn out of thirty, so a run could
 * clear all ten chapters and never once be offered the companion. A power-up nobody meets is not
 * balanced, it is absent.
 *
 * What the change adds is data plus one branch, so the checks below are about a route:
 *
 * - chapter 1 declares a crate holding the drone at a point on its opening route
 *   (`content/levels/chapters-1-3.ts`), and a chapter's declared crates go down with its floor —
 *   `placeSupply`, called from `startFloor` in `systems/levels.ts`, before the clock starts;
 * - a crate that was *told* what it holds pays that card instead of rolling one (`payChest`),
 *   which is the difference between "the crate south-east of the spawn holds the drone" being a
 *   fact a player can learn and being a coin flip they cannot.
 *
 * Controls run beside nearly every claim, in the style `levels-split.test.ts` sets: the same
 * floor with the crate taken back out, the same fixture with nothing to fire, the same run twice
 * to show nothing was rolled. A route is only worth asserting because a run that does not walk it
 * ends up without the drone, and that difference *is* the change.
 */

import { describe, expect, it } from 'vitest';

import { enemyIndex } from '../../src/content/enemies';
import { levelAt, type SupplyDef } from '../../src/content/levels';
import { powerupIndex } from '../../src/content/powerups';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { hashWorld } from '../../src/sim/hash';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { canTravel } from '../../src/sim/systems/obstacles';
import { startArena, startChapter } from '../../src/sim/systems/levels';
import { Holds, dropChest, placeSupply } from '../../src/sim/systems/pickups';
import { Ev, TUNE, countAlive, createWorld, eventAt, release, type World } from '../../src/sim/world';

/** The card chapter 1 hands out, and the index it holds in the table. */
const DRONE_ID = 'drone';
const DRONE = powerupIndex(DRONE_ID);

/** Where a run is dropped, and how long a route gets before it counts as unreachable. */
const SPAWN = { x: 0, y: 0 };
const WALK_TICKS = 1_000;

/** The crates a chapter declares, read off the chapter rather than copied into the test. */
function declared(chapter = 0): readonly SupplyDef[] {
  return levelAt(chapter).supply ?? [];
}

/**
 * The bay's one declared crate, with its existence checked rather than assumed.
 *
 * The route tests steer at this point, and taking it with `[0]!` would turn somebody else's edit
 * — the crate moved off the floor, the field renamed, a chapter rewritten — into a TypeError four
 * tests deep instead of one message that says the chapter stopped declaring anything.
 */
function bayCrate(): SupplyDef {
  const rows = declared(0);
  expect(rows.length, 'the bay declares one crate, and the route below walks to it').toBe(1);
  return rows[0]!;
}

/**
 * What is on the floor, as data.
 *
 * Read from the pool instead of counted, because the interesting half of "there is one crate" is
 * which card it holds and where it stands — the two things a seed must not be allowed to decide.
 */
function crates(w: World): { x: number; y: number; state: number; kind: number }[] {
  const out: { x: number; y: number; state: number; kind: number }[] = [];
  for (let i = 0; i < w.chests.cap; i++) {
    if (w.chests.alive[i] === 0) continue;
    out.push({
      x: w.chests.x[i]!,
      y: w.chests.y[i]!,
      state: w.chests.state[i]!,
      kind: w.chests.kind[i]!,
    });
  }
  return out;
}

/** Take every crate back off the floor: how a control's chapter is built. */
function strip(w: World): void {
  for (let i = 0; i < w.chests.cap; i++) if (w.chests.alive[i] === 1) release(w.chests, i);
  expect(countAlive(w.chests), 'the control floor declares nothing').toBe(0);
}

/** What the drone ended up worth, as the stat the companion's pass reads. */
function droneTier(w: World): number {
  return w.stats.drone;
}

/** What a drive collected: when the drone arrived, and what it spent afterwards. */
interface Driven {
  /** The tick the companion arrived, -1 if it never did. */
  pickedAt: number;
  /** Metres from the player to the nearest crate at that moment, Infinity if it never moved. */
  pickedNear: number;
  /** Rounds loosed from more than a metre off the player. */
  rounds: number;
}

/**
 * Steer at `target` for `ticks` and take the facts this file cares about out of the run.
 *
 * The heading is recomputed from the player's live position every tick rather than scripted as a
 * key sequence: what is under test is whether the crate can be *walked to*, and a fixed move
 * script measures its own choreography — a route that only worked for one pre-baked sequence of
 * keys would pass that and prove nothing. Inside 0.15 m the frame goes quiet, so a run stops
 * beside the crate instead of orbiting it. Pass the spawn point for a run that stands still.
 *
 * HP is refilled on every tick, the concession `playChapter` and `drone.test.ts` both make: a
 * fixture shot dead on the way reports the fight rather than the route.
 *
 * `rounds` counts rounds that began more than a metre off the player. With both hands emptied
 * that number means the companion and nothing else — a player round starts inside the metre, at
 * `TUNE.playerRadius + TUNE.shotStart`, and an enemy bolt arrives with `a` = -1 — so a control's
 * zero is the same measurement as a run's dozen, not a weaker claim. The crate's distance is
 * taken *before* the tick that opened it, which is one tick of travel more than the radius the
 * crate actually opened at: the assertions below leave room for that and say why.
 */
function drive(w: World, ticks: number, target: { x: number; y: number }): Driven {
  const f = createInputFrame();
  const out: Driven = { pickedAt: -1, pickedNear: Infinity, rounds: 0 };

  for (let t = 0; t < ticks; t++) {
    resetFrame(f);
    const dx = target.x - w.player.x;
    const dy = target.y - w.player.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.15) {
      f.moveX = dx / d;
      f.moveY = dy / d;
    }
    w.player.hp = 1_000_000;

    let near = Infinity;
    for (const c of crates(w)) {
      const at = Math.hypot(c.x - w.player.x, c.y - w.player.y);
      if (at < near) near = at;
    }

    const before = w.events.written;
    step(w, f);

    for (let at = before; at < w.events.written; at++) {
      const i = eventAt(w, at);
      if (i < 0 || w.events.type[i] !== Ev.Shot) continue;
      const off = Math.hypot(w.events.x[i]! - w.player.x, w.events.y[i]! - w.player.y);
      if (off > 1) out.rounds++;
    }

    if (out.pickedAt < 0 && droneTier(w) > 0) {
      out.pickedAt = w.tick;
      out.pickedNear = near;
    }
  }

  return out;
}

/**
 * Chapter 1, played.
 *
 * `stripped` is the control: the same floor, seed and walk with the declared crate taken back off
 * the floor. Written as an option on the fixture rather than as a second fixture so the pair
 * cannot drift apart in anything but the one thing being measured.
 */
function bayRun(seed: number, opts: { stripped?: boolean } = {}): World {
  const w = createWorld(seed);
  startChapter(w, 0);
  w.autoFire = false;
  if (opts.stripped) strip(w);
  return w;
}

describe('the crate a chapter declares', () => {
  it('is on the floor the moment the bay loads, on every seed tried', () => {
    expect(DRONE, 'the ward drone is a card before it is a route').toBeGreaterThanOrEqual(0);
    const at = declared(0);
    expect(at.length, 'the bay declares supply').toBe(1);

    for (const seed of [1, 5, 42, 777, 0x2000]) {
      const w = createWorld(seed);
      startChapter(w, 0);

      const on = crates(w);
      expect(on.length, `seed ${seed}: the crate is there`).toBe(1);
      expect(on[0]!.x, `seed ${seed}: where the chapter said`).toBe(at[0]!.x);
      expect(on[0]!.y, `seed ${seed}: where the chapter said`).toBe(at[0]!.y);
      expect(on[0]!.state, `seed ${seed}: it says which table its card came from`).toBe(
        Holds.Powerup,
      );
      expect(on[0]!.kind, `seed ${seed}: and which card`).toBe(DRONE);
      expect(w.tick, 'it went down with the room, not with the clock').toBe(0);
    }
  });

  it('arrives through the chapter door, which is why a bare World and the arena have none', () => {
    // The control for the test above, and the reason the crate is not a field on `World`: the
    // paused arena and every bare-`World` fixture are meant to be *empty* rather than quietly
    // chapter 1 (`systems/levels.ts`), so a declared crate must not be reachable from
    // `createWorld` itself.
    expect(countAlive(createWorld(3).chests), 'a fixture floor declares nothing').toBe(0);

    const arena = createWorld(3);
    startArena(arena);
    expect(
      countAlive(arena.chests),
      'and neither does the arena: a room to be measured in, not a route to be walked',
    ).toBe(0);
  });

  it('names a card the power-up table holds, in every chapter that declares one', () => {
    // `placeSupply` turns a name into an index through `powerupIndex`, so an id the table does
    // not hold is not a crash — it is a crate that quietly rolls something else, which is the
    // exact mistake the field exists to prevent. Pinned here because the alternative is a chapter
    // that hands out a random card and nothing that can tell.
    for (let i = 0; i < 10; i++) {
      for (const row of declared(i)) {
        expect(powerupIndex(row.powerup), `${levelAt(i).id} declares ${row.powerup}`).toBeGreaterThan(
          -1,
        );
      }
    }
  });

  it('leaves a rolled crate when a chapter mistypes the card', () => {
    // The other half of the same rule: a mistyped name costs a card, not the crate, the way a
    // mistyped archetype falls back to the default body in `waves.ts`. Level data gets mistyped;
    // the test above is what stops that hiding, and this one is what says the floor still pays
    // something when it does.
    const w = bayRun(11);
    strip(w);
    placeSupply(w, [{ x: 0.6, y: 0, powerup: 'no such card' }]);

    const on = crates(w);
    expect(on.length).toBe(1);
    expect(on[0]!.state, 'an id that matches nothing rolls').toBe(Holds.Roll);
    expect(on[0]!.kind, 'and leaves no card index in the slot beside it').toBe(0);

    const walked = drive(w, 2, SPAWN);
    expect(countAlive(w.chests), 'and it was opened').toBe(0);
    expect(w.slots[1].weapon, 'so it paid the way a rolled crate pays').toBeGreaterThanOrEqual(0);
    expect(droneTier(w), 'and not the card the chapter meant to name').toBe(0);
    expect(walked.pickedAt, 'a rolled crate is not a drone, whatever it rolls').toBe(-1);
  });

  it('pays a declared card into an empty hand, which is what "declared" has to mean', () => {
    // `payChest` fills an empty hand first and only then considers a card, and that order is
    // right for a rolled crate — a second gun beats a third tier of something already run. For a
    // declared crate it would be a lie: a run that walked to a crate marked *ward drone* and got
    // a shotgun did not walk to a drone. So the declared branch runs first, and these two fixtures
    // are what tell the branches apart: the same crate slot, one side named and one not, both
    // with nobody holding a gun.
    const named = createWorld(81);
    const rolled = createWorld(82);
    for (const w of [named, rolled]) {
      w.slots[0].weapon = -1;
      w.slots[1].weapon = -1;
    }
    expect(dropChest(named, 0.6, 0, DRONE), 'a named crate is still a crate').toBe(true);
    expect(dropChest(rolled, 0.6, 0)).toBe(true);

    drive(named, 2, SPAWN);
    drive(rolled, 2, SPAWN);

    expect(named.powerTiers[DRONE], 'the named one handed the card over').toBe(1);
    expect(droneTier(named), 'and the companion is running').toBe(1);
    expect(named.slots.every((hand) => hand.weapon < 0), 'without spending the hand first').toBe(
      true,
    );
    expect(rolled.slots.some((hand) => hand.weapon >= 0), 'the rolled one spent the hand').toBe(
      true,
    );
    expect(rolled.powerTiers[DRONE], 'and rolled past the drone').toBe(0);
  });
});

describe('the route that buys it', () => {
  it('hands the drone to a run that walks the bay, inside its first five seconds', () => {
    const at = bayCrate();
    const w = bayRun(21);
    expect(droneTier(w), 'a run that stands still starts with no companion').toBe(0);
    const run = drive(w, WALK_TICKS, { x: at.x, y: at.y });

    expect(run.pickedAt, 'the crate was walked onto').toBeGreaterThan(0);
    expect(
      run.pickedAt,
      'and early enough to be part of the chapter rather than an errand after it',
    ).toBeLessThan(300);
    // Read before the tick that opened it, so it carries one tick of travel: 0.15 m of it, and
    // the crate opens at 1.2 m. The claim is that the grant happened *at the crate*.
    expect(run.pickedNear, 'at the crate, not somewhere lucky').toBeLessThan(
      TUNE.chestOpenRadius + 0.2,
    );
    expect(droneTier(w), 'and the run ends with one').toBe(1);
  });

  it('is worth walking: the same floor with the crate taken out never gives one', () => {
    // The pair that makes the route a fact. Both runs get the same seed, the same floor, the same
    // steering and the same length, and one of them has a drone to walk to; the only way this
    // passes is if the crate is what paid.
    const at = bayCrate();
    const target = { x: at.x, y: at.y };
    const run = bayRun(41);
    const control = bayRun(41, { stripped: true });
    expect(droneTier(run) + droneTier(control), 'neither starts with one').toBe(0);

    const a = drive(run, WALK_TICKS, target);
    const b = drive(control, WALK_TICKS, target);

    expect(a.pickedAt, 'the crate was walked onto').toBeGreaterThan(0);
    expect(droneTier(run), 'the walk bought one').toBe(1);
    expect(droneTier(control), 'and the same walk on a floor that declares nothing did not').toBe(
      0,
    );
    expect(b.pickedAt, 'the control never even opened a crate').toBe(-1);
  });

  it('is the same route on every seed, and the same run twice', () => {
    // Two halves of one claim: a route may not be dealt. The first walks it at five seeds, the
    // second replays one and compares fingerprints — `hashWorld` folds the crate pool, so an
    // identical pair says the crate is not a thing the rng gets to place.
    const at = bayCrate();
    const target = { x: at.x, y: at.y };
    for (const seed of [1, 5, 42, 777, 0x2000]) {
      const run = drive(bayRun(seed), WALK_TICKS, target);
      expect(run.pickedAt, `seed ${seed}: the crate was not dealt`).toBeGreaterThan(0);
    }

    const first = bayRun(31);
    const twice = bayRun(31);
    drive(first, 600, target);
    drive(twice, 600, target);
    expect(hashWorld(twice), 'the same seed and the same keys are the same run').toBe(
      hashWorld(first),
    );
  });

  it('is a walk the bay was shaped for, not a wall the test happens to slide along', () => {
    // The straight line is what a held key takes, and it is the thing the bay's comment claims:
    // the twelve metres down +x stay clear, and the crate is a pickup rather than cover. Read off
    // the chapter's own geometry, so putting a wall across the route is a failure here rather
    // than a scenario that quietly stops making sense.
    const at = bayCrate();
    const w = bayRun(5);
    const dx = at.x - SPAWN.x;
    const dy = at.y - SPAWN.y;
    const len = Math.hypot(dx, dy);
    expect(len, 'under eighteen metres of floor').toBeLessThan(18);
    expect(len / TUNE.moveSpeed, 'under three seconds each way at walking pace').toBeLessThan(3);

    const ux = dx / len;
    const uy = dy / len;
    let blocked = -1;
    for (let d = 0; d + 0.25 <= len + 1e-9; d += 0.25) {
      const x = SPAWN.x + ux * d;
      const y = SPAWN.y + uy * d;
      if (!canTravel(w.props, x, y, ux * 0.25, uy * 0.25, TUNE.playerRadius)) {
        blocked = d;
        break;
      }
    }
    expect(blocked, `the straight line stops short at ${blocked} m`).toBe(-1);

    // And the walk itself, with everything the floor owns running: bodies, the clock, the lot.
    const w2 = bayRun(61);
    expect(droneTier(w2), 'a run that stands still starts with no companion').toBe(0);
    const run = drive(w2, WALK_TICKS, { x: at.x, y: at.y });
    expect(run.pickedAt, 'a run that starts for the crate gets there').toBeGreaterThan(0);
    expect(droneTier(w2), 'and gets it by walking, on a floor full of bodies too').toBe(1);
  });
});

describe('what the drone does once it is bought', () => {
  it('fires, and the same floor with nothing to fire does not', () => {
    // The pair this file exists for. Both fixtures are a bare floor — no chapter, so the wave
    // spawner never runs and the only way either can acquire the drone is the crate the test
    // declares — with both hands emptied, so the only way anything fires is the companion. One
    // ring of bodies, one walk, the crate on one side only.
    const crate = { x: 14, y: -10 };
    const withCrate = arenaFixture(71, crate);
    const without = arenaFixture(72, undefined);

    const a = drive(withCrate, 600, crate);
    const b = drive(without, 600, crate);

    expect(a.pickedAt, 'the crate was walked onto').toBeGreaterThan(0);
    expect(droneTier(withCrate), 'and paid the companion').toBe(1);
    expect(a.rounds, 'a drone over a pack looses a lot of rounds').toBeGreaterThan(12);
    expect(b.rounds, 'and every one of them is the drone: the same run without one fires nothing')
      .toBe(0);
    for (const [name, w] of [
      ['with', withCrate],
      ['without', without],
    ] as const) {
      expect(
        w.slots.every((hand) => hand.weapon < 0),
        `${name}: the hands stayed empty, which is what makes the round count mean the drone`,
      ).toBe(true);
    }
  });
});

/**
 * A floor with no chapter under it, bodies placed by hand, and optionally the drone crate.
 *
 * No `startChapter` on purpose: the wave spawner drops rolled crates, and the pair above is about
 * a *declared* one. Sixteen chasers in a ring about the crate are what give the companion
 * something to spend a volley on once the run stops beside it; they are melee, so nothing shoots
 * back and a round's origin stays unambiguous.
 */
function arenaFixture(seed: number, crate: { x: number; y: number } | undefined): World {
  const w = createWorld(seed);
  w.slots[0].weapon = -1;
  w.slots[1].weapon = -1;
  w.autoFire = false;
  expect(w.slots.every((hand) => hand.weapon < 0)).toBe(true);

  if (crate !== undefined) placeSupply(w, [{ x: crate.x, y: crate.y, powerup: DRONE_ID }]);
  const at = crate ?? { x: 14, y: -10 };
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const made = spawnEnemy(w, enemyIndex('chaser'), at.x + Math.cos(a) * 7, at.y + Math.sin(a) * 7);
    expect(made, `a body at leg ${i}`).toBeGreaterThanOrEqual(0);
    w.enemies.hp[made] = 400;
  }
  return w;
}
