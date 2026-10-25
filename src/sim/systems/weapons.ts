/**
 * Weapons and their projectiles.
 *
 * One pass owns the whole firing loop: hand swap, cooldown, magazine and reload,
 * the fire decision, then every live shot's movement and its hits. Shots are
 * tested as the segment they swept this tick rather than as a point, because a
 * 55 m/s round covers 0.92 m per tick — further than an enemy's radius — so a
 * point test would tunnel straight through the front rank. The same "ahead of the
 * segment start only" rule is what stops a piercing shot re-hitting what it has
 * already passed through.
 *
 * Nothing here allocates: shots come out of the projectile pool, spread comes
 * from world.rng, and the broad phase is the tick's spatial hash.
 */

import { ENEMIES } from '../../content/enemies';
import { WEAPONS, type WeaponDef } from '../../content/weapons';
import type { InputFrame } from '../input';
import { range } from '../rng';
import { queryRadius } from '../spatialHash';
import { DT, Ev, TUNE, alloc, pushEvent, release, type WeaponSlot, type World } from '../world';
import { killEnemy } from './enemies';

/** Metres of per-tick travel the hit query pads for, beyond the widest body. */
const HIT_SLACK = 0.15;

/** Widest enemy body in content, so one query radius covers every shot. */
let widestRadius = 0;
for (let i = 0; i < ENEMIES.length; i++) {
  if (ENEMIES[i].radius > widestRadius) widestRadius = ENEMIES[i].radius;
}
const HIT_PAD = widestRadius + HIT_SLACK;

/** Ticks a knocked-back enemy rides its shove instead of steering (see systems/enemies). */
const STAGGER_TICKS = 3;

/** Above this length a direction counts as a real aim vector. */
const EPS = 1e-6;

/**
 * One tick of the weapon loop.
 *
 * Order inside the pass matters: cooldowns and reloads tick down first, so a gun
 * that finished its reload this tick may already fire, and only then do the shots
 * already in the air move.
 */
export function updateWeapons(world: World, frame: InputFrame): void {
  tickWeaponTimers(world);

  if (frame.swap) swapWeapon(world);

  if (world.player.alive && wantsFire(world, frame)) {
    const slot = world.slots[world.activeSlot];
    if (slot !== undefined) fire(world, slot, !frame.fire);
  }

  updateShots(world);
}

/** Tick down both hands, so the off hand is ready when it is swapped to. */
function tickWeaponTimers(w: World): void {
  for (let i = 0; i < w.slots.length; i++) {
    const slot = w.slots[i];
    if (slot.cooldown > 0) {
      slot.cooldown -= DT;
      if (slot.cooldown < 0) slot.cooldown = 0;
    }
    if (slot.reload > 0) {
      slot.reload -= DT;
      if (slot.reload <= 0) {
        slot.reload = 0;
        const def = WEAPONS[slot.weapon];
        if (def) slot.ammo = def.ammo.mag;
      }
    }
  }
}

/**
 * Q or the wheel: change hands, but only to a hand that holds something, so
 * swapping can never leave the player holding nothing.
 */
function swapWeapon(w: World): void {
  const next = w.activeSlot === 0 ? 1 : 0;
  const other = w.slots[next];
  if (other && other.weapon >= 0) w.activeSlot = next;
}

/**
 * Hold-to-fire always shoots. Auto-fire only wakes up when something is actually
 * in range, which is what keeps a run from emptying a magazine into empty floor,
 * and it leads that target — see `fire`.
 */
function wantsFire(w: World, frame: InputFrame): boolean {
  if (frame.fire) return true;
  return w.autoFire && w.enemyNear <= TUNE.autoFireRange;
}

/**
 * Fire one round from `slot` if the gun is able to.
 *
 * `auto` marks the trigger as auto-fire rather than a held button, and the two aim
 * differently on purpose: a held trigger fires exactly where the mouse steered,
 * while auto-fire leads the nearest body. Auto-fire exists so the gun keeps working
 * while the player is busy moving, and a round fired along whatever the aim happened
 * to be last almost never finds the crowd closing in from every side, which would
 * leave the setting looking broken.
 */
