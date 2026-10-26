/**
 * The ranged trio: bodies that refuse to press in.
 *
 * The armored circles at arm's length to keep its plate toward the fight, the shooter stops
 * to deliver one bolt down a locked line, and the grenadier plants to ring the player's
 * feet. What they share is the refusal; what they do instead is different enough that each
 * one earns a function. The shots they trigger are delivered by
 * `systems/enemyProjectiles.ts`.
 */

import { ENEMIES } from '../../../content/enemies';
import { DT, Ev, Tele, TUNE, pushEvent, type World } from '../../world';
import { launchBolt, lobGrenade } from '../enemyProjectiles';
import { Phase, drive } from './shared';

/**
 * Armored: close, then circle at arm's length.
 *
 * It stops at a four metre ring rather than pressing into the player, and spends most of
 * its speed going sideways — which is what makes its plate a positioning puzzle instead of
 * a tax. Its facing follows where it is going and lags that by a quarter of a second, so a
 * body walking in a circle presents its flank to the middle of it. Running past one, or
 * knocking it sideways and shooting the flat side, is the answer to it; standing in front
 * of it and holding the trigger is not.
 */
export function standoffOrbit(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const player = w.player;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;
  const ring = def.params.standoff;

  if (d2 > ring * ring) {
    const d = Math.sqrt(d2);
    enemies.phase[i] = Phase.Seek;
    drive(w, i, def, (dx / d) * def.speed, (dy / d) * def.speed);
    return;
  }
  if (d2 <= 1e-12) {
    drive(w, i, def, 0, 0);
    return;
  }

  enemies.phase[i] = Phase.Orbit;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  // Half the pack circles one way and half the other, by slot parity: no extra state to
  // carry, and a pair that arrives together does not march in single file.
  const spin = (i & 1) === 0 ? 1 : -1;
  const orbit = def.params.orbit;
  // Sideways travel plus a spring on the ring, so it holds the distance instead of sliding
  // past it, and so a player who runs away is followed rather than watched.
  const drift = (d - ring) * 2;
  const speed = def.speed;
  const vx = (-ny * orbit * spin + nx * drift) * speed;
  const vy = (nx * orbit * spin + ny * drift) * speed;
  drive(w, i, def, vx, vy);
}

/**
 * Shooter: hold a band, plant, flash, fire.
 *
 * The armored's ranged cousin: it also refuses to press in, but where the armored
 * circles to present a plate the shooter stops to deliver a bolt. `standMin` and
 * `standMax` are the band it works at — past `standMax` it closes, inside `standMin`
 * it gives ground, in between it plants; `windup` is the seconds of red flash before
 * the bolt leaves, at DESIGN.md's 400 ms floor and read across a crowd because the
 * bolt is slow; `shotGap` is the seconds of cooldown between volleys; and the bolt
 * itself carries `boltSpeed`, `boltDamage` and `boltLife`.
 *
 * The line is locked the tick the flash starts and does not steer after it, which is
 * what makes the telegraph worth answering: a bolt that curved to follow you would
 * punish exactly the players who read it. The shot itself is spent one file away in
 * `enemyProjectiles.ts` — this function only decides when to pull the trigger, and
 * keeps its feet busy in between.
 */
export function standoffShoot(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const player = w.player;

  if (enemies.phase[i] === Phase.Windup) {
    // Feet off the throttle for the whole flash, same bargain as the charger's
    // wind-up: a thirty-tick window to step off a line that will not steer.
    enemies.vx[i] = 0;
    enemies.vy[i] = 0;
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      // Fired down the locked facing, starting clear of the body so the first step
      // of its sweep cannot start inside anything.
      const fx = enemies.fx[i];
      const fy = enemies.fy[i];
      const start = def.radius + TUNE.shotRadius + 0.1;
      launchBolt(
        w,
        enemies.x[i] + fx * start,
        enemies.y[i] + fy * start,
        fx,
        fy,
        def.params.boltSpeed,
        def.params.boltDamage,
        def.params.boltLife,
      );
      enemies.phase[i] = Phase.Seek;
      enemies.timer[i] = def.params.shotGap;
    }
    return;
  }

  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;
  if (d2 <= 1e-12) {
    drive(w, i, def, 0, 0);
    return;
  }

  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;

  let vx = 0;
  let vy = 0;
  if (d > def.params.standMax) {
    vx = nx * def.speed;
    vy = ny * def.speed;
  } else if (d < def.params.standMin) {
    vx = -nx * def.speed;
    vy = -ny * def.speed;
  }
  drive(w, i, def, vx, vy);

  if (d >= def.params.standMin && d <= def.params.standMax && enemies.timer[i] <= 0) {
    enemies.fx[i] = nx;
    enemies.fy[i] = ny;
    enemies.phase[i] = Phase.Windup;
    enemies.timer[i] = def.params.windup;
    // The `Line` shape is the sniper's thin sight (DESIGN.md): drawn from the
    // locked facing for as long as the body's timer says wind-up is left.
    pushEvent(w, Ev.Telegraph, i, Tele.Line, enemies.x[i], enemies.y[i]);
  }
}

/**
 * Grenadier: walk to lob range, plant, and ring the player's feet.
 *
 * `lobRange` is how far it will throw and `lobMin` how close it will throw from;
 * outside the band it walks (closing, or backing away when the player has inside
 * itself on it — the same reasoning as the charger's `nearRange`: a threat with no
 * room to be read is not a telegraph, it is just damage). Inside, it plants and
 * lobs on `lobGap` seconds.
 *
 * The lob lands where the player was when it went up. The flight is the throw
 * distance over `arcSpeed`, and the band's floor is four metres against a bomb that
 * travels ten, so a ring only ever opens with at least 0.4 s of fill in it — read
 * the ring, walk out of it, and the lob spent itself on empty floor. The ring
 * announces itself at the landing point (`Tele.RingAt`, whose centre is the event's
 * x/y) the tick the grenade leaves the body, and the grenade carries the fill.
 */
export function lobRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const player = w.player;

  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;
  if (d2 <= 1e-12) {
    drive(w, i, def, 0, 0);
    return;
  }

  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;

  if (d > def.params.lobRange) {
    drive(w, i, def, nx * def.speed, ny * def.speed);
    return;
  }
  if (d < def.params.lobMin) {
    drive(w, i, def, -nx * def.speed, -ny * def.speed);
    return;
  }

  // In the band: plant, and lob on the beat. The ring and the grenade go out on the
  // same tick, at the player's feet as read now — the point the dodge test walks
  // out of, and the point the standing player is still on when the ring fills.
  drive(w, i, def, 0, 0);

  if (enemies.timer[i] <= 0) {
    enemies.timer[i] = def.params.lobGap;
    pushEvent(w, Ev.Telegraph, i, Tele.RingAt, player.x, player.y);
    lobGrenade(
      w,
      enemies.x[i],
      enemies.y[i],
      nx,
      ny,
      def.params.arcSpeed,
      d / def.params.arcSpeed,
      def.params.blastDamage,
      def.params.blastRadius,
    );
  }
}