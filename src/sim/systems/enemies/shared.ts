/**
 * The half of the enemy pass that more than one behaviour needs.
 *
 * The travel tail — `seekDrive`, `drive`, `face`, `advance` — is here so separation, the
 * speed cap, the facing and the arena clamp are one answer for every body rather than one
 * answer per behaviour, and the phase ids are here because a behaviour's state machine and
 * the stagger a hit gives it have to survive each other.
 */

import { type EnemyDef } from '../../../content/enemies';
import { ELITES, type EliteDef } from '../../../content/levels';
import { DT, type World } from '../../world';
import { canTravel } from '../obstacles';
import { queryRadius } from '../../spatialHash';

/** Separation stops paying for itself past this many neighbours examined. */
const SEP_CAP = 24;

/**
 * Behaviour phases, in the pool's `phase` slot.
 *
 * Kept beside `state` rather than inside it because a behaviour's phase and the stagger a
 * hit gives it are two facts that have to survive each other: a charger knocked out of its
 * wind-up is still a charger in a wind-up, it is just reeling.
 */
export const Phase = { Seek: 0, Windup: 1, Dash: 2, Recover: 3, Fuse: 4, Orbit: 5 } as const;

/** The golden angle, in radians. See `spawnEnemy` and `killEnemy` for what it does. */
export const GOLDEN_ANGLE = 2.399_963_229_728_653;

/**
 * How far the body being stepped through is allowed to travel this tick, as a fraction
 * of its own velocity.
 *
 * One module-scratch scalar rather than an argument, for the same reason `w.blasts.depth`
 * and `chainHits` are scratch: it is a fact about the body currently being handled, it
 * never outlives the tick, and threading it through `drive` and `face` and the four
 * behaviours that call `advance` would put a number about *slowness* in six signatures
 * that have nothing to do with slowness. Written once per body at the top of the loop in
 * `updateEnemies`, read once per travel step in `advance` — which is why it is a slot in a
 * shared object rather than a module scalar: the pass that writes it and the tail that reads
 * it are two modules now, and a copy each way is a field that never slows anything.
 */
/** The one slot `updateEnemies` writes and `advance` reads. See above. */
export const scratch = { travel: 1 };

/** The variant a body came in as, or undefined for a plain one. */
export function eliteOf(w: World, i: number): EliteDef | undefined {
  const at = w.enemies.elite[i];
  return at === 0 ? undefined : ELITES[at - 1];
}

/**
 * Straight-line seek at the archetype's cruise speed, through the crowd.
 *
 * Kept to one call so the separation, the speed cap and the facing are the same answer for
 * every body that simply walks at you, and so a new archetype that only needs to walk is
 * one data entry rather than one function.
 */
export function seekDrive(w: World, i: number, def: EnemyDef): void {
  const enemies = w.enemies;
  const player = w.player;
  let vx = 0;
  let vy = 0;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    vx = (dx / d) * def.speed;
    vy = (dy / d) * def.speed;
  }
  drive(w, i, def, vx, vy);
}

/** True on the tick one body's `gap`-second beat turns over. */
export function onBeat(age: number, gap: number): boolean {
  return Math.floor((age - DT) / gap) !== Math.floor(age / gap);
}

/**
 * Steer `vx`/`vy` through the crowd, then move.
 *
 * The shared half of every behaviour: personal space, a cap so a shove cannot make a body
 * faster than its own gait, the facing that directional armour and the shield quad are read
 * from, and one travel step that keeps the whole body inside the arena.
 */
