/**
 * Power-ups: the run's folded stat block, and the two reward doors that feed it.
 *
 * The unit tests here are written against *outcomes*, not against the arithmetic in
 * `content/powerups.ts`: a card that changes a number nobody reads is a card that lies,
 * so each test drives the sim until the effect is visible in the world (a body that
 * died, HP that came back, a gun in the second hand). Two of them are paired with a
 * control run — the same world with the card left on the floor — because "the number
 * moved" only means something next to "and it would not have otherwise".
 *
 * The harness is the one `combat.test.ts` uses: `place` puts a real archetype down
 * through the same `spawnEnemy` the spawner uses, and `run` steps the world with one
 * reused `InputFrame`, so nothing here touches a DOM, a canvas or a wall clock.
 */

import { describe, expect, it } from 'vitest';
import { POWERUPS, baseStats } from '../../src/content/powerups';
import { createInputFrame, resetFrame, type InputFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { dropChest, grantPowerup } from '../../src/sim/systems/pickups';
import { startWaves } from '../../src/sim/systems/waves';
import { Ev, TUNE, countAlive, countEvents, createWorld, type World } from '../../src/sim/world';

/** Put a chaser (archetype 0) down at (x, y) with the HP the test wants. */
function place(w: World, x: number, y: number, hp = 20): number {
  const i = spawnEnemy(w, 0, x, y);
  w.enemies.hp[i] = hp;
  return i;
}

/** Run ticks with a frame the caller refills; the frame itself is reused. */
function run(w: World, ticks: number, fill?: (f: InputFrame) => void): void {
  const f = createInputFrame();
  for (let t = 0; t < ticks; t++) {
    resetFrame(f);
    if (fill) fill(f);
    step(w, f);
  }
}

const shoot: (f: InputFrame) => void = (f) => {
  f.fire = true;
};

/** The POWERUPS index of a card by id, or -1. Keeps ids out of the assertions. */
function card(id: string): number {
  const i = POWERUPS.findIndex((p) => p.id === id);
  expect(i, `the power-up table should hold a '${id}'`).toBeGreaterThanOrEqual(0);
  return i;
}

/** Hand `id` `tiers` times, through the same door a chest or a card would use. */
function give(w: World, id: string, tiers = 1): void {
  const i = card(id);
  for (let t = 0; t < tiers; t++) {
    expect(grantPowerup(w, i), `${id} should still be grantable at tier ${t}`).toBe(true);
  }
}

/** How many fields of the folded block differ from a run that owns nothing. */
function changedStats(w: World): string[] {
  const base = baseStats() as unknown as Record<string, number>;
  const stats = w.stats as unknown as Record<string, number>;
  return Object.keys(base).filter((key) => stats[key] !== base[key]);
}

function totalTiers(w: World): number {
  let n = 0;
  for (let i = 0; i < w.powerTiers.length; i++) n += w.powerTiers[i];
  return n;
}

describe('power-up content', () => {
  it('declares each card once, and says how long a timed one lasts', () => {
    const ids = POWERUPS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const def of POWERUPS) {
      expect(['stat', 'timed', 'curse']).toContain(def.kind);
      expect(def.maxTier).toBeGreaterThanOrEqual(1);
      if (def.kind === 'timed') {
        expect(def.duration, `${def.id} is timed but has no duration`).toBeGreaterThan(0);
      }
      // A curse buys something with a downside, so it has to be short: two tiers of a
      // -45% HP curse is not a trade, it is a lost run.
      if (def.kind === 'curse') expect(def.maxTier).toBeLessThanOrEqual(2);
    }
  });

  it('has no card that changes nothing, and no stat nobody reads', () => {
    // Every entry has to move at least one field, or the card is decoration. The other
    // half of the promise — that each field is read somewhere — is held by the tests
    // below, which each end in a world fact rather than a stat comparison.
    const readFields = new Set([
      'dmg', // projectiles, beam, chain, blast
      'fireRate', // weapons.ts cooldown
      'magnet', // pickups.ts
      'crit',
      'critMult', // projectiles.ts through rollCrit
      'armor',
      'fragile',
      'shield', // enemyProjectiles.ts through absorbIncoming
      'regen', // step.ts timers
      'lifesteal', // projectiles.ts
      'thorns', // enemies.ts contact
      'speed',
      'dashCd', // step.ts
      'spread',
      'pierce',
      'extraShots',
      'homing',
      'chain',
      'sabot',
      'slowField',
      'slowRadius', // travelScale, read by every behaviour's travel
      'drone', // systems/drone.ts
    ]);

    for (let i = 0; i < POWERUPS.length; i++) {
      const w = createWorld(3100 + i);
      expect(grantPowerup(w, i), `${POWERUPS[i].id} should grant`).toBe(true);
      const changed = changedStats(w);
      expect(changed.length, `${POWERUPS[i].id} folds no stat the sim could read`).toBeGreaterThan(0);
      for (const key of changed) {
        expect(readFields.has(key), `${POWERUPS[i].id} writes '${key}', which nothing reads`).toBe(true);
      }
    }
  });
});

