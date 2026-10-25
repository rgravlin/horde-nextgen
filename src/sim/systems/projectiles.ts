/**
 * Shot physics: everything that resolves damage after the trigger decision.
 *
 * Three delivery paths live here, one per fire kind that needs one:
 *
 * - `projectile` — a round flies and is tested as the segment it swept this tick,
 *   because a 55 m/s round covers 0.92 m per tick, further than an enemy's radius,
 *   so a point test would tunnel straight through the front rank.
 * - `hitscan` — a ray resolved the tick the trigger went down, marched through the
 *   tick's spatial hash and stopped once its pierce budget was spent.
 * - `melee` — an arc sweep around the player.
 * - `arc` — a shell that flies the full length it was lobbed and bursts there.
 *
 * Nothing here allocates: candidates come out of the tick's shared `world.query`
 * buffer, the ray's march is a loop over probe windows rather than a list, and the
 * only events are the fixed-shape ones the renderer and audio read later.
 */

import { ENEMIES } from '../../content/enemies';
import { WEAPONS, type WeaponDef } from '../../content/weapons';
import { queryRadius } from '../spatialHash';
import { DT, Ev, TUNE, pushEvent, release, type World } from '../world';
import { killEnemy } from './enemies';

/** Metres of per-tick travel the hit query pads for, beyond the widest body. */
const HIT_SLACK = 0.15;

/** Widest enemy body in content, so one query radius covers every shot. */
let widestRadius = 0;
for (let i = 0; i < ENEMIES.length; i++) {
  if (ENEMIES[i].radius > widestRadius) widestRadius = ENEMIES[i].radius;
}
const HIT_PAD = widestRadius + HIT_SLACK;

/** Ticks a knocked-back enemy rides its shove instead of steering (see enemies.ts). */
const STAGGER_TICKS = 3;

/** Length of one probe window in metres, for the ray's march. */
const PROBE_STEP = 2;

/** Above this length a direction counts as a real aim vector. */
const EPS = 1e-6;

/**
 * Damage multiplier at `distance`, from the def's [start, end, mult].
 *
 * Shared by all four paths: falloff always keys off the distance the damage
 * travelled, never off the target's distance from the player, so a sweep and a ray
 * that reach the same body for the same reason report the same number.
 */
function falloff(def: WeaponDef, distance: number): number {
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
 * The shove is applied in the direction the damage travelled and staggers the body
 * for STAGGER_TICKS, which is what makes knockback a positioning tool rather than
 * only a number.
 *
 * `slot` is the projectile that landed it, or -1 for a ray or a sweep, which has no
 * entity to name.
 */
function damage(
  w: World,
  def: WeaponDef,
  j: number,
  dmg: number,
  dirx: number,
  diry: number,
  slot: number,
): void {
  const enemies = w.enemies;
  const enemy = ENEMIES[enemies.kind[j]];
  const pen = def.armorPen || 0;
  const armor = enemy.armor * (1 - pen);

  const dealt = dmg > armor ? dmg - armor : 1;
  enemies.hp[j] -= dealt;

  if (def.knockback > 0 && enemies.hp[j] > 0) {
    enemies.vx[j] = dirx * def.knockback;
    enemies.vy[j] = diry * def.knockback;
    enemies.state[j] = STAGGER_TICKS;
  }

  // `a` is the projectile slot, `b` the enemy slot: enough for a tracer, an impact
  // burst and a damage number without a per-hit object.
  pushEvent(w, Ev.Hit, slot, j, enemies.x[j], enemies.y[j]);
  if (enemies.hp[j] <= 0) killEnemy(w, j);
}

/**
 * March a ray through the hash and let it hit.
 *
 * The ray advances in probe windows and queries the hash around each window centre
 * for everything that could possibly be touched inside it, then tests exactly: a
 * body counts only if the ray's *first entry point* into its disc falls inside the
 * window being examined. Ownership by entry point is what makes the march both
 * complete and single-counting — a body straddling a window edge is owned by the
 * window it entered, so the neighbouring window's overlapping query cannot spend a
 * second pierce on it — and the query radius is padded past the window's own length
 * plus the widest body so a body owned by a window is always inside that window's
 * query.
 *
 * Bodies wholly behind the ray's start are ignored (that is not what the gun was
 * pointed at), and the march stops the moment the pierce budget is gone, which is
 * the "no more" half of a piercing shot.
 */
export function castRay(
  w: World,
  def: WeaponDef,
  ox: number,
  oy: number,
  dirx: number,
  diry: number,
): void {
  const enemies = w.enemies;
  const query = w.query;
  const reach = PROBE_STEP * 0.5 + HIT_PAD + 0.5;
  const base = def.dmg * w.stats.dmg;
  let budget = def.pierce + 1;

  for (let travelled = PROBE_STEP * 0.5; travelled < def.range && budget > 0; travelled += PROBE_STEP) {
    const win = Math.floor(travelled / PROBE_STEP);
    const found = queryRadius(
      w.hash,
      enemies.x,
      enemies.y,
      enemies.alive,
      ox + dirx * travelled,
      oy + diry * travelled,
      reach,
      query,
    );

    for (let k = 0; k < found && budget > 0; k++) {
      const j = query[k];
      if (enemies.hp[j] <= 0) continue;

      const enemy = ENEMIES[enemies.kind[j]];
      const hitR = TUNE.shotRadius + enemy.radius;

      const ex = enemies.x[j] - ox;
      const ey = enemies.y[j] - oy;
      const along = ex * dirx + ey * diry;
      if (along <= 0) continue;

      const d2 = ex * ex + ey * ey;
      // disc is the squared half-chord the ray cuts through the body's disc: no
      // chord, no hit. Written without a square root because that is the common case.
      const disc = hitR * hitR - (d2 - along * along);
      if (!(disc > 0)) continue;

      const raw = along - Math.sqrt(disc);
      const entry = raw > 0 ? raw : 0;
      if (entry > def.range) continue;
      if (Math.floor(entry / PROBE_STEP) !== win) continue;

      damage(w, def, j, base * falloff(def, entry), dirx, diry, -1);
      budget--;
    }
  }
}

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
      damage(w, def, j, base * falloff(def, d), dx / d, dy / d, -1);
    } else {
      damage(w, def, j, base, ax, ay, -1);
    }
    budget--;
  }
}

