/**
 * The World: every piece of game state in one object, plus the one place it is built.
 *
 * Nothing in this file runs per tick; it only allocates. Three things it used to carry
 * beside the World now have their own files, because a file that is half declarations and
 * half allocation is a file nobody can read in one sitting:
 *
 * - `pools.ts` — the struct-of-arrays pool and its three verbs (take a slot, give one
 *   back, count the live ones);
 * - `constants.ts` — the pool caps, the tuning defaults and the event ids, each written
 *   down once (AGENTS.md rule) so the pools, the bench, the save format and the shaders
 *   all read the same numbers;
 * - `events.ts` — the event ring and the blast stack, the two buffers a tick writes into
 *   and pays out of later.
 *
 * All of it is re-exported here. The sim, the renderer, the audio and the tests come in
 * through this module, and `createWorld(options)` can still shrink the caps for tests.
 */

import { baseStats, POWERUPS, type StatBlock } from '../content/powerups';
import { WEAPONS } from '../content/weapons';
import { POOL_CAPS, TUNE } from './constants';
import { createBlastStack, type BlastStack, type EventRing } from './events';
import { createEffects, type EffectField } from './fx';
import { createPropField, createZoneField, type PropField, type ZoneField } from './systems/obstacles';
import { createRng, type Rng } from './rng';
import { createSpatialHash, type SpatialHash } from './spatialHash';
import { createPool, type Pool } from './pools';

// The declarations and verbs above, still reachable from here: `TUNE`/`Ev`/`Tele` are
// read by the render and audio layers, `alloc`/`release`/`countAlive` by the bench,
// `eventAt` and friends by the event readers, `Pool` by `hash.ts` and `serialize.ts`.
export { DT, Ev, POOL_CAPS, Tele, TUNE } from './constants';
export { alloc, countAlive, createPool, release } from './pools';
export type { Pool } from './pools';
export { clearEvents, countEvents, createBlastStack, eventAt, eventSlot, findEvent, pushEvent } from './events';
export type { BlastStack, EventRing } from './events';

export interface Player {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  shield: number;
  xp: number;
  level: number;
  /** Seconds until the dash is ready. */
  dashCd: number;
  /** Seconds left in the current dash burst. */
  dashTime: number;
  /** Seconds of invulnerability left. */
  iframes: number;
  /** Unit direction of the dash in flight. */
  dashDirX: number;
  dashDirY: number;
  /** Unit aim direction. */
  aimX: number;
  aimY: number;
  alive: boolean;
}

/**
 * One weapon hand. Ammo is a count rather than a pool because a magazine is
 * small and the HUD reads it directly.
 *
 * A hand spends exactly one of `ammo`, `heat` or `energy` per trigger pull, which
 * is what the def declares; the two gauges only mean anything on the hand that owns
 * them, and both refill on the ticks the hand does not spend them.
 */
export interface WeaponSlot {
  /** Index into the WEAPONS table; -1 is an empty hand. */
  weapon: number;
  ammo: number;
  /** Seconds until this hand may fire again. 0 on a `beam`, which has no gap. */
  cooldown: number;
  /** Seconds of reload left. Above 0 the hand cannot fire. */
  reload: number;
  /**
   * Seconds of draw built on a hold-to-charge weapon (see ChargeDef), spent when
   * the shot is loosed. Zero on every hand that does not charge.
   */
  charge: number;
  /** Heat on the barrel, 0 to the def's `max`. Cools every tick, firing or not. */
  heat: number;
  /**
   * True from the moment the barrel reaches `max` until it has cooled back to the
   * def's `recover`. Kept as state rather than derived from `heat` because the two
   * thresholds are what stop a hot gun from sputtering one shot per tick.
   */
  venting: boolean;
  /** Charge left on an energy hand, 0 to the def's `capacity`. */
  energy: number;
  /**
   * Seconds a `beam` has been on this hand, reset the moment it stops. The renderer
   * and the audio ping off it, so a continuous weapon stays one event every 0.12 s
   * instead of one every tick.
   */
  beam: number;
}

