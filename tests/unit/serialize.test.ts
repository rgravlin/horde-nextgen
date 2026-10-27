import { describe, expect, it } from 'vitest';
import { POWERUPS } from '../../src/content/powerups';
import { WEAPONS } from '../../src/content/weapons';
import { createInputFrame, resetFrame, packFrame, unpackFrame, type InputFrame } from '../../src/sim/input';
import { hashWorld } from '../../src/sim/hash';
import { deserialize, serialize } from '../../src/sim/serialize';
import { createLog, frameAt, playReplay, readReplay, recordFrame, writeReplay } from '../../src/sim/replay';
import { createWorld, loadSlot, type World } from '../../src/sim/world';
import { step } from '../../src/sim/step';
import { startChapter } from '../../src/sim/systems/levels';
import { grantPowerup } from '../../src/sim/systems/pickups';
import { recomputeStats, startTime } from '../../src/sim/systems/powerups';

/**
 * Save and replay, checked where persistence has to be exact: the run fingerprint.
 *
 * A save is only worth having if resuming it is the same game, and the only honest way to say
 * that is to run the same input at two worlds — the one that was written out and the one read
 * back — and compare their fingerprints after every further tick. Hashing the restored world
 * alone would only prove the snapshot decoded; it is the 300 ticks *after* the restore that
 * show whether the resume kept the fight, because a field that is read only on the tick after
 * it loads (a hazard clock, a magazine, the order the pool hands out its next slot) is invisible
 * to a single hash.
 *
 * The fixture is therefore built to be full, and the fullness is asserted before anything is
 * round-tripped: a test whose fixture has no projectiles in it would pass happily on a
 * serializer that forgot the projectile pool. Same reasoning for the replay — a run whose input
 * survives the packed channel unchanged would pass on a replay file that stored nothing, so it
 * also checks the channel actually transformed the frames it was given.
 */

/** The chapter this file plays: cover, corrosion and crusher plates, so both clocks are live. */
const CHAPTER = 4;

/** Where the run starts. Pinned, because a different seed is a different fight. */
const SEED = 0xc0ffee;

/**
 * How long the saved run is, in ticks.
 *
 * Thirty seconds of play rather than the ten the brief sketched, and for a reason worth
 * keeping: measured, at 600 ticks chapter four's first pack has already thinned to four live
 * enemies, and a fixture that thin cannot tell a serializer that carried the enemy pool from
 * one that dropped it. At 1800 the horde is forty strong, both kinds of round are in the air
 * and the dead slots and free stack carry enough to be worth checking. The thresholds below
 * decided the length, not the other way round.
 */
const RUN = 1800;

/** How far both worlds are stepped after the restore, to catch what a single hash cannot see. */
const CONT = 300;

/** Fill one tick's worth of intent: a walk around a square, a shot, a dash now and then.
 *  With `analogue` the aim and the move pair are pointer-and-stick shaped rather than keys. */
function script(f: InputFrame, t: number, analogue: boolean): void {
  resetFrame(f);
  const leg = Math.floor(t / 90) % 4;
  if (leg === 0) {
    f.moveX = 1;
    f.moveY = 1;
  } else if (leg === 1) {
    f.moveX = -1;
    f.moveY = 1;
  } else if (leg === 2) {
    f.moveX = -1;
    f.moveY = -1;
  } else {
    f.moveX = 1;
    f.moveY = -1;
  }
  if (analogue) {
    // Neither pair is representable in the packed channel: the move pair lands inside and
    // outside the 0.2 dead zone, and the aim floats are not multiples of 1/1023.
    f.moveX = Math.cos(t * 0.02) * 0.8;
    f.moveY = Math.sin(t * 0.017) * 0.8;
    f.aimX = Math.cos(t * 0.05) * 0.9;
    f.aimY = Math.sin(t * 0.047) * 0.9;
  }
  f.fire = true;
  if (t % 97 === 0) f.dash = true;
  if (t === 250 || t === 610) f.swap = true;
}

/**
 * A world with a fight in it: chapter four's floor, both hands loaded, a handful of power-ups
 * (one of them timed and running), a level-up offer waiting, and `ticks` of scripted play.
 *
 * Everything here is set through the same doors the game uses — `startChapter`, `loadSlot`,
 * `grantPowerup` — rather than by writing fields, so the fixture is a run that could have
 * happened and not a pile of values that merely typechecks.
 */
