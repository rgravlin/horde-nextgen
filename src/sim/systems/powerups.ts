/**
 * Power-ups: the read side of the run's StatBlock.
 *
 * The *write* side is `content/powerups.ts`, which says what each card does, and
 * `grantPowerup` in `systems/pickups.ts`, which raises a tier. This file owns the two
 * things a card needs that content cannot express on its own: how the folded numbers
 * get rebuilt when the set of cards changes, and where in combat they get read.
 *
 * Two rules keep the fifty-odd power-ups in this game from becoming fifty ways to write
 * an if-chain:
 *
 * - **One number, folded, read at the point of use.** A card writes a multiplier into
 *   the block; the code that needs it reads `w.stats.something` where it already is.
 *   There is no second registry of "effects" to keep in step, and adding a card is
 *   adding one `apply` plus — if it is a new stat — one read.
 * - **A read that is switched off costs nothing.** Every helper below returns early
 *   when its stat is at its neutral value, so a run that owns none of the exotic cards
 *   pays one comparison per hit rather than a branch tree. That is what lets the
 *   default case stay the 1,000-enemy case.
 *
 * No DOM, no engine, no wall clock (ARCHITECTURE.md's purity gate): the clocks here are
 * counted in ticks by the step, so the whole file runs headless in the unit tests.
 */

import { baseStats, POWERUPS } from '../../content/powerups';
import { eliteRosterAt, levelAt } from '../../content/levels';
import { next, nextInt } from '../rng';
import { DT, TUNE, type World } from '../world';

/**
 * Rebuild the block from the tiers held, in content order.
 *
 * Reset-then-apply rather than multiply-on-grant: the result depends on which cards the
 * run holds and at what tier, never on the order they arrived in or on how many ticks
 * they have been held. A `+=`-on-grant design drifts with every recompute, and a
 * recompute is exactly what a timed buff expiring has to trigger.
 *
 * A timed card only counts while its clock is running, which is the whole reason the
 * block has to be foldable from scratch: an expired dose has to leave, and the only way
 * to make something leave a folded product is to fold it again without it.
 */
export function recomputeStats(w: World): void {
  const stats = w.stats;
  const time = w.powerTime;

  // Every field back to neutral first, not just the three the first pass wrote. A new
  // stat that nobody resets leaks across a recompute, and the leak is invisible: the
  // number is right the first time and only wrong after a second card arrives.
  Object.assign(stats, baseStats());

  for (let i = 0; i < POWERUPS.length; i++) {
    const tier = w.powerTiers[i];
    if (tier === 0) continue;
    if (POWERUPS[i].kind === 'timed' && time[i] <= 0) continue;
    POWERUPS[i].apply(stats, tier);
  }

  // Barrier is a pool, not a rate, and the only time it refills is when the run's tiers
  // change — a fresh cell from a card or a crate. Refilling every second would make it
  // a second regen stat with a confusing name.
  const pool = stats.shield;
  if (pool > w.player.shield) w.player.shield = pool;
}

/**
 * Count the run's clocks down, and refold when one runs out.
 *
 * One pass over the power-up table per tick, and only over the entries the run actually
 * holds — after the first few levels that is a handful of comparisons rather than
 * twenty-two, and the common case (nothing running) costs nothing at all.
 */
export function tickPowerTimers(w: World): void {
  if (!w.player.alive) return;

  const time = w.powerTime;
  let spent = false;
  for (let i = 0; i < POWERUPS.length; i++) {
    const left = time[i];
    if (left <= 0) continue;
    const rest = left > DT ? left - DT : 0;
    time[i] = rest;
    if (rest === 0) spent = true;
  }
  if (spent) recomputeStats(w);
}

/** Put a timed dose on the clock. A re-pick restarts it at the new tier's length. */
export function startTime(w: World, index: number, seconds: number): void {
  w.powerTime[index] = seconds;
}

/**
 * Damage a player hit actually pays out, after the run's damage multiplier.
 *
 * Folded here rather than at each of the seven delivery paths so `falloff`, armour and
 * the multiplier cannot be applied in three different orders by three different weapons.
 */
export function scaleOut(w: World, base: number): number {
  const dmg = w.stats.dmg;
  return dmg === 1 ? base : base * dmg;
}

