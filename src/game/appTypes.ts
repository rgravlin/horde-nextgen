/**
 * The shapes the game shell shares with its callers.
 *
 * `app.ts` runs the scene machine and `appState.ts` paints these objects; this file is the
 * contract between them and the two readers that are not the game: `main.ts`, which publishes
 * `window.__forgeState`/`__forgeDebug`, and the browser scenarios that assert on them. It is
 * types plus the one function that builds a snapshot (`snapshotSettings`) of the shape declared
 * here, so a scenario reading a dial back out of `__forgeState().settings` reads it through the
 * same door the shell writes it through.
 *
 * No DOM, no engine, no timers — this file must keep compiling in plain Node, which is what
 * lets a unit test build a whole app with no renderer (ARCHITECTURE.md "One shared core, two
 * runtimes").
 */

import { BIND_DEFS, type BindAction, type BindTable } from '../input/bindings';
import type { PadSource } from '../input/gamepad';
import type { View } from '../render/renderer';
import type { World } from '../sim/world';
import type { AudioEngine } from '../audio/synth';
import type { Hud, HudCommand } from '../ui/hud';
import type { BenchOptions, BenchRig } from './bench';
import type {
  Meta,
  ParticlesSetting,
  QualitySetting,
  Settings,
  StorageLike,
} from './persistence';

/**
 * The scenes the shell runs.
 *
 * Only `playing` advances the simulation; every other id draws a frozen frame, which is what
 * "the game freezes" means here and what lets a pause hold a thousand bodies mid-charge without a
 * single position changing (ARCHITECTURE.md "Scene state machine").
 *
 * Four of them are panels rather than states of a run — `levelselect`, `settings`, `history` and
 * `victory` — and each remembers the screen it was opened from, so `back` returns to the pause
 * panel from the pause panel and to the title from the title.
 */
export type SceneId =
  | 'menu'
  | 'playing'
  | 'levelup'
  | 'paused'
  | 'summary'
  | 'victory'
  | 'levelselect'
  | 'settings'
  | 'history';

export interface ForgeWeapon {
  id: string;
  family: string;
  /** Rounds in hand; 0 for a weapon that has no magazine. */
  ammo: number;
  /** Heat on the barrel, 0 to the def's `max`; 0 for a weapon that does not run hot. */
  heat: number;
  /** Charge in hand, 0 to the def's `capacity`; 0 for a weapon that is not charged. */
  energy: number;
  /** The barrel is venting, which is why the hand is not firing. */
  venting: boolean;
  reloading: boolean;
}

/**
 * What `__forgeState().settings` reports.
 *
 * A snapshot rather than the whole `Settings`, and only the four knobs a browser scenario has
 * reason to move: the two that change what is drawn, the trigger rule, and the shake. A test that
 * turns a dial and reads it back on the next page load is the only proof that a setting is
 * *stored* rather than merely applied, and this is the seam it reads through.
 */
export interface SettingsSnapshot {
  quality: QualitySetting;
  particles: ParticlesSetting;
  damageNumbers: boolean;
  autoFire: boolean;
  shake: number;
  /** The live key map: each action against its sources, space-joined. */
  binds: Record<string, string>;
}

/** Build one, from the settings and the table compiled out of them. */
export function snapshotSettings(settings: Settings, table: BindTable): SettingsSnapshot {
  const binds: Record<string, string> = {};
  for (const def of BIND_DEFS) binds[def.action] = table.sourcesOf(def.action).join(' ');
  return {
    quality: settings.quality,
    particles: settings.particles,
    damageNumbers: settings.damageNumbers,
    autoFire: settings.autoFire,
    shake: settings.shake,
    binds,
  };
}

/** The exact `window.__forgeState()` shape from TECH.md "State for checks". */
export interface ForgeState {
  scene: SceneId;
  backend: 'webgpu' | 'webgl2' | 'none';
  tick: number;
  chapter: number;
  mode: 'campaign' | 'arena' | 'bench';
  player: {
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    shield: number;
    level: number;
    xp: number;
    dashReady: boolean;
    alive: boolean;
  };
  wave: { index: number; timeLeft: number; bossAlive: boolean };
  /**
   * The chapter's encounter, for the boss plate and the top-centre bar: `hp` and `maxHp` are
   * the combined total across every body of the encounter (a chapter is allowed to end on more
   * than one), and `name` is the lead body's id. All quiet when nothing is on the floor.
   */
  boss: { alive: boolean; name: string; hp: number; maxHp: number };
  /** The encounter is dead and the next floor has not loaded yet. */
  chapterComplete: boolean;
  /** Every chapter has fallen, so the run is won. */
  victory: boolean;
  score: number;
  kills: number;
  enemies: {
    count: number;
    byType: Record<string, number>;
    nearest: Array<{ type: string; x: number; y: number; hp: number }>;
  };
  weapons: ForgeWeapon[];
  activeWeapon: string;
  powerups: Array<{ id: string; tier: number }>;
  levelUpChoices: string[];
  fps: number;
  errors: number;
  /** The settings the shell runs under, and the live key map, for a scenario to read back. */
  settings: SettingsSnapshot;
}