export function drive(w: World, i: number, def: EnemyDef, vx: number, vy: number): void {
  const enemies = w.enemies;
  const sepRadius = def.params.sepRadius;
  const push = def.params.sepPush;
  const found = queryRadius(
    w.hash,
    enemies.x,
    enemies.y,
    enemies.alive,
    enemies.x[i],
    enemies.y[i],
    sepRadius,
    w.query,
  );
  const seen = found < SEP_CAP ? found : SEP_CAP;
  for (let k = 0; k < seen; k++) {
    const j = w.query[k];
    if (j === i || enemies.hp[j] <= 0) continue;
    const ox = enemies.x[i] - enemies.x[j];
    const oy = enemies.y[i] - enemies.y[j];
    const o2 = ox * ox + oy * oy;
    if (o2 >= sepRadius * sepRadius || o2 <= 1e-12) continue;
    const od = Math.sqrt(o2);
    const weight = (1 - od / sepRadius) * push;
    vx += (ox / od) * weight;
    vy += (oy / od) * weight;
  }

  // Cap the sum so a shove cannot make a walker faster than its own dash. The charger's
  // dash sets its velocity directly and never comes through here, which is the point: a
  // charge is supposed to be faster than a walk.
  const cap = def.speed * 1.35;
  const speed2 = vx * vx + vy * vy;
  if (speed2 > cap * cap) {
    const k = cap / Math.sqrt(speed2);
    vx *= k;
    vy *= k;
  }

  enemies.vx[i] = vx;
  enemies.vy[i] = vy;
  face(w, i, def, vx, vy);
  advance(w, i, def);
}

/**
 * Turn the body's front toward where it is actually going.
 *
 * A lag rather than a snap, and a renormalise after it: lerping a unit vector toward
 * another shortens it, and `armorAgainst` reads a dot product, so a facing allowed to
 * shrink would quietly make armour weaker the harder a body turned. The low-`faceLag` cases
 * are the interesting ones — the armored turns slowly enough that flanking it is something
 * a player does on purpose.
 */
function face(w: World, i: number, def: EnemyDef, vx: number, vy: number): void {
  const enemies = w.enemies;
  const speed2 = vx * vx + vy * vy;
  if (speed2 <= 1e-12) return;

  const speed = Math.sqrt(speed2);
  const tx = vx / speed;
  const ty = vy / speed;
  let fx = enemies.fx[i];
  let fy = enemies.fy[i];

  if (fx === 0 && fy === 0) {
    enemies.fx[i] = tx;
    enemies.fy[i] = ty;
    return;
  }

  // A body that declares no `faceLag` turns instantly: the number is a lag, so a big one
  // means no lag, and the clamp keeps a big one from overshooting the heading it wants.
  const lag = def.params.faceLag ?? 64;
  const k = Math.min(1, lag * DT);
  fx += (tx - fx) * k;
  fy += (ty - fy) * k;
  const n2 = fx * fx + fy * fy;
  if (n2 > 1e-12) {
    const n = 1 / Math.sqrt(n2);
    enemies.fx[i] = fx * n;
    enemies.fy[i] = fy * n;
  } else {
    enemies.fx[i] = tx;
    enemies.fy[i] = ty;
  }
}

/**
 * One tick of travel, kept inside the arena and out of the cover.
 *
 * Cover is tested one axis at a time, and that is what turns a wall into a slide: a body
 * running at a wall face-on loses the axis that hit it and keeps the axis that did not, so it
 * goes along the wall instead of sticking to it. Nothing is remembered between ticks and no
 * steering is added, which is the whole reason a thousand bodies can afford the test — and
 * the reason a body that is properly shut in stops, rather than edging through a corner.
 *
 * Both axes are *sweeps* rather than point checks. A dash crosses 0.37 m in one tick and a
 * charger's dash is faster than that, so a test on the destination alone would let a body
 * arrive on the far side of anything thinner than its own stride, which is the same failure
 * the round path guards against for the same reason.
 */
export function advance(w: World, i: number, def: EnemyDef): void {
  const enemies = w.enemies;
  const r = def.radius;
  const dx = enemies.vx[i] * DT * scratch.travel;
  const dy = enemies.vy[i] * DT * scratch.travel;
  const x = enemies.x[i];
  const y = enemies.y[i];

  if (dx !== 0) {
    if (canTravel(w.props, x, y, dx, 0, r)) enemies.x[i] = x + dx;
    else enemies.vx[i] = 0;
  }
  if (dy !== 0) {
    if (canTravel(w.props, enemies.x[i], y, 0, dy, r)) enemies.y[i] = y + dy;
    else enemies.vy[i] = 0;
  }

  enemies.x[i] = Math.min(Math.max(enemies.x[i], w.minX + r), w.maxX - r);
  enemies.y[i] = Math.min(Math.max(enemies.y[i], w.minY + r), w.maxY - r);
}