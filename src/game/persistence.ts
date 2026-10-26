/**
 * The three places where something outlives the run that made it.
 *
 * TECH.md pins three localStorage keys and this file is the only place that knows what
 * lives under them: `neonhorde.save.v1` (the run you can come back to),
 * `neonhorde.settings.v1` (the player's knobs) and `neonhorde.meta.v1` (the facts that
 * belong to the machine rather than to a run — what is unlocked, the best time per
 * chapter, and the last fifty runs for the history screen). The split is by lifetime: a
 * save is thrown away when its run ends, settings live across runs, and meta is written
 * *because* a run ended.
 *
 * **Why the storage is injected.** Everything here is a function over a
 * `{getItem, setItem, removeItem}` port, which buys two things. Unit tests in plain Node
 * hand it a `Map` and a whole persistence layer gets tested without a browser (the rule
 * ARCHITECTURE.md holds the sim to, extended to the layer that talks to the browser about
 * state). And nothing in here can reach a `window` that may not exist, which matters most
 * on the paths where it is most likely not to: private-mode Safari throws on *both* reads
 * and writes of a full localStorage, and a browser with storage turned off is a browser
 * this game still has to run in.
 *
 * **Nothing here throws, and nothing here forgets to mention what it caught.** A payload
 * that will not parse, or parses into something that is not the shape the key is
 * documented to hold, is discarded *and* reported through the optional `ProblemSink`, so
 * it reaches `__forgeState().errors` (AGENTS.md: count it, do not swallow it). Two
 * consequences worth spelling out, because they are decisions rather than defaults:
 *
 * - **Absence is not an error.** No key, or an empty one, is a first launch: it comes
 *   back as "nothing to load" or as the defaults, uncounted. Only a payload that was
 *   written and cannot be read is a problem.
 * - **A file from a different build is discarded whole.** Unknown keys, a wrong type, a
 *   history row with a field missing — the file is refused, defaults take over, and it is
 *   counted. Half-reading a settings file is how a renamed option silently becomes a
 *   different number for everyone who had already changed it. Fields that are simply
 *   *missing* are the exception: they take their default, so a settings file written
 *   before an option existed still carries the ones it knows.
 *
 * **Key bindings are stored as a diff, not as a map.** TECH.md lists a "dash keybind map"
 * among the three keys' contents, and the map itself is not here: it is
 * `src/input/bindings.ts`, one table that both the sampler and the Controls tab read. What
 * this file stores is the player's *diff* against it, which is why a file written before a
 * default changed still gets the new default, and why an empty `binds` means "every key as
 * shipped" rather than "no keys". A second copy of the defaults here is a second source of
 * truth that the sampler would ignore — a remap that appears in the menu and does nothing.
 */

import { LEVELS } from '../content/levels';
import { WEAPONS } from '../content/weapons';
import { isBindOverrides, type BindAction, type BindOverrides } from '../input/bindings';
import { SAVE_VERSION, deserialize, serialize } from '../sim/serialize';
import type { World } from '../sim/world';
import type { Quality } from '../render/renderer';

/** The resumable run. The name is the one TECH.md and ARCHITECTURE.md pin. */
export const SAVE_KEY = 'neonhorde.save.v1';

/** Volume, quality, resolution scale, auto-fire, shake. */
export const SETTINGS_KEY = 'neonhorde.settings.v1';

/** Unlocked chapters, best time per chapter, run history. */
export const META_KEY = 'neonhorde.meta.v1';

// The three are separate schemas that happen to travel together, so each spells its own
// version in its own key rather than reaching for `SAVE_VERSION`: a new snapshot format has
// no business resetting everyone's volumes. `SAVE_VERSION` stays where it belongs, in
// `serialize`'s payload, which `loadRun` checks below.

/**
 * The storage this module is allowed to talk to: `Storage` in the browser, a `Map` in a
 * test. `Storage` satisfies it as it stands, so the browser case is a hand-over rather
 * than an adapter.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Where a caught problem goes instead of disappearing.
 *
 * One shape for every problem this module can hit — a message, not an exception or a
 * result union — and one home for the count, which is the app's error tally. A caller
 * that does not pass a sink still gets correct answers (defaults, null); it just does not
 * hear about them, which is the difference between quiet and silent that AGENTS.md asks
 * for.
 */
