/**
 * The defensive half: how much of a hit a body has to swallow, and what happens when one
 * gets close enough to touch the player.
 *
 * `hurtPlayer` — the one i-frame gate — lives in `systems/enemyProjectiles.ts`, so a hug,
 * a bolt and a lob all pay the same rule; this file only decides when a hug happens and how
 * much it costs.
 */

import { ENEMIES, type EnemyDef } from '../../../content/enemies';
import { Ev, TUNE, pushEvent, type World } from '../../world';
import { queryRadius } from '../../spatialHash';
import { hurtPlayer } from '../enemyProjectiles';
import { killEnemy } from './deaths';

/**
 * The armour one hit has to get through, given the direction it travelled.
 *
 * Directional only for a body that declares `armorArc` and `armorSide`. A body that
 * declares neither reads as "no arc, full plate all round" — the two defaults fold back to
 * the flat number, which is every archetype except the armored, and is why the reads below
 * use `??` instead of an existence test: `params` is a record of numbers, so a missing key
 * is a number-shaped hole and the neutral value has to be named.
 *
 * Inside the arc — a hit arriving from within `armorArc`'s cosine of the body's front — it
 * pays its full plate; anywhere else it pays `armorSide` of it, which the armored sets to
 * nothing.
 *
 * `dirx`/`diry` point *along* the damage, from its source toward the body, so a hit that
 * came from the front runs against the facing and the dot product goes negative. That is why
 * the plate test is one comparison and not an angle.
 */
export function armorAgainst(w: World, j: number, dirx: number, diry: number): number {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[j]];
  if (def.armor <= 0) return 0;

  const arc = def.params.armorArc ?? 0;
  const side = def.params.armorSide ?? 1;
  if (arc <= 0 || side >= 1) return def.armor;

  const fx = enemies.fx[j];
  const fy = enemies.fy[j];
  if (fx === 0 && fy === 0) return def.armor;

  return dirx * fx + diry * fy < -arc ? def.armor : def.armor * side;
}

/** Metres a Hot Plate pulse reaches around the player. */
const THORNS_REACH = 2.4;

/**
 * Contact damage, gated by i-frames, and the Hot Plate's answer to it.
 *
 * The pulse is gated on the same i-frame window as the hug rather than on the body that
 * triggered it: a crowd that piles in costs one thorns pulse, not one per body, because
 * the gate at the top returns for everyone after the first touch. `d2` is the squared
 * distance from before either of them moved.
 */
export function contact(w: World, def: EnemyDef, d2: number): void {
  const player = w.player;
  if (!player.alive || player.iframes > 0) return;

  const reach = TUNE.playerRadius + def.radius + def.params.touchRange;
  if (d2 > reach * reach) return;

  // The hug goes through the one player-damage gate, so armour, the barrier and a
  // curse's fragility read the same for a body's touch as for a bolt's.
  hurtPlayer(w, def.params.touchDamage, 3);

  const thorns = w.stats.thorns;
  if (thorns > 0) thornsPulse(w, thorns);
}

/**
 * Hot Plate: every body inside a short ring around the player pays when the player is
 * hit — the explosion a thorns power-up is meant to read as. It goes through armour and
 * finishes bodies with `killEnemy`, so a pulse spent in a crowd actually thins it rather
 * than only bruising it.
 *
 * It spends the tick's query buffer, which is free here: contact runs after the body's
 * own steering has finished querying it, and the next body refills the buffer before it
 * reads anything.
 */
function thornsPulse(w: World, thorns: number): void {
  const enemies = w.enemies;
  const found = queryRadius(
    w.hash,
    enemies.x,
    enemies.y,
    w.hash.findable,
    w.player.x,
    w.player.y,
    THORNS_REACH,
    w.query,
  );

  for (let k = 0; k < found; k++) {
    const j = w.query[k];
    if (enemies.hp[j] <= 0) continue;

    const def = ENEMIES[enemies.kind[j]];
    let dealt = thorns - def.armor;
    if (dealt < 1) dealt = 1;
    enemies.hp[j] -= dealt;
    pushEvent(w, Ev.Hit, -1, j, enemies.x[j], enemies.y[j]);
    pushEvent(w, Ev.Damage, Math.round(dealt), 0, enemies.x[j], enemies.y[j]);
    if (enemies.hp[j] <= 0) killEnemy(w, j);
  }
}