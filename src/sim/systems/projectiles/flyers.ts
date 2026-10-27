/**
 * The rounds that spend ticks in the air: the flying bullet, the lobbed shell and the
 * singularity, plus the two things an `orb` does on the way — drag and detonate.
 *
 * `updateProjectiles` is the pass; `steer`, `drag` and `burst` are the three things a
 * round can do while it is in there. They are separate because each answers a different
 * question the flight asks: which way is it going (steer), what does it pull (drag), what
 * happens when it stops (burst).
 *
 * Nothing here allocates: candidates come out of the tick's shared `world.query` buffer
 * and the only events are the fixed-shape ones the renderer and audio read later.
 *
 * Split out of `systems/projectiles.ts` with no behaviour change.
 */

import { ENEMIES } from '../../../content/enemies';
import { WEAPONS, type WeaponDef } from '../../../content/weapons';
import { DT, Ev, TUNE, pushEvent, release, type World } from '../../world';
import { queryRadius } from '../../spatialHash';
import { canTravel } from '../obstacles';
import { EPS, HIT_PAD, damage, falloff } from './shared';

/**
 * Metres a hunting shot looks around itself for something to follow.
 *
 * Sized against the one thing that reads it: the disruptor's turn radius is its speed
 * over its turn rate, 7.5 m, so a seek band narrower than that would only let a shot
 * bend once it had already flown past whatever it was meant to be bending toward.
 */
const SEEK_RADIUS = 12;

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
  const found = queryRadius(w.hash, enemies.x, enemies.y, w.hash.findable, x, y, r + HIT_PAD, query);

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
  const found = queryRadius(w.hash, enemies.x, enemies.y, w.hash.findable, x, y, r + HIT_PAD, w.query);
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
    // And the same cover test, which the clamp above cannot stand in for: this is the one
    // body write in the sim that displaces by position rather than by velocity, so it is
    // the only way a body gets *inside* cover during play. A pull that would land a body
    // in a wall is skipped rather than partly applied, since a part of it still ends with
    // the body sealed in the wall, unable to steer or be shot.
    if (!canTravel(w.props, enemies.x[j], enemies.y[j], nx - enemies.x[j], ny - enemies.y[j], radius)) {
      continue;
    }
    enemies.x[j] = Math.min(Math.max(nx, w.minX + radius), w.maxX - radius);
    enemies.y[j] = Math.min(Math.max(ny, w.minY + radius), w.maxY - radius);
  }
}

/**
 * Turn a hunting shot toward the nearest body it can see, by at most `maxTurn`.
 *
 * A turn, not a lock-on: the rate comes from the def, so the shot keeps its speed and
 * can still be walked out of — it bends the line the aim gave it rather than replacing
 * the aim. What it bends toward is the closest live body inside `SEEK_RADIUS` of where
 * the shot stands, read out of the tick's hash and the shared query buffer, which the
 * hit test below then refills: one buffer per tick, and this is done with it before
 * anything else looks at it.
 *
 * A body at 0 HP is skipped, so a bolt does not spend its curve on a corpse, and a
 * shot with nothing near it flies straight, which is why a hunting weapon with no
 * crowd in front of it still misses the way a non-hunting one does.
 */
function steer(w: World, i: number, maxTurn: number): void {
  const shots = w.shots;
  const enemies = w.enemies;

  const x = shots.x[i];
  const y = shots.y[i];
  const found = queryRadius(
    w.hash,
    enemies.x,
    enemies.y,
    w.hash.findable,
    x,
    y,
    SEEK_RADIUS,
    w.query,
  );

  let best = -1;
  let best2 = Infinity;
  for (let k = 0; k < found; k++) {
    const j = w.query[k];
    if (enemies.hp[j] <= 0) continue;

    const dx = enemies.x[j] - x;
    const dy = enemies.y[j] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= best2) continue;
    best2 = d2;
    best = j;
  }
  if (best < 0 || !(best2 > EPS)) return;

  const vx = shots.vx[i];
  const vy = shots.vy[i];
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (!(speed > EPS)) return;

  // Both pairs are unit-length by construction, so `atan2` of their cross and dot is
  // the signed angle between them: one call, and the sign carries which way to turn.
  const reach = Math.sqrt(best2);
  const tx = (enemies.x[best] - x) / reach;
  const ty = (enemies.y[best] - y) / reach;
  const hx = vx / speed;
  const hy = vy / speed;
  let turn = Math.atan2(hx * ty - hy * tx, hx * tx + hy * ty);
  if (turn > maxTurn) turn = maxTurn;
  else if (turn < -maxTurn) turn = -maxTurn;

  // Rotating the velocity, not rewriting it toward the target, is what keeps the
  // speed a charged or half-drawn shot left the muzzle with, and keeps the turn a
  // rate rather than a snap.
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  shots.vx[i] = vx * c - vy * s;
  shots.vy[i] = vx * s + vy * c;
}

/**
 * Move every live shot and let it hit, once per tick.
 *
 * A round's own velocity is what the sweep length and the falloff distance come off,
 * not the def's speed, so a half-drawn arrow flies its own flatter line. A round whose
 * def declares `homing` gets that velocity steered first, so the segment tested below
 * is the segment it actually swept.
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

    if (def.homing !== undefined && def.homing > 0) steer(w, i, def.homing * DT);

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

    // Cover retires a round. The test is the swept segment at the round's own radius, so
    // a railgun's 3.3 m step cannot cross a 1.2 m wall in one tick, and it is the same
    // helper a body's travel uses, which is what makes "that crate stops both sides" one
    // fact in this game rather than two that have to be kept in step. A round that began
    // the tick already inside cover — a muzzle pressed against a crate — is let fly: a
    // gun that went silent against the cover the player is supposed to hide behind is a
    // worse bug than a shot that grazes its way out.
    if (!canTravel(w.props, x0, y0, x1 - x0, y1 - y0, TUNE.shotRadius)) {
      if (def.fire === 'arc' || def.fire === 'orb') burst(w, def, shots.kind[i], x0, y0, dirx, diry);
      release(shots, i);
      continue;
    }

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
      w.hash.findable,
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
