/**
 * The Endless Arena: the mode, its ladder, and the two doors it comes in through.
 *
 * The arena is a *mode* (`world.endless`) rather than an eleventh chapter, and that choice has
 * consequences this file exists to hold:
 *
 * - **One floor identity.** `layoutOf` is how the tint, the scenery rebuild and the soundtrack
 *   know which room they are in, and `hashWorld` folds the same number in. A run that changed
 *   room without changing layout key would draw the previous room's cover over the new floor and
 *   fingerprint the same as the room it replaced, so the key is checked here rather than trusted.
 * - **A ladder with a ceiling.** The drumbeat's own dials bottom out around wave 25, so the
 *   bands carry their own batch cap, gap divisor and HP price — and they stop. A mode that
 *   escalated forever would end in a full pool and a run that cannot be lost, which is a
 *   scoreboard rather than a game, so the top rung is pinned as a rung and not as a slope.
 * - **Nothing about it may move a campaign number.** The ten chapter fingerprints in
 *   `levels-split.test.ts` are why the arena borrows chapter *zero* instead of joining `LEVELS`:
 *   an eleventh entry would shift `bestTimes`, the chapter grid and every one of those pins.
 *
 * The long runs keep the player topped up between ticks. That is a fixture buying play time, the
 * same way `app-save.test.ts` does — chapter one kills a passive player inside half a minute and
 * the ladder needs minutes to read — and it changes no rule under test: the spawner never notices
 * how much health the player has.
 */

import { describe, expect, it } from 'vitest';
import { enemyIndex } from '../../src/content/enemies';
import { ARENA, ARENA_ROSTERS, bandAt, bandIndexAt, eliteIndex } from '../../src/content/levels';
import { createApp } from '../../src/game/app';
import { defaultMeta, recordRunEnd, type StorageLike } from '../../src/game/persistence';
import { hashWorld } from '../../src/sim/hash';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { deserialize, serialize } from '../../src/sim/serialize';
import { step } from '../../src/sim/step';
import { Phase, startArena, startChapter } from '../../src/sim/systems/levels';
import { POOL_CAPS, TUNE, createWorld, layoutOf, type World } from '../../src/sim/world';

/** One world's worth of ticks, with the player held alive so the clock keeps running. */
function run(w: World, ticks: number): void {
  const frame = createInputFrame();
  for (let i = 0; i < ticks; i++) {
    resetFrame(frame);
    if (!w.over) {
      w.player.hp = w.player.maxHp;
      w.player.iframes = 0.5;
    }
    step(w, frame);
  }
}

/** An arena run, started the way the shell starts one. */
function arena(seed = 7): World {
  const w = createWorld(seed);
  startArena(w);
  return w;
}

/** A storage fake, so the door tests need neither localStorage nor a browser. */
function memory(): StorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

