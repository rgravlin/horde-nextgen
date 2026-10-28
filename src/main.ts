/**
 * The composition root: the browser-only wiring that turns the pieces into a game.
 *
 * It builds the renderer (best-effort), the DOM overlay and the game shell, then
 * drives them from one requestAnimationFrame loop. Everything decision-shaped lives
 * in `src/game` and `src/sim`; this file only plugs them together and exposes the
 * two check hooks the browser scenarios read (TECH.md "State for checks").
 *
 * The renderer is optional by design. If `renderer.init()` fails — a machine with
 * neither WebGPU nor WebGL2 — the shell still runs the simulation with `view: null`
 * and a panel explains why nothing is drawn, rather than the page dying on a black
 * canvas. A scenario checks `__forgeState()`, not pixels, so a headless box still
 * exercises the game.
 */

import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/ibm-plex-mono/700.css';

import { createEngine, type AudioEngine, type AudioGraph } from './audio/synth';
import { createApp } from './game/app';
import { snapshotSettings, type App, type ForgeState } from './game/appTypes';
import type { BenchResult } from './game/bench';
import { defaultSettings, loadMeta, loadSettings, type Settings, type StorageLike } from './game/persistence';
import { buildBinds } from './input/bindings';
import { createView, type View, type ViewOptions } from './render/renderer';
import { createHud } from './ui/hud';

/**
 * The run's knobs that come from the URL.
 *
 * `?bench=N` is the one that changes what the page *is*: a bench window rather than a game (see
 * `src/game/bench.ts`). It has to arrive before the app is built because it replaces the run — a
 * bench that had to be started by hand from a menu would never be run twice the same way — and
 * `&seconds=` and `&chapter=` are there for the same reason: two runs of the same URL are two
 * comparable numbers, and two runs of a different URL are not.
 *
 * `?arena=1` is the other run-shaped knob: it starts the page inside the Endless Arena. A player
 * reaches that mode through the chapter grid or the victory sweep, once a win is in their meta
 * file, and both of those doors stay as they are — this is the scripted door, for the `arena`
 * scenario in `forge-scenarios.json`, which starts from an empty profile and whose step list can
 * only press keys and click things. It goes through `__forgeDebug.arena()` rather than by editing
 * any value, so the run it produces is still reproducible from its seed.
 */
function readParams(): {
  seed: number;
  forceWebGL: boolean;
  bench: number;
  seconds: number;
  chapter: number;
  arena: boolean;
} {
  let seed = 1;
  let forceWebGL = false;
  let bench = 0;
  let seconds = 0;
  let chapter = 0;
  let arena = false;
  try {
    const params = new URLSearchParams(location.search);
    const positive = (key: string): number => {
      const raw = params.get(key);
      if (raw === null) return 0;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    };
    seed = positive('seed') || 1;
    forceWebGL = params.get('gl') === 'webgl2';
    // `?bench=1000` is a horde size; 0 or a nonsense value means no bench at all.
    bench = positive('bench');
    seconds = positive('seconds');
    // `&chapter` is 1-based, the way every other place a chapter is named is, so `&chapter=10`
    // is the tenth floor. It is clamped against the roster where the bench is armed.
    chapter = positive('chapter');
    arena = params.get('arena') === '1';
  } catch {
    // A missing location (a non-browser import) keeps the defaults.
  }
  return { seed, forceWebGL, bench, seconds, chapter, arena };
}

/**
 * The run's storage, handed to the shell as a port.
 *
 * `Storage` already satisfies `StorageLike`, so this is a hand-over rather than an adapter;
 * the wrapper exists for the two ways it can fail. Reading `window.localStorage` throws by
 * itself in private-mode Safari and on a page with storage blocked, and a storage that
 * throws on every call is what the persistence layer is written against (it counts the
 * failure and carries on with the defaults). Returning `null` means the game plays with no
 * saves at all rather than with a broken one.
 */