/** Timer-driven spawn state for the current chapter. */
export interface WaveState {
  /** False until the game starts a chapter, so an idle World spawns nothing. */
  running: boolean;
  /** Wave number within the chapter; difficulty keys off it. */
  index: number;
  /** Seconds left in this wave; at 0 the index ticks up. */
  timeLeft: number;
  /** Seconds until the next spawn batch. */
  timer: number;
  /**
   * Where in the wave's pack recipe the next batch starts. Walked forward by the size
   * of each batch, so successive packs draw different parts of the recipe: that is
   * what makes a pack mixed rather than one archetype repeated, and what lets a
   * chapter's composition be read off the recipe instead of drawn from luck.
   */
  cursor: number;
  /**
   * Seconds of the chapter's script spent, counted from the moment its clock started. A
   * scripted pack's `t` in `content/levels.ts` is a number on this clock, and a chapter's
   * `duration` is where the clock stops and the encounter walks in — which is why it is a
   * second count rather than another way of saying which wave it is on.
   */
  elapsed: number;
  /**
   * Index of the next scripted pack to land. Walked one pack at a time, so a pack whose
   * landing point was refused gets retried on a later tick instead of being skipped for the
   * rest of the chapter.
   */
  script: number;
  /**
   * Ticks the pack at `script` has been refused a landing point for. It counts down to giving
   * up rather than to a search: a blocked edge delays its chapter's set pieces, it must not
   * delete the rest of them. Reset when a pack lands or is given up on.
   */
  tries: number;
  /**
   * Scripted packs given up on after `tries` ran out. Nothing else in the sim can see that a
   * chapter quietly lost one of its set pieces, so it is counted here — and asserted on.
   */
  skips: number;
  /**
   * Where the chapter is in its own arc, which is not the same question as which wave
   * it is on. See `Phase` in `systems/levels.ts`: the drumbeat runs during the script,
   * stops when the chapter's encounter walks in, and the chapter is over when the
   * encounter is.
   */
  phase: number;
  /** Seconds of intermission left before the next chapter loads. */
  clearTime: number;
}

/**
 * The chapter's encounter, as the HUD's boss bar and the browser scenarios read it.
 *
 * One object refreshed once a tick by `systems/boss.ts` rather than a scan on every read:
 * the bar wants the same number that ends the chapter, so there is one walk of the enemy
 * pool per tick that decides both, and a scenario cannot be shown a boss the chapter
 * machine has already stopped waiting for.
 */
export interface BossState {
  /** Whether an encounter body is on the floor. What `bossesAlive` answers. */
  alive: boolean;
  /** Hit points left across every live body of the encounter. */
  hp: number;
  /** Their combined HP when the encounter walked in, so the bar has a full length. */
  maxHp: number;
  /** The lead body's name for the plate; empty while nothing is on the floor. */
  name: string;
  /**
   * Boss bodies the chapter could not put on clear floor within reach. Nothing else in the
   * sim can see that a chapter lost its encounter before it started, so it is counted rather
   * than swallowed — the same reason `WaveState.skips` exists.
   */
  skips: number;
}