describe('the arena floor', () => {
  it('is a mode: a floor, a ladder and no chapter', () => {
    const w = arena();

    expect(w.endless).toBe(true);
    // The layout key is the fact the shell, the renderer and the fingerprint all read.
    expect(layoutOf(w)).toBe(-1);
    expect(w.chapter).toBe(0);
    expect(w.wave.phase).toBe(Phase.Endless);
    expect(w.wave.running).toBe(true);
    expect(w.boss.alive).toBe(false);
    expect(w.victory).toBe(false);

    // A floor that was actually put down, rather than a chapter counter with nothing on it. A
    // prop too thin to stop a body is dropped on install, which is how a bad layout shows.
    expect(w.props.dropped).toBe(0);
    expect(w.props.n).toBe(ARENA.props.length);
    expect(w.zones.n).toBe(ARENA.hazards.length);
  });

  it('names only archetypes and variants that exist', () => {
    for (const band of ARENA.bands) {
      for (const row of band.packs) {
        for (const id of row) {
          expect(enemyIndex(id), `${band.id} names ${id}, which has no behaviour`).toBeGreaterThan(
            -1,
          );
        }
      }
      // The roster is what `rollElite` draws, resolved once at module load: a typo'd variant
      // would quietly vanish there rather than fail, so the count is what has to be pinned.
      expect(ARENA_ROSTERS[bandIndexAt(band.from)]).toHaveLength(band.elites.length);
      for (const id of band.elites) {
        expect(eliteIndex(id), `${band.id} rolls ${id}`).toBeGreaterThan(-1);
      }
    }
  });

  it('escalates, and then stops', () => {
    const first = bandAt(1);
    const top = bandAt(ARENA.bands[ARENA.bands.length - 1].from);

    expect(top.batch).toBeGreaterThan(first.batch);
    expect(top.rate).toBeGreaterThan(first.rate);
    expect(top.hp).toBeGreaterThan(first.hp);
    expect(top.eliteChance).toBeGreaterThan(first.eliteChance);

    // Every rung is capped by the ceiling every chapter already has: the batch size by
    // `TUNE.batchCap`, which is the difference between a hard ending and a broken one.
    for (const band of ARENA.bands) {
      expect(band.batch).toBeLessThanOrEqual(TUNE.batchCap);
    }

    // And past the last rung the ladder holds rather than climbing on forever.
    expect(bandAt(26).id).toBe('annihilation');
    expect(bandAt(40).id).toBe('annihilation');
    expect(bandAt(400)).toBe(top);
  });

  it('fills the floor and stays inside its ceilings', () => {
    const w = arena();
    run(w, 1_800);

    expect(w.errors, `the arena raised ${w.errors} errors`).toBe(0);
    expect(w.over).toBe(false);
    expect(w.enemies.count).toBeGreaterThan(0);

    // Nobody ends up outside the room they were put in.
    let alive = 0;
    for (let i = 0; i < w.enemies.cap; i++) {
      if (w.enemies.alive[i] === 0) continue;
      alive++;
      expect(Math.abs(w.enemies.x[i])).toBeLessThanOrEqual(w.maxX + 1);
      expect(Math.abs(w.enemies.y[i])).toBeLessThanOrEqual(w.maxY + 1);
    }
    expect(alive).toBeLessThanOrEqual(POOL_CAPS.enemies);
  });

  it('still fills at its top rung', () => {
    const w = arena();
    // Jump the clock rather than an hour of play: the question is whether the drumbeat still
    // runs once the ladder has run out of rungs.
    w.wave.index = 40;
    const cursor = w.wave.cursor;
    run(w, 900);

    expect(w.errors).toBe(0);
    // Fifteen seconds of play is over a wave long, so the clock rolled and the drumbeat spent
    // its recipe the whole way: the cursor is how many bodies it put down.
    expect(w.wave.index).toBeGreaterThan(40);
    expect(w.wave.cursor).toBeGreaterThan(cursor);
    expect(w.enemies.count).toBeGreaterThan(10);
    expect(w.enemies.count).toBeLessThanOrEqual(POOL_CAPS.enemies);
    // Ninety seconds deeper than it started, the mode still has no end in it: a long run of
    // steps must not grow a victory, which is the difference between a ladder and a chapter.
    expect(w.wave.phase).toBe(Phase.Endless);
    expect(w.victory).toBe(false);
  });

  it('replays the same run twice, and does not fingerprint as a chapter', () => {
    const a = arena(11);
    const b = arena(11);
    run(a, 900);
    run(b, 900);
    expect(hashWorld(a)).toBe(hashWorld(b));

    // The same clock on chapter one's floor has to read as a different room, or `layoutOf` is
    // not actually in the fingerprint.
    const campaign = createWorld(11);
    startChapter(campaign, 0);
    run(campaign, 900);
    expect(hashWorld(campaign)).not.toBe(hashWorld(a));
    expect(layoutOf(campaign)).toBe(0);
  });

  it('survives the trip through a save', () => {
    const w = arena(5);
    run(w, 600);

    const back = deserialize(serialize(w));
    expect(back).not.toBeNull();
    const w2 = back as World;
    expect(w2.endless).toBe(true);
    expect(layoutOf(w2)).toBe(-1);
    expect(w2.wave.phase).toBe(Phase.Endless);
    expect(w2.tick).toBe(w.tick);
    expect(w2.wave.index).toBe(w.wave.index);

    // And the run carries on from there rather than starting a chapter it was not in.
    run(w2, 120);
    expect(w2.endless).toBe(true);
    expect(w2.errors).toBe(0);
  });
});

