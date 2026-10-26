/**
 * The melee path: one arc sweep around the player.
 *
 * It is a path rather than a shortcut over the sweep helper because reach has to be
 * measured to the target's body edge and the shove has to be radial, which is what makes
 * a flail reach and feel the way it looks. A `melee` weapon spends no projectile slot:
 * the swing is resolved the tick the trigger goes down, like the ray.
 *
 * Split out of `systems/projectiles.ts` with no behaviour change.
 */

import { ENEMIES } from '../../../content/enemies';
import { type WeaponDef } from '../../../content/weapons';
import type { World } from '../../world';
import { queryRadius } from '../../spatialHash';
import { EPS, HIT_PAD, damage, falloff } from './shared';

/**
 * Sweep an arc around the player, from `def.spread` either side of `ax, ay`.
 *
 * Reach is measured to the target's body edge, so a 3.4 m flail actually reaches a
 * body whose centre is 3.85 m out, which is what makes the reach read the way it
 * looks. Anything outside the arc is untouched even when it is touching the player,
 * which is the whole cost of a 300° swing being the best close-range answer.
 *
 * The shove is radial — away from the player rather than along the aim — because a
 * sweep pushes the ring outward, and that is the feel the weapon is for.
 */
export function sweepMelee(
  w: World,
  def: WeaponDef,
  px: number,
  py: number,
  ax: number,
  ay: number,
): void {
  const enemies = w.enemies;
  const query = w.query;
  const base = def.dmg * w.stats.dmg;
  const cosHalf = Math.cos(def.spread);
  let budget = def.pierce + 1;

  const found = queryRadius(
    w.hash,
    enemies.x,
    enemies.y,
    enemies.alive,
    px,
    py,
    def.range + HIT_PAD,
    query,
  );

  for (let k = 0; k < found && budget > 0; k++) {
    const j = query[k];
    if (enemies.hp[j] <= 0) continue;

    const enemy = ENEMIES[enemies.kind[j]];
    const dx = enemies.x[j] - px;
    const dy = enemies.y[j] - py;
    const d2 = dx * dx + dy * dy;

    const reach = def.range + enemy.radius;
    if (d2 > reach * reach) continue;

    // A body centred on the player has no radial direction to be shoved along, so
    // it takes the shove along the aim instead.
    const d = d2 > EPS ? Math.sqrt(d2) : 0;
    if (d > 0) {
      // Both vectors are unit-length by construction, so the dot product is the
      // cosine of the angle between them and one comparison settles the arc test.
      if ((dx * ax + dy * ay) / d < cosHalf) continue;
      damage(w, def, j, base * falloff(def, d), dx / d, dy / d, -1, 1);
    } else {
      damage(w, def, j, base, ax, ay, -1, 1);
    }
    budget--;
  }
}
