/**
 * Shot physics: everything that resolves damage after the trigger decision.
 *
 * Seven delivery paths live here, one per fire kind:
 *
 * - `projectile` — a round flies and is tested as the segment it swept this tick,
 *   because a 55 m/s round covers 0.92 m per tick, further than an enemy's radius,
 *   so a point test would tunnel straight through the front rank.
 * - `hitscan` — a ray resolved the tick the trigger went down, marched through the
 *   tick's spatial hash and stopped once its pierce budget was spent.
 * - `melee` — an arc sweep around the player.
 * - `arc` — a shell that flies the full length it was lobbed and bursts there.
 * - `beam` — the same march, every tick the trigger is held, for as long as the
 *   barrel has heat left. Damage is measured per second, so it goes through
 *   `throughArmor` on the tick's time base (see `systems/status.ts`), and it reports
 *   one `Hit` per body per tick like every other path: a continuous weapon that
 *   cannot light a hit flash has no presentation channel at all.
 * - `chain` — a bolt that takes the nearest body and then jumps to the next nearest
 *   body it has not already hurt, up to the def's jump count.
 * - `orb` — a singularity that drags bodies inside its radius toward itself for its
 *   whole flight and detonates inside the same circle.
 *
 * Nothing here allocates: candidates come out of the tick's shared `world.query`
 * buffer, the ray's march is a loop over probe windows rather than a list, the chain
 * remembers its own hit list in one module-scratch array, and the only events are the
 * fixed-shape ones the renderer and audio read later.
 */

import { ENEMIES } from '../../content/enemies';
import { WEAPONS, type WeaponDef } from '../../content/weapons';
import { queryRadius } from '../spatialHash';
import { DT, Ev, TUNE, pushEvent, release, type World } from '../world';
import { killEnemy } from './enemies';
import { applyBurn, throughArmor } from './status';

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
 * The bodies one chain bolt has already spent a jump on, reset by the bolt that uses
 * it. Longest chain in content is five jumps plus the first body, and the bolt stops
 * at the end of this array if content ever asks for more.
 */
const chainHits = new Int32Array(16);

/**
 * Damage multiplier at `distance`, from the def's [start, end, mult].
 *
 * Shared by every path: falloff always keys off the distance the damage
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
function damage(
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
  const enemy = ENEMIES[enemies.kind[j]];
  const pen = def.armorPen || 0;
  const armor = enemy.armor * (1 - pen);

  enemies.hp[j] -= throughArmor(armor, dmg * scale, scale);

  // `a` is the projectile slot, `b` the enemy slot: enough for a tracer, an impact
  // burst and a damage number without a per-hit object. Pushed before the kill so a
  // fatal hit still owns its impact.
  pushEvent(w, Ev.Hit, slot, j, enemies.x[j], enemies.y[j]);

  if (enemies.hp[j] <= 0) {
    killEnemy(w, j);
    return;
  }

  if (def.knockback > 0) {
    enemies.vx[j] = dirx * def.knockback;
    enemies.vy[j] = diry * def.knockback;
    enemies.state[j] = STAGGER_TICKS;
  }

  const dot = def.dot;
  if (dot) applyBurn(w, j, dot);
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
 *
 * `scale` is the time base of the charge (see `throughArmor` in `systems/status.ts`):
 * 1 for one instant ray, DT for a beam running this same march again every tick, where
 * `def.dmg` is damage per second. Both report their hits; only the burn stays quiet.
 */
function march(
  w: World,
  def: WeaponDef,
  ox: number,
  oy: number,
  dirx: number,
  diry: number,
  scale: number,
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

      damage(w, def, j, base * falloff(def, entry), dirx, diry, -1, scale);
      budget--;
    }
  }
}

/** One instant ray: the sniper's shot, resolved the tick the trigger went down. */
export function castRay(
  w: World,
  def: WeaponDef,
  ox: number,
  oy: number,
  dirx: number,
  diry: number,
): void {
  march(w, def, ox, oy, dirx, diry, 1);
}

/**
 * One tick of a beam: the same march, on the tick's time base.
 *
 * Called again every tick the trigger is held, which is what "continuous" means
 * here: the pierce budget renews each tick, so a beam cuts through its four bodies
 * sixty times a second until the barrel vents. It writes a `Hit` for each body each
 * tick — 240 events a second at the very most, four a frame, which is what the ring
 * is for — because a hit flash and a damage number have nothing else to read.
 */
export function castBeam(
  w: World,
  def: WeaponDef,
  ox: number,
  oy: number,
  dirx: number,
  diry: number,
): void {
  march(w, def, ox, oy, dirx, diry, DT);
}

/**
 * One chain bolt: take a body, then jump.
 *
 * The bolt starts at the muzzle and needs a body to start with — a bolt that finds
 * nobody is not fired and spends nothing — and then walks to the closest body it has
 * not already hurt within `chainRadius` of where it stands, up to `chain` jumps. Bodies
 * at 0 HP are skipped, so a bolt cannot spend a jump on a corpse, and the list of
 * bodies it has used lives in one module-scratch array rather than in a set it would
 * have to allocate per shot.
 *
 * A jump starts from the *body's* position even when the previous link died, because
 * arcing through a corpse is what the weapon looks like doing. Distance — and so the
 * falloff — is measured along the bolt's path, not as the crow flies, so a bolt that
 * zigzags through a pack pays for it.
 *
 * Returns the number of bodies it hurt, which is 0 when there was nothing to hit.
 */
