import { describe, expect, it } from 'vitest';
import { AI_IDS, ENEMIES, enemyIndex } from '../../src/content/enemies';
import { POWERUPS } from '../../src/content/powerups';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { hashWorld } from '../../src/sim/hash';
import {
  armorAgainst,
  killEnemy,
  queueBlast,
  resolveBlasts,
  spawnEnemy,
  updateEnemies,
} from '../../src/sim/systems/enemies';
import { AI } from '../../src/sim/systems/enemies/behaviours';
import { grantPowerup } from '../../src/sim/systems/pickups';
import { startChapter } from '../../src/sim/systems/levels';
import { recomputeStats, startTime } from '../../src/sim/systems/powerups';
import { Ev, countAlive, countEvents, createWorld, type World } from '../../src/sim/world';

/**
 * The enemy pass, after it moved out of one 1,372-line file into `src/sim/systems/enemies/`.
 *
 * The brief for the move was "no behaviour change", so this file does not re-pin what
 * `enemies-a.test.ts`, `enemies-b.test.ts` and `combat.test.ts` already pin. It checks the
 * two things a folder of modules can break that one file could not:
 *
 * - **the wiring.** The dispatch table still has to cover every behaviour id, and the helpers
 *   that used to be shared inside the file still have to be *one* thing — one travel scratch,
 *   one mending aura. A helper copied per module compiles, reads plausibly, and drifts the
 *   first time someone edits one of the copies.
 * - **whole runs.** Five fixtures play out start to finish and their fingerprints are
 *   compared with the ones the single file produced. A behaviour that winds up a tick late
 *   has the same positions as one that does not, for a while; a few hundred ticks of a whole
 *   horde is what shows it.
 *
 * The pinned numbers were taken from `src/sim/systems/enemies.ts` before it was split, by
 * running these fixtures against it, and they are exact on purpose. A failure here means a rule
 * moved rather than that a tolerance needs widening: run the fixture against the code from
 * before your change and see which.
 */

/** Put one archetype down by id, at the HP the test needs rather than the default. */
function place(w: World, id: string, x: number, y: number, hp?: number): number {
  const i = spawnEnemy(w, enemyIndex(id), x, y);
  if (hp !== undefined) w.enemies.hp[i] = hp;
  return i;
}

/**
 * Play `ticks` of one world and fingerprint it.
 *
 * `fire` and `move` are the only two levers a fixture needs: without them the horde is pure
 * behaviour and nothing dies, with them the kills, the blasts those kills queue and the rounds
 * that caused them are all inside the fingerprint too.
 */
function play(w: World, ticks: number, fire = false, move = false): number {
  const f = createInputFrame();
  for (let t = 1; t <= ticks; t++) {
    resetFrame(f);
    if (fire) f.fire = true;
    if (move) {
      // A walk around a square, so bodies arrive from every bearing and the arena clamp and the
      // cover sweeps both get used, with a dash every so often to spend the i-frames.
      const leg = Math.floor(t / 90) % 4;
      f.moveX = leg === 0 ? 1 : leg === 1 ? -1 : leg === 2 ? -1 : 1;
      f.moveY = leg === 0 ? 1 : leg === 1 ? 1 : leg === 2 ? -1 : -1;
      if (t % 97 === 0) f.dash = true;
    }
    step(w, f);
  }

  return hashWorld(w);
}

/** One body of every archetype in the table, spread around the player at its content HP. */
function wholeTable(w: World): void {
  const n = ENEMIES.length;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const r = 6 + (k % 3) * 2.5;
    spawnEnemy(w, k, Math.cos(a) * r, Math.sin(a) * r);
  }
}

/** The POWERUPS index of a card by id, or -1. Keeps ids out of the assertions. */
function card(id: string): number {
  const i = POWERUPS.findIndex((p) => p.id === id);
  expect(i, `the power-up table should hold a '${id}'`).toBeGreaterThanOrEqual(0);
  return i;
}

