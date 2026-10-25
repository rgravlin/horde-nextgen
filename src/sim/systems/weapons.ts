/**
 * Weapons: the trigger side of combat.
 *
 * One pass owns the whole firing loop — hand swap, cooldown, magazine and reload,
 * the draw, the two gauges, the fire decision and the aim — and hands the delivery
 * to `systems/projectiles.ts`, which owns everything that happens after the
 * trigger: the segment test for a round, the march for a ray and the beam, the arc
 * of a sweep, the jumps of a bolt and the burst of a lobbed shell.
 *
 * All seven fire kinds have a delivery path. What a hand spends is the other half of
 * the contract, and each weapon declares exactly one of them (the def's `ammo`,
 * `heat` or `energy`): a magazine that runs out and reloads, a barrel that cooks
 * itself into vent, or a charge cell that dribbles until it recovers. There is no
 * fourth case and no hand that spends two, which is why the three gauges stay
 * readable on the HUD and in `__forgeState()`.
 *
 * Nothing here allocates: shots come out of the projectile pool, spread comes from
 * world.rng, and the broad phase is the tick's spatial hash.
 */

import { WEAPONS, type WeaponDef } from '../../content/weapons';
import type { InputFrame } from '../input';
import { range } from '../rng';
import { DT, Ev, TUNE, alloc, pushEvent, type WeaponSlot, type World } from '../world';
import { castBeam, castChain, castRay, sweepMelee, updateProjectiles } from './projectiles';
import { tickBurn } from './status';

/** Above this length a direction counts as a real aim vector. */
const EPS = 1e-6;

/** m — the shortest throw an auto-fired lob gets, so it still has a flight to work on. */
const LOB_MIN = 2;

/**
 * s between the pings a continuous weapon writes into the event ring.
 *
 * This is about the *sound*: a beam that wrote one `Shot` per tick would spend 60 of
 * the ring's 1024 slots every second it is on, and what it pushed out would be other
 * weapons' tracers and impacts. Presentation wants "the beam is on, and for how long",
 * which is what `slot.beam` carries, plus one ping a twelfth of a second to put a
 * sound on the air. What the beam cuts is a different event and is not throttled —
 * every `Hit` it lands is reported, the same as a ray's or a sweep's.
 */
const BEAM_PING = 0.12;

/**
 * One tick of the weapon loop.
 *
 * Order inside the pass matters: cooldowns, reloads, burns and gauges tick down
 * first, so a gun that finished its reload this tick may already fire; the burns
 * tick before the shots that might renew them, so a body walked over by a second
 * arrow keeps one burn rather than getting two; and only then do the shots already in
 * the air move.
 */
export function updateWeapons(world: World, frame: InputFrame): void {
  tickWeaponTimers(world);

  if (frame.swap) swapWeapon(world);

  if (world.player.alive) {
    const slot = world.slots[world.activeSlot];
    const def = slot === undefined ? undefined : WEAPONS[slot.weapon];
    if (slot !== undefined && def !== undefined) decideFire(world, slot, def, frame);
  }

  tickBurn(world);
  updateProjectiles(world);
}

/**
 * Tick down both hands, so the off hand is ready when it is swapped to.
 *
 * Heat and charge both refill here, on every tick and not only the ones the hand sits
 * out: a cell that only refills between shots refills slower than the gun drains it,
 * which reads as a weapon that stops working rather than as one with a rhythm. Venting
 * needs the second threshold to be state, not arithmetic — cooling alone would let a
 * hot gun fire the tick it drops a hundredth of a degree, sputter, and heat straight
 * back up.
 */
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
        slot.charge = 0; // a fresh magazine is a fresh draw
        const fresh = WEAPONS[slot.weapon];
        if (fresh && fresh.ammo) slot.ammo = fresh.ammo.mag;
      }
    }

    const def = WEAPONS[slot.weapon];
    if (def === undefined) continue;

    const heat = def.heat;
    if (heat !== undefined && slot.heat > 0) {
      slot.heat -= heat.coolPerSec * DT;
      if (slot.heat <= 0) {
        slot.heat = 0;
        slot.venting = false;
      } else if (slot.venting && slot.heat <= heat.recover) {
        slot.venting = false;
      }
    }

    const energy = def.energy;
    if (energy !== undefined && slot.energy < energy.capacity) {
      slot.energy += energy.regenPerSec * DT;
      if (slot.energy > energy.capacity) slot.energy = energy.capacity;
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
  if (other && other.weapon >= 0) {
    w.activeSlot = next;
    other.charge = 0;
    // The beam clock is per hand and per trigger pull: a fresh hand starts a fresh
    // sound rather than continuing the one it was swapped away from.
    other.beam = 0;
  }
}