function fire(w: World, slot: WeaponSlot, auto: boolean): void {
  const def = WEAPONS[slot.weapon];
  // The other fire kinds get their own delivery path here; a weapon that names a
  // kind the sim does not implement yet simply does not shoot.
  if (!def || def.fire !== 'projectile') return;
  if (slot.reload > 0 || slot.cooldown > 0 || slot.ammo <= 0) return;

  const shots = w.shots;
  const index = alloc(shots);
  if (index < 0) return; // pool full: no shot, and the round stays in the magazine

  const player = w.player;
  let ax = player.aimX;
  let ay = player.aimY;
  if (auto && w.nearest >= 0) {
    const ex = w.enemies.x[w.nearest] - player.x;
    const ey = w.enemies.y[w.nearest] - player.y;
    const targetLen = Math.sqrt(ex * ex + ey * ey);
    if (targetLen > EPS) {
      ax = ex / targetLen;
      ay = ey / targetLen;
    }
  } else {
    const aimLen = Math.sqrt(ax * ax + ay * ay);
    if (aimLen < EPS) {
      ax = 1;
      ay = 0;
    } else {
      ax /= aimLen;
      ay /= aimLen;
    }
  }

  if (def.spread > 0) {
    const turn = range(w.rng, -def.spread, def.spread);
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const nx = ax * c - ay * s;
    ay = ax * s + ay * c;
    ax = nx;
  }

  // The shot starts downrange of the body, so a contact-range enemy is still
  // "ahead" of the sweep and the first segment already reaches past it.
  const muzzle = TUNE.playerRadius + TUNE.shotStart;
  const invSpeed = 1 / def.speed;

  shots.x[index] = player.x + ax * muzzle;
  shots.y[index] = player.y + ay * muzzle;
  shots.vx[index] = ax * def.speed;
  shots.vy[index] = ay * def.speed;
  shots.hp[index] = def.dmg;
  shots.life[index] = def.range * invSpeed;
  shots.kind[index] = slot.weapon;
  // One hit for itself plus `pierce` pass-throughs.
  shots.state[index] = def.pierce + 1;

  slot.ammo--;
  slot.cooldown = 1 / (def.rate * w.stats.fireRate);
  if (slot.ammo <= 0) slot.reload = def.ammo.reload;

  // `a` is the weapon index for the muzzle-flash look, `b` the shot slot.
  pushEvent(w, Ev.Shot, slot.weapon, index, shots.x[index], shots.y[index]);
}

/**
 * Move every live shot and let it hit.
 *
 * A round is tested as the capsule it swept this tick. Two rules keep that
 * honest: a body entirely behind the segment start is ignored (it is not what
 * the gun was pointed at), and a body that was already inside the round's disc
 * at the segment start is ignored too, because it was already hit the tick
 * before — without that, one round would spend its whole pierce on the first
 * body it lingered inside. The first tick of a shot is exempt from the second
 * rule, which is what lets a chaser pressed against the muzzle still be reached.
 *
 * Damage is read off the distance travelled, so falloff follows the same line
 * the shot flew, and armour subtracts after it.
 */
function updateShots(w: World): void {
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

    const invSpeed = 1 / def.speed;
    const dirx = shots.vx[i] * invSpeed;
    const diry = shots.vy[i] * invSpeed;
    const sweep = def.speed * DT;

    const x0 = shots.x[i];
    const y0 = shots.y[i];
    const dx = shots.vx[i] * DT;
    const dy = shots.vy[i] * DT;
    const x1 = x0 + dx;
    const y1 = y0 + dy;

    const fresh = shots.age[i] === 0;
    shots.age[i] += DT;
    shots.life[i] -= DT;

    const dmg = shots.hp[i] * falloff(def, def.speed * shots.age[i]) * w.stats.dmg;
    let hits = shots.state[i];

    // Broad phase: the capsule the shot swept, padded for the widest body and for
    // how far an enemy can move between the grid being built and this test.
    const reach = sweep * 0.5 + HIT_PAD;
    const found = queryRadius(
      w.hash,
      enemies.x,
      enemies.y,
      enemies.alive,
      (x0 + x1) * 0.5,
      (y0 + y1) * 0.5,
      reach,
      query,
    );

    for (let k = 0; k < found && hits > 0; k++) {
      const j = query[k];
      if (enemies.hp[j] <= 0) continue;

      const enemy = ENEMIES[enemies.kind[j]];
      const hitR = TUNE.shotRadius + enemy.radius;
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

      const dealt = dmg > enemy.armor ? dmg - enemy.armor : 1;
      enemies.hp[j] -= dealt;

      if (def.knockback > 0 && enemies.hp[j] > 0) {
        enemies.vx[j] = dirx * def.knockback;
        enemies.vy[j] = diry * def.knockback;
        enemies.state[j] = STAGGER_TICKS;
      }

      hits--;
      // `a` is the shot slot, `b` the enemy slot: enough for a tracer, an impact
      // burst and a damage number without a per-hit object.
      pushEvent(w, Ev.Hit, i, j, enemies.x[j], enemies.y[j]);
      if (enemies.hp[j] <= 0) killEnemy(w, j);
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

/** Damage multiplier at `distance` travelled, from the def's [start, end, mult]. */
function falloff(def: WeaponDef, distance: number): number {
  const start = def.falloff[0];
  const end = def.falloff[1];
  const mult = def.falloff[2];
  if (distance <= start) return 1;
  if (distance >= end) return mult;
  return 1 + (mult - 1) * ((distance - start) / (end - start));
}