describe('what the folder hands out', () => {
  it('still hands out the six doors the rest of the sim comes through', () => {
    // What `step.ts`, `projectiles.ts`, `status.ts`, `levels.ts`, `boss.ts`, `waves.ts`, the
    // bench and nine test files import. The import path is part of the assertion: it names
    // the directory, and those callers kept working only because `enemies/index.ts` answers
    // it with exactly these names.
    const doors = { spawnEnemy, updateEnemies, armorAgainst, killEnemy, queueBlast, resolveBlasts };
    for (const [name, fn] of Object.entries(doors)) {
      expect(typeof fn, `${name} should still come out of systems/enemies`).toBe('function');
    }
  });

  it('still dispatches by behaviour id, and keeps the pair that shares one', () => {
    // The reason `AI` is keyed by the `AiId` union rather than looked up in a map: an id
    // without a behaviour is meant to fail the typecheck, not to stand still. This is the
    // same fact at runtime, because a table that quietly lost a key would otherwise show up
    // only as a mob of something that does nothing.
    expect(Object.keys(AI).sort()).toEqual([...AI_IDS].sort());
    for (const id of AI_IDS) expect(typeof AI[id], `${id} has no behaviour`).toBe('function');
    for (const def of ENEMIES) expect(AI_IDS, `${def.id} names a behaviour nobody wrote`).toContain(def.ai);

    // The swarmling and the splitter are one function on purpose, and the sharing is now a
    // cross-module fact: `seekers.ts` exports it and `behaviours.ts` points two keys at it.
    // Were it copied per file to keep each one self-contained, this is where you would see.
    expect(AI.swarmling).toBe(AI.splitter);
    expect(AI.swarmling).not.toBe(AI.chaser);
  });
});