function openStorage(): StorageLike | null {
  try {
    const store = globalThis.localStorage;
    if (!store) return null;
    return {
      getItem: (key) => store.getItem(key),
      setItem: (key, value) => {
        store.setItem(key, value);
      },
      removeItem: (key) => {
        store.removeItem(key);
      },
    };
  } catch {
    return null;
  }
}

/**
 * The soundtrack, or nothing.
 *
 * Like the renderer, audio is a best-effort device: a machine with no output, or a browser with
 * no `AudioContext`, plays a silent game rather than a broken one, and the fact goes to the
 * console rather than into `errors` — the same call `boot()` makes about a machine with neither
 * WebGPU nor WebGL2, where a missing capability is not a fault the run made. A throw *after* the
 * engine exists is different (a sound that cannot be built is a bug), so that one path reports
 * through `fault` and lands in `__forgeState().errors`.
 *
 * The `AudioGraph` is spelled out rather than handed over as the raw context for two reasons.
 * `resume()` returns a promise, and the engine calls and forgets it — an unhandled rejection
 * would trip the `unhandledrejection` listener below and be counted sixty times a second on a
 * machine that simply will not start audio. And a getter written here reads the live context
 * every time, which is what the engine's per-frame "still suspended?" knock needs.
 */
function openAudio(warn: (problem: string) => void, fault: (problem: string) => void): AudioEngine | null {
  if (typeof AudioContext === 'undefined') {
    warn('audio: no AudioContext, playing silent');
    return null;
  }

  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ latencyHint: 'interactive' });
  } catch (error) {
    warn(`audio: no audio device (${String(error)}), playing silent`);
    return null;
  }

  // Autoplay policy: a context is born suspended and only a gesture lets it run. Two one-shot
  // listeners cover a keyboard and a mouse start; the engine's once-a-second `resume` knock
  // covers a run driven by a script, where nobody presses anything.
  const unlock = (): void => {
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  const graph: AudioGraph = {
    get currentTime() {
      return ctx.currentTime;
    },
    get sampleRate() {
      return ctx.sampleRate;
    },
    get destination() {
      return ctx.destination;
    },
    get state() {
      return ctx.state;
    },
    resume: () => {
      void ctx.resume().catch(() => {});
    },
    createGain: () => ctx.createGain(),
    createOscillator: () => ctx.createOscillator(),
    createBufferSource: () => ctx.createBufferSource(),
    createBuffer: (channels, length, sampleRate) => ctx.createBuffer(channels, length, sampleRate),
    createBiquadFilter: () => ctx.createBiquadFilter(),
    createStereoPanner: () => ctx.createStereoPanner(),
    createDelay: (maxDelay) => ctx.createDelay(maxDelay),
    createDynamicsCompressor: () => ctx.createDynamicsCompressor(),
  };

  try {
    return createEngine(graph, { note: fault });
  } catch (error) {
    warn(`audio: the synth would not start (${String(error)}), playing silent`);
    return null;
  }
}

/** The menu state served before the app exists, so `__forgeState` is never absent. */
function idleState(backend: ForgeState['backend']): ForgeState {
  return {
    scene: 'menu',
    backend,
    tick: 0,
    chapter: 0,
    mode: 'campaign',
    player: {
      x: 0,
      y: 0,
      hp: 100,
      maxHp: 100,
      shield: 0,
      level: 1,
      xp: 0,
      dashReady: true,
      alive: true,
      // The aim a World is born with, so the placeholder answers the same question the live
      // state does — and nothing reading the two pairs off a menu page divides by a zero.
      shot: { x: 1, y: 0 },
      barrel: { x: 1, y: 0 },
    },
    wave: { index: 1, timeLeft: 0, bossAlive: false },
    boss: { alive: false, name: '', hp: 0, maxHp: 0 },
    // No run, so no companion and nothing drawn: the same answer a live page gives when it has no
    // backend to ask, which is why `drawn` is no place rather than a ring the drone is not on.
    drone: { shown: false, orbit: { x: 1, y: 0 }, drawn: { x: 0, y: 0, h: 0 } },
    chapterComplete: false,
    victory: false,
    score: 0,
    kills: 0,
    enemies: { count: 0, byType: {}, nearest: [] },
    weapons: [],
    activeWeapon: '',
    powerups: [],
    levelUpChoices: [],
    fps: 0,
    errors: 0,
    settings: snapshotSettings(defaultSettings(), buildBinds()),
  };
}