export function castChain(w: World, def: WeaponDef, x: number, y: number): number {
  const enemies = w.enemies;
  const query = w.query;
  const jump = def.chainRadius || 0;
  const budget = (def.chain || 0) + 1;
  const base = def.dmg * w.stats.dmg;
  if (jump <= 0) return 0;

  let cx = x;
  let cy = y;
  let travelled = 0;
  let links = 0;

  for (let hop = 0; hop < budget && links < chainHits.length; hop++) {
    // The first hop reaches the whole acquisition radius from the muzzle; after that
    // the bolt only has to find a body within one jump of the last one.
    const r = hop === 0 ? def.range : jump;
    const found = queryRadius(w.hash, enemies.x, enemies.y, enemies.alive, cx, cy, r, query);

    let next = -1;
    let best2 = Infinity;
    for (let k = 0; k < found; k++) {
      const j = query[k];
      if (enemies.hp[j] <= 0) continue;

      let used = false;
      for (let u = 0; u < links; u++) {
        if (chainHits[u] === j) {
          used = true;
          break;
        }
      }
      if (used) continue;

      const jx = enemies.x[j] - cx;
      const jy = enemies.y[j] - cy;
      const d2 = jx * jx + jy * jy;
      if (d2 >= best2) continue;
      best2 = d2;
      next = j;
    }
    if (next < 0) break;

    const dx = enemies.x[next] - cx;
    const dy = enemies.y[next] - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    travelled += d;
    // A jump of no length (two bodies on one point) has no direction to shove along,
    // so it takes the +x pair, as a sweep on a body dead centre does.
    let shx = 1;
    let shy = 0;
    if (d > EPS) {
      shx = dx / d;
      shy = dy / d;
    }
    damage(w, def, next, base * falloff(def, travelled), shx, shy, -1, 1);

    chainHits[links++] = next;
    cx = enemies.x[next];
    cy = enemies.y[next];
  }

  return links;
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
      damage(w, def, j, base * falloff(def, d), dx / d, dy / d, -1, 1);
    } else {
      damage(w, def, j, base, ax, ay, -1, 1);
    }
    budget--;
  }
}

/**
 * Burst whatever is at (x, y) — a lobbed shell, or a singularity at the end of its
 * drift.
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
    if (d > EPS) damage(w, def, j, base, dx / d, dy / d, -1, 1);
    else damage(w, def, j, base, fx, fy, -1, 1);
  }

  pushEvent(w, Ev.Explosion, weapon, Math.round(r * 10), x, y);
}

/**
 * Drag everything inside the orb's radius toward it.
 *
 * A displacement rather than a velocity, deliberately: the enemy pass has already run
 * by the time a shot resolves, so a shove written into `vx`/`vy` would be overwritten
 * by the next tick's steering and the vacuum would move nothing. Displacing instead
 * keeps the drag small — 7 m/s is 0.117 m a tick, inside the padding the hit queries
 * allow for a body having moved since the grid was built — and reads the way it looks,
 * a funnel of bodies pulled off their line.
 *
 * A body is never dragged past the middle, so nothing oscillates around the orb.
 */
function drag(w: World, def: WeaponDef, x: number, y: number): void {
  const r = def.aoe || 0;
  const speed = def.pull || 0;
  if (r <= 0 || speed <= 0) return;

  const enemies = w.enemies;
  const found = queryRadius(w.hash, enemies.x, enemies.y, enemies.alive, x, y, r + HIT_PAD, w.query);
  const step = speed * DT;

  for (let k = 0; k < found; k++) {
    const j = w.query[k];
    if (enemies.hp[j] <= 0) continue;

    const dx = enemies.x[j] - x;
    const dy = enemies.y[j] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r * r || d2 <= EPS) continue;

    const d = Math.sqrt(d2);
    const pull = step < d ? step : d;
    const nx = enemies.x[j] - (dx / d) * pull;
    const ny = enemies.y[j] - (dy / d) * pull;

    // Same arena clamp the enemy pass uses, so a vacuum cannot fling a body through a
    // wall — the orb's radius reaches 3.2 m and the arena edge is only 0.4 m away.
    const radius = ENEMIES[enemies.kind[j]].radius;
    enemies.x[j] = Math.min(Math.max(nx, w.minX + radius), w.maxX - radius);
    enemies.y[j] = Math.min(Math.max(ny, w.minY + radius), w.maxY - radius);
  }
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
 * detonates at the end of its flight, so a shot can be walked under on purpose. An
 * `orb` is the same shape of flight plus one thing — it drags on the way — and it too
 * resolves only at the end, which is why it is a weapon for where a crowd is going.
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

    if (def.fire === 'arc' || def.fire === 'orb') {
      if (shots.life[i] <= 0) {
        burst(w, def, shots.kind[i], x1, y1, dirx, diry);
        release(shots, i);
      } else {
        if (def.fire === 'orb') drag(w, def, x1, y1);
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

      damage(w, def, j, dmg, dirx, diry, i, 1);
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