/**
 * Burst a lobbed shell at (x, y).
 *
 * Everything whose body overlaps the burst circle is hurt for full damage — no
 * falloff, because the radius is already the whole point of the weapon — and shoved
 * outward from the centre, which is what clears a lane rather than only thinning it.
 * The `Explosion` event carries the burst radius times ten in `b` so a ring can be
 * drawn from the event alone (ARCHITECTURE.md: presentation is driven by events).
 */
function burst(w: World, def: WeaponDef, weapon: number, x: number, y: number, fx: number, fy: number): void {
  const r = def.aoe || 0;
  if (r <= 0) return;

  const enemies = w.enemies;
  const query = w.query;
  const base = def.dmg * w.stats.dmg;
  const found = queryRadius(w.hash, enemies.x, enemies.y, enemies.alive, x, y, r + HIT_PAD, query);

  for (let k = 0; k < found; k++) {
    const j = query[k];
    if (enemies.hp[j] <= 0) continue;

    const enemy = ENEMIES[enemies.kind[j]];
    const dx = enemies.x[j] - x;
    const dy = enemies.y[j] - y;
    const d2 = dx * dx + dy * dy;
    const reach = r + enemy.radius;
    if (d2 > reach * reach) continue;

    const d = Math.sqrt(d2);
    if (d > EPS) damage(w, def, j, base, dx / d, dy / d, -1);
    else damage(w, def, j, base, fx, fy, -1);
  }

  pushEvent(w, Ev.Explosion, weapon, Math.round(r * 10), x, y);
}

/**
 * Move every live shot and let it hit, once per tick.
 *
 * A round's own velocity is what the sweep length and the falloff distance come off,
 * not the def's speed, so a half-drawn arrow flies its own flatter line.
 *
 * Two rules keep the segment test honest: a body entirely behind the segment start
 * is ignored, and a body already inside the round's disc when the segment began is
 * ignored too, because it was hit the tick before — without that, one round would
 * spend its whole pierce on the first body it lingered inside. A shot's first tick
 * is exempt from the second rule, which is what lets a chaser pressed against the
 * muzzle still be reached.
 *
 * An `arc` shell does none of this while it flies: it carries no hit budget and
 * detonates at the end of its flight, so a shot can be walked under on purpose.
 */
export function updateProjectiles(w: World): void {
  const shots = w.shots;
  const enemies = w.enemies;
  const query = w.query;

  for (let i = 0; i < shots.cap; i++) {
    if (shots.alive[i] === 0) continue;

    const def = WEAPONS[shots.kind[i]];
    if (!def) {
      release(shots, i);
      continue;
    }

    const vx = shots.vx[i];
    const vy = shots.vy[i];
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (!(speed > EPS)) {
      release(shots, i);
      continue;
    }

    const dirx = vx / speed;
    const diry = vy / speed;
    const sweep = speed * DT;

    const x0 = shots.x[i];
    const y0 = shots.y[i];
    const x1 = x0 + vx * DT;
    const y1 = y0 + vy * DT;

    const fresh = shots.age[i] === 0;
    shots.age[i] += DT;
    shots.life[i] -= DT;

    if (def.fire === 'arc') {
      if (shots.life[i] <= 0) {
        burst(w, def, shots.kind[i], x1, y1, dirx, diry);
        release(shots, i);
      } else {
        shots.x[i] = x1;
        shots.y[i] = y1;
      }
      continue;
    }

    const bulletR = TUNE.shotRadius;
    let hits = shots.state[i];
    const dmg = shots.hp[i] * falloff(def, speed * shots.age[i]) * w.stats.dmg;

    // Broad phase: the capsule the shot swept, padded for the widest body and for
    // how far an enemy can move between the grid being built and this test.
    const found = queryRadius(
      w.hash,
      enemies.x,
      enemies.y,
      enemies.alive,
      (x0 + x1) * 0.5,
      (y0 + y1) * 0.5,
      sweep * 0.5 + HIT_PAD,
      query,
    );

    for (let k = 0; k < found && hits > 0; k++) {
      const j = query[k];
      if (enemies.hp[j] <= 0) continue;

      const enemy = ENEMIES[enemies.kind[j]];
      const hitR = bulletR + enemy.radius;
      const hitR2 = hitR * hitR;

      const sx = enemies.x[j] - x0;
      const sy = enemies.y[j] - y0;
      const start2 = sx * sx + sy * sy;
      if (!fresh && start2 <= hitR2) continue;

      const along = sx * dirx + sy * diry;
      if (along <= 0) continue;
      const t = along < sweep ? along : sweep;
      const ox = enemies.x[j] - (x0 + dirx * t);
      const oy = enemies.y[j] - (y0 + diry * t);
      if (ox * ox + oy * oy > hitR2) continue;

      damage(w, def, j, dmg, dirx, diry, i);
      hits--;
    }

    shots.state[i] = hits;
    if (hits <= 0 || shots.life[i] <= 0) {
      release(shots, i);
    } else {
      shots.x[i] = x1;
      shots.y[i] = y1;
    }
  }
}