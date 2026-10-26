/**
 * The two marks: bodies that commit to a line before they spend it.
 *
 * The sniper takes the shot from across the room and stops to take it; the orbiter takes it
 * from a circle and does not stop. What they share is the bargain every marksman in this game
 * makes: the line is decided the tick the tell starts and nothing steers after it, so the
 * answer to a marksman is to *move*, and to move after the flash rather than before it. A bolt
 * that curved to follow you would punish exactly the players who read the line — the same
 * reasoning `standoffShoot` gives for its own locked shot — and a bolt aimed at where you
 * *are* when it leaves was never telegraphed at all.
 *
 * The lead is one multiplication, on the player's velocity read the tick the line is painted:
 * enough to punish a body that keeps going in a straight line, and nothing against a body that
 * turns. There is deliberately no lookahead — the sim cannot know a turn coming, and an enemy
 * that could would be answering a question the player never got to ask. The same read takes out
 * the shooter's own travel during the window, because a line that ignores its own muzzle lands
 * beside a player who never moved, and that is a shot with no answer either way.
 *
 * Both spend their rounds through `launchBolt` one file away, so the flight, the hit test and
 * the i-frame gate are the shooter's, not a second copy of them.
 */

import { ENEMIES, type EnemyDef } from '../../../content/enemies';
import { DT, Ev, Tele, TUNE, pushEvent, type World } from '../../world';
import { launchBolt } from '../enemyProjectiles';
import { Phase, advance, drive } from './shared';

/** Below this a painted line counts as no line, and the shot is not spent. */
const EPS = 1e-6;

/**
 * Paint the line on the body's facing slots.
 *
 * The facing is where a locked line has to live: it is already what the telegraph is drawn
 * from and what directional armour is read against, and the pool has no second direction.
 *
 * The aim is the gap the bolt has to close rather than the gap that exists: it takes out the
 * distance the muzzle itself travels while the sight line is up, and adds where the player's
 * velocity says they will be when the bolt arrives. Both reads happen the one tick the line is
 * painted, and nothing steers afterwards.
 *
 * Returns false when there is nothing to aim at, which leaves the body's cooldown alone so
 * the next tick can ask again.
 */
function paintLine(
  w: World,
  i: number,
  dx: number,
  dy: number,
  d: number,
  speed: number,
  windup: number,
): boolean {
  const enemies = w.enemies;
  const player = w.player;
  const flight = d / speed;
  const ax = dx + (player.vx - enemies.vx[i]) * windup + player.vx * flight;
  const ay = dy + (player.vy - enemies.vy[i]) * windup + player.vy * flight;
  const l2 = ax * ax + ay * ay;
  if (l2 <= EPS) return false;

  const l = Math.sqrt(l2);
  enemies.fx[i] = ax / l;
  enemies.fy[i] = ay / l;
  return true;
}

/**
 * Spend the line: `n` rounds, `fan` radians apart, down the facing the body has been holding.
 *
 * One round at `fan` 0 is the sniper's single shot; the orbiter's three are the same call with
 * a spread, which is why the fan is centred rather than one-sided — a spread that only opened
 * to one side is a shot that can be walked with.
 */
function fireLine(w: World, i: number, def: EnemyDef, fan: number, n: number): void {
  const enemies = w.enemies;
  const fx = enemies.fx[i];
  const fy = enemies.fy[i];
  const start = def.radius + TUNE.shotRadius + 0.1;
  const ox = enemies.x[i] + fx * start;
  const oy = enemies.y[i] + fy * start;
  const half = (n - 1) / 2;

  for (let k = 0; k < n; k++) {
    const angle = (k - half) * fan;
    let dx = fx;
    let dy = fy;
    if (angle !== 0) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      dx = fx * c - fy * s;
      dy = fx * s + fy * c;
    }
    launchBolt(w, ox, oy, dx, dy, def.params.boltSpeed, def.params.boltDamage, def.params.boltLife);
  }
}

/**
 * Sniper: find its band, plant, paint it for 0.75 s, and put one fast bolt down what it
 * painted.
 *
 * `bandMin`/`bandMax` are the band: it closes from outside, gives ground inside, and holds
 * station in between, which is what makes it a body you have to *cross* rather than a turret
 * — walk at one and it backs off, and the shot it takes on the way is aimed where you were
 * going, not where you are going. The wind-up is nearly a second because the bolt is a third
 * of a second behind it: the two together are the ~1.2 s of warning DESIGN.md's 400 ms floor
 * is meant to cover, and both are drawn as a sight line (see `render/telegraphs.ts`).
 *
 * The line is painted from the player's position and velocity as they were *before* the body
 * moved this tick, and it does not move again until the bolt is gone.
 */
