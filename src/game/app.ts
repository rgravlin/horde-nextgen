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
 * clock, the frame report and the step callback are all allocated once with the app.
 */

import { ENEMIES } from '../content/enemies';
import { POWERUPS } from '../content/powerups';
import { WEAPONS } from '../content/weapons';
import { InputSampler } from '../input/sampler';
import type { View } from '../render/renderer';
import { createInputFrame } from '../sim/input';
import { createRng, next } from '../sim/rng';
import { step } from '../sim/step';
import { bossesAlive } from '../sim/systems/boss';
import { spawnEnemy } from '../sim/systems/enemies';
import { awardXp, choosePick, reroll } from '../sim/systems/pickups';
import { startChapter } from '../sim/systems/levels';
import { createWorld, loadSlot, type World } from '../sim/world';
import { createClock, createFrameReport, runFrame } from './loop';
import {
  autosaveDue,
  clearSave,
  createAutosaveTimer,
  hasSave,
  loadMeta,
  loadRun,
  markAutosaved,
  recordRunEnd,
  saveMeta,
  saveRun,
  type AutosaveTimer,
  type ProblemSink,
  type StorageLike,
} from './persistence';
import type { Hud, HudCommand, HudView } from '../ui/hud';

/** The scenes this slice runs. More arrive with the chapter and settings screens. */
export type SceneId = 'menu' | 'playing' | 'levelup' | 'paused' | 'summary';

/** A frame's worth of scene-level key presses, drained once by `takeCommands`. */
interface CommandBits {
  pause: boolean;
  accept: boolean;
  reroll: boolean;
}

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
}

/** `window.__forgeDebug`, for scenarios and tests that need to set a scene up. */
export interface ForgeDebug {
  setSeed(seed: number): void;
  spawn(type: number, n: number): number;
  grantXp(n: number): void;
  giveWeapon(id: string): boolean;
  bench(n: number): number;
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
}

export interface AppPorts {
  view: View | null;
  hud: Hud | null;
  seed: number;
  /** Passed in so the state can report it without the shell importing the engine. */
  backend: 'webgpu' | 'webgl2' | 'none';
  /** Auto-fire default (TECH.md: on). A setting later, but on for the slice. */
  autoFire?: boolean;
  /**
   * Where a run outlives the page: `window.localStorage` in the browser, a `Map` in a
   * headless test, `null` where there is no storage at all (a browser with it turned off,
   * a Node run). `persistence.ts` owns what is written under which key; the shell only
   * decides *when*, and it does that through this port so nothing here reaches for a
   * `window` that may not exist.
   */
  storage?: StorageLike | null;
}

/** Rolling window for the fps estimate; below this it reports 0 ("still warming up"). */
const FPS_SAMPLES = 30;

/**
 * What one run owes the storage, and how much of it it has already paid.
 *
 * It is created with the run rather than with the app, because both halves of it are
 * facts about *this* run: the autosave clock's next due time counts play seconds from
 * this run's start, and "has this chapter's ending been written" only means something
 * while the chapter is part of an unfinished run. A restart that kept the old archive
 * would hand a fresh run a spent clock (ARCHITECTURE.md "The autosave clock counts play
 * seconds"), which is the one way this file can be misused, so it is written down here.
 */
interface RunArchive {
  /** When the run is due to be written out: every 30 s of play, and at a chapter's end. */
  autosave: AutosaveTimer;
  /** The chapter whose clearing has been written to the meta; -1 while none has. */
  clearedChapter: number;
  /** The finished run's own history row has been written, so a run is counted once. */
  ended: boolean;
}

function createArchive(): RunArchive {
  return { autosave: createAutosaveTimer(), clearedChapter: -1, ended: false };
}

