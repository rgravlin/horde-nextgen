/**
 * The struct-of-arrays entity pool, and the three words spoken about it: take a slot,
 * give one back, count the live ones.
 *
 * One pool shape serves enemies, both projectile pools, shards and crates, which is why
 * the six behaviour slots (`dotT` … `elite`) are allocated even where nothing writes
 * them: `alloc` has to be able to hand back a cleared slot without knowing what kind of
 * pool it is. That is also why the free list is a stack of indices rather than a scan —
 * a recycled slot is cleared by the same code that claims it, so nothing downstream has
 * to remember to reset a field.
 *
 * Split out of `world.ts` with no behaviour change; `world.ts` re-exports all of it so
 * the sim and the tests still come in through one door.
 */

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
   * `systems/enemies/shared.ts`). Kept beside `state` rather than inside it because a
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
   * `content/levels/`: a chapter says which variants it rolls and how often, and
   * `systems/enemies/` reads this back when it sets a body's HP, its touch damage and
   * its gait. Kept in the pool rather than in a side table for the same reason `phase`
   * is — a recycled slot has to start clean without anything remembering to clear it.
   *
   * The projectile pools never write it. They allocate it for the same reason they
   * allocate the six behaviour slots above: so `alloc` can hand back a cleared slot
   * without knowing what kind of pool it is.
   */
  readonly elite: Uint8Array;
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