export function sniperRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const player = w.player;

  if (enemies.phase[i] === Phase.Windup) {
    // Feet off the throttle for the whole window: a line painted by something that is also
    // walking is a decal, and this archetype's whole answer is that you had time.
    enemies.vx[i] = 0;
    enemies.vy[i] = 0;
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      fireLine(w, i, def, 0, 1);
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
  if (d > def.params.bandMax) {
    vx = nx * def.speed;
    vy = ny * def.speed;
  } else if (d < def.params.bandMin) {
    vx = -nx * def.speed;
    vy = -ny * def.speed;
  }
  drive(w, i, def, vx, vy);

  // In the band and cooled down: commit. Past `bandMax` a bolt is a warning shot, and inside
  // `bandMin` the body that fired it is standing in the open with its feet still set.
  if (
    d >= def.params.bandMin &&
    d <= def.params.bandMax &&
    enemies.timer[i] <= 0 &&
    paintLine(w, i, dx, dy, d, def.params.boltSpeed, def.params.windup)
  ) {
    enemies.phase[i] = Phase.Windup;
    enemies.timer[i] = def.params.windup;
    pushEvent(w, Ev.Telegraph, i, Tele.Line, enemies.x[i], enemies.y[i]);
  }
}

/**
 * Orbiter: walk a circle around the player and shoot from it.
 *
 * It holds `orbitRadius` metres of distance by combining sideways travel with a spring back
 * onto the ring — the armored's shape of problem, with a gun attached. The spring is what
 * makes "it keeps its distance" true in both directions: a player who runs is chased rather
 * than watched, and a player who charges in is backed off, so the circle reforms every time
 * the player changes their mind. `slack` is how far outside the ring it will still spend a
 * shot, and past `orbitRadius + slack` the fan is not worth a lock.
 *
 * Unlike everything else that shoots, it does not stop to aim: the ring *is* its feet, and a
 * body that stopped circling to fire would present the one thing this archetype exists to
 * deny — a fixed bearing. `orbit` is the fraction of its cruise spent sideways, so the circle
 * is a walk rather than a stand, and half the pack goes one way and half the other (by slot
 * parity, as the armored does) so a pair that arrives together does not march in single file.
 */
export function orbiterRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const player = w.player;

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

  // Sideways plus spring. `inOut` is clamped to a body speed, so a player who sprints is
  // chased at cruise plus whatever the cap in `drive` allows, and is never watched from a
  // circle that no longer contains them.
  const spin = (i & 1) === 0 ? 1 : -1;
  const side = def.params.orbit * def.speed * spin;
  const drift = (d - def.params.orbitRadius) * def.params.spring;
  const inOut = drift > 1 ? 1 : drift < -1 ? -1 : drift;
  const vx = -ny * side + nx * def.speed * inOut;
  const vy = nx * side + ny * def.speed * inOut;

  if (enemies.phase[i] === Phase.Windup) {
    // The line stays where it was painted for the whole window, which is why this walks
    // through `advance` rather than `drive`: `drive` turns the facing toward wherever the
    // body is going, and a sight line that swings with the strafe is not a sight line. The
    // same trade the charger's dash makes, for the same reason — see rushers.ts.
    enemies.vx[i] = vx;
    enemies.vy[i] = vy;
    advance(w, i, def);
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      fireLine(w, i, def, def.params.fan, def.params.bolts);
      enemies.phase[i] = Phase.Seek;
      enemies.timer[i] = def.params.shotGap;
    }
    return;
  }

  drive(w, i, def, vx, vy);

  if (enemies.timer[i] > 0) {
    enemies.timer[i] -= DT;
    return;
  }
  if (d > def.params.orbitRadius + def.params.slack) return;
  if (paintLine(w, i, dx, dy, d, def.params.boltSpeed, def.params.windup)) {
    enemies.phase[i] = Phase.Windup;
    enemies.timer[i] = def.params.windup;
    pushEvent(w, Ev.Telegraph, i, Tele.Line, enemies.x[i], enemies.y[i]);
  }
}