describe('stat power-ups', () => {
  it('caps a stack at five tiers however many copies arrive', () => {
    const w = createWorld(31);
    give(w, 'damage', 5);

    const damage = card('damage');
    expect(w.powerTiers[damage]).toBe(5);
    expect(POWERUPS[damage].maxTier).toBe(5);
    expect(w.stats.dmg).toBeCloseTo(2.25, 10);

    // A sixth and seventh copy change nothing, and neither does the seventh refold the
    // block in a way that lets the first five drift.
    expect(grantPowerup(w, damage)).toBe(false);
    expect(grantPowerup(w, damage)).toBe(false);
    expect(w.powerTiers[damage]).toBe(5);
    expect(w.stats.dmg).toBeCloseTo(2.25, 10);

    // The cap is the def's, not a global five: the cards below cap lower, and a
    // multiplier with its own ceiling (crit, at 60%) has to respect that too.
    const crit = card('crit');
    give(w, 'crit', 5);
    expect(w.powerTiers[crit]).toBe(5);
    expect(w.stats.crit).toBeLessThanOrEqual(0.6);
    expect(w.stats.crit).toBeCloseTo(0.4, 10); // 0.08 x 5, and the ceiling is not reached

    const plate = card('plate');
    expect(POWERUPS[plate].maxTier).toBe(4);
    give(w, 'plate', 4);
    expect(w.powerTiers[plate]).toBe(4);
    expect(grantPowerup(w, plate)).toBe(false); // a fifth copy is refused, not folded
    expect(w.stats.armor).toBeLessThanOrEqual(0.22);
  });

  it('keeps a capped card capped when a later card refolds the block', () => {
    const w = createWorld(32);
    give(w, 'pierce', 3); // maxTier 3
    const atCap = w.stats.pierce;
    expect(w.powerTiers[card('pierce')]).toBe(3);

    // Twenty more copies of anything already at its cap are refused outright, so the
    // block is never refolded by a grant that cannot land.
    for (let i = 0; i < 20; i++) expect(grantPowerup(w, card('pierce'))).toBe(false);
    expect(w.stats.pierce).toBe(atCap);

    // And when a *different* card does refold it, the capped card's contribution comes
    // back at the same tier rather than one step further along.
    give(w, 'drone', 1);
    expect(w.stats.drone).toBe(1);
    expect(w.stats.pierce).toBe(atCap);
  });
});

