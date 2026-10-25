/**
 * Per-enemy status effects: what keeps hurting a body after the thing that put it
 * there is gone.
 *
 * One channel today — burn — and it is deliberately narrow. A body carries one burn,
 * described by a timer (`dotT`) and a rate (`dotDps`), both held in the enemy pool, so
 * a slot that is recycled starts clean and no side table has to be kept in step with
 * the pool. A later status (a slow field, a mark) adds a pair of arrays here rather
 * than a second mechanism.
 *
 * `throughArmor` lives here because both halves of continuous damage need it: a burn
 * and a beam pay out per second, and armour is a per-second number, so putting a
 * per-tick charge and the armour on the same time base is the only way either one
 * respects plating. Shot physics imports it rather than duplicating it.
 *
 * The write side is called from a hit (see `systems/projectiles.ts`) and the tick side
 * once per tick from the weapon pass, before the shots that might renew a burn — which
 * is what keeps a body walked over by a second arrow on one burn instead of two.
 *
 * No DOM, no engine, no wall clock (ARCHITECTURE.md's purity gate): this runs headless
 * in the unit tests.
 */

import { ENEMIES } from '../../content/enemies';
import type { DotDef } from '../../content/weapons';
import { DT, type World } from '../world';
import { killEnemy } from './enemies';

/**
 * What one charge takes off a body, after armour.
 *
 * `scale` is the charge's time base: 1 for a single hit, DT for damage that lands
 * once a tick (a beam, a burn). The floor of one damage per second is what stops a
 * weapon from being hard-countered into doing nothing.
 */
export function throughArmor(armor: number, charge: number, scale: number): number {
  const raw = charge - armor * scale;
  return raw > 0 ? raw : scale;
}

/**
 * Leave `j` burning, taking the stronger rate and the longer timer of what is already
 * on it.
 *
 * Renewal, not stacking: a second fire arrow spends a body's one burn channel back to
 * full length instead of doubling the tick, so a weapon that applies DoT twice in a
 * second is not secretly twice as strong as one that lands it once.
 */
export function applyBurn(w: World, j: number, dot: DotDef): void {
  const enemies = w.enemies;
  if (dot.seconds > enemies.dotT[j]) enemies.dotT[j] = dot.seconds;
  if (dot.dps > enemies.dotDps[j]) enemies.dotDps[j] = dot.dps;
}

/**
 * Pay out every burn, once per tick, before the shots that might renew it.
 *
 * One scan of the enemy pool's DoT timer, so a burn costs one comparison per body and
 * no bookkeeping anywhere else: the timer lives in the pool, `alloc` clears it with the
 * rest of a reused slot, and a body that burns down is finished here rather than in a
 * sweep at the end of the tick.
 *
 * No `Hit` events. A dozen bodies burning would write 720 of them a second into a
 * 1024-slot ring, and what a burning body would drop is every other weapon's tracers
 * and impacts — damage that continuous has no presentation channel to ride. A hit that
 * carries a burn is still one event, the hit that lit it.
 */
export function tickBurn(w: World): void {
  const enemies = w.enemies;

  for (let i = 0; i < enemies.cap; i++) {
    if (enemies.alive[i] === 0 || enemies.hp[i] <= 0 || enemies.dotT[i] <= 0) continue;

    enemies.dotT[i] = enemies.dotT[i] > DT ? enemies.dotT[i] - DT : 0;
    const armor = ENEMIES[enemies.kind[i]].armor;
    enemies.hp[i] -= throughArmor(armor, enemies.dotDps[i] * DT, DT);
    if (enemies.hp[i] <= 0) killEnemy(w, i);
  }
}