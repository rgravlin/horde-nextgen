import { describe, expect, it } from 'vitest';
import { LEVELS } from '../../src/content/levels';
import { WEAPONS } from '../../src/content/weapons';
import {
  AUTOSAVE_INTERVAL,
  HISTORY_LIMIT,
  META_KEY,
  NO_CLEAR,
  SAVE_KEY,
  SETTINGS_KEY,
  autosaveDue,
  clearSave,
  createAutosaveTimer,
  defaultMeta,
  defaultSettings,
  hasSave,
  isChapterUnlocked,
  loadMeta,
  loadRun,
  loadSettings,
  markAutosaved,
  recordRunEnd,
  saveMeta,
  saveRun,
  saveSettings,
  type ProblemSink,
  type StorageLike,
} from '../../src/game/persistence';
import { hashWorld } from '../../src/sim/hash';
import { createInputFrame, resetFrame, type InputFrame } from '../../src/sim/input';
import { hurtPlayer } from '../../src/sim/systems/enemyProjectiles';
import { startChapter } from '../../src/sim/systems/levels';
import { step } from '../../src/sim/step';
import { createWorld, loadSlot, type World } from '../../src/sim/world';

/**
 * The storage layer, tested against a `Map`.
 *
 * That is the whole point of the injected port in `persistence.ts`: the three keys, what
 * counts as a readable file and what counts as a corrupt one, how a run survives a round
 * trip through text, and when the autosave clock says "write now" are all behaviour of pure
 * functions, so they are pinned here in Node with no `window` — which is also the only way
 * the corrupt-file and quota paths can be tested at all, since there is no browser state
 * that makes `localStorage.getItem` throw on command.
 *
 * Three things the fixtures have to keep honest, each one a way this file could pass while
 * the code under it was broken:
 *
 * - **The round trip goes through the storage, not through memory.** A save that equalled
 *   its own snapshot object would prove nothing about the text written out; the check is the
 *   fingerprint of the world that came back, and then 60 more ticks played on both worlds,
 *   because a field that only gets read on the tick after a restore (a hazard clock, the
 *   order the pool hands out its next slot) is invisible to a single hash.
 * - **A refused file is counted.** Every reject case is paired with "and the sink heard
 *   about it", and every accept case with "and the sink stayed quiet" — otherwise a module
 *   that refused *everything* would look like a working validator, exactly as one that
 *   swallowed errors would look like a working store.
 * - **The autosave interval is measured in play seconds.** So it is checked against a world
 *   that was actually stepped, and the run stops short of chapter two's encounter (84 s of
 *   script, so 4,000 ticks is safe): past that line a chapter can end, and a chapter end is
 *   the other thing allowed to make a save due.
 */

/** The seed is pinned: a different seed is a different fight, and "kills > 0" is a fact
 *  about this one rather than about luck. */
const SEED = 0x5eed;

/** The chapter the fixtures fight in: cover, corrosion, and a 84-second script. */
const CHAPTER = 2;

/** How long a "played" fixture runs, in ticks: fifteen seconds of play. */
const RUN = 900;

/**
 * The `Map`-backed fake: the three methods and nothing else, so a test cannot lean on a
 * `Storage` feature the port does not promise.
 *
 * `seed` pre-loads raw payloads, which is how the corrupt-file cases get written without
 * going through the API that would refuse them.
 */
