/**
 * The game shell: the scene machine and the fixed-step loop (ARCHITECTURE.md
 * "Scene state machine", TECH.md "Simulation and rendering").
 *
 * It owns the World and decides, once per browser frame, whether the sim advances
 * and what the scene is. It holds no game rules of its own — pausing means "stop
 * calling step", a level-up means "stop and show the cards", death means "stop and
 * show the summary" — and it never edits a gameplay value directly except through
 * the sim's own entry points (`step`, `choosePick`, `grantXp`, `spawnEnemy`), so a
 * run stays reproducible from its seed.
 *
 * Four files sit beside it, split off by what they answer rather than by size:
 * `appTypes.ts` holds the shapes this shell shares with `main.ts` and the scenarios (plus
 * `snapshotSettings`), `appState.ts` paints a frame of them out of a live `StateHost`,
 * `appDebug.ts` builds the `__forgeDebug` hooks, and `appArchive.ts` keeps the storage in
 * step with the run. What stays here is the sequence: which scene a frame leaves, when the
 * sim is not run at all, and which door each command goes through.
 *
 * The pieces it talks to are injected, not imported at runtime, so a headless
 * test can drive a whole run:
 *
 * - `view` (the renderer) draws the state and answers the pointer-to-ground ray.
 *   It may be null: a machine with neither WebGPU nor WebGL2 still plays, and a
 *   scenario checks state, not pixels.
 * - `hud` is the DOM overlay, read-only over the World.
 * - the input sampler reads the keyboard and mouse into one `InputFrame` per frame.
 *
 * Storage is the fourth, and it comes in the same way: `storage` is a `StorageLike` port
 * (`persistence.ts`) holding the run, so the shell decides when a run gets written out —
 * every 30 s of play, at a chapter's end, when the player asks — without knowing whether
 * that is localStorage, a `Map`, or nothing at all. Nothing here decides what the file
 * looks like either; `serialize` owns that.
 *
 * Nothing here allocates in the steady state: the frame, the command bits, the
 * clock, the frame report, the shelf, the state host and the step callback are all
 * allocated once with the app.
 */

import { buildBinds, swapBinds } from '../input/bindings';
import { InputSampler } from '../input/sampler';
import { createInputFrame } from '../sim/input';
import { step } from '../sim/step';
import { startArena, startChapter } from '../sim/systems/levels';
import { choosePick, reroll } from '../sim/systems/pickups';
import { createWorld, type World } from '../sim/world';
import { createArchive, keepShelf, storeSettings, writeSave, type Shelf } from './appArchive';
import { createDebug } from './appDebug';
import { buildState, type StateHost } from './appState';
import { createClock, createFrameReport, runFrame } from './loop';
import type { BenchRig } from './bench';
import {
  defaultMeta,
  defaultSettings,
  hasSave,
  isChapterUnlocked,
  loadRun,
  type ProblemSink,
  type Settings,
} from './persistence';
import type { HudView } from '../ui/hud';
import type { App, AppPorts, SceneId } from './appTypes';

/** A frame's worth of scene-level key presses, drained once by `takeCommands`. */
interface CommandBits {
  pause: boolean;
  accept: boolean;
  reroll: boolean;
}

/** Rolling window for the fps estimate; below this it reports 0 ("still warming up"). */
const FPS_SAMPLES = 30;

const NOOP = (): void => {};

/**
 * The panel scenes that are a way into somewhere else, and so owe a way back.
 *
 * `paused` is not one of them: it is where the game stops, and the pause key leaves it the same
 * way it entered.
 */
const PANEL_SCENES = new Set<SceneId>(['levelselect', 'settings', 'history']);

/**
 * A fixed-step clock plus the state machine around it.
 *
 * `scene` drives two things: whether `step` runs at all, and whether the camera
 * follows (play) or orbits (menu). Only `playing` advances the sim; every other
 * scene draws a frozen frame, which is DESIGN.md's "the game freezes" and what lets
 * a pause hold a thousand bodies mid-charge without a single position changing.
 */
