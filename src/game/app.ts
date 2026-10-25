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
 * The three things it talks to are injected, not imported at runtime, so a headless
 * test can drive a whole run:
 *
 * - `view` (the renderer) draws the state and answers the pointer-to-ground ray.
 *   It may be null: a machine with neither WebGPU nor WebGL2 still plays, and a
 *   scenario checks state, not pixels.
 * - `hud` is the DOM overlay, read-only over the World.
 * - the input sampler reads the keyboard and mouse into one `InputFrame` per frame.
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
import { spawnEnemy } from '../sim/systems/enemies';
import { awardXp, choosePick, reroll } from '../sim/systems/pickups';
import { startWaves } from '../sim/systems/waves';
import { createWorld, loadSlot, type World } from '../sim/world';
import { createClock, createFrameReport, runFrame } from './loop';
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
}

/** Rolling window for the fps estimate; below this it reports 0 ("still warming up"). */
const FPS_SAMPLES = 30;

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

  // One persistent step callback, so the accumulator loop allocates nothing per
  // frame. It reads `world` and `frame` through this closure, so a restart (which
  // swaps `world`) is picked up without rebuilding the callback.
  const stepOne = (): void => {
    step(world, frame);
  };

  /** Throw the run away and start a fresh one on the same seed. */
  function restart(): void {
    world = createWorld(ports.seed);
    world.autoFire = ports.autoFire ?? true;
    startWaves(world, 1);
    scene = 'playing';
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
      wave: { index: w.wave.index, timeLeft: w.wave.timeLeft, bossAlive: false },
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
  };

  return app;
}