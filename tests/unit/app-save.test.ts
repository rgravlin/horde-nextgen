import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/game/app';
import type { App } from '../../src/game/appTypes';
import { WEAPONS } from '../../src/content/weapons';
import {
  META_KEY,
  SAVE_KEY,
  hasSave,
  loadMeta,
  loadRun,
  saveRun,
  type StorageLike,
} from '../../src/game/persistence';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { Phase, startChapter } from '../../src/sim/systems/levels';
import { step } from '../../src/sim/step';
import { createWorld, loadSlot, type World } from '../../src/sim/world';

/**
 * The save feature as the shell wires it, driven with no renderer, no DOM and no browser.
 *
 * `persistence.test.ts` pins the storage layer against a `Map`; this file pins the half that
 * decides *when* — that the autosave clock is actually fed, that a chapter's end and a run's
 * end each reach the meta file, that a stored run can be put back into play, and that none of
 * it can throw a run off the rails. That timing is the feature: everything underneath was
 * already true before this wiring existed, and a save that never happens is invisible from
 * inside the sim, so the only way to see it is to run the scene machine.
 *
 * Three things keep the fixtures honest:
 *
 * - **Frames, not ticks.** The app is driven through `advance(nowMs)`, the same door `main.ts`
 *   uses, so the accumulator, the step cap and the scene machine all take part. A 100 ms frame
 *   pays the loop's five-step cap, so one frame is 1/12 s of play and the 30-second autosave
 *   arrives after 360 of them rather than after a real half minute.
 * - **Write counts, not just contents.** The storage fake records every `setItem`, so a rule
 *   like "the interval restarts where the write landed" reads as *one* write rather than as "a
 *   save exists", which a per-frame writer would also satisfy.
 * - **The clock is what the fixtures hold open.** The driver hands the player's HP back between
 *   frames and answers the level-up cards. Neither cheats a rule: both exist so a fixture can
 *   buy play time — chapter one kills a passive player at about 33 s, and a card left on the
 *   table freezes the sim — which is the quantity the save clock measures.
 */

/** ms of wall clock per frame: 100 buys the loop's five-step cap, so 12 frames are 1 s. */
const FRAME_MS = 100;

/**
 * One app's clock plus the two answers a player would give.
 *
 * The clock belongs to the driver rather than to each call because `advance` wants a monotonic
 * timestamp: a second burst of frames that restarted at zero would hand the accumulator back
 * the time it had just banked, and the fixture would silently play fewer ticks than it counts.
 */
function createDriver(app: App) {
  let now = 0;

  function frame(keepAlive: boolean): void {
    now += FRAME_MS;
    const world = app.world;
    if (keepAlive && !world.over) world.player.hp = world.player.maxHp;
    app.advance(now);
    // A card freezes the sim, so answer it. Eight is more than one frame can raise, and the
    // guard keeps a card that will not clear from spinning here forever.
    for (let guard = 0; guard < 8 && app.scene === 'levelup'; guard++) app.pick(0);
  }

  return {
    /** Play `frames` frames, holding the run open while `keepAlive` is on. */
    play(frames: number, keepAlive = true): void {
      for (let i = 0; i < frames; i++) frame(keepAlive);
    },

    /** Play outwards until the run dies, and say whether it got there inside `cap`. */
    untilDead(cap = 700): boolean {
      for (let i = 0; i < cap && !app.world.over; i++) frame(false);
      return app.world.over;
    },
  };
}