describe('the arena door', () => {
  it('is locked until the campaign is beaten', () => {
    const meta = defaultMeta();
    expect(meta.arenaUnlocked).toBe(false);

    // Dying anywhere in the campaign, even in the last chapter, does not open it.
    const died = createWorld(3);
    startChapter(died, 9);
    died.over = true;
    expect(recordRunEnd(meta, died, 'died').arenaUnlocked).toBe(false);

    // Winning does.
    const won = createWorld(3);
    startChapter(won, 9);
    won.victory = true;
    expect(recordRunEnd(meta, won, 'won').arenaUnlocked).toBe(true);
  });

  it('puts the shell into arena mode, and a locked door does nothing', () => {
    const locked = createApp({
      view: null,
      hud: null,
      seed: 21,
      backend: 'none',
      storage: memory(),
      meta: defaultMeta(),
    });
    locked.command('arena');
    expect(locked.scene).toBe('menu');
    expect(locked.state().mode).toBe('campaign');

    const open = createApp({
      view: null,
      hud: null,
      seed: 21,
      backend: 'none',
      storage: memory(),
      meta: { ...defaultMeta(), arenaUnlocked: true },
    });

    open.command('arena');
    expect(open.scene).toBe('playing');
    expect(open.world.endless).toBe(true);
    expect(open.state().mode).toBe('arena');
    expect(open.state().chapter).toBe(0);

    // It plays: frames pass, bodies arrive, and the mode survives all of them. A card offer
    // stops the sim until it is answered, so the driver takes the first one, the same way the
    // bench rig does (`rig.resolve`).
    let now = 0;
    for (let i = 0; i < 240; i++) {
      now += 100;
      const w = open.world;
      if (!w.over) w.player.hp = w.player.maxHp;
      if (open.scene === 'levelup') open.pick(0);
      open.advance(now);
    }
    expect(open.scene).toBe('playing');
    expect(open.state().mode).toBe('arena');
    expect(open.world.enemies.count).toBeGreaterThan(0);
    expect(open.state().errors).toBe(0);
  });

  it('reopens through the debug door, which a scenario has to use', () => {
    // The player doors (the chapter grid, the victory sweep) read the unlock; the scripted door
    // does not, because a scenario starts from an empty profile and has no win to spend. Both
    // halves are pinned here: `command('arena')` stays shut without a victory in the meta file,
    // and `debug.arena()` — what `?arena=1` goes through in `main.ts` — opens the mode anyway.
    const app = createApp({
      view: null,
      hud: null,
      seed: 21,
      backend: 'none',
      storage: memory(),
      meta: defaultMeta(),
    });

    app.command('arena');
    expect(app.scene).toBe('menu');
    expect(app.state().mode).toBe('campaign');

    app.debug.arena();
    expect(app.scene).toBe('playing');
    expect(app.world.endless).toBe(true);
    expect(app.state().mode).toBe('arena');

    // And it plays: the ladder is armed, bodies arrive, and nothing was raised on the way in.
    let now = 0;
    for (let i = 0; i < 300; i++) {
      now += 16;
      const w = app.world;
      if (!w.over) w.player.hp = w.player.maxHp;
      if (app.scene === 'levelup') app.pick(0);
      app.advance(now);
    }
    expect(app.state().mode).toBe('arena');
    expect(app.world.enemies.count).toBeGreaterThan(0);
    expect(app.state().errors).toBe(0);
  });

  it('restarts inside the arena, and a chapter picked from the grid is a chapter', () => {
    const app = createApp({
      view: null,
      hud: null,
      seed: 33,
      backend: 'none',
      storage: memory(),
      // Chapter five open, so `choose` below is a click on a lit tile rather than a no-op.
      meta: { ...defaultMeta(), arenaUnlocked: true, unlockedChapters: 10 },
    });

    app.command('arena');
    app.advance(16);
    app.command('pause');
    expect(app.scene).toBe('paused');

    // "Again" inside the mode stays in the mode: there is one floor and it does not end.
    app.command('restart');
    expect(app.world.endless).toBe(true);
    expect(app.state().mode).toBe('arena');

    // While the chapter grid names a chapter, and a named chapter is played.
    app.choose(4);
    expect(app.world.endless).toBe(false);
    expect(app.world.chapter).toBe(4);
    expect(app.state().mode).toBe('campaign');
  });
});