function memoryStorage(seed: Record<string, string> = {}): StorageLike & {
  readonly data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

/** A storage that throws on every call: private-mode Safari, and a quota that is full. */
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

/** Where the module's problems go, so "counted, not swallowed" is an assertion. */
function probe(): { problems: string[]; sink: ProblemSink } {
  const problems: string[] = [];
  return { problems, sink: { note: (problem: string) => problems.push(problem) } };
}

/** One tick's intent: walk a curve, aim along it, hold the trigger. */
function drive(f: InputFrame, t: number): void {
  resetFrame(f);
  f.moveX = Math.cos(t * 0.02) * 0.8;
  f.moveY = Math.sin(t * 0.017) * 0.8;
  f.aimX = Math.cos(t * 0.05);
  f.aimY = Math.sin(t * 0.047);
  f.fire = true;
}

/**
 * A world with a fight in it, built through the doors the game uses.
 *
 * Both hands carry a gun, because which weapons a run ended holding is one of the things the
 * meta has to record, and an empty second hand would let a writer that dropped the second
 * slot pass.
 */
function playedRun(ticks: number): World {
  const w = createWorld(SEED, { arenaHalf: 40 });
  w.autoFire = true;
  startChapter(w, CHAPTER);
  loadSlot(w.slots[1], WEAPONS.findIndex((def) => def.id === 'longbow'));

  const f = createInputFrame();
  for (let t = 1; t <= ticks; t++) {
    drive(f, t);
    step(w, f);
  }
  return w;
}

/** The same save text the storage would hold, for the truncation cases. */
function saveText(w: World): string {
  const store = memoryStorage();
  saveRun(store, w);
  return store.data.get(SAVE_KEY) ?? '';
}

/**
 * A chapter that is over: its encounter is down and the intermission is running.
 *
 * `chapterComplete` is the flag the chapter arc raises for exactly that (see
 * `systems/boss.ts`) and it is the only thing `recordRunEnd` and `autosaveDue` read about
 * the outcome, so it is set here rather than played out through 84 seconds of script — with
 * one real tick stepped first, so the clocks are a running world's rather than a fresh
 * World's zeros.
 */
function chapterCleared(chapter: number, seconds: number): World {
  const w = createWorld(11, { arenaHalf: 40 });
  startChapter(w, chapter);
  step(w, createInputFrame());
  w.time = seconds;
  w.chapterComplete = true;
  return w;
}

describe('the save slot', () => {
  it('writes under the pinned key and reads back at the same fingerprint', () => {
    const store = memoryStorage();
    const a = playedRun(RUN);

    // The fixture first: a save of a quiet arena would pass on a writer that dropped
    // everything the fight is made of.
    expect(a.errors).toBe(0);
    expect(a.over).toBe(false);
    expect(a.kills).toBeGreaterThan(0);
    expect(a.enemies.count).toBeGreaterThan(0);

    expect(saveRun(store, a)).toBe(true);
    expect([...store.data.keys()]).toEqual(['neonhorde.save.v1']);
    expect(SAVE_KEY).toBe('neonhorde.save.v1');
    expect(SETTINGS_KEY).toBe('neonhorde.settings.v1');
    expect(META_KEY).toBe('neonhorde.meta.v1');
    expect(hasSave(store)).toBe(true);

    const back = loadRun(store);
    expect(back).not.toBeNull();
    const b = back!;
    expect(hashWorld(b)).toBe(hashWorld(a));

    // And still 60 ticks later. A fingerprint taken straight out of storage only says the
    // snapshot decoded; the resumed fight has to be the same fight.
    const f = createInputFrame();
    for (let t = RUN + 1; t <= RUN + 60; t++) {
      drive(f, t);
      step(a, f);
      step(b, f);
    }
    expect(hashWorld(b)).toBe(hashWorld(a));
    expect(b.errors).toBe(0);
    expect(b.kills).toBeGreaterThan(0);
  });

  it('writes what it can read, and keeps the three slots apart', () => {
    const store = memoryStorage();
    saveRun(store, playedRun(30));
    saveSettings(store, defaultSettings());
    saveMeta(store, defaultMeta());

    expect([...store.data.keys()].sort()).toEqual([META_KEY, SAVE_KEY, SETTINGS_KEY]);
    expect(loadRun(store)).not.toBeNull();
    expect(loadSettings(store)).toEqual(defaultSettings());
    expect(loadMeta(store)).toEqual(defaultMeta());

    // Taking the run away leaves the other two alone: they are different lifetimes, which
    // is the whole reason there are three keys.
    clearSave(store);
    expect(loadRun(store)).toBeNull();
    expect(loadMeta(store)).toEqual(defaultMeta());
  });

  it('clears, and finds nothing afterwards without calling it an error', () => {
    const store = memoryStorage();
    saveRun(store, playedRun(30));
    clearSave(store);
    expect(hasSave(store)).toBe(false);

    const p = probe();
    expect(loadRun(store, p.sink)).toBeNull();
    // An empty slot is a first launch. Counting it would put an error in the state of
    // every run that ever started.
    expect(p.problems).toEqual([]);
  });

  it('refuses a payload that is not a save, and counts each one', () => {
    const whole = saveText(playedRun(30));
    const corrupt = [
      'not json at all',
      '"a string"',
      '[1,2,3]',
      '{}',
      '{"v":"v0","seed":1}',
      JSON.stringify({ v: 'v1', seed: 1 }),
      // A snapshot cut in half, from each end: this is what a write that ran out of room
      // leaves behind, and it has to come back as "no save" rather than as half a run.
      whole.slice(0, 400),
      whole.slice(0, whole.length - 40),
    ];

    for (const text of corrupt) {
      const store = memoryStorage({ [SAVE_KEY]: text });
      const p = probe();
      expect(loadRun(store, p.sink)).toBeNull();
      expect(p.problems).toHaveLength(1);
    }
  });

  it('treats a storage that throws as a missing save, not a crash', () => {
    const store = brokenStorage();
    const p = probe();
    const a = playedRun(30);

    expect(saveRun(store, a, p.sink)).toBe(false);
    expect(loadRun(store, p.sink)).toBeNull();
    expect(hasSave(store, p.sink)).toBe(false);
    clearSave(store, p.sink);

    expect(p.problems).toHaveLength(4);
    expect(p.problems.every((line) => line.startsWith(SAVE_KEY))).toBe(true);
  });
});

describe('settings', () => {
  it('starts where the brief says: auto-fire on, shake at 70 per cent, tier left to the machine', () => {
    const store = memoryStorage();
    const p = probe();
    const s = loadSettings(store, p.sink);

    expect(s).toEqual(defaultSettings());
    // TECH.md pins auto-fire on; DESIGN.md pins the shake default at 70%.
    expect(s.autoFire).toBe(true);
    expect(s.shake).toBeCloseTo(0.7, 10);
    // TECH.md wants the tier detected on first launch, so the default is the answer "detect
    // it" rather than a tier, which a default of `medium` would have switched off.
    expect(s.quality).toBe('auto');
    expect(p.problems).toEqual([]);
  });

  it('round-trips, including the settings that are not the defaults', () => {
    const store = memoryStorage();
    const tuned = { ...defaultSettings(), music: 0.2, quality: 'low' as const, autoFire: false, shake: 0 };
    expect(saveSettings(store, tuned)).toBe(true);

    const read = loadSettings(store);
    expect(read).toEqual(tuned);
    // The two that matter: a file that says off has to mean off, and a stored tier has to
    // beat the auto-detect.
    expect(read.autoFire).toBe(false);
    expect(read.quality).toBe('low');
  });

  it('knows every tier the renderer can draw', () => {
    // `QUALITY_NAMES` is written out next to `Quality` on purpose, and this is the half that
    // keeps the two lists honest: a tier the renderer has and the loader has not is a settings
    // file that gets thrown away as corrupt.
    const store = memoryStorage();
    for (const tier of ['low', 'medium', 'high', 'ultra'] as const) {
      const tuned = { ...defaultSettings(), quality: tier };
      expect(saveSettings(store, tuned)).toBe(true);
      const p = probe();
      expect(loadSettings(store, p.sink)).toEqual(tuned);
      expect(p.problems).toEqual([]);
    }
  });

  it('keeps what it recognises from a partial file and defaults the rest', () => {
    // A file written before an option existed is not a corrupt file. Refusing it would
    // quietly reset the volumes of anyone who had already changed them.
    const store = memoryStorage({ [SETTINGS_KEY]: '{"shake":0}' });
    const p = probe();
    expect(loadSettings(store, p.sink)).toEqual({ ...defaultSettings(), shake: 0 });
    expect(p.problems).toEqual([]);
  });

  it('clamps an out-of-range number instead of throwing the file away', () => {
    const store = memoryStorage({ [SETTINGS_KEY]: '{"music":3,"resolutionScale":0.1}' });
    const p = probe();
    const s = loadSettings(store, p.sink);

    expect(s.music).toBe(1);
    expect(s.resolutionScale).toBe(0.5);
    expect(p.problems).toEqual([]);
  });

  it('refuses a file it cannot honour, and counts it', () => {
    const corrupt = [
      'nope',
      '[1,2]',
      '{"master":"loud"}',
      '{"autoFire":"yes"}',
      '{"quality":"insane"}',
      '{"shake":0.5,"ghost":1}',
    ];

    for (const text of corrupt) {
      const store = memoryStorage({ [SETTINGS_KEY]: text });
      const p = probe();
      expect(loadSettings(store, p.sink)).toEqual(defaultSettings());
      expect(p.problems).toHaveLength(1);
    }
  });
});

describe('meta', () => {
  it('records a dead run: the chapter it died in, what it killed and what it was holding', () => {
    const w = playedRun(RUN);
    expect(w.over).toBe(false);

    // The sim's own death path, so `over` is set the way a game would set it.
    w.player.iframes = 0;
    hurtPlayer(w, 100_000, 0);
    expect(w.over).toBe(true);

    const meta = defaultMeta();
    recordRunEnd(meta, w, '2026-10-25T12:00:00.000Z');

    expect(meta.history).toHaveLength(1);
    const row = meta.history[0];
    expect(row.date).toBe('2026-10-25T12:00:00.000Z');
    expect(row.chapter).toBe(CHAPTER);
    expect(row.time).toBeCloseTo(RUN / 60, 10);
    expect(row.kills).toBe(w.kills);
    expect(row.score).toBe(w.score);
    expect(row.weapons).toEqual(['pistol', 'longbow']);
    expect(w.kills).toBeGreaterThan(0);

    // And it survives the trip through storage: the rows have to be plain JSON, which is
    // why "never cleared" is -1 rather than the Infinity it would rather have been.
    const store = memoryStorage();
    expect(saveMeta(store, meta)).toBe(true);
    expect(loadMeta(store)).toEqual(meta);
    expect(loadMeta(store).history[0].kills).toBe(w.kills);
  });

  it('opens the next chapter when a chapter is beaten, and not when a run dies', () => {
    const meta = defaultMeta();
    expect(isChapterUnlocked(meta, 0)).toBe(true);
    expect(isChapterUnlocked(meta, 1)).toBe(false);

    recordRunEnd(meta, chapterCleared(0, 80), 'first');
    expect(meta.unlockedChapters).toBe(2);
    expect(isChapterUnlocked(meta, 1)).toBe(true);
    expect(isChapterUnlocked(meta, 2)).toBe(false);
    expect(meta.bestTimes[0]).toBe(80);

    // A run that ended in the same chapter without finishing it changes neither. Recording
    // a death's time as a best time would put "4:10" next to a chapter that takes six
    // minutes and call it a record.
    const died = chapterCleared(0, 250);
    died.chapterComplete = false;
    recordRunEnd(meta, died, 'died');
    expect(meta.unlockedChapters).toBe(2);
    expect(meta.bestTimes[0]).toBe(80);
    expect(meta.history).toHaveLength(2);

    // A faster clear does.
    recordRunEnd(meta, chapterCleared(0, 70), 'faster');
    expect(meta.bestTimes[0]).toBe(70);
  });

  it('never unlocks past the campaign', () => {
    const meta = defaultMeta();
    const last = LEVELS.length - 1;
    recordRunEnd(meta, chapterCleared(last, 60), 'end');

    expect(meta.unlockedChapters).toBe(LEVELS.length);
    expect(isChapterUnlocked(meta, LEVELS.length - 1)).toBe(true);
    expect(isChapterUnlocked(meta, LEVELS.length)).toBe(false);
    expect(isChapterUnlocked(meta, -1)).toBe(false);
  });

  it('keeps fifty runs and drops the oldest first', () => {
    const meta = defaultMeta();
    const w = playedRun(60);

    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      w.kills = i;
      recordRunEnd(meta, w, `run-${i}`);
    }

    expect(meta.history).toHaveLength(HISTORY_LIMIT);
    expect(meta.history.map((row) => row.kills)).toEqual(
      Array.from({ length: HISTORY_LIMIT }, (_, i) => i + 5),
    );
    expect(meta.history[HISTORY_LIMIT - 1].date).toBe(`run-${HISTORY_LIMIT + 4}`);

    // A full history is also a file that has to stay readable, at the size it is.
    const store = memoryStorage();
    saveMeta(store, meta);
    expect(loadMeta(store)).toEqual(meta);
  });

  it('starts empty, and refuses a file it cannot honour', () => {
    const fresh = defaultMeta();
    expect(fresh.unlockedChapters).toBe(1);
    expect(fresh.bestTimes).toEqual(new Array(LEVELS.length).fill(NO_CLEAR));
    expect(fresh.history).toEqual([]);

    const corrupt = [
      'nonsense',
      '[]',
      '{"unlockedChapters":0}',
      '{"unlockedChapters":999}',
      '{"bestTimes":[1,2,3]}',
      '{"history":"none"}',
      '{"history":[{"date":"x"}]}',
      // A row that is the right shape but means nothing: a chapter this build has no
      // history for is a file from a different build.
      `{"history":[{"date":"x","chapter":${LEVELS.length + 1},"time":10,"kills":1,"score":1,"weapons":[]}]}`,
      '{"history":[{"date":"x","chapter":0,"time":10,"kills":1,"score":1,"weapons":[],"extra":1}]}',
    ];

    for (const text of corrupt) {
      const store = memoryStorage({ [META_KEY]: text });
      const p = probe();
      expect(loadMeta(store, p.sink)).toEqual(defaultMeta());
      expect(p.problems).toHaveLength(1);
    }
  });

  it('keeps a history it wrote, at any length', () => {
    const meta = defaultMeta();
    const w = playedRun(60);
    for (let i = 0; i < 3; i++) recordRunEnd(meta, w, `run-${i}`);

    const store = memoryStorage();
    saveMeta(store, meta);
    const back = loadMeta(store);
    expect(back.history).toHaveLength(3);
    expect(back.history.map((row) => row.date)).toEqual(['run-0', 'run-1', 'run-2']);
  });
});