export function createApp(ports: AppPorts): App {
  const view = ports.view;
  const hud = ports.hud;
  const audio = ports.audio ?? null;

  /**
   * The three things a player can change, all read once and all live.
   *
   * `settings` is replaced rather than patched: it is the file's shape, so writing it out after
   * a change writes the whole file, and the copy the panels read is never a frame behind the one
   * that was stored. `binds` is the compiled form of `settings.binds` and is the *same table*
   * the sampler looks keys up in — one map, two readers, which is the whole reason the bind
   * table lives in `input/bindings.ts` instead of inside the sampler.
   */
  let settings = ports.settings ?? defaultSettings();
  let binds = buildBinds(settings.binds);
  /** Unlocks, best times and history; the copy the chapter grid and the history table read. */
  let meta = ports.meta ?? defaultMeta();

  let world = createWorld(ports.seed);
  world.autoFire = settings.autoFire;

  let scene: SceneId = 'menu';

  /**
   * The bench window this page is running, if it is running one.
   *
   * Held on the app rather than in `main.ts` because the rig needs three moments of a frame —
   * before the ticks, after them and after the draw — and only the shell knows where those are.
   * `bench.ts` owns what a window measures; the shell only hands it the frame.
   */
  let rig: BenchRig | null = null;

  /**
   * Which screen a panel should hand back to.
   *
   * Settings and history open from both the title and the pause menu, and `back` means a
   * different place in each. One variable remembers it; a second one for each panel is how a
   * back button starts stranding the player.
   */
  let returnTo: SceneId = 'menu';

  let errorCount = 0;

  /**
   * Where a problem goes instead of disappearing: the same tally a sim assertion
   * failure uses, so a save that would not write or a save that would not read shows up in
   * `__forgeState().errors` (AGENTS.md "count caught errors in the state's errors"). A device
   * poll that throws reports through it too, which is the only way a dead gamepad is visible.
   *
   * It is declared before the sampler because the sampler is the first thing handed to it.
   */
  const problems: ProblemSink = {
    note() {
      errorCount++;
    },
  };

  const sampler = new InputSampler({
    player: () => world.player,
    project: view ? (clientX, clientY, out) => view.aim(clientX, clientY, out) : undefined,
    bindings: binds,
    /**
     * The pads come in as a port for the same reason the storage does: `src/game` may not reach
     * for `navigator` (ARCHITECTURE.md), and a headless test then plays with no controller rather
     * than with a fake to invent — a test that wants one hands over a list of sticks and buttons.
     * Left out, `gamepad.ts` polls the real `navigator.getGamepads`.
     */
    pads: ports.pads,
    note: (problem) => problems.note(problem),
  });

  const clock = createClock();
  const report = createFrameReport();
  const frame = createInputFrame();
  const commands: CommandBits = { pause: false, accept: false, reroll: false };
  const frameTimes = new Float32Array(FPS_SAMPLES);
  let frameTimeIndex = 0;

  const storage = ports.storage ?? null;

  /**
   * The shelf, read live so `keepShelf` never needs a second argument to say what scene this is.
   *
   * The flag it carries (`archive.onShelf`) is answered from the file once and then kept current
   * by every write: the title's Continue button and the pause menu's Load ask every frame they
   * are on screen, and a `getItem` plus a JSON parse sixty times a second is not a check, it is
   * a stall.
   */
  const shelf: Shelf = {
    storage,
    problems,
    get benched() {
      return rig !== null;
    },
    get idle() {
      return scene === 'menu';
    },
    wroteMeta(next) {
      meta = next;
    },
  };

  /** The storage debt of whichever run `world` is, rebuilt with it. */
  let archive = createArchive(storage === null ? false : hasSave(storage, problems));

  // One persistent step callback, so the accumulator loop allocates nothing per
  // frame. It reads `world` and `frame` through this closure, so a restart (which
  // swaps `world`) is picked up without rebuilding the callback.
  const stepOne = (): void => {
    step(world, frame);
  };

  /**
   * Throw the run away and start a fresh campaign one on chapter `chapter`.
   *
   * `startChapter` rather than `startWaves`: the chapter is what puts a floor under the
   * player, and the shell is the only door that does it (a fresh `World` is empty on
   * purpose). Starting only the wave clock gave a run a horde and no room — no cover,
   * no hazards, and a chapter counter stuck on 0 — which is exactly the flat endless
   * arena the design brief rules out.
   *
   * The chapter argument is what lets the chapter grid and the summary's Restart Level
   * reuse this: both start a *run*, at a chosen floor, and neither is a special case.
   *
   * It always builds a campaign floor, including when the run it replaces was an arena one —
   * the chapter grid and the bench's restart both name a chapter, and a chapter named is a
   * chapter played. The arena's own restart is `restartArena`.
   */
  function restartRun(chapter: number): void {
    beginRun(false, chapter);
  }

  /** Throw the run away and start a fresh Endless Arena run. */
  function restartArena(): void {
    beginRun(true, 0);
  }

  /**
   * The one place a run is rebuilt, so a fresh World, a fresh archive and the play scene are
   * always said together.
   *
   * A new clock and a new chapter tally, but the shelf carries over: restarting the run does not
   * un-write the file that is still sitting there.
   */
  function beginRun(endless: boolean, chapter: number): void {
    world = createWorld(ports.seed);
    world.autoFire = settings.autoFire;
    archive = createArchive(archive.onShelf);
    if (endless) startArena(world);
    else startChapter(world, chapter);
    scene = 'playing';
  }

  /**
   * Put a restored World in play, as the run it was saved as.
   *
   * The scene comes off the world rather than being written as "playing": a snapshot keeps
   * the state the run was frozen in, and a resume that landed on the play scene with a
   * level-up still waiting would show no cards and no way to take one.
   */
  function enterWorld(w: World): void {
    world = w;
    world.autoFire = settings.autoFire;
    // The file it came out of is still on the shelf, so Load stays offered.
    archive = createArchive(true);
    scene = w.over
      ? 'summary'
      : w.victory
        ? 'victory'
        : w.pendingLevelUp
          ? 'levelup'
          : 'playing';
  }

  /**
   * Open one of the panel scenes, remembering where it was opened from.
   *
   * A panel is a scene, so the sim freezes with it — that is what makes Settings a place to
   * rebind the dash key mid-run rather than a thing you have to do between runs.
   */
  function openPanel(next: SceneId): void {
    returnTo = scene === 'paused' ? 'paused' : 'menu';
    scene = next;
  }

  /** Leave a panel back where it came in. */
  function closePanel(): void {
    scene = returnTo === scene ? 'menu' : returnTo;
  }

  /** Rebuild the key map and hand it to the sampler, which drops its held keys with it. */
  function applyBinds(): void {
    binds = buildBinds(settings.binds);
    sampler.setBindings(binds);
  }

  /**
   * Turn one frame's scene-level keys into a scene change.
   *
   * Done before the sim runs so a pause pressed on the frame a level-up opens lands
   * on the play state, not the cards, and so the same press cannot both pause and
   * step. `accept` means "go" (start or restart) and `pause` toggles the freeze.
   */
  function applyCommands(): void {
    if (commands.accept) {
      if (scene === 'menu' || scene === 'summary' || scene === 'victory') restartRun(0);
      else if (PANEL_SCENES.has(scene)) closePanel();
      commands.accept = false;
    }
    if (commands.pause) {
      if (scene === 'playing') scene = 'paused';
      else if (scene === 'paused') scene = 'playing';
      else if (PANEL_SCENES.has(scene)) closePanel();
      commands.pause = false;
    }
  }

  function handleLevelUp(): void {
    if (commands.reroll) reroll(world);
    if (frame.pick > 0) {
      choosePick(world, frame.pick - 1);
      if (!world.pendingLevelUp) scene = 'playing';
    }
  }

  /**
   * The shell read live, for `buildState` (see `appState.ts`).
   *
   * One object allocated with the app rather than a literal built per call: `state()` is a
   * check seam that a scenario may poll, and the alternative is a fresh argument object on every
   * read. The getters are what keep it honest — a scenario that pauses and then asks for the
   * state gets the scene it paused on, not the one that was current when this was written.
   */
  const stateHost: StateHost = {
    get world() {
      return world;
    },
    get scene() {
      return scene;
    },
    backend: ports.backend,
    get mode() {
      // A bench window is a mode rather than a scene, and so is the arena: the scene is still
      // `playing` in both. The two never overlap (a rig builds a campaign floor) and the rig
      // wins the read if they somehow did, because a page running a window is measuring.
      if (rig !== null) return 'bench';
      return world.endless ? 'arena' : 'campaign';
    },
    get errors() {
      return errorCount;
    },
    get settings() {
      return settings;
    },
    get bindings() {
      return binds;
    },
    frameTimes,
    // The one host field that is not a fact about the shell: the view answers what it drew, so
    // the state's `barrel` is the rig read back rather than the aim re-stated. Null on a box
    // that got no backend at all, where nothing is drawn.
    view,
  };

  /** The debug hooks; see `appDebug.ts` for why they read the world through a host. */
  const debug = createDebug({
    world: () => world,
    frame,
    restart: restartRun,
    arenaRun: restartArena,
    arm(armed) {
      rig = armed;
    },
    backend: ports.backend,
    now: ports.now,
  });

  const app: App = {
    get scene() {
      return scene;
    },
    get world() {
      return world;
    },

    advance(nowMs) {
      sampler.takeCommands(commands);
      applyCommands();

      // Sample once per frame, then feed every step this frame runs the same frame
      // (ARCHITECTURE.md "Data flow"). In a frozen scene the sample still runs, so
      // the level-up pick and the swap latch are read even while nothing steps.
      //
      // The second argument is which screen the gamepad's face buttons are read against: with the
      // cards up they are cards 1, 2 and 3, and anywhere else they are dash and swap
      // (`input/gamepad.ts`). It is taken from the scene at the top of the frame rather than from
      // the world at the bottom, so the frame that opens a level-up is still a play frame and a
      // button held through the transition is not spent on a card nobody chose.
      sampler.sample(frame, scene === 'levelup' ? 'cards' : 'play');

      const played = scene === 'playing';
      let alpha = 0;
      if (played) {
        // A bench window pins its load before the ticks, so every tick in the frame is fought at
        // the target rather than at whatever the last frame left, and the trigger comes from the
        // rig rather than from whatever the pointer happens to be over.
        rig?.hold(world, frame);
        runFrame(clock, nowMs, false, stepOne, report);
        alpha = report.alpha;
        // A window does not stop for a card offer: the offer would freeze the sim and spend the
        // rest of the window timing a menu, so the rig takes the first card here — before the
        // scene is decided, which is what keeps the play scene running through it.
        rig?.resolve(world);
        if (world.victory) scene = 'victory';
        else if (world.over) scene = 'summary';
        else if (world.pendingLevelUp) scene = 'levelup';
      } else {
        // Frozen: runFrame clears the banked time instead of holding it, so a resume
        // (or a menu) never hands a backlog back as an instant wall of enemies. The
        // clock still advances, so the first play frame is a normal frame, not a jump.
        runFrame(clock, nowMs, true, NOOP, report);
        if (scene === 'levelup') handleLevelUp();
      }

      keepShelf(shelf, archive, world);

      if (view) view.draw(world, alpha, report.dt, scene === 'menu');

      // Sound, in the same phase as the draw and after it, so the events it drains are the ones
      // the steps this frame just ran wrote. It is called on the frozen scenes too: a pause is a
      // reason for the music to get out of the way, not a reason for it to stop, and the duck is
      // keyed off the scene it is handed. A throw inside the engine is caught there — audio gives
      // up after one report rather than spending the run's error budget (see `src/audio/synth.ts`).
      audio?.frame(world, scene, report.dt, settings);

      hud?.tick(hudView);

      // The bench window is booked last, after the draw, the sound drain and the overlay, so the
      // time it records is the whole frame — the number a 60 fps target is a claim about — and not
      // the simulation's share of it. It is called on the frozen scenes too: a window whose run
      // stopped playing still has to be able to *end*, and a report that says "the load was not
      // held" is worth more than a page that measures nothing.
      rig?.frame(world, played ? report.steps : 0);

      frameTimes[frameTimeIndex] = report.dt;
      frameTimeIndex = (frameTimeIndex + 1) % FPS_SAMPLES;
    },

    command(cmd) {
      switch (cmd) {
        case 'start':
          if (scene === 'menu') restartRun(0);
          break;
        case 'restart':
          // A new run from the first floor; `restartLevel` is the same act on this floor. In the
          // arena there is one floor and it does not end, so both mean the same thing there:
          // start another arena run. Neither one leaves the mode, which is what a player asking
          // for "again" means.
          if (scene === 'menu') break;
          if (world.endless) restartArena();
          else restartRun(0);
          break;
        case 'restartLevel':
          if (scene === 'menu') break;
          if (world.endless) restartArena();
          else restartRun(world.chapter);
          break;
        case 'arena':
          // The Endless Arena, from the title and from the victory panel — both clickable, and
          // deliberately from no key: a mode you can enter by accident from the screen you land
          // on after winning is a mode nobody chose. Locked until the campaign is beaten, and
          // checked here rather than only hidden in the panel, because a scenario (and a
          // devtools click) can reach a button that is not there.
          if (!meta.arenaUnlocked) break;
          if (scene === 'menu' || scene === 'victory') restartArena();
          break;
        case 'resume':
          if (scene === 'paused') scene = 'playing';
          break;
        case 'pause':
          if (scene === 'playing') scene = 'paused';
          else if (PANEL_SCENES.has(scene)) closePanel();
          break;
        case 'reroll':
          if (scene === 'levelup') reroll(world);
          break;
        case 'save':
          // Only ever from a frozen scene in the game, which is the point of the button:
          // what gets written is the state the player stopped on.
          if (scene === 'playing' || scene === 'paused') writeSave(shelf, archive, world);
          break;
        case 'load': {
          // The title's Continue and the pause menu's Load are the same act: stop this run
          // and play the stored one. From the pause menu that throws the run in hand away,
          // which is what the player asked for by asking for a file. A panel counts as
          // frozen ground for this too: the file is a place to come back to from anywhere
          // the game is standing still.
          if (scene !== 'menu' && scene !== 'paused' && !PANEL_SCENES.has(scene)) break;
          const saved = storage === null ? null : loadRun(storage, problems);
          // `enterWorld` is what puts the file back on the shelf, so a Load of the run you are
          // already holding does not look like a way to lose it.
          if (saved !== null) enterWorld(saved);
          break;
        }
        case 'levelselect':
          openPanel('levelselect');
          break;
        case 'settings':
          openPanel('settings');
          break;
        case 'history':
          openPanel('history');
          break;
        case 'back':
          closePanel();
          break;
        case 'menu':
          scene = 'menu';
          break;
      }
    },

    pick(index) {
      if (scene !== 'levelup') return;
      choosePick(world, index);
      if (!world.pendingLevelUp) scene = 'playing';
    },

    state: () => buildState(stateHost),

    get bench() {
      return rig;
    },

    noteError() {
      errorCount++;
    },

    get settings() {
      return settings;
    },

    setSetting(key, value) {
      // A whole new object rather than a patch, because `settings` *is* the file's shape: this
      // writes the file whole, so what the panels show and what a reload will read are the same
      // thing. `autoFire` is the one entry a live world has to be told about.
      settings = { ...settings, [key]: value } as Settings;
      storeSettings(shelf, settings);
      if (key === 'autoFire') world.autoFire = settings.autoFire;
    },

    get bindings() {
      return binds;
    },

    rebind(action, source) {
      settings = { ...settings, binds: swapBinds(settings.binds, action, source) };
      storeSettings(shelf, settings);
      applyBinds();
    },

    resetBindings() {
      settings = { ...settings, binds: {} };
      storeSettings(shelf, settings);
      applyBinds();
    },

    get hasSave() {
      return archive.onShelf;
    },

    get meta() {
      return meta;
    },

    choose(index) {
      // The grid greys a locked tile out, but the click still arrives here, so this is where
      // "you have not earned that floor yet" is decided — once, and not in the view.
      if (index < 0 || !isChapterUnlocked(meta, index)) return;
      restartRun(index);
    },

    debug,
  };

  /** Feed the overlay; the world and scene are read live through these getters. */
  const hudView: HudView = {
    get scene() {
      return scene;
    },
    get world() {
      return world;
    },
    pick(index) {
      app.pick(index);
    },
    command(cmd) {
      app.command(cmd);
    },
    // Answered off the flag the writes keep current (see `shelf`), so a panel that asks
    // every frame pays for a boolean rather than a file read and a JSON parse.
    hasSave() {
      return archive.onShelf;
    },
    choose(index) {
      app.choose(index);
    },
    get settings() {
      return settings;
    },
    setSetting(key, value) {
      app.setSetting(key, value);
    },
    get meta() {
      return meta;
    },
    get bindings() {
      return binds;
    },
    rebind(action, source) {
      app.rebind(action, source);
    },
    resetBindings() {
      app.resetBindings();
    },
  };

  return app;
}