function playedRun(ticks: number, analogue = false) {
  const w = createWorld(SEED, { arenaHalf: 40 });
  w.autoFire = true;
  startChapter(w, CHAPTER);

  // Both hands armed, the second one a heat gauge rather than a magazine, and the run starts
  // on it: `heat`, `cooldown` and the active hand all have to survive the round trip for the
  // resumed fight to be the same fight.
  const repeater = WEAPONS.findIndex((def) => def.id === 'plasmaRepeater');
  loadSlot(w.slots[1], repeater);
  w.slots[1].heat = 0.6;
  w.slots[1].cooldown = 0.3;
  w.activeSlot = 1;

  // Enough life that this test is about a resumed fight rather than about a resumed death.
  w.player.maxHp = 400;
  w.player.hp = 400;

  for (const id of ['damage', 'drone', 'stasis', 'adrenaline']) {
    grantPowerup(w, POWERUPS.findIndex((def) => def.id === id));
  }
  startTime(w, POWERUPS.findIndex((def) => def.id === 'adrenaline'), 20);
  recomputeStats(w);

  // A level-up offer waiting, with the reroll spent: the run is mid-choice at the moment it is
  // saved, which is the state a save most needs to get right.
  w.pendingLevelUp = true;
  w.levelUpChoices[0] = 0;
  w.levelUpChoices[1] = 1;
  w.levelUpChoices[2] = 2;
  w.rerollUsed = true;

  const f = createInputFrame();
  for (let t = 1; t <= ticks; t++) {
    // A second timed dose lands five seconds before the save. Without it the only buff the
    // fixture ever starts has expired by the time the world is written out (Adrenaline lasts
    // 20 s, the run is 30), and `powerTime` would then be all zeroes — a save that dropped the
    // clocks entirely would pass. Placed inside the loop because that is when a buff arrives
    // in a real run, and the expiry on the way is itself part of what gets compared.
    if (t === ticks - 300) {
      const frenzy = POWERUPS.findIndex((def) => def.id === 'frenzy');
      grantPowerup(w, frenzy);
      startTime(w, frenzy, 15);
      recomputeStats(w);
    }
    script(f, t, analogue);
    step(w, f);
  }
  return w;
}

/** How many slots are dead but still carrying data, i.e. residue a save would have to carry. */
function dirtySlots(w: World): number {
  const p = w.enemies;
  let n = 0;
  for (let i = 0; i < p.cap; i++) {
    if (p.alive[i] === 0 && (p.x[i] !== 0 || p.hp[i] !== 0 || p.state[i] !== 0)) n++;
  }
  return n;
}

describe('save round trip', () => {
  it('restores a running fight so exactly that 300 more ticks stay identical', () => {
    const a = playedRun(RUN);

    // The fixture first: if any of these came back empty, the round trip below would be
    // proving less than it looks like it is.
    expect(a.errors).toBe(0);
    expect(a.over).toBe(false);
    expect(a.enemies.count).toBeGreaterThan(10);
    expect(a.kills).toBeGreaterThan(10);
    expect(a.shots.count + a.enemyShots.count).toBeGreaterThan(0);
    expect(a.shards.count).toBeGreaterThan(0);
    expect(a.props.n).toBeGreaterThan(0);
    expect(a.zones.n).toBeGreaterThan(0);
    expect(a.wave.elapsed).toBeGreaterThan(0);
    expect(a.activeSlot).toBe(1);
    expect(a.powerTiers.some((tier) => tier > 0)).toBe(true);
    expect(a.powerTime.some((clock) => clock > 0)).toBe(true);

    // Two things the fingerprint reads that a "just the live bodies" save would get wrong, and
    // that therefore have to be present for the hash checks below to mean anything: dead slots
    // still holding the body that died in them, and a free stack whose order those deaths
    // shuffled, which is what decides where the next body lands.
    expect(dirtySlots(a)).toBeGreaterThan(0);
    let stacked = 0;
    for (let i = 0; i < a.enemies.freeCount; i++) {
      if (a.enemies.freeList[i] !== a.enemies.cap - 1 - i) stacked++;
    }
    expect(stacked).toBeGreaterThan(0);

    const back = deserialize(JSON.parse(JSON.stringify(serialize(a))));
    expect(back).not.toBeNull();
    const b = back!;

    // Straight away: every slot of every pool, the generator's state and the chapter's clocks.
    expect(hashWorld(b)).toBe(hashWorld(a));

    // And still after another five seconds of play, which is where the fields that only get
    // read on a later tick give themselves away.
    const f = createInputFrame();
    for (let t = RUN + 1; t <= RUN + CONT; t++) {
      script(f, t, true);
      step(a, f);
      step(b, f);
    }
    expect(hashWorld(b)).toBe(hashWorld(a));
    expect(b.errors).toBe(0);
    expect(b.player.x).toBe(a.player.x);
    expect(b.kills).toBe(a.kills);
  });

  it('round-trips an idle arena, which is the fixture every other test lives in', () => {
    const a = createWorld(7);
    const b = deserialize(JSON.parse(JSON.stringify(serialize(a))));
    expect(b).not.toBeNull();
    expect(hashWorld(b!)).toBe(hashWorld(a));
    expect(b!.props.n).toBe(0);
    expect(b!.enemies.count).toBe(0);
  });

  it('refuses a file that is not a save, without throwing', () => {
    const good = serialize(playedRun(30));

    // Read the untouched snapshot first. Every case below is an edit of it, so without this
    // line a decoder that rejected *every* file would look exactly like a working validator.
    expect(deserialize(good)).not.toBeNull();

    const bad: unknown[] = [null, undefined, 42, 'neonhorde', {}, []];

    // A different build's save, a truncated blob, and the two ways a corrupt file can ask the
    // allocator for more than the machine has.
    const version = structuredClone(good);
    version.v = 'v0';
    const truncated = structuredClone(good);
    truncated.pools.enemies.data = truncated.pools.enemies.data.slice(0, 40);
    const giantPools = structuredClone(good);
    giantPools.size = new Array(8).fill(900_000);
    const giantArena = structuredClone(good);
    giantArena.grid = [0.02, 40_000];
    const extraField = structuredClone(good);
    (extraField.player as Record<string, unknown>).haste = 3;
    const stringState = structuredClone(good);
    (stringState.state as unknown[])[6] = 'near';

    bad.push(version, truncated, giantPools, giantArena, extraField, stringState);
    for (const data of bad) {
      expect(deserialize(data)).toBeNull();
    }
  });
});