/**
 * The crit multiplier for one hit, spending one rng draw — and only when the run can
 * actually crit.
 *
 * One draw per body rather than per trigger pull, because a hit is resolved where the
 * delivery is, and a per-pull decision would have to be threaded down through seven
 * delivery paths to reach the eight bodies it applies to. A run with no crit card pays
 * nothing here at all, which is what keeps the seeded streams of every earlier test
 * exactly as they were.
 */
export function rollCrit(w: World): number {
  const stats = w.stats;
  if (stats.crit <= 0) return 1;
  return next(w.rng) < stats.crit ? stats.critMult : 1;
}

/**
 * What a hit of `raw` damage actually costs the player, after armour and the barrier.
 *
 * Returns what is left to take off HP — 0 when the hit did not land, which is how the
 * caller knows not to spend the i-frame window on it. Armour and fragility multiply (a
 * plate and a curse are two independent numbers, not one contested slot), and the
 * barrier drinks what is left before HP does.
 */
export function absorbIncoming(w: World, raw: number): number {
  const stats = w.stats;
  const player = w.player;
  let dmg = raw;

  if (stats.armor > 0 || stats.fragile > 0) {
    dmg *= (1 - stats.armor) * (1 + stats.fragile);
  }
  if (dmg <= 0) return 0;

  if (player.shield > 0) {
    if (player.shield >= dmg) {
      player.shield -= dmg;
      return 0;
    }
    dmg -= player.shield;
    player.shield = 0;
  }

  return dmg;
}

/**
 * Mend the player from a hit that landed, capped per hit.
 *
 * The cap is the point. Four percent of a railgun's 140 damage is 5.6 HP a shot, and an
 * uncapped lifesteal turns the sniper into a licence to stop moving; two HP a hit keeps
 * it a reward for good aim rather than a second health bar.
 */
export function lifesteal(w: World, dealt: number): void {
  const stats = w.stats;
  if (stats.lifesteal <= 0) return;

  const player = w.player;
  if (player.hp >= player.maxHp) return;

  let mend = dealt * stats.lifesteal;
  if (mend > TUNE.lifestealCap) mend = TUNE.lifestealCap;
  player.hp = player.hp + mend > player.maxHp ? player.maxHp : player.hp + mend;
}

/** What a body pays for touching the player, on top of its own hug damage. */
export function thornsDamage(w: World): number {
  return w.stats.thorns;
}

/**
 * How far one body travels this tick, as a fraction of its own velocity.
 *
 * One number carrying two effects — the stasis field off, the elite's gait on — because
 * both are read at the same point, the single travel tail every behaviour funnels
 * through, and a body that is both slowed and sprinting has one answer rather than two
 * that have to be reconciled. Written into a scratch slot rather than returned so the
 * hot path passes no arguments.
 */
export function travelScale(w: World, ex: number, ey: number, eliteGait: number): number {
  const stats = w.stats;
  let scale = eliteGait;

  if (stats.slowField > 0) {
    const dx = ex - w.player.x;
    const dy = ey - w.player.y;
    const reach = stats.slowRadius;
    if (dx * dx + dy * dy <= reach * reach) {
      const slow = stats.slowField > TUNE.slowMax ? TUNE.slowMax : stats.slowField;
      scale *= 1 - slow;
    }
  }

  return scale;
}

/**
 * The elite variant this chapter rolls for one body, as an index into `ELITES`, or -1
 * for a plain one.
 *
 * Draws at most one rng number per body, and none at all on a chapter that declares no
 * elites — which is what keeps every seeded run predating the variants bit-for-bit the
 * run it already was. The roster comes pre-resolved out of `content/levels/` so a
 * spawn never probes a name map.
 */
export function rollElite(w: World, roster: readonly number[]): number {
  const chance = levelAt(w.chapter).eliteChance;
  if (chance <= 0 || roster.length === 0) return -1;
  if (next(w.rng) >= chance) return -1;
  return roster[nextInt(w.rng, roster.length)];
}

/** The roster the current chapter rolls, kept next to the roll so the two cannot drift. */
export function eliteRoster(w: World): readonly number[] {
  return eliteRosterAt(w.chapter);
}