const NOOP = (): void => {};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

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

  let world = createWorld(ports.seed);
  world.autoFire = ports.autoFire ?? true;

  let scene: SceneId = 'menu';

  const sampler = new InputSampler({
    player: () => world.player,
    project: view ? (clientX, clientY, out) => view.aim(clientX, clientY, out) : undefined,
  });

  const clock = createClock();
  const report = createFrameReport();
  const frame = createInputFrame();
  const commands: CommandBits = { pause: false, accept: false, reroll: false };
  const frameTimes = new Float32Array(FPS_SAMPLES);
  let frameTimeIndex = 0;
  let errorCount = 0;

  const storage = ports.storage ?? null;

  /**
   * Where a storage problem goes instead of disappearing: the same tally a sim assertion
   * failure uses, so a save that would not write or a save that would not read shows up in
   * `__forgeState().errors` (AGENTS.md "count caught errors in the state's errors").
   */
  const problems: ProblemSink = {
    note() {
      errorCount++;
    },
  };

  /** The storage debt of whichever run `world` is, rebuilt with it. */
  let archive = createArchive();

  // One persistent step callback, so the accumulator loop allocates nothing per
  // frame. It reads `world` and `frame` through this closure, so a restart (which
  // swaps `world`) is picked up without rebuilding the callback.
  const stepOne = (): void => {
    step(world, frame);
  };

  /**
   * Throw the run away and start a fresh one on the same seed.
   *
   * `startChapter` rather than `startWaves`: the chapter is what puts a floor under the
   * player, and the shell is the only door that does it (a fresh `World` is empty on
   * purpose). Starting only the wave clock gave a run a horde and no room — no cover,
   * no hazards, and a chapter counter stuck on 0 — which is exactly the flat endless
   * arena the design brief rules out.
   */
  function restart(): void {
    world = createWorld(ports.seed);
    world.autoFire = ports.autoFire ?? true;
    archive = createArchive();
    startChapter(world, 0);
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
    world.autoFire = ports.autoFire ?? true;
    archive = createArchive();
    scene = w.over ? 'summary' : w.pendingLevelUp ? 'levelup' : 'playing';
  }

  /** Add this run to the machine's history, and open what it earned. */
  function writeMeta(w: World): void {
    if (storage === null) return;
    // One read, one write: the file is the history, so a run's row goes onto whatever is
    // already there rather than replacing it, and `recordRunEnd` does the unlocking.
    const meta = recordRunEnd(loadMeta(storage, problems), w, new Date().toISOString());
    saveMeta(storage, meta, problems);
  }

  /**
   * Write the run out now, because the player asked.
   *
   * The clock starts again from here: a hand-written save of the same state the autosave
   * was due for would otherwise spend its next write, a frame later, on nothing new.
   */
  function writeSave(): void {
    if (storage === null) return;
    saveRun(storage, world, problems);
    markAutosaved(archive.autosave, world);
  }

  /**
   * Keep the storage in step with the run: the autosave clock, and the meta write when a
   * chapter or the run ends.
   *
   * Three rules hold it together, and all three exist because a save that lands at the
   * wrong moment is worse than one that does not land:
   *
   * - A chapter's end is recorded, keyed by *which* chapter, and it is recorded before the
   *   autosave writes, because that write is the one that lets the next floor be resumed.
   * - A finished run writes its history row and then loses its slot. A dead or won run is
   *   not a run to come back to, and `persistence.ts` is explicit that a save of one is a
   *   Continue button into a game you already finished.
   * - A failed write is counted and the interval restarts anyway. Retrying a storage that
   *   refused (quota, private mode) every frame would spend the run's whole error budget on
   *   one bad write.
   */
  function archiveRun(): void {
    if (storage === null || scene === 'menu') return;
    const w = world;

    if (w.over || w.victory) {
      if (archive.ended) return;
      archive.ended = true;
      writeMeta(w);
      clearSave(storage, problems);
      return;
    }

    if (w.chapterComplete && w.chapter !== archive.clearedChapter) {
      archive.clearedChapter = w.chapter;
      writeMeta(w);
    }

    if (autosaveDue(archive.autosave, w)) {
      saveRun(storage, w, problems);
      markAutosaved(archive.autosave, w);
    }
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
      if (scene === 'menu' || scene === 'summary') restart();
      commands.accept = false;
    }
    if (commands.pause) {
      if (scene === 'playing') scene = 'paused';
      else if (scene === 'paused') scene = 'playing';
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

  function nearestEnemies(w: World): ForgeState['enemies']['nearest'] {
    const pool = w.enemies;
    const px = w.player.x;
    const py = w.player.y;
    // A ten-wide insertion list over one scan of the live slots: cheap enough to
    // call from a scenario, and it reads only the pools, so the state stays a
    // snapshot rather than a second game.
    const picks: Array<{ d2: number; i: number }> = [];
    for (let i = 0; i < pool.cap; i++) {
      if (pool.alive[i] === 0 || pool.hp[i] <= 0) continue;
      const dx = pool.x[i] - px;
      const dy = pool.y[i] - py;
      const d2 = dx * dx + dy * dy;
      if (picks.length < 10) {
        picks.push({ d2, i });
        if (picks.length === 10) picks.sort((a, b) => a.d2 - b.d2);
      } else if (d2 < picks[9].d2) {
        picks[9] = { d2, i };
        picks.sort((a, b) => a.d2 - b.d2);
      }
    }

    const out: ForgeState['enemies']['nearest'] = [];
    for (const pick of picks) {
      const i = pick.i;
      out.push({ type: ENEMIES[pool.kind[i]].id, x: pool.x[i], y: pool.y[i], hp: pool.hp[i] });
    }
    return out;
  }

  function measureFps(): number {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < FPS_SAMPLES; i++) {
      const dt = frameTimes[i];
      if (dt > 0) {
        sum += dt;
        n++;
      }
    }
    if (n < FPS_SAMPLES) return 0;
    return Math.round(n / sum);
  }

  function buildState(): ForgeState {
    const w = world;
    const p = w.player;

    const byType: Record<string, number> = {};
    for (let i = 0; i < ENEMIES.length; i++) byType[ENEMIES[i].id] = 0;
    const enemies = w.enemies;
    // One pass over the live slots, so a scenario can count a horde by archetype
    // without walking the pools. Every id key is always present — 0 means "not on
    // screen", which is what lets a scenario assert on a type it expects to see.
    for (let i = 0; i < enemies.cap; i++) {
      if (enemies.alive[i] === 0 || enemies.hp[i] <= 0) continue;
      byType[ENEMIES[enemies.kind[i]].id]++;
    }
    const nearest = nearestEnemies(w);

    const weapons: ForgeWeapon[] = [];
    for (const hand of w.slots) {
      if (hand.weapon < 0) continue;
      const def = WEAPONS[hand.weapon];
      // Both gauges as they stand rather than as fractions: which of the three things a
      // hand spends — magazine, heat or charge — is the def's business, and a scenario
      // that wants a percentage has the ceiling to divide by in the same def.
      weapons.push({
        id: def.id,
        family: def.family,
        ammo: hand.ammo,
        heat: hand.heat,
        energy: hand.energy,
        venting: hand.venting,
        reloading: hand.reload > 0,
      });
    }

    const powerups: Array<{ id: string; tier: number }> = [];
    for (let i = 0; i < POWERUPS.length; i++) {
      const tier = w.powerTiers[i];
      if (tier > 0) powerups.push({ id: POWERUPS[i].id, tier });
    }

    const levelUpChoices: string[] = [];
    for (let i = 0; i < w.levelUpChoices.length; i++) {
      const id = w.levelUpChoices[i];
      if (id >= 0 && id < POWERUPS.length) levelUpChoices.push(POWERUPS[id].id);
    }

    const active = w.slots[w.activeSlot];
    const activeWeapon = active && active.weapon >= 0 ? WEAPONS[active.weapon].id : '';

    return {
      scene,
      backend: ports.backend,
      tick: w.tick,
      chapter: w.chapter,
      mode: 'campaign',
      player: {
        x: p.x,
        y: p.y,
        hp: p.hp,
        maxHp: p.maxHp,
        shield: p.shield,
        level: p.level,
        xp: p.xp,
        dashReady: p.dashCd <= 0,
        alive: p.alive,
      },
      // The same read the chapter machine waits on, so the number a scenario asserts on
      // and the number that ends the chapter cannot drift apart: `bossesAlive` is the flag
      // the arc itself was written from this tick.
      wave: { index: w.wave.index, timeLeft: w.wave.timeLeft, bossAlive: bossesAlive(w) },
      boss: { alive: w.boss.alive, name: w.boss.name, hp: w.boss.hp, maxHp: w.boss.maxHp },
      chapterComplete: w.chapterComplete,
      victory: w.victory,
      score: w.score,
      kills: w.kills,
      enemies: { count: enemies.count, byType, nearest },
      weapons,
      activeWeapon,
      powerups,
      levelUpChoices,
      fps: measureFps(),
      errors: errorCount + w.errors,
    };
  }

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
      sampler.sample(frame);

      let alpha = 0;
      if (scene === 'playing') {
        runFrame(clock, nowMs, false, stepOne, report);
        alpha = report.alpha;
        if (world.over) scene = 'summary';
        else if (world.pendingLevelUp) scene = 'levelup';
      } else {
        // Frozen: runFrame clears the banked time instead of holding it, so a resume
        // (or a menu) never hands a backlog back as an instant wall of enemies. The
        // clock still advances, so the first play frame is a normal frame, not a jump.
        runFrame(clock, nowMs, true, NOOP, report);
        if (scene === 'levelup') handleLevelUp();
      }

      archiveRun();

      if (view) view.draw(world, alpha, report.dt, scene === 'menu');
      hud?.tick(hudView);

      frameTimes[frameTimeIndex] = report.dt;
      frameTimeIndex = (frameTimeIndex + 1) % FPS_SAMPLES;
    },

    command(cmd) {
      switch (cmd) {
        case 'start':
          if (scene === 'menu') restart();
          break;
        case 'restart':
          if (scene !== 'menu') restart();
          break;
        case 'resume':
          if (scene === 'paused') scene = 'playing';
          break;
        case 'pause':
          if (scene === 'playing') scene = 'paused';
          break;
        case 'reroll':
          if (scene === 'levelup') reroll(world);
          break;
        case 'save':
          // Only ever from a frozen scene in the game, which is the point of the button:
          // what gets written is the state the player stopped on.
          if (scene === 'playing' || scene === 'paused') writeSave();
          break;
        case 'load': {
          // The title's Continue and the pause menu's Load are the same act: stop this run
          // and play the stored one. From the pause menu that throws the run in hand away,
          // which is what the player asked for by asking for a file.
          if (scene !== 'menu' && scene !== 'paused') break;
          const saved = storage === null ? null : loadRun(storage, problems);
          if (saved !== null) enterWorld(saved);
          break;
        }
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

    state: () => buildState(),

    noteError() {
      errorCount++;
    },

    debug: {
      setSeed(seed) {
        world.rng = createRng(seed);
      },

      // Put `n` bodies of archetype `type` on a ring around the player, close enough
      // that auto-fire engages, for a scenario or the bench to shoot at.
      spawn(type, n) {
        const kind = type >= 0 && type < ENEMIES.length ? type : 0;
        const def = ENEMIES[kind];
        let made = 0;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + next(world.rng) * 0.5;
          const r = 8 + next(world.rng) * 6;
          const x = clamp(world.player.x + Math.cos(a) * r, world.minX + def.radius, world.maxX - def.radius);
          const y = clamp(world.player.y + Math.sin(a) * r, world.minY + def.radius, world.maxY - def.radius);
          if (spawnEnemy(world, kind, x, y) >= 0) made++;
        }
        return made;
      },

      grantXp(n) {
        awardXp(world, n);
      },

      giveWeapon(id) {
        const index = WEAPONS.findIndex((w) => w.id === id);
        if (index < 0) return false;
        // Fill the empty hand if there is one, else the active hand, and make a hand
        // that was empty the one in play, so a granted weapon is the one being fired.
        let slot = world.slots.findIndex((s) => s.weapon < 0);
        let switched = false;
        if (slot < 0) slot = world.activeSlot;
        else switched = true;
        const hand = world.slots[slot];
        // One call owns "this hand now holds that gun", including what the gun starts
        // its magazine, its heat and its charge with — a granted weapon that arrived
        // half empty would read as a broken grant, not as a spent one.
        loadSlot(hand, index);
        if (switched) world.activeSlot = slot;
        return true;
      },

      bench(n) {
        return this.spawn(0, n);
      },
    },
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
    // Read once per scene change rather than per frame, so the title screen can ask
    // "is there something to come back to" for the cost of one key lookup.
    hasSave() {
      return storage === null ? false : hasSave(storage, problems);
    },
  };

  return app;
}