describe('the autosave clock', () => {
  it('is due every thirty seconds of play, and not one tick before', () => {
    const w = playedRun(0);
    const timer = createAutosaveTimer();
    const f = createInputFrame();

    // Which ticks reported due, out of 4,000 of them. Two things are held still so this
    // measures the clock and nothing else, both on the pattern levels.test.ts sets: the
    // run is kept alive (on this seed the player is dead by 2,000 ticks otherwise, and a
    // frozen dead world is not a window of play), and it stops at 66 seconds, short of
    // chapter two's 84-second script, so no chapter can end inside the window — a chapter
    // end being the other thing allowed to make a save due.
    const fired: number[] = [];

    for (let t = 1; t <= 4000; t++) {
      w.player.hp = w.player.maxHp;
      drive(f, t);
      step(w, f);
      if (autosaveDue(timer, w)) {
        fired.push(t);
        markAutosaved(timer, w);
      }
    }

    expect(w.over).toBe(false);
    expect(AUTOSAVE_INTERVAL).toBe(30);
    expect(fired).toEqual([1800, 3600]);
  });

  it('holds the interval while nothing steps, which is what a pause is', () => {
    const w = playedRun(300);
    const timer = createAutosaveTimer();
    expect(w.time).toBeCloseTo(5, 10);

    // Twenty seconds of wall clock spent on the pause screen. A timer that read
    // `performance.now` would have written five saves here and called it autosave.
    for (let i = 0; i < 1200; i++) expect(autosaveDue(timer, w)).toBe(false);

    const f = createInputFrame();
    for (let t = 301; t <= 1800; t++) {
      drive(f, t);
      step(w, f);
    }
    expect(w.time).toBeCloseTo(30, 10);
    expect(autosaveDue(timer, w)).toBe(true);
  });

  it('is due when a chapter ends, once per chapter, even inside the interval', () => {
    const timer = createAutosaveTimer();

    const first = chapterCleared(0, 5);
    expect(autosaveDue(timer, first)).toBe(true);

    // And it stays due until somebody writes it, rather than flashing for one frame.
    markAutosaved(timer, first);
    expect(autosaveDue(timer, first)).toBe(false);

    // Chapter two's floor replaces chapter one's, and its encounter falls at 20 seconds —
    // inside the window the last write opened, so only the chapter ending can make it due.
    const second = chapterCleared(1, 20);
    expect(autosaveDue(timer, second)).toBe(true);
  });
});