describe('timed power-ups', () => {
  it('runs Adrenaline out and takes its numbers with it', () => {
    const w = createWorld(33);
    const adrenaline = card('adrenaline');
    const def = POWERUPS[adrenaline];
    expect(def.duration).toBe(20);

    give(w, 'adrenaline', 1);
    expect(w.powerTime[adrenaline]).toBeCloseTo(20, 10);
    expect(w.stats.dmg).toBeCloseTo(1.45, 10);

    // Ten seconds in it is still up: the clock is counted in ticks, not on a wall.
    run(w, 600);
    expect(w.stats.dmg).toBeCloseTo(1.45, 10);
    expect(w.powerTime[adrenaline]).toBeGreaterThan(0);

    // Past the twentieth second the dose is gone from the folded block, which is the
    // whole reason the block is foldable from scratch.
    run(w, 700);
    expect(w.powerTime[adrenaline]).toBe(0);
    expect(changedStats(w)).toEqual([]);
    expect(w.stats.dmg).toBe(1);
    expect(w.stats.speed).toBe(1);
    expect(w.stats.fireRate).toBe(1);

    // A second pick while the clock is back at zero is a fresh dose, at the next tier.
    expect(grantPowerup(w, adrenaline)).toBe(true);
    expect(w.powerTiers[adrenaline]).toBe(2);
    expect(w.powerTime[adrenaline]).toBeCloseTo(20, 10);
    expect(w.stats.dmg).toBeCloseTo(1.9, 10);
  });

  it('counts a timed dose down and stops counting it for a dead player', () => {
    const w = createWorld(34);
    give(w, 'targeting', 1);
    const probe = card('targeting');
    expect(w.stats.crit).toBeGreaterThanOrEqual(0.3);

    w.player.alive = false;
    w.over = true;
    run(w, 1300);

    // Nothing ticks once the run is over, so a frozen summary cannot quietly spend a
    // buff the player never got to use.
    expect(w.powerTime[probe]).toBeCloseTo(25, 10);
  });
});

describe('combat reads', () => {
  it('mends the player with Life Tap when a round lands', () => {
    // A target far enough away that nothing reaches the player back: the only way HP
    // moves in this world is a hit that paid some of itself back.
    const plain = createWorld(35);
    plain.player.hp = 50;
    place(plain, 12, 0, 500);
    run(plain, 120, shoot);
    expect(plain.player.hp).toBe(50);

    const tapped = createWorld(36);
    tapped.player.hp = 50;
    give(tapped, 'siphon', 4);
    expect(tapped.stats.lifesteal).toBeCloseTo(0.12, 10);
    const victim = place(tapped, 12, 0, 500);
    expect(victim).toBeGreaterThanOrEqual(0);

    run(tapped, 120, shoot);

    expect(tapped.player.hp).toBeGreaterThan(50);
    expect(tapped.player.hp).toBeLessThan(50 + 120 * TUNE.lifestealCap); // capped per hit
    expect(tapped.enemies.hp[victim]).toBeLessThan(500);
    expect(countEvents(tapped, Ev.Hit)).toBeGreaterThan(0);

    // And it stops at max HP rather than mending past a full bar.
    const full = createWorld(37);
    give(full, 'siphon', 4);
    place(full, 12, 0, 500);
    run(full, 120, shoot);
    expect(full.player.hp).toBe(100);
  });

  it('pays Hot Plate back into the bodies that touched the player', () => {
    const plain = createWorld(38);
    for (const [x, y] of [[0.9, 0], [0.8, 0.4], [0.7, -0.5]]) place(plain, x, y, 8);
    run(plain, 1);

    // One hug, one i-frame window, and nothing paid back.
    expect(plain.player.hp).toBe(94);
    expect(countAlive(plain.enemies)).toBe(3);

    const plated = createWorld(39);
    for (const [x, y] of [[0.9, 0], [0.8, 0.4], [0.7, -0.5]]) place(plated, x, y, 8);
    give(plated, 'thorns', 4);
    expect(plated.stats.thorns).toBe(12);

    run(plated, 1);

    expect(plated.player.hp).toBe(94); // the pulse is the player's only cost-free answer
    // 12 back per body against 8 HP bodies: the ring empties, and it goes through
    // armour rather than around it.
    expect(countAlive(plated.enemies)).toBe(0);
    expect(plated.kills).toBe(3);
    expect(countEvents(plated, Ev.Kill)).toBe(3);

    // It also works on bodies too tough to pop, which is the case that keeps it a
    // number rather than a one-trick killer.
    const tough = createWorld(40);
    const victim = place(tough, 0.9, 0, 500);
    give(tough, 'thorns', 1);
    run(tough, 1);
    expect(tough.enemies.hp[victim]).toBeCloseTo(497, 10); // 3 back at tier 1
    expect(tough.kills).toBe(0);
  });

  it('makes a curse cost HP as well as buy damage', () => {
    const plain = createWorld(41);
    place(plain, 0.9, 0);
    run(plain, 1);
    expect(plain.player.hp).toBe(94);

    const cursed = createWorld(42);
    give(cursed, 'glass', 2);
    // Both halves of the trade are on the block ...
    expect(cursed.stats.dmg).toBeCloseTo(1.9, 10);
    expect(cursed.stats.fragile).toBeCloseTo(0.9, 10);

    // ... and both are read: the same hug that costs 94% of a bar without the curse
    // costs 11.4 HP with it, because fragility is folded in at the one damage gate.
    place(cursed, 0.9, 0);
    run(cursed, 1);
    expect(cursed.player.hp).toBeCloseTo(88.6, 10);

    // A shield drinks what is left after armour and fragility, so the second defensive
    // card reads through the same gate.
    const walled = createWorld(43);
    give(walled, 'barrier', 1);
    expect(walled.player.shield).toBe(15);
    place(walled, 0.9, 0);
    run(walled, 1);
    expect(walled.player.shield).toBeCloseTo(9, 10);
    expect(walled.player.hp).toBe(100);
  });

  it('slows bodies inside the Stasis Field and only inside it', () => {
    const plain = createWorld(44);
    const near = place(plain, 4, 0);
    const far = place(plain, 30, 0);
    run(plain, 60);
    const plainClose = plain.enemies.x[near];
    const plainFar = plain.enemies.x[far];

    const frozen = createWorld(45);
    const slowed = place(frozen, 4, 0);
    const distant = place(frozen, 30, 0);
    give(frozen, 'stasis', 3);
    expect(frozen.stats.slowField).toBeCloseTo(0.39, 10);
    expect(frozen.stats.slowRadius).toBeCloseTo(7.1, 10);

    run(frozen, 60);

    // Ground travelled, not position: the field is what kept the near body 1.8 m
    // further out, and at 30 m — outside the 7.1 m radius — the same body travels
    // exactly the ground it did without the field.
    expect(4 - frozen.enemies.x[slowed]).toBeLessThan(4 - plainClose - 0.5);
    expect(frozen.enemies.x[distant]).toBeCloseTo(plainFar, 10);
  });
});

