/**
 * The ward drone: the one power-up that acts on the world instead of folding a number
 * the weapons read.
 *
 * Everything else in `content/powerups.ts` writes a multiplier that some existing code
 * path consults. A companion that shoots has no existing path to consult, so it lives
 * here: one pass, after the enemy pass (which is what works out `world.nearest` and
 * fills the tick's query buffer) and before the weapon pass (which is what moves and
 * resolves the rounds it puts in the air, so a drone round spends the same tick it was
 * loosed in, exactly like a hand-fired one).
 *
 * Three things shape it:
 *
 * - **It borrows the pistol def rather than inventing a gun.** `DRONE_WEAPON` is the
 *   pistol's index, so the round is delivered by the `projectile` path with the
 *   pistol's falloff and its tracer, and the drone's own numbers are only the ones a
 *   companion needs that a gun does not: how far it will shoot, how often, and how hard
 *   relative to the gun it copies (a full-power pistol on every body would out-damage
 *   the weapon the run chose, so the round carries two thirds of it and the tier buys
 *   *more rounds*, not bigger ones).
 * - **It leads, and it does not spray.** One round per body within reach, aimed at
 *   where the body is going, is what makes a companion read as a marksman rather than as
 *   a second flamethrower; the rotating cursor into the query keeps a five-round volley
 *   from spending itself on whoever happened to sort first.
 * - **It costs nothing when the run has no drone.** The whole pass is behind one
 *   `stats.drone` comparison and, when a body is in reach, one query — so the default
 *   1,000-enemy case pays what AGENTS.md asks of it.
 *
 * No DOM, no engine, no wall clock: the cadence counts ticks, so this runs headless.
 */

import { WEAPONS } from '../../content/weapons';
import { queryRadius } from '../spatialHash';
import { Ev, alloc, pushEvent, type World } from '../world';

/** The gun the drone copies: `WEAPONS[0]`, the pistol. */
const DRONE_WEAPON = 0;

/** m — radius of the ring the drone circles the player in. */
const ORBIT_R = 1.35;

/** rad per tick that it walks round that ring (a little under half a turn a second). */
const ORBIT_W = 0.05;

/** m — how far from the player it will spend a volley. */
const REACH = 14;

/** Ticks between volleys. A quarter of a second, so four a second at the most. */
const GAP = 24;

/** m/s a drone round leaves at. */
const SPEED = 46;

/**
 * Fraction of the copied gun's damage a drone round carries.
 *
 * The tier pips buy rounds, not calibres: five bodies at tier 5 is five rounds a
 * volley at two thirds of a pistol each, which is a companion worth taking while a hand
 * is still weak and a poor buy once a hitscan clears the room faster than the drone can.
 */
const DMG_SCALE = 0.65;

/** Below this length an aim vector counts as no aim, and the round is not loosed. */
const EPS = 1e-6;

/**
 * One tick of the drone: find someone within reach, loose one round each at up to
 * `stats.drone` of them.
 *
 * The volley gate is the tick count rather than a timer because the drone has no
 * magazine, no heat and no cooldown of its own — it is not a hand, and giving it a
 * `WeaponSlot` would put a second set of gauges in `__forgeState()` that the HUD has
 * nowhere to put. The orbit angle comes from the same number for the same reason: it
 * needs no state, and it is the same circle in every run with the same length.
 */
export function updateDrone(w: World): void {
  const tier = w.stats.drone;
  if (tier <= 0) return;
  if (!w.player.alive || w.enemies.count === 0) return;
  if (w.tick % GAP !== 0) return;

  const enemies = w.enemies;
  const player = w.player;

  const found = queryRadius(
    w.hash,
    enemies.x,
    enemies.y,
    w.hash.findable,
    player.x,
    player.y,
    REACH,
    w.query,
  );
  if (found === 0) return;

  const angle = w.tick * ORBIT_W;
  const ox = player.x + Math.cos(angle) * ORBIT_R;
  const oy = player.y + Math.sin(angle) * ORBIT_R;

  const def = WEAPONS[DRONE_WEAPON];
  const dmg = def.dmg * DMG_SCALE;
  const life = REACH / SPEED;
  const shots = w.shots;

  // Where in the query this volley starts, turned one step per volley. Without it a
  // drone over a packed ring would empty every round into the same two bodies.
  let at = (w.tick / GAP) % found;
  let loose = tier;

  for (let k = 0; k < found && loose > 0; k++) {
    // Walk the query from the rotating cursor rather than from its front, so the next
    // volley over the same ring starts at the bodies this one skipped.
    const j = w.query[at];
    at = at + 1 === found ? 0 : at + 1;
    if (enemies.alive[j] === 0 || enemies.hp[j] <= 0) continue;

    const tx = enemies.x[j] - ox;
    const ty = enemies.y[j] - oy;
    const d2 = tx * tx + ty * ty;
    // The query is centred on the player and the drone sits `ORBIT_R` off it, so a
    // body can come back in the list without actually being in reach of the muzzle.
    if (d2 > REACH * REACH || d2 <= EPS) continue;

    // Lead it. The round is in the air for a fifth of a second over that distance and
    // a chaser covers most of its own body length in the time; aimed at the body
    // itself, most drone fire would walk behind the crowd it was loosed at.
    const d = Math.sqrt(d2);
    const flight = d / SPEED;
    const lx = tx + enemies.vx[j] * flight;
    const ly = ty + enemies.vy[j] * flight;
    const len = Math.sqrt(lx * lx + ly * ly);
    if (len <= EPS) continue;

    const ux = lx / len;
    const uy = ly / len;

    const slot = alloc(shots);
    if (slot < 0) return; // no room in the air: the volley is spent, nothing is queued

    shots.x[slot] = ox;
    shots.y[slot] = oy;
    shots.vx[slot] = ux * SPEED;
    shots.vy[slot] = uy * SPEED;
    shots.hp[slot] = dmg;
    shots.life[slot] = life;
    shots.kind[slot] = DRONE_WEAPON;
    // One body per round: the drone is a marksman, and pierce is the copied gun's
    // answer to a line of bodies, not a companion's.
    shots.state[slot] = 1;

    pushEvent(w, Ev.Shot, DRONE_WEAPON, slot, ox, oy);
    loose--;
  }
}