describe('what the split put behind a module boundary', () => {
  /**
   * Where a chaser ends up after 90 ticks of walking at the player from 6.5 m, with and
   * without a stasis field over the arena.
   *
   * The field is the one number in the pass that has to reach two modules at once:
   * `update.ts` writes the tick's travel fraction into a scratch slot and `shared.ts` spends
   * it in `advance`. One slot per module would compile, would still draw the field's radius
   * on screen, and would slow nothing.
   */
  function walked(withField: boolean): number {
    const w = createWorld(91, { arenaHalf: 40 });
    if (withField) {
      for (let tier = 0; tier < 3; tier++) expect(grantPowerup(w, card('stasis'))).toBe(true);
    }
    expect(w.stats.slowField).toBe(withField ? 0.39 : 0);

    const i = place(w, 'chaser', 6.5, 0);
    play(w, 90);
    return Math.hypot(w.enemies.x[i], w.enemies.y[i]);
  }

  it('slows a body inside the field through one travel slot, not two', () => {
    const free = walked(false);
    const slow = walked(true);

    // Full cruise puts it against the player; the field leaves it three metres out after the
    // same ninety ticks — the 39% the card is worth, not a rounding error. If the travel
    // fraction stopped reaching `advance`, the two runs would land in the same place.
    expect(free).toBeLessThan(1.5);
    expect(slow).toBeGreaterThan(3);
    expect(slow - free).toBeGreaterThan(1.5);
  });

  /**
   * A chaser knocked to 1 HP, left beside a mender or alone, and what it has left after
   * `ticks`.
   *
   * Nothing in either run can hurt it — no rounds are fired and the player's own gun stays
   * holstered — so any HP it gained came out of an aura. That is the control: the menders run
   * through one helper now, `mendAura` in `support.ts`, and the only thing that differs
   * between them is the clock that starts a pulse.
   */
  function mended(withMender: boolean, ticks: number, mender = 'healer'): World {
    const w = createWorld(92, { arenaHalf: 40 });
    // Enough life that the run is about a mended pack rather than about a dead player: the
    // escort has to stay next to its mender for a pulse to be possible at all.
    w.player.maxHp = 400;
    w.player.hp = 400;
    place(w, 'chaser', 30, 0, 1);
    if (withMender) place(w, mender, 30, 1);
    play(w, ticks);
    return w;
  }

  it('mends the pack, and does not mend it on its own', () => {
    const alone = mended(false, 420);
    const healed = mended(true, 420);

    expect(alone.enemies.hp[0]).toBe(1);
    expect(healed.enemies.hp[0]).toBeGreaterThan(1);
    expect(countEvents(healed, Ev.Heal)).toBeGreaterThan(0);
  });

  it('still mends for the matron, through the same aura the healer uses', () => {
    // The matron's beat runs on the body's own age, three seconds round, so this is a longer
    // run than the healer's; it also starts 30 m out, so the pair is still inside the 7 m
    // aura when the first beat lands.
    const withMatron = mended(true, 420, 'matron');
    expect(withMatron.enemies.hp[0]).toBeGreaterThan(1);
    expect(countEvents(withMatron, Ev.Heal)).toBeGreaterThan(0);
  });

  it('queues a death blast rather than detonating inside the kill', () => {
    // The other piece of state that crosses a boundary mid-tick: a death queues into the
    // blast stack and `resolveBlasts`, a whole pass later in the tick, spends it. Both halves
    // live in `deaths.ts` now, and queue-don't-detonate is why they live together.
    const w = createWorld(93, { arenaHalf: 40 });
    const bomb = place(w, 'exploder', 20, 20);
    const crowd = place(w, 'chaser', 21.5, 20);

    killEnemy(w, bomb);
    expect(w.blasts.count).toBe(1); // queued by the kill, not spent inside it
    expect(w.enemies.alive[crowd]).toBe(1);

    play(w, 1);

    // Spent on the following tick, which is how the tick order spends it: `step` rebuilds the
    // hash the blast query reads, so the crowd is findable. Calling `resolveBlasts` straight
    // from here takes an empty grid, hits nothing, and proves nothing about the queue.
    expect(w.blasts.count).toBe(0);
    expect(w.enemies.alive[crowd]).toBe(0);
    expect(w.kills).toBe(2);
  });
});