describe('headless replay', () => {
  it('replays a recorded chapter to the same fingerprints, through the file', () => {
    const w = createWorld(SEED);
    w.autoFire = true;
    startChapter(w, 2);

    const log = createLog(SEED, 2, true);
    const raw = createInputFrame();
    const played = createInputFrame();
    const marks: Array<{ ticks: number; hash: number }> = [];

    // Record and play from the same channel: the file stores what the sim was actually fed, so
    // the reference run is the packed one rather than a raw script that the packing rewrites.
    for (let t = 1; t <= 700; t++) {
      script(raw, t, true);
      recordFrame(log, raw);
      step(w, frameAt(log, log.codes.length - 1, played));
      if (t === 350 || t === 700) marks.push({ ticks: t, hash: hashWorld(w) });
    }

    expect(w.over).toBe(false);
    expect(w.kills).toBeGreaterThan(0);

    const file = JSON.parse(JSON.stringify(writeReplay(log)));
    expect(file.ticks).toBe(700);
    expect(typeof file.codes).toBe('string');
    expect(file.aim).toHaveLength(1400);
    expect(file.lob).toHaveLength(700);

    const loaded = readReplay(file);
    expect(loaded).not.toBeNull();

    const whole = playReplay(loaded!);
    expect(hashWorld(whole)).toBe(marks[1].hash);

    // The halfway fingerprint too: a divergence that healed itself by the end is still a
    // divergence, and a replay that only matched on the last tick would be a coincidence.
    const half = playReplay({
      ...loaded!,
      codes: loaded!.codes.slice(0, 350),
      aim: loaded!.aim.slice(0, 700),
      lob: loaded!.lob.slice(0, 350),
    });
    expect(hashWorld(half)).toBe(marks[0].hash);
  });

  it('keeps aim that the packed channel cannot carry, and proves the channel dropped it', () => {
    const raw = createInputFrame();
    const packed = createInputFrame();
    script(raw, 17, true);
    unpackFrame(packFrame(raw), packed);

    // The channel is lossy for this frame. That is why `writeReplay` ships the aim pair beside
    // the code: replaying from the bits alone would steer every shot a hair off.
    expect(packed.aimX).not.toBe(raw.aimX);
    expect(packed.moveX).not.toBe(raw.moveX);

    const log = createLog(SEED, 0, true);
    recordFrame(log, raw);
    const read = createInputFrame();
    frameAt(log, 0, read);
    expect(read.aimX).toBe(raw.aimX);
    expect(read.aimY).toBe(raw.aimY);
    expect(read.dash).toBe(raw.dash);
    expect(read.fire).toBe(raw.fire);
  });

  it('reads back a file it wrote, and refuses what is not one', () => {
    const log = createLog(SEED, 3, false);
    const f = createInputFrame();
    for (let t = 1; t <= 60; t++) {
      script(f, t, false);
      recordFrame(log, f);
    }

    const file = writeReplay(log);
    const back = readReplay(JSON.parse(JSON.stringify(file)));
    expect(back).not.toBeNull();
    expect(back!.codes).toEqual(log.codes);
    expect(back!.aim).toEqual(log.aim);
    expect(back!.chapter).toBe(3);
    expect(back!.autoFire).toBe(false);

    const bare = createLog(1, null, false);
    expect(readReplay(JSON.parse(JSON.stringify(writeReplay(bare))))).toEqual(bare);

    const shortCodes = structuredClone(file);
    shortCodes.codes = file.codes.slice(0, file.codes.length - 4);
    const shortAim = structuredClone(file);
    shortAim.aim = file.aim.slice(0, file.aim.length - 1);
    const wrongVersion = structuredClone(file);
    wrongVersion.v = 'v1';
    const noAim = structuredClone(file);
    delete (noAim as { aim?: number[] }).aim;
    // A file from before the aim distance existed. Playing it would lob every shell to the top
    // of its range rather than where the run landed it, so it reads as no replay, not a short one.
    const noLob = structuredClone(file);
    delete (noLob as { lob?: number[] }).lob;
    const shortLob = structuredClone(file);
    shortLob.lob = file.lob.slice(0, file.lob.length - 1);

    for (const data of [null, 7, {}, file.seed, shortCodes, shortAim, wrongVersion, noAim, noLob, shortLob]) {
      expect(readReplay(data)).toBeNull();
    }
  });
});