function memory(seed: Record<string, string> = {}): StorageLike & {
  readonly writes: string[];
} {
  const data = new Map<string, string>(Object.entries(seed));
  const writes: string[] = [];
  return {
    writes,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

/** A storage that throws on every call, the way private-mode Safari and a full quota do. */
function brokenStorage(): StorageLike {
  const fail = (): never => {
    throw new Error('storage is not available');
  };
  return {
    getItem: () => fail(),
    setItem: () => {
      fail();
    },
    removeItem: () => {
      fail();
    },
  };
}

/**
 * An app with nothing but a world and a clock: no view, no overlay, `storage` for a shelf.
 * The shell is built for this (ARCHITECTURE.md "One shared core, two runtimes"), which is what
 * makes the save timing testable at all.
 */
function appOver(storage: StorageLike | null, seed = 1): App {
  return createApp({ view: null, hud: null, seed, backend: 'none', storage });
}

/** A played run, built through the doors the game uses, for the fixtures that load a file. */
function playedRun(ticks: number, chapter: number): World {
  const w = createWorld(0x5eed, { arenaHalf: 40 });
  w.autoFire = true;
  startChapter(w, chapter);
  // A second hand as well as the starting pistol, so a restored run is checked with both slots
  // in it and not only the one the game begins with.
  loadSlot(w.slots[1], WEAPONS.findIndex((def) => def.id === 'longbow'));

  const f = createInputFrame();
  for (let t = 1; t <= ticks; t++) {
    resetFrame(f);
    f.moveX = Math.cos(t * 0.02) * 0.8;
    f.moveY = Math.sin(t * 0.017) * 0.8;
    f.aimX = Math.cos(t * 0.05);
    f.aimY = Math.sin(t * 0.047);
    f.fire = true;
    step(w, f);
  }
  return w;
}

describe('autosave', () => {
  it('writes the run once its thirty seconds of play are up, and only then', () => {
    const store = memory();
    const app = appOver(store);
    const clock = createDriver(app);
    app.command('start');
    expect(app.scene).toBe('playing');

    // Half an interval: nothing is owed yet.
    clock.play(170);
    expect(app.world.time).toBeGreaterThan(14);
    expect(hasSave(store)).toBe(false);

    // The rest of the way past 30 s, which is where the first write is due.
    clock.play(230);
    expect(app.world.time).toBeGreaterThan(30);
    expect(app.scene, 'the fixture holds the run open, so this is still a live run').toBe(
      'playing',
    );

    expect(store.writes.filter((key) => key === SAVE_KEY)).toHaveLength(1);
    const saved = loadRun(store);
    expect(saved).not.toBeNull();
    expect(saved!.tick).toBeGreaterThanOrEqual(1800);
    expect(saved!.chapter).toBe(0);
    expect(saved!.over).toBe(false);

    // A chapter runs 78 s, so a 33 s run has earned no meta row. The point of the pairing is
    // that the save is a checkpoint while the meta is what a finished chapter or a finished
    // run leaves behind.
    expect(loadMeta(store).history).toEqual([]);
    expect(store.writes.filter((key) => key === META_KEY)).toHaveLength(0);
    expect(app.state().errors).toBe(0);
  });

  it('starts the next interval from where it wrote, so a live run costs one write a half minute', () => {
    const store = memory();
    const app = appOver(store);
    const clock = createDriver(app);
    app.command('start');

    // 66 s of play, inside chapter one's 78 s of script: two intervals, and no third inside
    // the run. Sixty-six rather than eighty so the chapter clock cannot land in this window
    // and be mistaken for a third interval.
    clock.play(800);
    expect(app.world.time).toBeGreaterThan(60);
    expect(app.world.chapter, 'still chapter one, so nothing but the interval wrote').toBe(0);
    expect(store.writes.filter((key) => key === SAVE_KEY)).toHaveLength(2);
    expect(app.state().errors).toBe(0);
  });

  it('does not write while the title screen sits on a world that never started', () => {
    const store = memory();
    const app = appOver(store);
    const clock = createDriver(app);

    // The menu is not a run: its World has no chapter, no wave clock and nothing to save.
    clock.play(400);
    expect(app.scene).toBe('menu');
    expect(store.writes).toEqual([]);
    expect(hasSave(store)).toBe(false);
  });

  it('writes on the pause screen when asked, and spends the write that was due', () => {
    const store = memory();
    const app = appOver(store);
    const clock = createDriver(app);
    app.command('start');
    clock.play(60);

    app.command('pause');
    expect(app.scene).toBe('paused');

    // Explicit Save, which is the pause menu's job: the state stopped on is the state kept.
    const tick = app.world.tick;
    app.command('save');
    const saved = loadRun(store);
    expect(saved).not.toBeNull();
    expect(saved!.tick).toBe(tick);
    expect(saved!.player.x).toBeCloseTo(app.world.player.x, 10);
    expect(store.writes).toEqual([SAVE_KEY]);

    // Six more frozen seconds: the clock stands still with the sim, so the pause screen costs
    // nothing beyond the one write the player asked for.
    clock.play(60);
    expect(store.writes).toEqual([SAVE_KEY]);
  });

  it('keeps playing when the storage refuses, and hears about it once, not per frame', () => {
    const app = appOver(brokenStorage());
    const clock = createDriver(app);
    app.command('start');
    clock.play(400);

    // Nothing threw, and the tally is a handful rather than one per frame: a storage that says
    // no is heard once per interval, not sixty times a second.
    expect(app.scene).toBe('playing');
    expect(app.state().errors).toBeGreaterThan(0);
    expect(app.state().errors).toBeLessThan(10);
  });
});

describe('coming back to a saved run', () => {
  it('puts the stored world into play, at the tick and place it was saved at', () => {
    const store = memory();
    const played = playedRun(600, 2);
    expect(played.over).toBe(false);
    expect(played.enemies.count).toBeGreaterThan(0);
    expect(saveRun(store, played)).toBe(true);

    const app = appOver(store);
    expect(app.scene).toBe('menu');

    app.command('load');
    expect(app.scene).toBe('playing');

    const state = app.state();
    expect(state.tick).toBe(played.tick);
    expect(state.chapter).toBe(2);
    expect(state.player.x).toBe(played.player.x);
    expect(state.player.y).toBe(played.player.y);
    expect(state.enemies.count).toBe(played.enemies.count);
    expect(state.weapons.map((w) => w.id)).toEqual(['pistol', 'longbow']);
    expect(state.errors).toBe(0);

    // And it plays on from there: the restored wave clock, spatial index and crowd are live
    // rather than a tableau. A floor that came back without its cell index would show up here
    // as bodies walking through cover, which is why the assertion is on the fight still moving.
    const clock = createDriver(app);
    clock.play(60);
    expect(app.world.tick).toBeGreaterThan(played.tick + 250);
    expect(app.state().errors).toBe(0);
  });

  it('offers nothing when there is no save, and does not call its absence an error', () => {
    const store = memory();
    const app = appOver(store);

    app.command('load');
    expect(app.scene).toBe('menu');
    expect(app.state().errors).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('refuses a payload that is not a run, and counts it', () => {
    const store = memory({ [SAVE_KEY]: '{"v":"v1","seed":1,"state":[0,0,0,0,0,0' });
    const app = appOver(store);

    // The key is there, so the title would offer Continue; the read is what finds nothing, and
    // that is the one place a broken file is allowed to cost anything.
    app.command('load');
    expect(app.scene).toBe('menu');
    expect(app.state().errors).toBe(1);
  });

  it('plays on a machine with no storage at all', () => {
    const app = appOver(null);
    const clock = createDriver(app);
    app.command('start');
    clock.play(240);

    expect(app.scene).toBe('playing');
    expect(app.state().errors).toBe(0);
  });

  it('loads from the pause screen back to the moment it was saved at', () => {
    const store = memory();
    const app = appOver(store);
    const clock = createDriver(app);
    app.command('start');
    clock.play(60);

    app.command('pause');
    app.command('save');
    const savedTick = app.world.tick;

    // Back into the fight, further in by now, and then Load: what comes back is the saved
    // state, not the one on screen. That is the difference between a checkpoint and a mirror.
    app.command('resume');
    clock.play(120);
    expect(app.world.tick).toBeGreaterThan(savedTick + 200);

    app.command('pause');
    app.command('load');

    const state = app.state();
    expect(state.scene).toBe('playing');
    expect(state.tick).toBe(savedTick);
    expect(state.errors).toBe(0);
  });
});

describe('the end of a run', () => {
  it('records the run in the meta and takes the save away with it', () => {
    const store = memory();
    const app = appOver(store);
    const clock = createDriver(app);
    app.command('start');

    // Nobody is holding the door open this time: the crowd does the rest.
    expect(clock.untilDead(), 'the fixture expects a passive run to die inside 700 frames').toBe(
      true,
    );
    expect(app.scene).toBe('summary');

    const meta = loadMeta(store);
    expect(meta.history).toHaveLength(1);
    const row = meta.history[0];
    expect(row.chapter).toBe(0);
    expect(row.time).toBeCloseTo(app.world.time, 10);
    expect(row.kills).toBe(app.world.kills);
    expect(row.score).toBe(app.world.score);
    expect(row.weapons).toEqual(['pistol']);

    // The slot is gone, so Continue has nothing to offer: a finished run is not a run to come
    // back to (persistence.ts — resuming one would drop the player into a game already over).
    expect(hasSave(store)).toBe(false);

    // One row per run, however long the summary screen is left up.
    clock.play(60, false);
    expect(loadMeta(store).history).toHaveLength(1);
    expect(app.state().errors).toBe(0);
  });

  it('records a chapter that ends, unlocks the one after it and saves the intermission', () => {
    const store = memory();
    const app = appOver(store);
    const clock = createDriver(app);
    app.command('start');
    clock.play(30);

    // The exact state the chapter arc raises when its encounter falls: the flag, the
    // intermission phase and its clock. Faked rather than played out, to keep this about what
    // a chapter's end leaves behind.
    const world = app.world;
    world.chapterComplete = true;
    world.wave.phase = Phase.Intermission;
    world.wave.clearTime = 20;

    // A chapter's end makes a save due on its own, inside the thirty-second interval.
    clock.play(1);
    const meta = loadMeta(store);
    expect(meta.history).toHaveLength(1);
    expect(meta.history[0].chapter).toBe(0);
    expect(meta.unlockedChapters).toBe(2);
    expect(meta.bestTimes[0]).toBeCloseTo(world.time, 10);
    expect(hasSave(store)).toBe(true);

    // And once the intermission runs out the next floor loads, so the run that carries on is
    // the run that was saved — chapter and all. Held open so this reads as "the floor changed"
    // rather than as a fight that ended.
    clock.play(400);
    expect(app.world.chapter).toBe(1);
    expect(app.state().errors).toBe(0);
  });
});

/**
 * `App.hasSave` — the flag the title's Continue and the pause menu's Load are built on.
 *
 * The block above reads the *file*; this one reads the shell's answer about the file, which is
 * what the menus actually ask and what a save feature gets wrong in four ways at once: a run
 * that outlived the page is not offered back, a restart hides a file that is still there, a
 * finished run keeps offering itself, and a load looks like a way to lose the only save. Each
 * `it` below is one of those, and each fails if the flag stops tracking the shelf.
 */
describe('the shelf flag the menus read', () => {
  it('comes off the file at boot, not off this run\'s writes', () => {
    const shelf = memory();
    expect(saveRun(shelf, playedRun(600, 0)), 'the fixture puts a run on the shelf').toBe(true);
    shelf.writes.length = 0;

    const app = appOver(shelf);

    // Before a single frame: Continue is offered because a file is there. This is the whole of
    // save/resume across a reload — a new app on a new World has to read the run back.
    expect(app.hasSave).toBe(true);
    expect(shelf.writes, 'reading the shelf is not a write').toEqual([]);

    expect(
      appOver(memory()).hasSave,
      'an empty shelf starts with no Continue',
    ).toBe(false);
  });

  it('goes up when a write lands, and stays up across a restart', () => {
    const store = memory();
    const app = appOver(store);
    const clock = createDriver(app);
    app.command('start');

    clock.play(170);
    expect(app.hasSave, 'no interval has fallen due yet').toBe(false);

    clock.play(230);
    expect(app.hasSave, 'the run is on the shelf now').toBe(true);

    // Restart starts a new run; it does not un-write the file that is still sitting there, and
    // the pause menu keeps offering Load while it is.
    app.command('restart');
    expect(app.hasSave).toBe(true);
    expect(hasSave(store)).toBe(true);
  });

  it('goes down with a finished run, and stays down while the summary is left up', () => {
    const store = memory();
    const app = appOver(store);
    const clock = createDriver(app);
    app.command('start');

    // Past an interval first, so there is a flag to take away.
    clock.play(400);
    expect(app.hasSave).toBe(true);

    expect(clock.untilDead()).toBe(true);
    expect(app.scene).toBe('summary');
    expect(app.hasSave, 'a run you already finished is not a run to come back to').toBe(false);
    expect(hasSave(store), 'and the file went with it').toBe(false);

    clock.play(60, false);
    expect(app.hasSave).toBe(false);
    expect(app.state().errors).toBe(0);
  });

  it('stays up when the pause screen takes the run back out of the file', () => {
    const store = memory();
    const app = appOver(store);
    const clock = createDriver(app);
    app.command('start');
    clock.play(400);
    expect(app.hasSave).toBe(true);

    app.command('pause');
    app.command('load');
    expect(app.scene).toBe('playing');
    expect(app.hasSave, 'loading a run does not look like a way to lose it').toBe(true);

    app.command('pause');
    expect(app.hasSave, 'Load is still offered, which is how you go back a second time').toBe(
      true,
    );
  });
});