describe('the frozen hordes', () => {
  /**
   * Fingerprints taken from the single-file pass.
   *
   * `hashWorld` covers positions, velocities, HP, the phase and timer slots, facels, elite
   * variants, both projectile pools, the rng state and the free lists — everything a
   * divergence can show up in — so one number per fixture is a whole-run equality rather than
   * a spot check.
   *
   * They were re-taken when the burrower joined the table, and with it for a second reason:
   * the tick now decides who is findable before it rebuilds the grid, and that rule reaches
   * the thorns pulse, the burst resolver and the burn tick as well as the shots. A failure
   * here still means a rule moved rather than that a tolerance needs widening; the way to tell
   * is to run the fixture with the new row left out.
   */
  const FROZEN = {
    /** Every archetype, nothing shooting: 900 ticks of pure behaviour. */
    quiet: 826703248,
    /** The same table under fire, so the kills and their blasts are covered too. */
    fought: 3477005370,
    /** The table with a stasis field up, which is where the travel fraction is read. */
    slowed: 2749729276,
    /** A hug against a Hot Plate: thorns, armour, and a burst spent in a crowd. */
    plated: 2942435726,
    /** Chapter four, 1,500 ticks: wave recipes, cover, hazards and an encounter. */
    chapter: 1109454232,
  };

  it('is the same quiet horde: nineteen bodies, nobody shooting, nine hundred ticks', () => {
    const w = createWorld(0x51de, { arenaHalf: 40 });
    wholeTable(w);
    const h = play(w, 900);

    // Readable first, exact second. The count is past the nineteen that walked in because a
    // splitter came apart into three splinters and the broodmother and the spawner kept
    // putting young into a room nothing was clearing — the behaviours that make the crowd
    // bigger than the pack recipe, which is exactly the thing a silent change would break. A
    // burrower is one of the nineteen and it spends part of every run of this fixture under
    // the floor, which is the difference these fingerprints now carry.
    expect(countAlive(w.enemies)).toBe(37);
    expect(h).toBe(FROZEN.quiet);
  });

  it('is the same fight: the same table, with the player shooting back', () => {
    const w = createWorld(0x51df, { arenaHalf: 40 });
    wholeTable(w);
    const h = play(w, 900, true, true);

    // Eleven left of the nineteen and whatever the crowd grew by, with both kinds of enemy
    // round in the air and the blast stack spent more than once. This is the fixture that
    // covers the kill path, because a death is where a shard, a burst and a brood all get
    // queued at once.
    expect(countAlive(w.enemies)).toBe(11);
    expect(h).toBe(FROZEN.fought);
  });

  it('is the same slowed horde: the whole table inside a stasis field', () => {
    const w = createWorld(0x51e0, { arenaHalf: 40 });
    wholeTable(w);
    grantPowerup(w, card('stasis'));
    const h = play(w, 900);

    // Different from the quiet horde only because of the field, which is what earns its own
    // pin: the whole difference between the two runs is a number one module writes and
    // another reads.
    expect(h).not.toBe(FROZEN.quiet);
    expect(h).toBe(FROZEN.slowed);
  });

  it('is the same hug against a Hot Plate', () => {
    const w = createWorld(0x51e1, { arenaHalf: 40 });
    grantPowerup(w, card('thorns'));

    // Sixteen bodies packed into the reach the plate pulse uses, so the pulse runs most
    // ticks, with an exploder among them and a healer behind them: the plate kills through
    // armour and finishes bodies, and a body it finishes queues its burst right there.
    for (let k = 0; k < 14; k++) place(w, 'chaser', 1.4 + (k % 3) * 0.3, (k % 5) * 0.4 - 0.8);
    place(w, 'exploder', 2.2, 0);
    place(w, 'healer', 5, 0);
    const h = play(w, 400, false, true);

    // Nothing in this fixture fires a player round, and the only other writer of
    // `Ev.Damage` is a player round in `projectiles.ts`, so every one of these sixteen is a
    // plate pulse spent on a body: the hug happened, the pulse reached it and it went through
    // armour and finished bodies, which is the path that moved here. The sixteenth is the
    // exploder's burst finishing a body the pulse had already wounded, which is what the
    // findability mask changed: the pulse and the burst now read one snapshot of the grid,
    // taken at the top of the tick, instead of asking who was alive at two different moments
    // of it.
    expect(countEvents(w, Ev.Damage)).toBeGreaterThan(0);
    expect(w.kills).toBe(16);
    expect(h).toBe(FROZEN.plated);
  });

  it('is the same chapter four: fifteen hundred ticks of the whole tick order', () => {
    const w = createWorld(0xc0ffee, { arenaHalf: 40 });
    w.autoFire = true;
    startChapter(w, 4);
    for (const id of ['damage', 'stasis', 'thorns', 'plate']) grantPowerup(w, card(id));

    // A timed dose running through the first third of the run, so the stat block the enemy
    // pass reads is not the neutral one for the whole fixture.
    startTime(w, card('adrenaline'), 20);
    recomputeStats(w);

    const h = play(w, 1500, true, true);

    // The chapter fixture is the one that runs every system in the tick's real order, waves
    // included, so it is also the one that would notice the enemy pass moving relative to
    // another. `step.ts` pins that order; this only proves the split kept it. Ten more deaths
    // than the fingerprint this file was written with, for the same one reason: the burst at
    // the end of a hug is spent against the tick's grid rather than against a second answer to
    // the same question.
    expect(w.kills).toBe(56);
    expect(h).toBe(FROZEN.chapter);
  });
});
