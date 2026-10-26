/**
 * What every delivery path shares: how far a hit query has to reach, how damage falls off
 * with distance, and the one place a hit lands.
 *
 * `falloff` and `damage` are here rather than copied per path so a sweep and a ray that
 * reach the same body for the same reason report the same number: falloff always keys off
 * the distance the damage travelled, never off the target's distance from the player, and
 * armour, crit, lifesteal, knockback and burn are applied once, in one order, whoever
 * asked for the hit.
 *
 * Split out of `systems/projectiles.ts` with no behaviour change.
 */

import { ENEMIES } from '../../../content/enemies';
import { type WeaponDef } from '../../../content/weapons';
import { Ev, pushEvent, type World } from '../../world';
import { armorAgainst, killEnemy } from '../enemies';
import { lifesteal, rollCrit } from '../powerups';
import { applyBurn, throughArmor } from '../status';

/** Metres of per-tick travel the hit query pads for, beyond the widest body. */
const HIT_SLACK = 0.15;

/** Widest enemy body in content, so one query radius covers every shot. */
let widestRadius = 0;
for (let i = 0; i < ENEMIES.length; i++) {
  if (ENEMIES[i].radius > widestRadius) widestRadius = ENEMIES[i].radius;
}

/**
 * The padding every broad-phase query in this folder uses.
 *
 * One number for all seven paths, and read rather than recomputed, so a new archetype
 * widens every hit test at once instead of quietly tunnelling under the ones written
 * before it existed.
 */
export const HIT_PAD = widestRadius + HIT_SLACK;

/** Ticks a knocked-back enemy rides its shove instead of steering (see `enemies/update.ts`). */
const STAGGER_TICKS = 3;

/** Above this length a direction counts as a real aim vector. */
export const EPS = 1e-6;

/**
 * Damage multiplier at `distance`, from the def's [start, end, mult].
 *
 * Shared by every path: falloff always keys off the distance the damage
 * travelled, never off the target's distance from the player, so a sweep and a ray
 * that reach the same body for the same reason report the same number.
 */
export function falloff(def: WeaponDef, distance: number): number {
  const start = def.falloff[0];
  const end = def.falloff[1];
  const mult = def.falloff[2];
  if (distance <= start) return 1;
  if (distance >= end) return mult;
  return 1 + (mult - 1) * ((distance - start) / (end - start));
}

/**
 * Land one hit on enemy `j`.
 *
 * Armour subtracts after falloff and the power-up multiplier, and `armorPen`
 * cancels part of it — the sniper's reason to exist. A hit that does not clear the
 * armour still takes 1 HP, so a weapon is never hard-countered into doing nothing.
 * Armour is read through `armorAgainst`, so it is the plate the body presents to *this*
 * direction rather than a flat number: the same shot into an armored's flank pays nothing.
 * The shove is applied in the direction the damage travelled and staggers the body
 * for STAGGER_TICKS, which is what makes knockback a positioning tool rather than
 * only a number.
 *
 * Every hit writes one `Hit` event, continuous delivery included: the event names the
 * body and the place, which is what a hit flash, an impact burst and a damage number
 * are drawn from, and the tests read it as the record of who was hurt. A burn is
 * deliberately not an event (see `tickBurn` in `systems/status.ts`), so the ring
 * carries the hits and not the ticking.
 *
 * A hit that carries a `dot` leaves the body burning through `applyBurn`: one channel
 * per body, so a second arrow renews the burn instead of doubling the tick.
 *
 * `slot` is the projectile that landed it, or -1 for a ray, a sweep, a bolt or a
 * burst, which has no entity to name.
 */
export function damage(
  w: World,
  def: WeaponDef,
  j: number,
  dmg: number,
  dirx: number,
  diry: number,
  slot: number,
  scale: number,
): void {
  const enemies = w.enemies;
  const pen = def.armorPen || 0;
  // Directional, and `dirx`/`diry` are what make it directional: a body shot while it is
  // walking at you pays its plate and the same body shot from the side or the back does
  // not, which is the whole answer to the armored (see `armorAgainst`). Every path here
  // knows the direction its damage travelled, so one call covers all seven.
  const armor = armorAgainst(w, j, dirx, diry) * (1 - pen);

  // Crit is one rng draw folded onto the raw damage and lifesteal mends off what the hit
  // actually took off the body. Both read neutral (crit 1, lifesteal 0) unless a run owns
  // the card, and at neutral neither draws a number nor writes the player — so a run with
  // no Weak Spot or Life Tap keeps the exact seeded streams it had before either existed.
  const crit = rollCrit(w);
  const dealt = throughArmor(armor, dmg * crit * scale, scale);
  enemies.hp[j] -= dealt;
  lifesteal(w, dealt);

  // `a` is the projectile slot, `b` the enemy slot: enough for a tracer, an impact
  // burst and a damage number without a per-hit object. Pushed before the kill so a
  // fatal hit still owns its impact.
  pushEvent(w, Ev.Hit, slot, j, enemies.x[j], enemies.y[j]);
  // The number wants the HP the armour actually let through, and nothing under 1: a
  // "0" floating over a body is not information, it is the noise DESIGN.md's merging
  // rule exists to keep out.
  if (dealt >= 1) pushEvent(w, Ev.Damage, Math.round(dealt), crit > 1 ? 1 : 0, enemies.x[j], enemies.y[j]);

  if (enemies.hp[j] <= 0) {
    killEnemy(w, j);
    return;
  }

  // A boss never rides a shove. Knockback is a positioning tool against the horde — three
  // ticks of not-steering is what spoils a charger's line — but the same number applied to
  // a 520 HP body makes the answer to every boss "hit it and walk it into a wall", which
  // is a better answer than any of its telegraphs and teaches nothing the fight was for.
  if (def.knockback > 0 && !ENEMIES[enemies.kind[j]].boss) {
    enemies.vx[j] = dirx * def.knockback;
    enemies.vy[j] = diry * def.knockback;
    enemies.state[j] = STAGGER_TICKS;
  }

  const dot = def.dot;
  if (dot) applyBurn(w, j, dot);
}