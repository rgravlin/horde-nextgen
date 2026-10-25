/**
 * The World: every piece of game state in one object, built from
 * struct-of-arrays pools with hard caps, plus the event rings the renderer,
 * audio and HUD read (ARCHITECTURE.md "Data flow").
 *
 * Nothing in this file runs per tick; it only allocates. Caps come from here so
 * the pools, the bench and the save format all read the same numbers — this is
 * the single place a cap is written down (AGENTS.md rule), and
 * createWorld(options) can shrink them for tests.
 */

import { baseStats, POWERUPS, type StatBlock } from '../content/powerups';
import { WEAPONS } from '../content/weapons';
import { createRng, type Rng } from './rng';
import { createSpatialHash, type SpatialHash } from './spatialHash';

/** Hard pool caps from TECH.md "Pools with hard caps". */
export const POOL_CAPS = {
  enemies: 2048,
  projectiles: 2048,
  enemyProjectiles: 512,
  shards: 1024,
} as const;

/** Tuning defaults the sim reads. Content files may override per item later. */
export const TUNE = {
  /** m/s walking speed. */
  moveSpeed: 6,
  /** m/s during a dash burst. */
  dashSpeed: 22,
  /** s of dash burst. */
  dashTime: 0.18,
  /** s of invulnerability a dash grants, outlasting the burst slightly. */
  dashIframes: 0.3,
  /** s before the dash can be used again, counted from the burst start. */
  dashCooldown: 1.5,
  /** m collision radius; the arena clamp keeps the centre this far inside. */
  playerRadius: 0.4,
  /** Broad-phase cell edge in world units. */
  hashCell: 2,
  /** m collision radius of a projectile, added to the target's for a hit test. */
  shotRadius: 0.12,
  /** m of barrel the shot spawns downrange of the player's centre. */
  shotStart: 0.2,
  /** m — XP shards inside this radius fly to the player. */
  magnetRadius: 2.5,
  /** m — auto-fire only wakes up when an enemy is this close. */
  autoFireRange: 18,
  /** m/s^2 a shard gains while inside the magnet field. */
  shardAccel: 26,
  /** m/s cap on shard flight, so a long pull does not become a bullet. */
  shardSpeed: 14,
  /** Drag per tick on a shard outside the magnet field. */
  shardDrag: 0.9,
  /** s a shard hangs around before it expires. */
  shardLife: 25,
  /** m — a shard this close to the player is gone in. */
  collectRadius: 0.5,
  /** s of invulnerability any hit buys, so a crowd cannot shred the player. */
  hurtIframes: 0.5,
  /** m half-edges of the 32x18 m view rect; spawns land just outside it. */
  viewHalfX: 16,
  viewHalfY: 9,
  /** m of extra margin outside the view rect a spawn may land in. */
  spawnMargin: 2.5,
  /** s between spawn batches at wave 1, and the floor it decays toward. */
  spawnGap: 1.4,
  spawnGapDecay: 0.88,
  spawnGapFloor: 0.3,
  /** Largest batch the timer-driven spawner will ever emit. */
  batchCap: 12,
  /** s a wave lasts before its index ticks up and the spawner tightens. */
  waveLength: 12,
  /** s before the first batch of a chapter, so it does not open on a crowd. */
  firstBatchDelay: 0.6,
  /** XP for the next level is xpBase + (level - 1) * xpStep, summed per level. */
  xpBase: 5,
  xpStep: 5,
  /** Level-up cards, and reroll attempts before the offer is called unchanged. */
  pickCount: 3,
  rerollTries: 8,
} as const;

/**
 * Event ids written to the ring. Render and audio map these to effects; the ids
 * are stable because saved replays and scenarios refer to them by number.
 * Later tasks add ids here rather than inventing a second channel.
 */
export const Ev = {
  Dash: 1,
  Shot: 2,
  Hit: 3,
  Kill: 4,
  Spawn: 5,
  Telegraph: 6,
  Pickup: 7,
  LevelUp: 8,
  Shake: 9,
  Death: 10,
  Error: 11,
  /** A lobbed shell detonated: `a` is the weapon, `b` the burst radius x 10. */
  Explosion: 12,
} as const;

/** One fixed-timestep tick, shared by the loop and the tests. */
export const DT = 1 / 60;

/** Struct-of-arrays entity pool. */
export interface Pool {
  readonly name: string;
  readonly cap: number;
  /** Live slots. */
  count: number;
  /** Stack of free slot indices, `freeCount` deep. */
  readonly freeList: Int32Array;
  freeCount: number;
  readonly alive: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Enemy health; projectile pools reuse it as damage dealt. */
  readonly hp: Float32Array;
  /** Seconds since spawn. */
  readonly age: Float32Array;
  /** Seconds of flight left; reaching 0 retires the slot. */
  readonly life: Float32Array;
  /** Index into the pool's content table: weapon for shots, archetype for
   * enemies and shards (a shard's XP comes from the enemy it came off). */
  readonly kind: Uint16Array;
  /** Behaviour state-machine slot: stagger ticks for enemies, shots a
   * projectile may still land. */
  readonly state: Uint16Array;
}

/** Circular event buffer, oldest first, dropping the oldest on overflow. */
export interface EventRing {
  readonly cap: number;
  readonly type: Int32Array;
  readonly a: Int32Array;
  readonly b: Int32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Next write slot. */
  head: number;
  /** Unread events. */
  count: number;
  /** Events dropped for lack of room; keeps the loss observable. */
  dropped: number;
}

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
 */