export interface ProblemSink {
  note(problem: string): void;
}

function note(problems: ProblemSink | undefined, problem: string): void {
  problems?.note(problem);
}

function reason(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Read one JSON payload, or nothing.
 *
 * Four outcomes, three of which are a problem worth counting: no value (fine), a value
 * that will not parse, a value that parses to something other than an object, and a
 * storage that threw on the way in. The last one is the reason the read is wrapped:
 * Safari in private mode and `chrome://pages` with storage blocked both throw.
 */
function readJson(
  storage: StorageLike,
  key: string,
  problems: ProblemSink | undefined,
): Record<string, unknown> | null {
  let text: string | null;
  try {
    text = storage.getItem(key);
  } catch (e) {
    note(problems, `${key}: read failed (${reason(e)})`);
    return null;
  }
  if (text === null || text === '') return null;

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    note(problems, `${key}: payload did not parse`);
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    note(problems, `${key}: payload is not an object`);
    return null;
  }
  return data as Record<string, unknown>;
}

/** Write one JSON payload. False means the write did not land, counted either way. */
function writeJson(
  storage: StorageLike,
  key: string,
  value: unknown,
  problems: ProblemSink | undefined,
): boolean {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    note(problems, `${key}: would not encode (${reason(e)})`);
    return false;
  }
  try {
    storage.setItem(key, text);
    return true;
  } catch (e) {
    // Quota is the common one, and it is worth knowing about: a run that stops
    // autosaving keeps the player playing on a thread they cannot fall back to.
    note(problems, `${key}: write failed (${reason(e)})`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Write the run out, in the shape `serialize` owns.
 *
 * The whole payload goes through one `JSON.stringify` of the snapshot: no envelope, no
 * second copy of the chapter or the score beside it. A second copy is a second thing to
 * keep in step, and everything a resume screen needs (chapter, tick, kills, score) is
 * already inside the snapshot.
 */
export function saveRun(storage: StorageLike, world: World, problems?: ProblemSink): boolean {
  return writeJson(storage, SAVE_KEY, serialize(world), problems);
}

/**
 * Read a run back, or null.
 *
 * Null covers "there is no save" and "the save is unreadable" and the two are told apart
 * by the sink, not by the return value: a first launch is not an error, while a file that
 * a previous session wrote and that now fails to decode is exactly the thing a developer
 * needs to see. The shape check itself is `deserialize`'s — it returns null rather than
 * throwing on a payload it does not recognise, and that null is counted here on the way
 * past.
 */
export function loadRun(storage: StorageLike, problems?: ProblemSink): World | null {
  const data = readJson(storage, SAVE_KEY, problems);
  if (data === null) return null;

  const world = deserialize(data);
  if (world === null) note(problems, `${SAVE_KEY}: payload is not a ${SAVE_VERSION} snapshot`);
  return world;
}

/**
 * Whether something is stored under the save key.
 *
 * Presence only, deliberately: the title screen asks this to decide whether to offer
 * "Resume", and answering it must not cost a megabyte of parsing and a World to prove it.
 * An unreadable save still gets counted, at the one place that has to read it — `loadRun`.
 */
export function hasSave(storage: StorageLike, problems?: ProblemSink): boolean {
  try {
    const text = storage.getItem(SAVE_KEY);
    return text !== null && text !== '';
  } catch (e) {
    note(problems, `${SAVE_KEY}: read failed (${reason(e)})`);
    return false;
  }
}

/** Throw the stored run away: the "abandon this run" door, and what the tests reset with. */
export function clearSave(storage: StorageLike, problems?: ProblemSink): void {
  try {
    storage.removeItem(SAVE_KEY);
  } catch (e) {
    note(problems, `${SAVE_KEY}: remove failed (${reason(e)})`);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The render quality as a setting: the tiers `Quality` in `render/renderer.ts` knows,
 * plus `auto`.
 *
 * `auto` is what a first launch gets, and it is a value rather than the absence of one
 * because TECH.md asks for the tier to be *detected* on first launch (from the adapter
 * name on WebGPU, `WEBGL_debug_renderer_info` on WebGL2, Med when unsure, Low on
 * SwiftShader). A default of `medium` would have silently switched that detector off for
 * everyone who never opened the settings screen, which is everyone.
 *
 * The names are written down twice, here and in `Quality`. That is on purpose and it is
 * the kind of thing that rots quietly, so: add a tier to `Quality` and you have to add it
 * here in the same change, or a settings file that names it is refused as corrupt.
 */
export type QualitySetting = Quality | 'auto';

const QUALITY_NAMES: readonly QualitySetting[] = ['auto', 'low', 'medium', 'high', 'ultra'];

/**
 * How much of the tier's particle budget is spent, as a setting.
 *
 * A fraction rather than a count because the count belongs to the tier (`profileFor` in
 * `render/quality.ts`): "half of whatever this machine was given" is the thing a player can
 * actually set from a menu, and it is what lets "particles off" mean off on every tier
 * instead of meaning "a quarter as many on Low, an eighth as many on Ultra".
 */
export type ParticlesSetting = 'off' | 'low' | 'medium' | 'full';

/** What each of the four words is worth, as a fraction of the tier's budget. */
export const PARTICLE_FRACTION: Record<ParticlesSetting, number> = {
  off: 0,
  low: 0.3,
  medium: 0.6,
  full: 1,
};

const PARTICLE_NAMES: readonly ParticlesSetting[] = ['off', 'low', 'medium', 'full'];

/**
 * What a player can set, and what the frame budget reads.
 *
 * Every field here is read by something: the three gains and the mute by the synth, `quality`,
 * `resolutionScale`, `shadows`, `bloom` and `particles` by the renderer (as a diff against the
 * tier — see `QualityOverrides` in `render/quality.ts`), `damageNumbers` by the number layer,
 * `shake` by the camera's trauma scale, `autoFire` by the sim's trigger and `binds` by the
 * input sampler. Nothing is here because it looked like a settings field.
 *
 * The four render knobs are read when the view is built, which means changing one takes effect
 * on the next load rather than mid-run: rebuilding a live renderer to move a shadow map by one
 * notch is not a thing this app does. The Controls tab says so on those rows.
 */
export interface Settings {
  /** Master gain, 0..1. */
  master: number;
  /** Weapon and impact sound, 0..1. */
  sfx: number;
  /** Music, 0..1. */
  music: number;
  /** Every gain at zero, kept beside them rather than folded into `master`. */
  muted: boolean;
  /** Render tier, or `auto` to let the machine pick. */
  quality: QualitySetting;
  /** Fraction of native resolution, 0.5..1 (TECH.md's range). */
  resolutionScale: number;
  /** Whether anything casts a shadow, under the tier's own answer. */
  shadows: boolean;
  /** Whether the bloom pass exists, under the tier's own answer. */
  bloom: boolean;
  /** How much of the tier's particle budget gets spent. */
  particles: ParticlesSetting;
  /** Whether hits throw numbers up. The purest "I cannot read the fight" switch there is. */
  damageNumbers: boolean;
  /** Shoot on its own when a body is close; on, per TECH.md. */
  autoFire: boolean;
  /** Screen shake, 0..1. 70% is DESIGN.md's default. */
  shake: number;
  /** Key map diffs, keyed by action. Empty means the shipped map. */
  binds: BindOverrides;
}

/** Music ships under the gunfire: it is the bed the shots are heard over, and DESIGN.md
 *  ducks it further at a level-up rather than starting it low. */
const DEFAULT_MUSIC = 0.7;

/** A fresh copy, because the defaults are handed to whoever asks and must not be shared. */
export function defaultSettings(): Settings {
  return {
    master: 1,
    sfx: 1,
    music: DEFAULT_MUSIC,
    muted: false,
    quality: 'auto',
    resolutionScale: 1,
    shadows: true,
    bloom: true,
    particles: 'full',
    damageNumbers: true,
    autoFire: true,
    shake: 0.7,
    binds: {},
  };
}

/** Read the settings, or the defaults if there is no readable file. */
export function loadSettings(storage: StorageLike, problems?: ProblemSink): Settings {
  const data = readJson(storage, SETTINGS_KEY, problems);
  if (data === null) return defaultSettings();

  const bad: string[] = [];
  const settings = decodeSettings(data, bad);
  if (settings !== null) return settings;

  note(problems, `${SETTINGS_KEY}: ${bad.join('; ')}, using defaults`);
  return defaultSettings();
}

/** Write the settings. */
export function saveSettings(storage: StorageLike, settings: Settings, problems?: ProblemSink): boolean {
  return writeJson(storage, SETTINGS_KEY, settings, problems);
}

function numberField(
  src: Record<string, unknown>,
  key: string,
  def: number,
  min: number,
  max: number,
  bad: string[],
): number {
  const v = src[key];
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    bad.push(`"${key}" is not a finite number`);
    return def;
  }
  // Out of range is clamped, not refused. A hand-edited 1.4 on a volume is somebody who
  // wants it louder, and the clamp still cannot do anything the game cannot already do.
  return clamp(v, min, max);
}

function flagField(
  src: Record<string, unknown>,
  key: string,
  def: boolean,
  bad: string[],
): boolean {
  const v = src[key];
  if (v === undefined) return def;
  if (typeof v !== 'boolean') {
    bad.push(`"${key}" is not a boolean`);
    return def;
  }
  return v;
}

function qualityField(src: Record<string, unknown>, bad: string[]): QualitySetting {
  const v = src.quality;
  if (v === undefined) return 'auto';
  const found = QUALITY_NAMES.find((name) => name === v);
  if (found === undefined) {
    bad.push('"quality" is not a known tier');
    return 'auto';
  }
  return found;
}

function particlesField(src: Record<string, unknown>, bad: string[]): ParticlesSetting {
  const v = src.particles;
  if (v === undefined) return 'full';
  const found = PARTICLE_NAMES.find((name) => name === v);
  if (found === undefined) {
    bad.push('"particles" is not a known level');
    return 'full';
  }
  return found;
}

/**
 * The key-map diff, checked against `bindings.ts` rather than against a shape of its own.
 *
 * A bind payload that names an action the sampler does not know, or holds something that is not
 * a list of key codes, is refused whole: half a key map is a game where a key does nothing and
 * the menu says it does something, which is the exact failure the one-table rule exists to
 * prevent.
 */
function bindsField(src: Record<string, unknown>, bad: string[]): BindOverrides {
  const v = src.binds;
  if (v === undefined) return {};
  if (!isBindOverrides(v)) {
    bad.push('"binds" is not a key map');
    return {};
  }
  // Copied key by key, for the same reason the history rows are: what came out of
  // `JSON.parse` is data that happens to typecheck, and the sampler reads this every key press.
  const out: BindOverrides = {};
  for (const [key, sources] of Object.entries(v)) {
    out[key as BindAction] = sources.slice();
  }
  return out;
}

function decodeSettings(data: Record<string, unknown>, bad: string[]): Settings | null {
  const d = defaultSettings();
  const out: Settings = {
    master: numberField(data, 'master', d.master, 0, 1, bad),
    sfx: numberField(data, 'sfx', d.sfx, 0, 1, bad),
    music: numberField(data, 'music', d.music, 0, 1, bad),
    resolutionScale: numberField(data, 'resolutionScale', d.resolutionScale, 0.5, 1, bad),
    shake: numberField(data, 'shake', d.shake, 0, 1, bad),
    quality: qualityField(data, bad),
    particles: particlesField(data, bad),
    muted: flagField(data, 'muted', d.muted, bad),
    shadows: flagField(data, 'shadows', d.shadows, bad),
    bloom: flagField(data, 'bloom', d.bloom, bad),
    damageNumbers: flagField(data, 'damageNumbers', d.damageNumbers, bad),
    autoFire: flagField(data, 'autoFire', d.autoFire, bad),
    binds: bindsField(data, bad),
  };
  for (const key of Object.keys(data)) {
    if (!(key in out)) bad.push(`"${key}" is not a setting`);
  }
  return bad.length === 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Meta: unlocks, best times, history
// ---------------------------------------------------------------------------

/** One finished run, as the history table shows it. */
export interface RunRecord {
  /** ISO date the run ended on. Passed in rather than read here: this module has no clock. */
  date: string;
  /** Chapter it ended in, 0-based. */
  chapter: number;
  /** Simulated seconds it lasted. */
  time: number;
  kills: number;
  score: number;
  /** Weapon ids the run was holding when it ended, in slot order. */
  weapons: string[];
}

/** How many runs the history screen keeps. Beyond this a row is a wall of text. */
export const HISTORY_LIMIT = 50;

/** `bestTimes` for a chapter nobody has finished. `Infinity` has no JSON spelling, and
 *  `null` would make every read a type check; a negative second count cannot be a time. */
export const NO_CLEAR = -1;

/**
 * What the machine knows across runs.
 *
 * `unlockedChapters` is a count rather than a list because unlocks are earned in order:
 * one number says which of the ten tiles are lit, and there is no state where chapter
 * seven is open while six is not. `bestTimes` is indexed by chapter, so the chapter grid
 * can show a ghost time beside the tile.
 */
export interface Meta {
  unlockedChapters: number;
  bestTimes: number[];
  history: RunRecord[];
}

/** A first-run meta: chapter one open, nothing finished, nothing remembered. */
export function defaultMeta(): Meta {
  return {
    unlockedChapters: 1,
    bestTimes: new Array<number>(LEVELS.length).fill(NO_CLEAR),
    history: [],
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
 * it.
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
  });
  while (meta.history.length > HISTORY_LIMIT) meta.history.shift();

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

function isRunRecord(v: unknown): v is RunRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const row = v as Record<string, unknown>;
  if (Object.keys(row).length !== 6) return false;
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
      }));
    }
  }

  for (const key of Object.keys(data)) {
    if (!(key in out)) bad.push(`"${key}" is not meta`);
  }
  return bad.length === 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