/** The "needs WebGL2" panel: the one failure that is worth showing the player. */
function showNoGpuPanel(root: HTMLElement, message: string): void {
  const panel = document.createElement('div');
  panel.className = 'no-gpu';
  panel.textContent = `Your browser can't run this (needs WebGL2). ${message}`;
  root.appendChild(panel);
}

/**
 * The render knobs, read from the settings file.
 *
 * The tier, the resolution scale and the shake amount are settings (`persistence.ts`), not
 * build-time constants, so they are read here and handed to the renderer as plain numbers:
 * `quality.ts` and `shake.ts` stay free of storage and of `window`, which is what lets a unit
 * test drive them. `quality: 'auto'` means "ask the machine", so it goes over as no opinion
 * rather than as a tier — see `QualitySetting`.
 *
 * Anything wrong with the file is pushed into `quiet` rather than dropped, and the caller
 * counts it once the app exists.
 */
function readSettings(storage: StorageLike | null, quiet: string[]): Settings {
  if (storage === null) return defaultSettings();
  return loadSettings(storage, { note: (problem) => quiet.push(problem) });
}

/** The settings plus the URL's backend override, in the shape `createView` takes. */
function viewOptions(settings: Settings, forceWebGL: boolean, host: HTMLElement | null): ViewOptions {
  return {
    forceWebGL,
    quality: settings.quality === 'auto' ? undefined : settings.quality,
    resolutionScale: settings.resolutionScale,
    shake: settings.shake,
    damageNumbers: settings.damageNumbers,
    // Where the damage numbers draw, and whether they draw at all. `createNumbers` takes these
    // two together: without a host the layer is built anyway and counts every hit into a pool no
    // one reads, so the numbers are on in the settings and absent from every frame, and the
    // toggle has nothing to turn off.
    overlay: host,
  };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
  const ui = document.getElementById('ui');
  const { seed, forceWebGL, bench, seconds, chapter, arena } = readParams();

  // The state hook is registered before anything is awaited, so `window.__forgeState`
  // is never absent — not while the renderer is still coming up, and not on a box
  // with no backend at all. It reads these two through the closure, so nothing has to
  // be re-pointed once the game exists.
  let backend: ForgeState['backend'] = 'none';
  let app: App | null = null;
  const w = window as unknown as {
    __forgeState?: () => ForgeState;
    __forgeDebug?: App['debug'];
    __benchResults?: BenchResult | null;
  };
  w.__forgeState = () => (app ? app.state() : idleState(backend));

  // The bench report leaves the same way: a page that is not benching answers null, a page inside
  // its window answers null, and a spent window answers with its numbers. A getter rather than a
  // write, because nothing has to notice the moment the window closes — the scenario that waits
  // for the report is the poll, and a per-frame check here would be a second one to keep in step.
  Object.defineProperty(w, '__benchResults', {
    get: () => app?.bench?.result ?? null,
    configurable: true,
  });

  // Errors are counted, never swallowed: an uncaught exception or a dropped promise
  // lands in `errors`, where the scenarios can see it (AGENTS.md).
  const noteError = (): void => {
    app?.noteError();
  };
  window.addEventListener('error', noteError);
  window.addEventListener('unhandledrejection', noteError);

  // The simulation waits for the renderer to resolve before it is built, so the
  // fixed-step clock's first frame is the first real frame: no time is banked while
  // `init()` runs, and a run's play time tracks real time from the first tick.
  //
  // The settings are read in that same pause, synchronously: one storage read, and the tier
  // has to be known before the first frame is sized.
  const storage = openStorage();
  const quiet: string[] = [];
  const settings = readSettings(storage, quiet);

  let view: View | null = null;
  if (canvas) {
    try {
      const result = await createView(canvas, viewOptions(settings, forceWebGL, ui));
      if (result.ok) view = result.view;
      else if (ui) showNoGpuPanel(ui, result.message);
    } catch (error) {
      if (ui) showNoGpuPanel(ui, String(error));
    }
  }
  backend = view ? view.backend : 'none';

  const hud = ui ? createHud(ui) : null;

  // The synth is built in the same pause, before the first frame: the graph, the noise buffer and
  // the three songs exist by the time the title screen is drawn, so the first sound a player ever
  // hears is not the sound of a compile.
  const audio = openAudio(
    (problem) => console.warn(problem),
    (problem) => {
      console.warn(problem);
      noteError();
    },
  );

  app = createApp({
    view,
    hud,
    audio,
    seed,
    backend,
    storage,
    settings,
    // Unlocks and history come in beside the settings for the same reason: the chapter grid and
    // the Runs table read them, and `src/game` may not reach for `window`.
    meta: storage === null ? undefined : loadMeta(storage, { note: (problem) => quiet.push(problem) }),
    // The bench rig's clock. `performance.now` rather than the rAF stamp the loop is handed,
    // because the rig measures *work between two reads* and needs a clock it can read a second
    // time inside the frame; see the header of `src/game/bench.ts`.
    now: () => performance.now(),
  });

  // A settings file that would not parse is counted rather than hushed (AGENTS.md): the tier
  // and the shake the player chose are gone, so this is not the run they asked for, and
  // `errors` is the one place a check can see that.
  for (const problem of quiet) {
    console.warn(problem);
    noteError();
  }
  w.__forgeDebug = app.debug;

  // `?bench=1000` replaces the run with a bench window, armed here rather than behind a menu or a
  // key so the URL alone fixes what gets measured: two runs of one address are two comparable
  // numbers. Arming happens before the loop starts, so the window's warm-up is this page's shader
  // compile and its first floor layout, not the first half second of the timed sample.
  if (bench > 0) {
    app.debug.bench(bench, {
      seconds: seconds || undefined,
      chapter: chapter > 0 ? chapter - 1 : undefined,
    });
  } else if (arena) {
    // `?arena=1` starts the page in the Endless Arena, and starts it the same way the bench URL
    // does: through the debug door, before the loop runs, so the URL alone fixes what the page is.
    // A person gets to the mode through the chapter grid or the victory sweep instead, and only
    // once a win is in their meta file — this knob is for the `arena` scenario, which has no win
    // to spend and no way to press one.
    app.debug.arena();
  }

  if (view) {
    view.resize();
    window.addEventListener('resize', () => view?.resize());
  }

  // The finished window is said out loud once. It also sits in `window.__benchResults`, and the
  // scenario that reads it is the machine that cares, but a person running the URL by hand has to
  // get the report — and the warnings about whether the load was really on the floor — without
  // opening the console first and knowing to ask.
  let reported = false;
  const reportBench = (): void => {
    const rig = app?.bench ?? null;
    if (rig === null || !rig.done || reported) return;
    const r = rig.result;
    if (r === null) return;
    reported = true;
    console.info(
      `bench: ${r.backend}, ${r.frames} frames over ${r.seconds} s at ${r.target.enemies} bodies / ` +
        `${r.target.shots} rounds / ${r.target.particles} particles — ${r.fps} fps, frame median ` +
        `${r.frameMs.median} ms (of which ${r.workMs.median} ms is code), ${r.workOverBudget} frames whose ` +
        `code went over the ${r.budgetMs} ms budget`,
    );
    for (const warning of r.warnings) console.warn(`bench: ${warning}`);
  };

  const frame = (now: number): void => {
    try {
      app?.advance(now);
      reportBench();
    } catch (error) {
      // A renderer that throws every frame would otherwise spam an uncaught error;
      // count it and keep the loop alive so the run is still inspectable.
      app?.noteError();
      console.error(error);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
