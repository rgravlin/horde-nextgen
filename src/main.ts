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

import { createApp, type App, type ForgeState } from './game/app';
import type { StorageLike } from './game/persistence';
import { createView, type View } from './render/renderer';
import { createHud } from './ui/hud';

/** `?seed=N` for a reproducible run; `?gl=webgl2` to force the WebGL2 backend. */
function readParams(): { seed: number; forceWebGL: boolean } {
  let seed = 1;
  let forceWebGL = false;
  try {
    const params = new URLSearchParams(location.search);
    const raw = params.get('seed');
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) seed = parsed >>> 0;
    }
    forceWebGL = params.get('gl') === 'webgl2';
  } catch {
    // A missing location (a non-browser import) keeps the defaults.
  }
  return { seed, forceWebGL };
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
    },
    wave: { index: 1, timeLeft: 0, bossAlive: false },
    boss: { alive: false, name: '', hp: 0, maxHp: 0 },
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
  };
}

/** The "needs WebGL2" panel: the one failure that is worth showing the player. */
function showNoGpuPanel(root: HTMLElement, message: string): void {
  const panel = document.createElement('div');
  panel.className = 'no-gpu';
  panel.textContent = `Your browser can't run this (needs WebGL2). ${message}`;
  root.appendChild(panel);
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
  const ui = document.getElementById('ui');
  const { seed, forceWebGL } = readParams();

  // The state hook is registered before anything is awaited, so `window.__forgeState`
  // is never absent — not while the renderer is still coming up, and not on a box
  // with no backend at all. It reads these two through the closure, so nothing has to
  // be re-pointed once the game exists.
  let backend: ForgeState['backend'] = 'none';
  let app: App | null = null;
  const w = window as unknown as {
    __forgeState?: () => ForgeState;
    __forgeDebug?: App['debug'];
  };
  w.__forgeState = () => (app ? app.state() : idleState(backend));

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
  let view: View | null = null;
  if (canvas) {
    try {
      const result = await createView(canvas, { forceWebGL });
      if (result.ok) view = result.view;
      else if (ui) showNoGpuPanel(ui, result.message);
    } catch (error) {
      if (ui) showNoGpuPanel(ui, String(error));
    }
  }
  backend = view ? view.backend : 'none';

  const hud = ui ? createHud(ui) : null;
  app = createApp({ view, hud, seed, backend, storage: openStorage() });
  w.__forgeDebug = app.debug;

  if (view) {
    view.resize();
    window.addEventListener('resize', () => view?.resize());
  }

  const frame = (now: number): void => {
    try {
      app?.advance(now);
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