/**
 * Hold-to-fire always shoots. Auto-fire only wakes up when something is actually
 * within the weapon's own reach, which is what keeps a run from emptying a magazine
 * into empty floor — and for a flail with 3.4 m of reach, from swinging at the far
 * side of the arena.
 */
function wantsFire(w: World, frame: InputFrame, def: WeaponDef): boolean {
  if (frame.fire) return true;
  if (!w.autoFire) return false;
  return w.enemyNear <= Math.min(TUNE.autoFireRange, def.range);
}

/**
 * Decide whether this tick looses anything, for the hand in play.
 *
 * A drawn weapon (the longbow) builds its draw while the trigger is held and looses
 * either at a full draw or the moment the trigger comes up, whichever happens
 * first — so a panicked tap still sends an arrow, just a flat weak one, and holding
 * the trigger down is what earns the fast hard one. Everything else fires the tick
 * it is asked to.
 */
function decideFire(w: World, slot: WeaponSlot, def: WeaponDef, frame: InputFrame): void {
  const charge = def.charge;
  const want = wantsFire(w, frame, def);

  if (!want) {
    if (charge && slot.charge > 0) fire(w, slot, def, false);
    slot.beam = 0;
    return;
  }

  if (charge) {
    if (slot.charge < charge.time) {
      slot.charge += DT;
      return;
    }
    fire(w, slot, def, !frame.fire);
    return;
  }

  fire(w, slot, def, !frame.fire);
}

/**
 * Fire one round, or one volley, from `slot` if the gun is able to.
 *
 * `auto` marks the trigger as auto-fire rather than a held button, and the two aim
 * differently on purpose: a held trigger fires exactly where the mouse steered,
 * while auto-fire leads the nearest body. Auto-fire exists so the gun keeps working
 * while the player is busy moving, and a round fired along whatever the aim happened
 * to be last almost never finds the crowd closing in from every side, which would
 * leave the setting looking broken.
 *
 * Leading matters most for a lobbed shell, which is why the `arc` branch does not
 * merely point at the nearest body — see the comment there. A singularity is pointed
 * and not led, for the opposite reason, also below.
 *
 * A shot that could not be created — the projectile pool is full — spends neither
 * ammo nor cooldown, so a jammed pool never quietly eats a round. The same goes for a
 * hand that cannot spend: venting, out of charge or out of ammo, it does not tick, and
 * a chain bolt that found nobody spends its charge too.
 *
 * The three paths added on top of a round aim differently. A beam and a bolt resolve
 * the tick they are called and need only a direction; a singularity is deliberately
 * *not* led, because it pops where it got to rather than where it was aimed, and its
 * job is to gather the crowd that is about to be there.
 */
