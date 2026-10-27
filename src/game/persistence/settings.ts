/**
 * Settings: what a player may set, and how a file that arrived here is checked.
 *
 * **Key bindings are stored as a diff, not as a map.** TECH.md lists a "dash keybind map"
 * among the three keys' contents, and the map itself is not here: it is
 * `src/input/bindings.ts`, one table that both the sampler and the Controls tab read. What
 * this file stores is the player's *diff* against it, which is why a file written before a
 * default changed still gets the new default, and why an empty `binds` means "every key as
 * shipped" rather than "no keys". A second copy of the defaults here is a second source of
 * truth that the sampler would ignore — a remap that appears in the menu and does nothing.
 *
 * A payload is either read whole or refused whole; a field that is merely *missing* takes
 * its default, so a file written before an option existed still carries the ones it knows.
 */

import { isBindOverrides, type BindAction, type BindOverrides } from '../../input/bindings';
import type { Quality } from '../../render/renderer';
import { clamp, note, readJson, writeJson, type ProblemSink, type StorageLike } from './envelope';
import { SETTINGS_KEY } from './keys';

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
