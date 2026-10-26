/**
 * The bodies that read a distance, announce themselves, and then spend everything on one
 * approach: the charger's locked line and the exploder's cooked fuse.
 *
 * Both put a tell in the event ring the tick they commit, and both spend themselves exactly
 * once — the charger on the floor it charged, the exploder on a burst.
 */

import { ENEMIES } from '../../../content/enemies';
import { DT, Ev, Tele, pushEvent, type World } from '../../world';
import { Phase, advance, seekDrive } from './shared';
import { killEnemy } from './deaths';

/**
 * Charger: stalk, lock a line, stop, dash it, recover. Four phases on one timer.
 *
 * The line is decided the tick it commits and does not move after that, so the answer to a
 * charger is to *move*, not to shoot faster — which is the difference between a telegraph
 * and a decoration. Half a second of wind-up is thirty ticks of it, past the 0.4 s
 * DESIGN.md sets as the floor for anything a player is asked to read and answer, and the
 * tell goes into the event ring the tick it starts, thirty ticks before the velocity does.
 *
 * `nearRange` is why a charge cannot be wasted on a body already in contact: a dash from
 * arm's length has no room to be read, and a charger that never stops is only a faster
 * chaser with a bigger number on it.
 */
export function chargeRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const phase = enemies.phase[i];

  if (phase === Phase.Windup) {
    // Feet off the throttle, line drawn: this is the window the player has in it.
    enemies.vx[i] = 0;
    enemies.vy[i] = 0;
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      enemies.phase[i] = Phase.Dash;
      enemies.timer[i] = def.params.dashTime;
    }
    return;
  }

  if (phase === Phase.Dash) {
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      enemies.phase[i] = Phase.Recover;
      enemies.timer[i] = def.params.recover;
      enemies.vx[i] = 0;
      enemies.vy[i] = 0;
      return;
    }
    // Straight down the locked line at thirteen metres a second — four times its cruise —
    // and deliberately without separation: a charge that steers around the crowd in front
    // of it is a homing missile, and that is a different monster.
    const speed = def.params.dashSpeed;
    enemies.vx[i] = enemies.fx[i] * speed;
    enemies.vy[i] = enemies.fy[i] * speed;
    advance(w, i, def);
    return;
  }

  if (phase === Phase.Recover) {
    // The punish for a missed charge: it stands where it overshot for two thirds of a
    // second, side on, with its line empty.
    enemies.vx[i] = 0;
    enemies.vy[i] = 0;
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      enemies.phase[i] = Phase.Seek;
      enemies.timer[i] = def.params.stalk;
    }
    return;
  }

  // Stalk. The timer here is the cooldown before it will commit again, so a charger that
  // has just finished a cycle walks for `stalk` seconds before it locks another line.
  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

  const player = w.player;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;

  if (d2 > 1e-12 && enemies.timer[i] <= 0) {
    const d = Math.sqrt(d2);
    if (d <= def.params.armRange && d >= def.params.nearRange) {
      enemies.fx[i] = dx / d;
      enemies.fy[i] = dy / d;
      enemies.vx[i] = 0;
      enemies.vy[i] = 0;
      enemies.phase[i] = Phase.Windup;
      enemies.timer[i] = def.params.windup;
      // `b` says which shape to draw; the body's `fx`/`fy` say where it points and its
      // `timer` says how much of the wind-up is left, which is everything a charge line
      // needs and none of it needs a per-event object.
      pushEvent(w, Ev.Telegraph, i, Tele.Line, enemies.x[i], enemies.y[i]);
      return;
    }
  }

  seekDrive(w, i, def);
}

/**
 * Exploder: walk, and cook once it is close enough to matter.
 *
 * It keeps walking through the fuse, because a bomb you can walk around is fine and one
 * that follows you for half a second at three metres a second is a threat you step out of.
 * The half second is measured from three point six metres and the burst reaches 3.2, so a
 * player who stands still eats it and a player who keeps moving does not — and the fuse
 * runs out before contact range does, which is deliberate: its damage is the burst, not the
 * hug, and a burst spent inside the i-frames a hug already spent is damage that silently
 * does not exist.
 *
 * Both of its endings go through one call. Shot or fused, it pays out exactly one blast at
 * the place it died, which is also why that blast is queued here and spent later.
 */
export function fuseRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];

  if (enemies.phase[i] === Phase.Fuse) {
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      killEnemy(w, i);
      return;
    }
    seekDrive(w, i, def);
    return;
  }

  const player = w.player;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;
  const arm = def.params.armRange;

  if (d2 > 1e-12 && d2 <= arm * arm) {
    enemies.phase[i] = Phase.Fuse;
    enemies.timer[i] = def.params.fuseTime;
    pushEvent(w, Ev.Telegraph, i, Tele.Ring, enemies.x[i], enemies.y[i]);
  }

  seekDrive(w, i, def);
}