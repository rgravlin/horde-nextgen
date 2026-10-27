/**
 * The Settings panel's rows, and the two bind lists, as data.
 *
 * A row is a ladder rather than a slider: `stops` is the whole ladder and `at` says where the
 * player currently sits on it, so a click can step *from* there. `at` may point at a rung the
 * value is not — `shake` ships at 0.7, between two of a dial's stops — and the row prints the
 * real number while the click moves to the next stop up. That is the whole reason the table
 * exists: the Controls tab and the panel are one list of buttons, and the list has to be
 * written somewhere the sampler's own key map (`input/bindings.ts`) can be read from it.
 *
 * Kept out of the panel that draws it for the same reason the weapon captions are kept out of
 * the HUD: it is content, it is read once a tab opens rather than once a frame, and a new row
 * should be one line here rather than a change to the code that paints rows.
 */

import { NO_CLEAR, type Settings } from '../../game/persistence';
import { BIND_DEFS, type BindAction } from '../../input/bindings';

/**
 * A pool id's caption, for the two places that list weapons by what they are called.
 *
 * An id is a key (`plasmaRepeater`) and a caption is a caption (`Plasma Repeater`); splitting the
 * camel case is the same trick `handLabel` uses in `hud.ts`, and it means a new weapon needs no
 * caption written for it either.
 */
export function readable(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** `0:43` for a chapter time, `--` for one that has never happened. */
export function clockTime(seconds: number): string {
  if (seconds === NO_CLEAR || !(seconds >= 0)) return '--';
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Percent, for the four rows that are a gain or a scale. */
function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** A dial's five stops, ending where it started. */
const LEVELS_STOPS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

/** Resolution has finer stops because its floor is 0.5 rather than 0. */
const SCALE_STOPS: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9, 1];

const QUALITY_STOPS = ['auto', 'low', 'medium', 'high', 'ultra'] as const;

const PARTICLE_STOPS = ['off', 'low', 'medium', 'full'] as const;

/** The four tabs, in the order DESIGN.md lists them. */
export const TABS = ['audio', 'video', 'controls', 'gameplay'] as const;
export type Tab = (typeof TABS)[number];

/**
 * One row of the Settings panel.
 *
 * `stops` is the whole ladder the row walks and `at` says where the player currently sits on it,
 * so a click can step *from* there. `at` may point at a rung the value is not: `shake` ships at
 * 0.7, which sits between two of the dial's stops, and the row prints the real number while the
 * click moves to the next stop up.
 */
export interface SettingRow {
  readonly key: keyof Settings;
  readonly label: string;
  readonly hint: string;
  readonly tab: Tab;
  readonly stops: readonly (string | number | boolean)[];
  at(settings: Settings): number;
  /** What the row prints: the current value, never the next one. */
  current(settings: Settings): string;
}

/** Where a value sits on a ladder, or the nearest rung when it is between two. */
function nearest(stops: readonly number[], v: number): number {
  let best = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < stops.length; i++) {
    const gap = Math.abs(stops[i] - v);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

export function nextStop(row: SettingRow, s: Settings): string | number | boolean {
  return row.stops[(row.at(s) + 1) % row.stops.length];
}

/** A gain dial: five stops, read back as a percent. */
function dial(
  key: keyof Settings,
  label: string,
  hint: string,
  tab: Tab,
  stops: readonly number[] = LEVELS_STOPS,
): SettingRow {
  return {
    key,
    label,
    hint,
    tab,
    stops,
    at: (s) => nearest(stops, s[key] as number),
    current: (s) => percent(s[key] as number),
  };
}

function toggle(key: keyof Settings, label: string, hint: string, tab: Tab): SettingRow {
  return {
    key,
    label,
    hint,
    tab,
    stops: [false, true],
    at: (s) => (s[key] as boolean ? 1 : 0),
    current: (s) => (s[key] as boolean ? 'on' : 'off'),
  };
}

function ladder(
  key: keyof Settings,
  label: string,
  hint: string,
  tab: Tab,
  stops: readonly string[],
): SettingRow {
  return {
    key,
    label,
    hint,
    tab,
    stops,
    at: (s) => {
      const at = stops.indexOf(s[key] as never);
      return at >= 0 ? at : 0;
    },
    current: (s) => String(s[key]),
  };
}

/** Every row the Settings panel shows, in tab order. */
export const SETTING_ROWS: readonly SettingRow[] = [
  toggle('muted', 'mute', 'silence every gain at once', 'audio'),
  dial('master', 'master', 'everything, after the mute', 'audio'),
  dial('sfx', 'gunfire', 'weapons, impacts, the blast on a big one', 'audio'),
  dial('music', 'music', 'the bed the gunfire sits on', 'audio'),
  ladder('quality', 'quality', 'what the machine picked, or the tier you picked over it', 'video', QUALITY_STOPS),
  {
    key: 'resolutionScale',
    label: 'resolution',
    hint: "of native, under the tier's own ceiling",
    tab: 'video',
    stops: SCALE_STOPS,
    at: (s) => nearest(SCALE_STOPS, s.resolutionScale),
    current: (s) => percent(s.resolutionScale),
  },
  toggle('shadows', 'shadows', 'needs a tier that has them', 'video'),
  toggle('bloom', 'bloom + chromatic', 'the glow, and the punch on a big hit', 'video'),
  ladder('particles', 'particles', 'of the tier\u2019s spark budget', 'video', PARTICLE_STOPS),
  toggle('damageNumbers', 'damage numbers', 'the floating mono numbers', 'video'),
  toggle('autoFire', 'auto-fire', 'shoots on its own when something is close', 'gameplay'),
  dial('shake', 'screen shake', 'this shipped at 70%', 'gameplay'),
];

/** The binds the Controls tab offers, in `BIND_DEFS` order. */
export const BIND_ROWS: readonly BindAction[] = BIND_DEFS.map((def) => def.action);

/**
 * The keys the pause panel quotes.
 *
 * Six of the thirteen, because the panel is 380px wide and seven buttons tall and the rest are
 * not used during a fight. DESIGN.md's "one-line hint", read from the live map so a rebind shows
 * up here too.
 */
export const PAUSE_HINT: readonly BindAction[] = ['up', 'left', 'dash', 'fire', 'swap', 'pause'];

/** The caption each bind row shows, from the table rather than written out here. */
export const BIND_LABELS = new Map<BindAction, string>(BIND_DEFS.map((def) => [def.action, def.label]));

/** The columns of the run-history table. */
export const HISTORY_HEADS = ['time', 'kills', 'score', 'chapter', 'carried'] as const;