describe('the ward drone', () => {
  /**
   * A world with no gun in either hand and no trigger held, so anything that dies was
   * killed by the companion rather than by the player.
   */
  function unaided(seed: number, withDrone: boolean): World {
    const w = createWorld(seed);
    w.slots[0].weapon = -1;
    w.slots[1].weapon = -1;
    w.autoFire = false;
    w.player.hp = 500; // the drone is the only variable; survival is not
    if (withDrone) give(w, 'drone', 1);
    expect(changedStats(w).length).toBe(withDrone ? 1 : 0);
    place(w, 6, 0);
    return w;
  }

  it('kills a body the player never fired a single round at', () => {
    const alone = unaided(46, false);
    run(alone, 600);
    expect(countEvents(alone, Ev.Shot)).toBe(0);
    expect(alone.kills).toBe(0);

    const withDrone = unaided(46, true);
    const victim = 0;
    expect(withDrone.stats.drone).toBe(1);

    run(withDrone, 600);

    expect(countEvents(withDrone, Ev.Shot)).toBeGreaterThan(0);
    expect(withDrone.kills).toBe(1);
    expect(withDrone.enemies.alive[victim]).toBe(0);
    // The rounds are the copied gun's: pistol index, one body each, and they were
    // loosed with both hands empty.
    expect(withDrone.slots.every((hand) => hand.weapon < 0)).toBe(true);
  });

  it('looses a volley per tier, and nothing when the arena is empty', () => {
    const quiet = createWorld(47);
    give(quiet, 'drone', 3);
    run(quiet, 300);
    expect(quiet.shots.count).toBe(0);
    expect(countEvents(quiet, Ev.Shot)).toBe(0);

    const pack = createWorld(48);
    for (let i = 0; i < 8; i++) place(pack, Math.cos(i * 0.8) * 7, Math.sin(i * 0.8) * 7);
    give(pack, 'drone', 5);

    let volley = 0;
    const f = createInputFrame();
    for (let t = 0; t < 240; t++) {
      resetFrame(f);
      step(pack, f);
      if (t % 24 === 23) volley = Math.max(volley, pack.shots.count);
    }

    // Tier 5 looses five rounds a volley — one per body — rather than five into one.
    expect(volley).toBeGreaterThan(1);
    expect(pack.kills).toBeGreaterThan(0);
  });
});

