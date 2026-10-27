/**
 * The numbers the sim is tuned on: pool caps, tuning defaults, event ids and the tick.
 *
 * These are in one file rather than beside the code that reads them because each is
 * written down exactly once (AGENTS.md rule): the caps are shared by the pools, the bench
 * and the save format; the event ids are read by the renderer, the audio and the HUD, and
 * saved replays name them by number, so a new id is added here rather than invented at the
 * call site.
 *
 * Split out of `world.ts` with no behaviour change; `world.ts` re-exports all of it so
 * callers keep one door.
 */

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
   * pellets are eight events, and it is the presentation side's job to fold the ones
   * that landed inside one body back into one number (see `MERGE_RADIUS` and
   * `MERGE_WINDOW` in `render/damageNumbers.ts`). The pool is finite and a frame has a
   * budget, precisely so that a number can be skipped when the screen is already full
   * of them.
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