export interface WeaponSlot {
  /** Index into the WEAPONS table; -1 is an empty hand. */
  weapon: number;
  ammo: number;
  /** Seconds until this hand may fire again. */
  cooldown: number;
  /** Seconds of reload left. Above 0 the hand cannot fire. */
  reload: number;
  /**
   * Seconds of draw built on a hold-to-charge weapon (see ChargeDef), spent when
   * the shot is loosed. Zero on every hand that does not charge.
   */
  charge: number;
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
  /** Multipliers folded from powerTiers; see recomputeStats in systems/pickups. */
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
  hash: SpatialHash;
  events: EventRing;
  /** Scratch for hash queries; only valid during the tick that filled it. */
  readonly query: Int32Array;
}

export interface WorldOptions {
  enemies?: number;
  projectiles?: number;
  enemyProjectiles?: number;
  shards?: number;
  /** Arena is centred on the origin with this half-edge; 60 gives 120x120 m. */
  arenaHalf?: number;
  hashCell?: number;
  eventCap?: number;
  queryCap?: number;
}

export function createPool(name: string, cap: number): Pool {
  const freeList = new Int32Array(cap);
  // Deepest-first pop order, so slots are handed out from index 0 upward: the
  // lowest-index-first iteration order stays deterministic across runs.
  for (let i = 0; i < cap; i++) freeList[i] = cap - 1 - i;
  return {
    name,
    cap,
    count: 0,
    freeList,
    freeCount: cap,
    alive: new Uint8Array(cap),
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    vx: new Float32Array(cap),
    vy: new Float32Array(cap),
    hp: new Float32Array(cap),
    age: new Float32Array(cap),
    life: new Float32Array(cap),
    kind: new Uint16Array(cap),
    state: new Uint16Array(cap),
  };
}

/** Take a slot, or -1 when the pool is full. The slot arrives cleared and alive. */
export function alloc(p: Pool): number {
  if (p.freeCount === 0) return -1;
  const i = p.freeList[--p.freeCount];
  p.alive[i] = 1;
  p.count++;
  p.x[i] = 0;
  p.y[i] = 0;
  p.vx[i] = 0;
  p.vy[i] = 0;
  p.hp[i] = 0;
  p.age[i] = 0;
  p.life[i] = 0;
  p.kind[i] = 0;
  p.state[i] = 0;
  return i;
}

/** Give a slot back. Releasing a dead slot is ignored, so double frees are harmless. */
export function release(p: Pool, i: number): void {
  if (i < 0 || i >= p.cap || p.alive[i] === 0) return;
  p.alive[i] = 0;
  p.count--;
  p.freeList[p.freeCount++] = i;
}

export function countAlive(p: Pool): number {
  let n = 0;
  for (let i = 0; i < p.cap; i++) n += p.alive[i];
  return n;
}

/** A hand holding `weaponIndex`, loaded when there is a gun to load. */
function createSlot(weaponIndex: number): WeaponSlot {
  const mag = weaponIndex >= 0 ? WEAPONS[weaponIndex].ammo.mag : 0;
  return { weapon: weaponIndex, ammo: mag, cooldown: 0, reload: 0, charge: 0 };
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
    stats: baseStats(),
    pendingLevelUp: false,
    levelUpChoices: new Int32Array(3),
    rerollUsed: false,
    wave: {
      running: false,
      index: 1,
      timeLeft: TUNE.waveLength,
      timer: TUNE.firstBatchDelay,
    },
    enemies: createPool('enemies', enemyCap),
    shots: createPool('shots', opts.projectiles ?? POOL_CAPS.projectiles),
    enemyShots: createPool('enemyShots', opts.enemyProjectiles ?? POOL_CAPS.enemyProjectiles),
    shards: createPool('shards', opts.shards ?? POOL_CAPS.shards),
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
    },
    query: new Int32Array(opts.queryCap ?? 256),
  };
}

/**
 * Append an event. On overflow the oldest unread event is dropped and counted,
 * because the sim must never block on a consumer (ARCHITECTURE.md). A full ring
 * has its read cursor sitting on `head`, so overwriting that slot is the drop.
 */
export function pushEvent(w: World, type: number, a: number, b: number, x: number, y: number): void {
  const e = w.events;
  if (e.count === e.cap) {
    e.count--;
    e.dropped++;
  }
  const i = e.head;
  e.type[i] = type;
  e.a[i] = a;
  e.b[i] = b;
  e.x[i] = x;
  e.y[i] = y;
  e.head = (i + 1) % e.cap;
  e.count++;
}

/** Slot index of the k-th unread event, 0 = oldest; -1 when k is out of range. */
export function eventSlot(w: World, k: number): number {
  const e = w.events;
  if (k < 0 || k >= e.count) return -1;
  return (e.head - e.count + k + e.cap * 2) % e.cap;
}

/** Slot index of the first unread event of `type`, or -1. */
export function findEvent(w: World, type: number): number {
  const e = w.events;
  for (let k = 0; k < e.count; k++) {
    const i = (e.head - e.count + k + e.cap * 2) % e.cap;
    if (e.type[i] === type) return i;
  }
  return -1;
}

export function countEvents(w: World, type: number): number {
  const e = w.events;
  const base = (e.head - e.count + e.cap * 2) % e.cap;
  let n = 0;
  for (let k = 0; k < e.count; k++) {
    if (e.type[(base + k) % e.cap] === type) n++;
  }
  return n;
}

/** Drop every unread event; the consumers call this once per rendered frame. */
export function clearEvents(w: World): void {
  const e = w.events;
  e.head = 0;
  e.count = 0;
}