describe('chests', () => {
  it('hands a gun to the empty second hand and puts it in play', () => {
    const w = createWorld(49);
    expect(w.slots[1].weapon).toBe(-1);
    expect(dropChest(w, 0.6, 0)).toBe(true);

    run(w, 1);

    const given = w.slots[1].weapon;
    expect(given, 'the crate should fill the empty hand').toBeGreaterThanOrEqual(0);
    expect(given, 'a crate cannot hand back the pistol the run already holds').toBeGreaterThan(0);
    expect(w.activeSlot).toBe(1); // it becomes the hand in play, not a swap to hunt for
    expect(countAlive(w.chests)).toBe(0);
    expect(countEvents(w, Ev.Pickup)).toBe(1);
  });

  it('pays a power-up when both hands are already full', () => {
    const w = createWorld(50);
    expect(dropChest(w, 0.6, 0)).toBe(true);
    run(w, 1);
    expect(w.slots[1].weapon).toBeGreaterThanOrEqual(0);

    const second = dropChest(w, 0.6, 0);
    expect(second).toBe(true);
    run(w, 1);

    expect(totalTiers(w)).toBe(1); // nothing else owns a tier, so the crate had to add one
    expect(countAlive(w.chests)).toBe(0);
  });

  it('rots on the floor if nobody walks to it', () => {
    const w = createWorld(51);
    expect(dropChest(w, 20, 20)).toBe(true);

    run(w, Math.round(TUNE.chestLife * 60) + 5);

    expect(countAlive(w.chests)).toBe(0);
    expect(w.slots[1].weapon).toBe(-1); // it was never opened, so it never paid
    expect(totalTiers(w)).toBe(0);
  });

  it('drops at a hot drop, and never in an empty stretch of floor', () => {
    // The rule has two halves — far enough to be a walk, busy enough to be worth it —
    // and the thin world stays two bodies short of the pack floor for the whole run, so
    // it must stay empty however many bodies die out there.
    const thin = createWorld(52, { arenaHalf: 40 });
    thin.autoFire = true;
    thin.player.hp = 1_000_000;
    for (let i = 0; i < 12; i++) place(thin, Math.cos(i * 1.3) * 9, Math.sin(i * 1.3) * 9, 40);
    run(thin, 1200, shoot);
    expect(thin.kills).toBeGreaterThan(0);
    expect(thin.chests.count).toBe(0);

    // A pack that clears the floor rule, with bodies dying 7-10 m out: crates appear.
    const hot = createWorld(53, { arenaHalf: 40 });
    hot.autoFire = true;
    hot.player.hp = 1_000_000;
    for (let i = 0; i < 20; i++) place(hot, Math.cos(i * 1.1) * 9, Math.sin(i * 1.1) * 9);
    startWaves(hot);

    run(hot, 1500, shoot);

    expect(hot.kills).toBeGreaterThan(20);
    expect(countAlive(hot.chests), 'a hot drop should have paid at least one crate').toBeGreaterThan(0);
    for (let i = 0; i < hot.chests.cap; i++) {
      if (hot.chests.alive[i] === 0) continue;
      const dx = hot.chests.x[i] - hot.player.x;
      const dy = hot.chests.y[i] - hot.player.y;
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(TUNE.chestMinDist - 0.001);
    }
  });
});