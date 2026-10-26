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
import { createEffects, type EffectField } from './fx';
import { createPropField, createZoneField, type PropField, type ZoneField } from './systems/obstacles';
import { createRng, type Rng } from './rng';
import { createSpatialHash, type SpatialHash } from './spatialHash';

/** Hard pool caps from TECH.md "Pools with hard caps". */
export const POOL_CAPS = {
  enemies: 2048,
  projectiles: 2048,
  enemyProjectiles: 512,
  shards: 1024,
  /**
   * Death blasts waiting inside one tick. Not a TECH.md pool: a burst is a few floats
   * rather than an entity, and 32 is already more bombers than detonate in one 1/60 s
   * window, so a stack that fills is a burst dropped and counted, not a queue that
   * grows.
   */
  blasts: 32,
  /**
   * Supply crates on the floor at once. Also not a TECH.md pool, and deliberately tiny:
   * a crate is somewhere the player is asked to walk rather than a thing to count, so
   * more than a dozen on screen at once would be a map full of prompts rather than a
   * choice. 24 is already more than a run can route to.
   */
  chests: 24,
  /**
   * Boxes of static cover a chapter may lay down, and floor hazards it may pour. Neither
   * is a TECH.md pool: both are built once when a chapter is installed rather than
   * allocated through a run, and the caps bound what a layout may author, not what a
   * fight can produce. 64 boxes is roughly a hundred metres of wall or forty crates,
   * which is more floor than a 120x120 m arena can hold interestingly.
   */
  props: 64,
  zones: 16,
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

  /**
   * m — the shortest detour a crate is worth. A drop beside the player's feet is not a
   * reward, it is a thing they walked past; the whole point of a crate is that it asks
   * the player to leave the ring they are in and go somewhere they chose.
   */
  chestMinDist: 6,
  /** Bodies on the floor for a drop to be worth that walk. */
  chestPackFloor: 14,
  /** Chance a qualifying arriving pack marks itself with a crate, 0..1. */
  chestChance: 0.25,
  /** s a crate sits on the floor before it rots. */
  chestLife: 30,
  /** m — walk within this and it opens. */
  chestOpenRadius: 1.2,
  /**
   * HP one lifesteal hit may pay back.
   *
   * A fraction alone turns a 140-damage railgun into immortality, which is why the
   * cap exists rather than a smaller fraction: the power-up should be a reason to keep
   * landing shots, not a licence to stop moving.
   */
  lifestealCap: 2,
  /**
   * Fraction of a body's travel a stasis field takes off it, at the field's full
   * strength and inside its radius. `stats.slowField` is the fraction itself, so this
   * constant is only the ceiling the read clamps to.
   */
  slowMax: 0.6,
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
  /**
   * A wind-up began, for the telegraph shapes in DESIGN.md ("a charge line or landing
   * ring that fills up until impact"). `a` is the enemy slot, `b` the shape from `Tele`
   * below. The event only marks the *start*: how much of the shape is still to come is
   * the body's `timer`, and where it points is its `fx`/`fy`, both read from the pool.
   */
  Telegraph: 6,
  Pickup: 7,
  LevelUp: 8,
  Shake: 9,
  Death: 10,
  Error: 11,
  /**
   * Something detonated: `b` is the burst radius x 10. `a` is the weapon for a lobbed
   * shell and -1 for an enemy's death blast, which has no gun behind it.
   */
  Explosion: 12,
  /**
   * A heal aura pulsed: `a` is the healer's slot, `b` the aura radius x 10 and x/y
   * the aura's centre. One event per pulse, not per healed body — the aura is one
   * thing on screen even when it mends six bodies.
   */
  Heal: 13,
  /**
   * Damage landed on a body, for the floating numbers in DESIGN.md ("Motion").
   *
   * `a` is the HP actually taken off the body (after armour, so the number tells the
   * truth about the armour), `b` is 1 when the crit roll paid off and 0 otherwise, and
   * x/y where it landed. One event per hit rather than one per shot: a shotgun's eight
   * pellets are eight numbers, and the pool is sixty-four wide precisely so that a
   * number can be skipped when the screen is already full of them.
   *
   * A presentation feed only — no rule reads it — which is what lets the renderer drop
   * numbers it has no room for and the headless run stay unchanged.
   */
  Damage: 14,
} as const;

/**
 * What a `Telegraph` event warns about, in its `b` slot.
 *
 * Shapes rather than archetype ids, because the shape is what the renderer needs and
 * two enemies can share one: a line drawn down the body's facing for a charge, a ring
 * of its blast radius for a detonation.
 */
