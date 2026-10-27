/**
 * Meta: what the machine knows across runs — unlocks, best times, the last fifty runs.
 *
 * The three are separate schemas that happen to travel together, so this file and
 * `settings.ts` each spell their own key rather than sharing one version marker. Nothing
 * here reads a clock: `recordRunEnd` is handed the date, because a module with no clock is
 * a module a Node test can drive.
 */

import { LEVELS } from '../../content/levels';
import { WEAPONS } from '../../content/weapons';
import type { World } from '../../sim/world';
import { note, readJson, writeJson, type ProblemSink, type StorageLike } from './envelope';
import { META_KEY } from './keys';

/** One finished run, as the history table shows it. */
export interface RunRecord {
  /** ISO date the run ended on. Passed in rather than read here: this module has no clock. */
  date: string;
  /** Chapter it ended in, 0-based. Zero means the arena too, which is why `endless` exists. */
  chapter: number;
  /** Simulated seconds it lasted. */
  time: number;
  kills: number;
  score: number;
  /** Weapon ids the run was holding when it ended, in slot order. */
  weapons: string[];
  /**
   * Whether it was an Endless Arena run. The arena is not a chapter and never gets cleared, so
   * without this a row for it reads as "died in chapter one" (see `layoutOf` in the sim). Rows
   * written before this field are campaign rows and still load (see `isRunRecord`).
   */
  endless: boolean;
}

/** How many runs the history screen keeps. Beyond this a row is a wall of text. */
export const HISTORY_LIMIT = 50;

/** `bestTimes` for a chapter nobody has finished. `Infinity` has no JSON spelling, and
 *  `null` would make every read a type check; a negative second count cannot be a time. */
export const NO_CLEAR = -1;

/**
 * What the machine knows across runs.
 *
 * `unlockedChapters` is a count rather than a list because unlocks are earned in order: one
 * number says which of the ten tiles are lit, and there is no state where chapter seven is open
 * while six is not. `bestTimes` is indexed by chapter, so the chapter grid can show a ghost time
 * beside the tile.
 *
 * `arenaUnlocked` is the one unlock that is not a chapter, so it cannot be a slot in the count
 * above: the Endless Arena is a mode, offered once the campaign has been beaten, and it is the
 * only fact here that a run *ends* rather than *clears* its way to.
 */
export interface Meta {
  unlockedChapters: number;
  bestTimes: number[];
  history: RunRecord[];
  arenaUnlocked: boolean;
}

/** A first-run meta: chapter one open, nothing finished, nothing remembered. */
export function defaultMeta(): Meta {
  return {
    unlockedChapters: 1,
    bestTimes: new Array<number>(LEVELS.length).fill(NO_CLEAR),
    history: [],
    arenaUnlocked: false,
  };
}

/** Whether the chapter select may offer `index`. */
export function isChapterUnlocked(meta: Meta, index: number): boolean {
  return index >= 0 && index < meta.unlockedChapters;
}

/** Read the meta, or the defaults if there is no readable file. */
export function loadMeta(storage: StorageLike, problems?: ProblemSink): Meta {
  const data = readJson(storage, META_KEY, problems);
  if (data === null) return defaultMeta();

  const bad: string[] = [];
  const meta = decodeMeta(data, bad);
  if (meta !== null) return meta;

  note(problems, `${META_KEY}: ${bad.join('; ')}, using defaults`);
  return defaultMeta();
}

/** Write the meta. */
export function saveMeta(storage: StorageLike, meta: Meta, problems?: ProblemSink): boolean {
  return writeJson(storage, META_KEY, meta, problems);
}

/**
 * Add a finished run to the meta: history first, then what it unlocked.
 *
 * It changes the meta it is handed, and hands it back, because the caller already holds
 * one and a copy per death is a copy nobody asked for. One entry per call, so a run that
 * ends twice (death, then quit to menu) would need the caller to say so — which is why
 * `recordRunEnd` is called from the one place a run ends.
 *
 * A best time only counts for a chapter the run *finished*: `chapterComplete` is the
 * flag the chapter arc raises when its encounter is down, and dying at 4:10 in a chapter
 * that takes six is not a fast clear of it. The same flag is what unlocks the next
 * chapter, since a chapter beaten is the only thing that has ever opened the door after
 * it. An arena run never raises it, so it writes no time into a chapter column. What a *won*
 * run does open is the Endless Arena (`arenaUnlocked`), because the mode's first band is the
 * last chapter's pressure and nothing before it teaches that.
 */