/** Seconds of play between autosaves — TECH.md's cadence, written down once. */
export const AUTOSAVE_INTERVAL = 30;

/**
 * When the run is due to be written out.
 *
 * It is fed *simulated* seconds (`world.time`), never a wall clock, and that is the whole
 * design. Time in this game only advances while the sim steps, so a pause, a level-up
 * card screen, a backgrounded tab and a frame that ran out of its step cap all hold the
 * clock still, and an interval measured on it cannot be talked into a save by a
 * stall. It also means the timer is pure enough to test without a renderer, a clock or a
 * browser.
 */
export interface AutosaveTimer {
  /** Seconds of play between writes. */
  readonly interval: number;
  /** Play seconds at which the next write is due. */
  nextAt: number;
  /** The chapter whose ending has been written since it happened; -1 while none has. */
  endChapter: number;
}

/** A timer for one run: the first write is due a full interval in, or at a chapter's end. */
export function createAutosaveTimer(interval: number = AUTOSAVE_INTERVAL): AutosaveTimer {
  return { interval, nextAt: interval, endChapter: -1 };
}

/**
 * Whether the run should be written right now.
 *
 * A chapter end stays due until somebody acts on it, and it is keyed by *which* chapter
 * ended rather than by "an ending has been written". Both halves matter. The flag outlives
 * the encounter by four seconds of intermission, so a rule that only fired on the rising
 * edge would need somebody to notice the tick it happened on; and a rule that fired once
 * per *run* would spend its one allowance on chapter one and let chapters two and three
 * end unwritten — the intermission is four seconds long and the autosave clock is thirty,
 * so a chapter can easily finish inside the gap its predecessor opened.
 *
 * A victory is not covered here. `victory` arrives after the intermission, by which time
 * there is no chapter left to resume, and a save of a finished run is a Resume button that
 * puts you back inside a game you already won.
 */
export function autosaveDue(timer: AutosaveTimer, world: World): boolean {
  if (world.chapterComplete && world.chapter !== timer.endChapter) return true;
  return world.time >= timer.nextAt;
}

/**
 * Record that the run was written, and start the next interval from where it was written.
 *
 * The timer belongs to a run the way the World does: a restart builds a new World, and the
 * timer is created with it. Handing a spent timer to a fresh run would leave it waiting out
 * an interval it has no way to be inside, which is the one way this helper can be
 * misused, so it is written down here rather than hidden in a name.
 */
export function markAutosaved(timer: AutosaveTimer, world: World): void {
  timer.nextAt = world.time + timer.interval;
  timer.endChapter = world.chapterComplete ? world.chapter : -1;
}