export interface World {
  readonly seed: number;
  rng: Rng;
  tick: number;
  /** Simulated seconds elapsed; tick * DT. */
  time: number;
  /** Caught sim assertion failures; surfaces through __forgeState().errors. */
  errors: number;
  score: number;
  kills: number;
  /** Chapter index, 0-based. */
  chapter: number;
  /** The run is over: the player died, so the game shows the summary. */
  over: boolean;
  /**
   * The chapter's encounter is dead and its floor is spent, so the run is standing between
   * chapters. Set the tick the last boss falls and cleared when the next floor loads, which
   * is what lets a chapter banner and a scenario both ask the same question: is this chapter
   * over and not yet replaced?
   */
  chapterComplete: boolean;
  /**
   * Every chapter has fallen. The run is won: the drumbeat has stopped for good and the
   * shell shows the victory sweep instead of the next chapter.
   */
  victory: boolean;
  /** The encounter on the floor, read by the boss bar and the scenarios. */
  boss: BossState;
  /**
   * Whether the player holds down the fire button (click-to-fire) or the sim
   * shoots on its own. Off here because it is a setting, not a sim default:
   * the game layer turns it on from `neonhorde.settings.v1`, where TECH.md pins
   * the shipped default of on.
   */
  autoFire: boolean;
  /** Distance to the closest live enemy, Infinity when the arena is empty.
   * Refreshed by the enemy pass and read by the auto-fire decision. */
  enemyNear: number;
  /** Pool slot of that closest enemy, -1 when there is none. Auto-fire leads its
   * shot at this body; `enemyNear` says how far away it is, this says where. */
  nearest: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  player: Player;
  /** Two hands, index `activeSlot` being the one that fires. */
  slots: WeaponSlot[];
  activeSlot: number;
  /** Tier per POWERUPS index; 0 means not owned. */
  powerTiers: Uint8Array;
  /**
   * Seconds left per POWERUPS index, for the timed entries only — 0 on everything the
   * run keeps forever. A timed card stops being folded into `stats` when its clock
   * runs out, which is what makes it a thing to spend rather than a permanent upgrade
   * with a longer name (see `powerups.ts`).
   */
  powerTime: Float32Array;
  /** Multipliers folded from powerTiers; see recomputeStats in systems/powerups. */
  stats: StatBlock;
  /** A level-up offer is waiting; the game freezes the sim and shows the cards. */
  pendingLevelUp: boolean;
  /** POWERUPS indices for the three cards, -1 for an empty slot. */
  levelUpChoices: Int32Array;
  /** One reroll per level-up, spent or not. */
  rerollUsed: boolean;
  wave: WaveState;
  enemies: Pool;
  shots: Pool;
  enemyShots: Pool;
  shards: Pool;
  /**
   * Supply crates on the floor. `kind` is what the crate holds (a POWERUPS index, or a
   * WEAPONS index when `state` says it is a gun) and `state` is which of the two;
   * `life` is how long it waits before it rots. See `systems/pickups.ts`.
   */
  chests: Pool;
  /** Death blasts queued this tick, paid out by `resolveBlasts` (see systems/enemies). */
  blasts: BlastStack;
  /**
   * Static cover, installed per chapter. Empty in a world that never started one, which
   * is why every query against it starts with a length check (see `props.ts`).
   */
  props: PropField;
  /** Floor hazards, installed per chapter alongside the cover. */
  zones: ZoneField;
  hash: SpatialHash;
  events: EventRing;
  /** Scratch for hash queries; only valid during the tick that filled it. */
  readonly query: Int32Array;
  /**
   * Particles and point lights, derived from the event ring after the damage passes
   * (see `fx.ts`). Presentation only: no rule reads it, which is what lets the bench
   * load 8,000 of them without changing a single outcome.
   */
  fx: EffectField;
}

export interface WorldOptions {
  enemies?: number;
  projectiles?: number;
  enemyProjectiles?: number;
  shards?: number;
  blasts?: number;
  chests?: number;
  /** Arena is centred on the origin with this half-edge; 60 gives 120x120 m. */
  arenaHalf?: number;
  hashCell?: number;
  eventCap?: number;
  queryCap?: number;
}

/** A hand holding `weaponIndex`, loaded by `loadSlot`. */
function createSlot(weaponIndex: number): WeaponSlot {
  const slot: WeaponSlot = {
    weapon: -1,
    ammo: 0,
    cooldown: 0,
    reload: 0,
    charge: 0,
    heat: 0,
    venting: false,
    energy: 0,
    beam: 0,
  };
  loadSlot(slot, weaponIndex);
  return slot;
}

/**
 * Put `weaponIndex` in `slot` and give it what the gun starts with, in place.
 *
 * One function owns "a hand is loaded", because three things need it to mean the same
 * thing: the two hands a World starts with, a chest or a level-up handing over a gun
 * (`__forgeDebug.giveWeapon`), and a test that wants to be about a weapon rather than
 * about how weapons arrive. A hand that spends charge starts with a full one and a
 * hand that spends heat starts cold, because a gun picked up empty reads as broken
 * rather than as balanced.
 */
export function loadSlot(slot: WeaponSlot, weaponIndex: number): void {
  const def = weaponIndex >= 0 ? WEAPONS[weaponIndex] : undefined;
  slot.weapon = weaponIndex;
  slot.ammo = def && def.ammo ? def.ammo.mag : 0;
  slot.energy = def && def.energy ? def.energy.capacity : 0;
  slot.heat = 0;
  slot.venting = false;
  slot.cooldown = 0;
  slot.reload = 0;
  slot.charge = 0;
  slot.beam = 0;
}