export function recordRunEnd(meta: Meta, world: World, date: string): Meta {
  const weapons: string[] = [];
  for (const hand of world.slots) {
    if (hand.weapon >= 0 && hand.weapon < WEAPONS.length) weapons.push(WEAPONS[hand.weapon].id);
  }

  meta.history.push({
    date,
    chapter: world.chapter,
    time: world.time,
    kills: world.kills,
    score: world.score,
    weapons,
    endless: world.endless,
  });
  while (meta.history.length > HISTORY_LIMIT) meta.history.shift();

  if (world.victory) meta.arenaUnlocked = true;

  if (world.chapterComplete) {
    const at = world.chapter;
    if (at >= 0 && at < meta.bestTimes.length) {
      const best = meta.bestTimes[at];
      if (best === NO_CLEAR || world.time < best) meta.bestTimes[at] = world.time;
    }
    // Beating chapter `at` opens chapter `at + 1`, which as a count is `at + 2`. Clamped
    // to the campaign's length so the last chapter cannot unlock an eleventh.
    const unlocked = Math.min(LEVELS.length, at + 2);
    if (unlocked > meta.unlockedChapters) meta.unlockedChapters = unlocked;
  }

  return meta;
}

function isTime(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && (v === NO_CLEAR || v >= 0);
}

function isChapterIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < LEVELS.length;
}

/**
 * One history row, checked.
 *
 * Six keys or seven: `endless` arrived after the first three releases of this file, and rows
 * written before it are the campaign rows they were, so a machine that already has fifty runs
 * does not lose them to a schema change. Any *other* extra key is still a file from a different
 * build and gets refused whole, which is the half of the rule that catches a rename.
 */
function isRunRecord(v: unknown): v is RunRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const row = v as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== 6 && keys.length !== 7) return false;
  // Seven keys is only legal if the seventh is the one this build added. A seventh key that is
  // not `endless` is a file from a different build, which is the case the count is there to catch.
  if (keys.length === 7 && (typeof row['endless'] !== 'boolean' || !('endless' in row))) {
    return false;
  }
  if (typeof row.date !== 'string') return false;
  if (!isChapterIndex(row.chapter)) return false;
  if (!isTime(row.time) || row.time === NO_CLEAR) return false;
  if (typeof row.kills !== 'number' || !Number.isInteger(row.kills) || row.kills < 0) return false;
  if (typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0) return false;
  if (!Array.isArray(row.weapons) || !row.weapons.every((id) => typeof id === 'string')) return false;
  return true;
}

function decodeMeta(data: Record<string, unknown>, bad: string[]): Meta | null {
  const out = defaultMeta();

  const unlocked = data.unlockedChapters;
  if (unlocked !== undefined) {
    if (!Number.isInteger(unlocked) || (unlocked as number) < 1 || (unlocked as number) > LEVELS.length) {
      bad.push('"unlockedChapters" is not a chapter count');
    } else {
      out.unlockedChapters = unlocked as number;
    }
  }

  const best = data.bestTimes;
  if (best !== undefined) {
    // One entry per chapter, or the indexes mean something different from what they meant
    // when they were written, which is worse than no times at all.
    if (!Array.isArray(best) || best.length !== LEVELS.length || !best.every(isTime)) {
      bad.push('"bestTimes" is not one time per chapter');
    } else {
      out.bestTimes = (best as number[]).slice();
    }
  }

  const history = data.history;
  if (history !== undefined) {
    if (!Array.isArray(history) || history.length > HISTORY_LIMIT || !history.every(isRunRecord)) {
      bad.push('"history" is not a list of run rows');
    } else {
      // Copied row by row rather than kept by reference: what came out of `JSON.parse` is
      // data that happens to typecheck, and the history screen reads these rows every
      // frame it is open.
      out.history = (history as RunRecord[]).map((row) => ({
        date: row.date,
        chapter: row.chapter,
        time: row.time,
        kills: row.kills,
        score: row.score,
        weapons: row.weapons.slice(),
        endless: row.endless === true,
      }));
    }
  }

  const arena = data.arenaUnlocked;
  if (arena !== undefined) {
    if (typeof arena !== 'boolean') {
      bad.push('"arenaUnlocked" is not a flag');
    } else {
      out.arenaUnlocked = arena;
    }
  }

  for (const key of Object.keys(data)) {
    if (!(key in out)) bad.push(`"${key}" is not meta`);
  }
  return bad.length === 0 ? out : null;
}
