/**
 * The state snapshot: the shell's read-only view of a run, as `__forgeState()` and
 * the HUD's readouts see it (TECH.md "State for checks").
 *
 * `app.ts` owns the mutable app; this file turns one of its frames into plain JSON. It is
 * separate for the reason the whole shell is headless: nothing here is a game rule, and
 * nothing here reads a `window`. `buildState` takes the live pieces in through a `StateHost`
 * rather than closing over them, so the same builder answers for the app, for the idle
 * placeholder in `main.ts`, and for a test that hands over a bare `World` (there is no second
 * copy of this formatting anywhere, which is the only way a scenario and the HUD can be shown
 * the same number).
 *
 * Two rules the callers depend on:
 *
 * - **Every archetype key is always present** in `enemies.byType`, with 0 meaning "not on
 *   screen". That is what lets a scenario assert on an enemy type it expects to *arrive*.
 * - **The gauges are counts, not fractions** (ammo, heat, energy): which of the three a hand
 *   spends is the weapon def's business, and the ceiling to divide by sits in that same def.
 *
 * It allocates (records, arrays) and that is fine: it runs when somebody asks, not once per
 * frame. The frame loop's own allocations are pinned by `tests/unit/loop.test.ts`.
 */

import { ENEMIES } from '../content/enemies';
import { POWERUPS } from '../content/powerups';
import { WEAPONS } from '../content/weapons';
import type { BindTable } from '../input/bindings';
import type { Settings } from './persistence';
import { bossesAlive } from '../sim/systems/boss';
import type { World } from '../sim/world';
import type { View } from '../render/renderer';
import { snapshotSettings, type ForgeState, type ForgeWeapon, type SceneId } from './appTypes';

/** How deep the `enemies.nearest` list goes; see `nearestEnemies`. */
const NEAREST_KEEP = 10;

/**
 * Everything `buildState` needs that is not the World, read live off the shell.
 *
 * A host rather than eight arguments because the eight change together: they are the app's
 * frame, and a signature that long is how a read model starts being called with its arguments
 * in the wrong order.
 */
export interface StateHost {
  readonly world: World;
  readonly scene: SceneId;
  readonly backend: 'webgpu' | 'webgl2' | 'none';
  /**
   * A bench window is a mode rather than a scene: the scene is still `playing`, and what a
   * scenario needs to be able to tell is that this page is measuring rather than being played.
   */
  readonly mode: 'campaign' | 'arena' | 'bench';
  /** The shell's own tally; the World's sim assertions are added to it. */
  readonly errors: number;
  readonly settings: Settings;
  readonly bindings: BindTable;
  /** The frame-time ring the loop writes; `measureFps` reads it back. */
  readonly frameTimes: Float32Array;
  /**
   * The renderer, when this machine got one.
   *
   * It is here for one question: which way is the player's gun *drawn*. Only the view can
   * answer that, so the state asks it rather than assuming the picture matches the sim — that
   * assumption is what let a barrel be drawn a quarter turn off its own tracers. A bare-`World`
   * host leaves it out, which is the same case as a machine with no backend: nothing is drawn.
   */
  readonly view?: View | null;
}

/**
 * The ten bodies nearest the player, as one scan of the live slots.
 *
 * Cheap enough to call from a scenario, and it reads only the pools, so the state stays a
 * snapshot rather than a second game. `hp <= 0` is skipped as well as `alive === 0`: a body
 * that died this tick is still in its slot until the sweep, and a snapshot that counted it
 * would disagree with the kill tally printed beside it.
 */
export function nearestEnemies(w: World): ForgeState['enemies']['nearest'] {
  const pool = w.enemies;
  const px = w.player.x;
  const py = w.player.y;
  // A ten-wide insertion list over one scan of the live slots.
  const picks: Array<{ d2: number; i: number }> = [];
  for (let i = 0; i < pool.cap; i++) {
    if (pool.alive[i] === 0 || pool.hp[i] <= 0) continue;
    const dx = pool.x[i] - px;
    const dy = pool.y[i] - py;
    const d2 = dx * dx + dy * dy;
    if (picks.length < NEAREST_KEEP) {
      picks.push({ d2, i });
      if (picks.length === NEAREST_KEEP) picks.sort((a, b) => a.d2 - b.d2);
    } else if (d2 < picks[NEAREST_KEEP - 1].d2) {
      picks[NEAREST_KEEP - 1] = { d2, i };
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

/**
 * Real frames per second over the ring, or 0 while it is still filling.
 *
 * Zero rather than a partial average: a half-warm ring would report the load of a shader
 * compile as the game's framerate, and the one thing a reader does with an fps figure is trust
 * it. `sum` is seconds, so `n / sum` is frames per second.
 */
export function measureFps(frameTimes: Float32Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < frameTimes.length; i++) {
    const dt = frameTimes[i];
    if (dt > 0) {
      sum += dt;
      n++;
    }
  }
  if (n < frameTimes.length) return 0;
  return Math.round(n / sum);
}

/**
 * The player's two lines: the one the round takes and the one the rig is drawn along.
 *
 * `shot` is the World's, written once a tick by the weapon pass. `barrel` is the view's, read
 * off the rig's live yaw. A check puts them side by side and fails when they come apart, which
 * is the only way a scenario can see the two facing mistakes: both left the *picture* lying
 * while the sim carried on correctly, and a state key derived from the sim's own answer could
 * only ever agree with itself.
 *
 * With no view to ask there is nothing drawn, so `barrel` answers the line the rig would have
 * been turned to. Both pairs stay unit length either way, since a reader divides by them.
 */
function aimLines(host: StateHost): { shot: { x: number; y: number }; barrel: { x: number; y: number } } {
  const shot = { x: host.world.muzzle.x, y: host.world.muzzle.y };
  const view = host.view;
  if (!view) return { shot, barrel: { x: shot.x, y: shot.y } };
  const barrel = { x: 0, y: 0 };
  view.playerFace(barrel);
  return { shot, barrel };
}

/** Paint the whole `__forgeState()` shape from a live shell. */
export function buildState(host: StateHost): ForgeState {
  const w = host.world;
  const p = w.player;
  const lines = aimLines(host);

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
    scene: host.scene,
    backend: host.backend,
    tick: w.tick,
    chapter: w.chapter,
    mode: host.mode,
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
      shot: lines.shot,
      barrel: lines.barrel,
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
    fps: measureFps(host.frameTimes),
    errors: host.errors + w.errors,
    settings: snapshotSettings(host.settings, host.bindings),
  };
}