export function createWorld(seed: number, opts: WorldOptions = {}): World {
  const half = opts.arenaHalf ?? 60;
  const cell = opts.hashCell ?? TUNE.hashCell;
  const minX = -half;
  const minY = -half;
  const maxX = half;
  const maxY = half;
  const enemyCap = opts.enemies ?? POOL_CAPS.enemies;
  const eventCap = opts.eventCap ?? 1024;

  return {
    seed,
    rng: createRng(seed),
    tick: 0,
    time: 0,
    errors: 0,
    score: 0,
    kills: 0,
    chapter: 0,
    over: false,
    chapterComplete: false,
    victory: false,
    boss: { alive: false, hp: 0, maxHp: 0, name: '', skips: 0 },
    autoFire: false,
    enemyNear: Infinity,
    nearest: -1,
    minX,
    minY,
    maxX,
    maxY,
    player: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      vx: 0,
      vy: 0,
      hp: 100,
      maxHp: 100,
      shield: 0,
      xp: 0,
      level: 1,
      dashCd: 0,
      dashTime: 0,
      iframes: 0,
      dashDirX: 1,
      dashDirY: 0,
      aimX: 1,
      aimY: 0,
      alive: true,
    },
    // Slot 0 holds the starting pistol (WEAPONS[0]); the second hand stays empty
    // until a chest or a level-up fills it.
    slots: [createSlot(0), createSlot(-1)],
    activeSlot: 0,
    powerTiers: new Uint8Array(POWERUPS.length),
    powerTime: new Float32Array(POWERUPS.length),
    stats: baseStats(),
    pendingLevelUp: false,
    levelUpChoices: new Int32Array(3),
    rerollUsed: false,
    wave: {
      running: false,
      index: 1,
      timeLeft: TUNE.waveLength,
      timer: TUNE.firstBatchDelay,
      cursor: 0,
      elapsed: 0,
      script: 0,
      tries: 0,
      skips: 0,
      phase: 0,
      clearTime: 0,
    },
    enemies: createPool('enemies', enemyCap),
    shots: createPool('shots', opts.projectiles ?? POOL_CAPS.projectiles),
    enemyShots: createPool('enemyShots', opts.enemyProjectiles ?? POOL_CAPS.enemyProjectiles),
    shards: createPool('shards', opts.shards ?? POOL_CAPS.shards),
    chests: createPool('chests', opts.chests ?? POOL_CAPS.chests),
    blasts: createBlastStack(opts.blasts ?? POOL_CAPS.blasts),
    props: createPropField(POOL_CAPS.props, cell, minX, minY, maxX, maxY),
    zones: createZoneField(POOL_CAPS.zones),
    hash: createSpatialHash(minX, minY, maxX, maxY, cell, enemyCap),
    events: {
      cap: eventCap,
      type: new Int32Array(eventCap),
      a: new Int32Array(eventCap),
      b: new Int32Array(eventCap),
      x: new Float32Array(eventCap),
      y: new Float32Array(eventCap),
      head: 0,
      count: 0,
      dropped: 0,
      written: 0,
    },
    query: new Int32Array(opts.queryCap ?? 256),
    fx: createEffects(),
  };
}

/**
 * Fit the playable box to a chapter, so a canal and a ring arena are not fought in a room
 * the size of the first one.
 *
 * Clamped inside the box the World was built with rather than trusted: the spatial hash and
 * the prop grid were both sized from `createWorld`'s arena, so a chapter that asked for a
 * bigger room than the World has would be indexing bodies outside the grid that holds them,
 * which is not a bigger arena but collisions quietly switching off. A chapter that wants
 * 200x200 m gets the floor there is, at the size the floor has.
 */
export function setArena(w: World, half: number): void {
  const built = Math.min(w.hash.cols * w.hash.cellSize, w.hash.rows * w.hash.cellSize) * 0.5;
  const edge = half > built ? built : half;
  const inner = edge > TUNE.playerRadius ? edge : TUNE.playerRadius;
  w.minX = -inner;
  w.minY = -inner;
  w.maxX = inner;
  w.maxY = inner;
}