function fire(w: World, slot: WeaponSlot, def: WeaponDef, auto: boolean): void {
  const cost = def.energy ? def.energy.perShot : 0;
  if (slot.reload > 0 || slot.cooldown > 0 || slot.venting) {
    slot.beam = 0;
    return;
  }
  if (def.ammo && slot.ammo <= 0) {
    slot.beam = 0;
    return;
  }
  if (cost > 0 && slot.energy < cost) {
    slot.beam = 0;
    return;
  }

  const player = w.player;
  const enemies = w.enemies;
  const muzzle = TUNE.playerRadius + TUNE.shotStart;
  let ax = player.aimX;
  let ay = player.aimY;
  // How far down that line a lob goes: the weapon's full range, unless auto-fire has
  // found a body to spend the throw on.
  let lob = def.range;

  if (auto && w.nearest >= 0) {
    const target = w.nearest;
    const tx = enemies.x[target] - player.x;
    const ty = enemies.y[target] - player.y;
    let lx = tx;
    let ly = ty;
    if (def.fire === 'arc') {
      // Lead it, and shorten the throw to match. A shell is airborne for up to
      // `range / speed` seconds and a chaser covers 4 m in that time, so a burst
      // aimed at the body's own footprint lands a whole flight behind the crowd it
      // was fired at — which for an area weapon means it never hits anything. The lead
      // time is the flight a throw as far as the body takes, so the aim is out by the
      // second pass rather than by the whole flight, well inside the burst radius. A
      // body closer than LOB_MIN gets a LOB_MIN throw instead, so the shell keeps a
      // flight rather than detonating on the player's boots.
      const flight = (Math.sqrt(tx * tx + ty * ty) - muzzle) / def.speed;
      if (flight > 0) {
        lx = tx + enemies.vx[target] * flight;
        ly = ty + enemies.vy[target] * flight;
        const led = Math.sqrt(lx * lx + ly * ly);
        lob = led > def.range ? def.range : led < LOB_MIN ? LOB_MIN : led;
      } else {
        lob = LOB_MIN;
      }
    } else if (def.fire === 'orb') {
      // No lead, on purpose and not for want of the maths: a singularity drags what is
      // already in its radius and pops where it arrives, so chasing a body that has not
      // got there yet spends the whole 1.3 s of flight on empty floor.
      const near = Math.sqrt(tx * tx + ty * ty) - muzzle;
      lob = near > def.range ? def.range : near < LOB_MIN ? LOB_MIN : near;
    }
    const len = Math.sqrt(lx * lx + ly * ly);
    if (len > EPS) {
      ax = lx / len;
      ay = ly / len;
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

  // The draw sets how hard and how flat the shot leaves, so it is resolved here
  // rather than per target: one draw, one number, every body it reaches.
  let dmg = def.dmg;
  let speed = def.speed;
  const charge = def.charge;
  if (charge) {
    const drawn = slot.charge < charge.time ? slot.charge / charge.time : 1;
    dmg *= 1 + (charge.dmg - 1) * drawn;
    speed *= 1 + (charge.speed - 1) * drawn;
  }

  // The ray and the bolt start at the same distance downrange as a round would, so a
  // body pressed against the player is still ahead of them and still reachable.
  const ox = player.x + ax * muzzle;
  const oy = player.y + ay * muzzle;

  let spent = false;
  if (def.fire === 'projectile') {
    spent = launchShots(w, slot, def, ax, ay, dmg, speed);
  } else if (def.fire === 'arc' || def.fire === 'orb') {
    spent = launchLob(w, slot, def, ax, ay, dmg, lob);
  } else if (def.fire === 'hitscan') {
    // `a` is the weapon index and `b` is -1 because an instant shot has no entity
    // to point at: the tracer is drawn from the muzzle to the impact it reports.
    pushEvent(w, Ev.Shot, slot.weapon, -1, ox, oy);
    castRay(w, def, ox, oy, ax, ay);
    spent = true;
  } else if (def.fire === 'melee') {
    pushEvent(w, Ev.Shot, slot.weapon, -1, player.x, player.y);
    sweepMelee(w, def, player.x, player.y, ax, ay);
    spent = true;
  } else if (def.fire === 'beam') {
    // One ping per BEAM_PING of continuous fire rather than one per tick, and
    // `slot.beam` says how long the beam has been on — see the constant.
    const before = slot.beam;
    slot.beam = before + DT;
    if (before === 0 || Math.floor(slot.beam / BEAM_PING) > Math.floor(before / BEAM_PING)) {
      pushEvent(w, Ev.Shot, slot.weapon, -1, ox, oy);
    }
    castBeam(w, def, ox, oy, ax, ay);
    spent = true;
  } else if (def.fire === 'chain') {
    const links = castChain(w, def, ox, oy);
    // Nothing in front of the muzzle: the bolt was never thrown. A flash here would be
    // a sound about nothing, and the charge stays in the cell for the next one.
    if (links > 0) {
      pushEvent(w, Ev.Shot, slot.weapon, -1, ox, oy);
      spent = true;
    }
  }

  if (!spent) {
    slot.beam = 0;
    return;
  }

  // Only now is the pull paid for, so nothing charges the player for a shot that did
  // not happen. A magazine hands itself a reload the moment it empties; a barrel and a
  // cell have no such pause, they just have less of whatever they run on.
  const magazine = def.ammo;
  if (magazine) {
    slot.ammo--;
    if (slot.ammo <= 0) slot.reload = magazine.reload;
  }
  if (cost > 0) slot.energy -= cost;

  const heat = def.heat;
  if (heat) {
    const hot = slot.heat + heat.perShot;
    slot.heat = hot > heat.max ? heat.max : hot;
    if (slot.heat >= heat.max) slot.venting = true;
  }

  // A beam has no gap between pulls — that is what makes it a beam, and why its rate is
  // 0 — so it buys no cooldown and gates on heat alone.
  if (def.rate > 0) slot.cooldown = 1 / (def.rate * w.stats.fireRate);
  if (slot.charge > 0) slot.charge = 0;
}

/**
 * Put one or eight rounds in the air.
 *
 * The shot starts downrange of the body, so a contact-range enemy is still "ahead"
 * of the sweep and the first segment already reaches past it. Each pellet takes its
 * own spread draw, which is what makes a shotgun cone: eight independent draws
 * inside the same half-angle, fired from the same trigger pull and the same magazine
 * round.
 */
function launchShots(
  w: World,
  slot: WeaponSlot,
  def: WeaponDef,
  ax: number,
  ay: number,
  dmg: number,
  speed: number,
): boolean {
  const shots = w.shots;
  const player = w.player;
  const muzzle = TUNE.playerRadius + TUNE.shotStart;
  const pellets = def.pellets || 1;
  let made = 0;

  for (let n = 0; n < pellets; n++) {
    const index = alloc(shots);
    if (index < 0) break; // pool full: what was already made still counts

    let dx = ax;
    let dy = ay;
    if (def.spread > 0) {
      const turn = range(w.rng, -def.spread, def.spread);
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      dx = ax * c - ay * s;
      dy = ax * s + ay * c;
    }

    shots.x[index] = player.x + dx * muzzle;
    shots.y[index] = player.y + dy * muzzle;
    shots.vx[index] = dx * speed;
    shots.vy[index] = dy * speed;
    shots.hp[index] = dmg;
    shots.life[index] = def.range / speed;
    shots.kind[index] = slot.weapon;
    // One hit for itself plus `pierce` pass-throughs.
    shots.state[index] = def.pierce + 1;

    // `a` is the weapon index, `b` the shot slot.
    pushEvent(w, Ev.Shot, slot.weapon, index, shots.x[index], shots.y[index]);
    made++;
  }

  return made > 0;
}

/**
 * Throw something that resolves at the end of its flight: the catapult's shell, or a
 * singularity.
 *
 * The shot carries no hit budget (`state` 0) because neither is a bullet: it flies over
 * whatever is under it and detonates at the end of its flight, a singularity dragging
 * on the way (see `updateProjectiles`). The aim
 * that reaches the sim is a direction, not a point (`InputFrame` carries
 * `aimX/aimY`), so `distance` says how far down that line the burst goes — the
 * weapon's range for a steered shot, the body's own distance for an auto-fired one —
 * and the flight time falls out of it. `life` *is* that timer: when it runs out the
 * burst happens where the shot got to, within one step of `distance`.
 */
function launchLob(
  w: World,
  slot: WeaponSlot,
  def: WeaponDef,
  ax: number,
  ay: number,
  dmg: number,
  distance: number,
): boolean {
  const shots = w.shots;
  const index = alloc(shots);
  if (index < 0) return false;

  const player = w.player;
  const muzzle = TUNE.playerRadius + TUNE.shotStart;
  const speed = def.speed;

  shots.x[index] = player.x + ax * muzzle;
  shots.y[index] = player.y + ay * muzzle;
  shots.vx[index] = ax * speed;
  shots.vy[index] = ay * speed;
  shots.hp[index] = dmg;
  // Measured from the muzzle, so the burst lands `distance` out from the player
  // rather than `distance` plus the length of the gun.
  shots.life[index] = (distance - muzzle) / speed;
  shots.kind[index] = slot.weapon;
  shots.state[index] = 0;

  pushEvent(w, Ev.Shot, slot.weapon, index, shots.x[index], shots.y[index]);
  return true;
}