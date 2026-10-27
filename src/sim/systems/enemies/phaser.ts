/**
 * Teleporter: paint a line, then spend the whole of it in two moves.
 *
 * This is the one body in the game that does not travel through the space between two
 * points, so it owes the folder's first rule an explanation rather than an exception. The
 * rule exists because the renderer draws a body *behind* where the sim says it is — one
 * tick of its own velocity, back-dated (see `render/instancing.ts`) — and because
 * separation, the speed cap and the arena clamp all hang off `advance`. A jump breaks
 * neither: it lands with no velocity to smear and it is measured against the same floor a
 * walk is, so what it skips is open floor only. What it does keep is the other rule — a
 * tell is an event — and the tell is the whole answer. The line it paints is exactly as
 * long as the line it spends, so the strip on the floor says "all of this, in a moment"
 * and the moment is half a second away.
 *
 * The second half of the bargain is that the line does not bend. It is decided the tick the
 * tell starts, the body stands still while it is up, and it then crosses the floor and runs
 * out the far end whether the player is there or not. A phase that curved toward wherever
 * the player had got to would be a hopping homing missile with a shorter wind-up, and the
 * player who read it and stepped aside would be punished for reading it.
 *
 * `phaseMin` is why it will not spend a phase at arm's length: eight metres of painted line
 * need eight metres of floor to be read on, and a body that blinks the last metre of a hug
 * is a body that hits you, not a body you answer. The recover window after the run is the
 * punish for spending it on empty floor — a second and a third of standing side-on, which
 * is what the charger's costs and what this one earns.
 */

import { ENEMIES } from '../../../content/enemies';
import { DT, Ev, Tele, pushEvent, type World } from '../../world';
import { canTravel } from '../obstacles';
import { Phase, advance, scratch, seekDrive } from './shared';

/**
 * One tick of the teleporter.
 *
 * Seek walks and counts down to the next phase; Windup is the half second of painted line,
 * standing still; Dash crosses the line (the first `phaseSkip` metres in this tick's single
 * jump, the rest at `phaseSpeed`); Recover is the window it leaves itself if it missed.
 */
export function teleporterRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const phase = enemies.phase[i];

  if (phase === Phase.Windup) {
    // Feet off the throttle, the same reason the charger takes them off: a line drawn by
    // something that is already moving is a decal, and this body's whole promise is that
    // the strip you were shown is the floor it is about to be standing on.
    enemies.vx[i] = 0;
    enemies.vy[i] = 0;
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      // The jump, and it is taken off the stasis field's fraction like every travel step
      // in the game: a slowed teleporter should shorten its own line, not keep eight
      // metres of reach and lose only the run at the end of it.
      const skip = def.params.phaseSkip * scratch.travel;
      const fx = enemies.fx[i];
      const fy = enemies.fy[i];
      put(w, i, enemies.x[i] + fx * skip, enemies.y[i] + fy * skip, def.radius);
      enemies.phase[i] = Phase.Dash;
      enemies.timer[i] = def.params.phaseTime;
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
    // Straight down the painted line at nearly four times its cruise, no separation: the
    // charge's own rule, for the charge's own reason — a phase that steers around the
    // crowd in front of it is a different monster and a harder one to read.
    const speed = def.params.phaseSpeed;
    enemies.vx[i] = enemies.fx[i] * speed;
    enemies.vy[i] = enemies.fy[i] * speed;
    advance(w, i, def);
    return;
  }

  if (phase === Phase.Recover) {
    enemies.vx[i] = 0;
    enemies.vy[i] = 0;
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      enemies.phase[i] = Phase.Seek;
      enemies.timer[i] = def.params.phaseGap;
    }
    return;
  }

  // Seek. The timer here is the cooldown, so between phases it walks — and a body that
  // walks is a body a player can position against, which is the half of the archetype the
  // phase would eat if it did nothing else.
  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

  const player = w.player;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;
  if (d2 <= 1e-12 || enemies.timer[i] > 0) {
    seekDrive(w, i, def);
    return;
  }

  const d = Math.sqrt(d2);
  if (d < def.params.phaseMin || d > def.params.armRange) {
    seekDrive(w, i, def);
    return;
  }

  const fx = dx / d;
  const fy = dy / d;
  // The line is tested as one sweep before anything is promised, on the same grounds the
  // cover checks are always taken: a phase that could be spent *through* a wall would make
  // the painted strip a lie about the floor it crosses, and the one arrival this game
  // refuses to give without a warning is a body that comes out of cover.
  const reach = def.params.dashReach;
  if (!canTravel(w.props, enemies.x[i], enemies.y[i], fx * reach, fy * reach, def.radius)) {
    seekDrive(w, i, def);
    return;
  }

  enemies.fx[i] = fx;
  enemies.fy[i] = fy;
  enemies.phase[i] = Phase.Windup;
  enemies.timer[i] = def.params.windup;
  pushEvent(w, Ev.Telegraph, i, Tele.Line, enemies.x[i], enemies.y[i]);
}

/**
 * Stand the body at (x, y), clamped into the arena the way `advance` clamps a walk.
 *
 * There is no cover test here: the whole segment was tested by the caller before the tell
 * went out, which is the only reason a jump gets to skip the two-axis slide. A jump that
 * was never checked would put a body on the far side of a wall with no way for the player
 * to have known it was coming.
 */
function put(w: World, i: number, x: number, y: number, r: number): void {
  const enemies = w.enemies;
  enemies.x[i] = Math.min(Math.max(x, w.minX + r), w.maxX - r);
  enemies.y[i] = Math.min(Math.max(y, w.minY + r), w.maxY - r);
}