/** `window.__forgeDebug`, for scenarios and tests that need to set a scene up. */
export interface ForgeDebug {
  setSeed(seed: number): void;
  spawn(type: number, n: number): number;
  grantXp(n: number): void;
  giveWeapon(id: string): boolean;
  /**
   * Start a bench window at horde size `n` (`?bench=N` gets here straight off the URL).
   *
   * It restarts the run on the chosen floor rather than arming on top of whatever screen the page
   * is on: a bench measures a fight, so it needs a playing scene and a floor under it. Returns the
   * number of bodies on the floor when the window armed — less than `n` only when the pool said
   * no, which is the load being short and worth seeing.
   */
  bench(n: number, options?: BenchOptions): number;
}

export interface App {
  readonly scene: SceneId;
  readonly world: World;
  /** Advance one browser frame: drain the accumulator, draw, sync the overlay. */
  advance(nowMs: number): void;
  command(cmd: HudCommand): void;
  pick(index: number): void;
  state(): ForgeState;
  readonly debug: ForgeDebug;
  /** Count a caught error; surfaces through `state().errors`. */
  noteError(): void;

  /**
   * The bench window this page is running, or null if it is playing a campaign.
   *
   * `main.ts` reads it to publish `window.__benchResults` once the window is spent: the rig keeps
   * its own clock and its own samples, so nothing here has to know what a finished report looks
   * like, and the page's only job is to hand the numbers to something that can print them.
   */
  readonly bench: BenchRig | null;

  /** The live settings, as they came off disk. The Settings tab reads and writes through this. */
  readonly settings: Settings;
  /** Change one and store the file, so it is still there after a reload. */
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  /** The live key map — the same table the sampler reads, not a copy of it. */
  readonly bindings: BindTable;
  /** Put `source` on `action`, swapping out whatever already had it. */
  rebind(action: BindAction, source: string): void;
  /** Back to the shipped map. */
  resetBindings(): void;

  /**
   * Whether a resumable run is on the shelf.
   *
   * Answered from a flag rather than a `getItem`: the title and pause panels ask every frame,
   * and a read of the file sixty times a second is not a check, it is a stall.
   */
  readonly hasSave: boolean;
  /** Unlocks, best times and history, as read at boot and updated when a chapter or run ends. */
  readonly meta: Meta;
  /** Start chapter `index`, from the chapter grid or a restart at the current floor. */
  choose(index: number): void;
}

export interface AppPorts {
  view: View | null;
  hud: Hud | null;
  seed: number;
  /** Passed in so the state can report it without the shell importing the engine. */
  backend: 'webgpu' | 'webgl2' | 'none';
  /**
   * Where a run outlives the page: `window.localStorage` in the browser, a `Map` in a
   * headless test, `null` where there is no storage at all (a browser with it turned off,
   * a Node run). `persistence.ts` owns what is written under which key; the shell only
   * decides *when*, and it does that through this port so nothing here reaches for a
   * `window` that may not exist.
   */
  storage?: StorageLike | null;
  /**
   * The player's settings, decoded off disk by the shell.
   *
   * They come in through a port rather than being read here because `src/game` must not reach
   * for `window.localStorage` (ARCHITECTURE.md: the sim runs headless in Node), and because a
   * headless run then runs on `defaultSettings()` without a fake to invent.
   */
  settings?: Settings;
  /** Unlocks, best times and history, read at boot. A run's end updates the copy. */
  meta?: Meta;
  /**
   * Where the gamepads come from. Left out, the sampler polls the real `navigator.getGamepads`
   * through `input/gamepad.ts`; a headless test hands over a list of sticks and buttons and plays
   * the game with a controller that does not exist. It is a port for the same reason the storage
   * is one: `src/game` does not reach for `window`, so the scene machine runs in plain Node.
   */
  pads?: PadSource;
  /**
   * The soundtrack, built by the shell and driven from here.
   *
   * Audio comes in through a port for the same reason the gamepads do: `src/game` does not touch
   * `window` or an `AudioContext`, so the scene machine still runs in plain Node. Left out, the
   * game plays silent — which is a degraded run rather than a broken one, and why this is a port
   * with a `null` rather than something the shell insists on.
   *
   * It is a *reader* of the frame, called after the sim has stepped however many ticks that frame
   * was owed, so one call covers up to five ticks of events (ARCHITECTURE.md "Data flow": render
   * and `audio.drain()` are the same phase of the frame). It gets the live `World`, the scene the
   * frame ended on — that is how the music ducks on the cards and the summary — the frame's real
   * elapsed time, and the player's four volume knobs.
   */
  audio?: AudioEngine | null;
  /**
   * A millisecond clock, for the bench rig.
   *
   * It comes in as a port for the same reason the storage does: `src/game` does not reach for a
   * wall clock, so a headless test can drive a whole bench window with a counter and get exact
   * frame times out of it. Left out, a rig falls back to `Date.now`, which is fine to run and too
   * coarse to trust.
   */
  now?: () => number;
}