export const Tele = {
  /** A charge is coming along the body's facing, `dashReach` metres of it. */
  Line: 1,
  /** The body is fusing and will burst at its own radius. */
  Ring: 2,
  /**
   * A ring at a point that is not a body: the lobbed grenade's landing circle. The
   * event's x/y is the ring's centre; the grenade that brings it carries the radius
   * (the `state` slot x 10) and how much of the fill is left (its `life`), so a
   * filling ring needs no per-event object either.
   */
  RingAt: 3,
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
   * projectile may still land, and the burst radius x 10 for a grenade (see
   * `Tele.RingAt`), which lands nothing until its `life` runs out. */
  readonly state: Uint16Array;
  /**
   * Burn, for the enemy pool only: seconds of damage-over-time left on the body, and
   * what it costs per second. Written by a weapon hit carrying a `dot`, ticked by the
   * projectile pass, and cleared with the rest of the slot — so a body that dies of
   * its burns cannot pass them to whatever takes the slot next.
   */
  readonly dotT: Float32Array;
  readonly dotDps: Float32Array;
  /**
   * Behaviour phase id, for the enemy pool only (see `Phase` in
   * `systems/enemies.ts`). Kept beside `state` rather than inside it because a
   * behaviour's phase and the stagger a hit gives it are two facts that have to
   * survive each other: a charger knocked out of its wind-up is still a charger in a
   * wind-up, it is just reeling.
   */
  readonly phase: Uint8Array;
  /**
   * Behaviour clock, for the enemy pool only: seconds left in the current phase for the
   * bodies that have phases, and the weave offset for the bodies that swing instead. One
   * array rather than two because a behaviour only ever wants one number that ages, and a
   * second would have to be kept in step with the first.
   */
  readonly timer: Float32Array;
  /**
   * Facing: the unit direction a body presents as its front, for the enemy pool only.
   * Directional armour reads it (`armorAgainst`) and the shield quad is drawn from it,
   * which is why it is state rather than something derived from velocity at the
   * moment a hit lands — a body that is standing still or reeling still has a front.
   */
  readonly fx: Float32Array;
  readonly fy: Float32Array;
  /**
   * Elite variant id + 1, for the enemy pool only (0 is a plain body). See
   * `content/levels.ts`: a chapter says which variants it rolls and how often, and
   * `systems/enemies.ts` reads this back when it sets a body's HP, its touch damage and
   * its gait. Kept in the pool rather than in a side table for the same reason `phase`
   * is — a recycled slot has to start clean without anything remembering to clear it.
   *
   * The projectile pools never write it. They allocate it for the same reason they
   * allocate the six behaviour slots above: so `alloc` can hand back a cleared slot
   * without knowing what kind of pool it is.
   */
  readonly elite: Uint8Array;
}

/**
 * Circular event buffer, oldest first, dropping the oldest on overflow.
 *
 * It is a broadcast, not a queue: nothing in the sim is required to drain it, which is
 * why a consumer (the particle field in `fx.ts`, later audio) keeps its own cursor into
 * `written` rather than consuming `count`. A drain would make the first reader silence
 * the rest, and the first reader is whichever feature got written first.
 */
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
  /**
   * How many events have ever been pushed, which is what makes a cursor possible: the
   * unread window is `[written - count, written)` and a slot is `written % cap`. Only
   * `clearEvents` resets it, and only because that call means "nobody wants the past".
   */
  written: number;
}

/**
 * Death blasts waiting to be resolved, newest at the top of the stack.
 *
 * A blast is queued where the death happens and paid out later in the tick, in
 * `resolveBlasts`, rather than resolved inside the kill. Two reasons, both about
 * correctness rather than tidiness: the kill happens while a shot is walking the
 * tick's shared hash-query buffer, and a blast that queried it there would rewrite
 * the very list the shot is still iterating; and a blast that kills another bomber
 * queues another blast, which wants a stack to land on rather than recursion.
 */
export interface BlastStack {
  readonly cap: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Metres of reach the burst carries. */
  readonly r: Float32Array;
  /** Damage at the centre, before armour. */
  readonly dmg: Float32Array;
  /** How many blasts deep this one was queued, capped by the resolver. */
  readonly chain: Uint8Array;
  count: number;
  /** Bursts dropped because the stack was full; keeps the loss observable. */
  dropped: number;
  /**
   * How deep the burst being paid out right now sits, so a death caused by a burst can
   * mark its own child instead of starting a fresh chain. Only `resolveBlasts` writes it,
   * and it is back to 0 between ticks.
   */
  depth: number;
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

/** The stack of waiting bursts. See `BlastStack`. */
export function createBlastStack(cap: number): BlastStack {
  return {
    cap,
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    r: new Float32Array(cap),
    dmg: new Float32Array(cap),
    chain: new Uint8Array(cap),
    count: 0,
    dropped: 0,
    depth: 0,
  };
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
    // Only the enemy pool ever writes these six (see Pool), but they are allocated
    // everywhere so `alloc` can hand back a cleared slot without knowing what kind
    // of pool it is: a few KB of quiet memory for that invariant to hold.
    dotT: new Float32Array(cap),
    dotDps: new Float32Array(cap),
    phase: new Uint8Array(cap),
    timer: new Float32Array(cap),
    fx: new Float32Array(cap),
    fy: new Float32Array(cap),
    elite: new Uint8Array(cap),
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
  p.dotT[i] = 0;
  p.dotDps[i] = 0;
  p.phase[i] = 0;
  p.timer[i] = 0;
  p.fx[i] = 0;
  p.fy[i] = 0;
  p.elite[i] = 0;
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
  e.written++;
}

/**
 * The slot a cursor points at, for a consumer that tracks `written` rather than
 * `count` (see `EventRing`). Returns -1 for a position already overwritten.
 */
export function eventAt(w: World, at: number): number {
  const e = w.events;
  if (at < 0 || at >= e.written || at < e.written - e.count) return -1;
  return at % e.cap;
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

/**
 * Drop every unread event; the consumers call this once per rendered frame.
 *
 * `written` goes back to zero with them, so a consumer that tracks a cursor starts from
 * the same reset point rather than reading a window that no longer exists. What a
 * consumer loses by this call is the events that arrived since its last look, which is
 * why the particle field keeps a cursor instead of calling this: the ring is a broadcast.
 */
export function clearEvents(w: World): void {
  const e = w.events;
  e.head = 0;
  e.count = 0;
  e.written = 0;
}