/**
 * The body that crosses the last eight metres under the floor instead of over it.
 *
 * Three phases on the archetype's one timer, and the whole shape of it is bought with one
 * question: what does a player *do* about a body they cannot shoot? The answer this file
 * gives is "move, and go early", and the three rules below are what make that a real answer
 * rather than a tax:
 *
 * - **The travel underneath cannot be shot, and cannot shoot anything either.** A burrower in
 *   `Burrowed` is out of the broad phase (see `markFindable` in `shared.ts`) so no hitscan,
 *   sweep, orb, drone round or burst can find it — and it is denied its own touch for the same
 *   ticks, so being untargetable never costs the player HP they had no way to protect.
 * - **It commits a line, not a chase.** The bearing is locked the tick it dives and nothing
 *   steers it afterwards, which is the same bargain the charger and the teleporter strike: a
 *   tell that curves to follow you is a homing missile with a shorter wind-up. It surfaces
 *   early if you walk *into* the burst's reach, and overshoots if you walk out of its line.
 * - **The burst is announced for longer than DESIGN.md's floor.** The ring goes into the
 *   event ring the tick it plants, fills for its whole `windup` (thirty ticks), is drawn at
 *   the burst's exact radius and centred on the circle the burst will be, and the body sits
 *   still for all of it — so it can be killed inside its own tell. The kill window and the
 *   warning are the same half second.
 *
 * It is the one behaviour here that spends its own `advance` on a velocity nothing steers, so
 * the `canTravel` test below happens before the dive rather than during it: a trench run that
 * would stop at a wall is not promised in the first place, which is the rule the teleporter's
 * painted line already keeps.
 */

import { ENEMIES } from '../../../content/enemies';
import { DT, Ev, Tele, pushEvent, type World } from '../../world';
import { canTravel } from '../obstacles';
import { queueBlast } from './deaths';
import { Phase, advance, seekDrive } from './shared';

/**
 * Burrower: dig a line, plant, burst, repeat.
 *
 * `digTime` bounds how long any one body can stay untargetable — under a second and a fifth,
 * at the end of which it is either bursting or back on the floor where a gun can reach it.
 * `digGap` is the chase between digs, and the only part of the cycle in which it is worth
 * standing and shooting at.
 */
export function burrowRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const params = def.params;

  if (enemies.phase[i] === Phase.Breach) {
    // Planted. The ring has been on the floor since the tick this phase started, so nothing
    // here needs to warn anybody again — it only has to keep its promise, or not, if the
    // player spent the half second the tell bought them.
    enemies.timer[i] -= DT;
    if (enemies.timer[i] > 0) return;

    queueBlast(w, enemies.x[i], enemies.y[i], params.burstRadius, params.burstDamage, w.blasts.depth);
    enemies.phase[i] = Phase.Seek;
    enemies.timer[i] = params.digGap;
    return;
  }

  if (enemies.phase[i] === Phase.Burrowed) {
    const dx = w.player.x - enemies.x[i];
    const dy = w.player.y - enemies.y[i];
    const d2 = dx * dx + dy * dy;
    const reach = params.burstReach;

    if (d2 <= reach * reach) {
      // In range of the burst it came for: stop, and let the ring fill. Note that this is the
      // *only* way the tunnel ends in damage — a burrower that runs out of line short of the
      // player surfaces and goes back to being a body you can kill.
      enemies.vx[i] = 0;
      enemies.vy[i] = 0;
      enemies.phase[i] = Phase.Breach;
      enemies.timer[i] = params.windup;
      pushEvent(w, Ev.Telegraph, i, Tele.Ring, enemies.x[i], enemies.y[i]);
      return;
    }

    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      // Overshoot. It spent its line on the floor the player left, so it comes up, shakes it
      // off and looks for another one from the walk.
      enemies.phase[i] = Phase.Seek;
      enemies.timer[i] = params.digGap;
      return;
    }

    // Straight down the locked bearing, through the crowd rather than around it, and at
    // almost five metres a second more than its cruise: the point of going under the floor is
    // arriving somewhere a walk would have taken three seconds to cross. No separation and no
    // steering on purpose — see the charger's dash in `rushers.ts`, which this copies.
    enemies.vx[i] = enemies.fx[i] * params.digSpeed;
    enemies.vy[i] = enemies.fy[i] * params.digSpeed;
    advance(w, i, def);
    return;
  }

  // On the floor: walk at the player, hug if that gets close enough, and look for a dig as
  // soon as the last one is paid for. This is the phase its gun answers, and the only one.
  if (enemies.timer[i] > 0) {
    enemies.timer[i] -= DT;
    seekDrive(w, i, def);
    return;
  }

  const dx = w.player.x - enemies.x[i];
  const dy = w.player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;
  const arm = params.armRange;
  const reach = params.burstReach;

  // It only goes under for a player it can actually reach from the other side: inside the
  // burst's own reach there is nothing to cross, and outside `armRange` the trench stops
  // short of you and the whole cycle would be a way of not fighting.
  if (d2 > arm * arm || d2 <= reach * reach) {
    seekDrive(w, i, def);
    return;
  }

  const d = Math.sqrt(d2);
  const ux = dx / d;
  const uy = dy / d;

  // The whole line is tested the tick it is chosen, so a burrower shut in behind a wall walks
  // instead of digging into it, and the trench it promises is one it can finish.
  const reach2 = params.digSpeed * params.digTime;
  if (w.props.n > 0 && !canTravel(w.props, enemies.x[i], enemies.y[i], ux * reach2, uy * reach2, def.radius)) {
    seekDrive(w, i, def);
    return;
  }

  enemies.phase[i] = Phase.Burrowed;
  enemies.timer[i] = params.digTime;
  enemies.fx[i] = ux;
  enemies.fy[i] = uy;
}
