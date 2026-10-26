/**
 * Death and what it leaves behind: the shard, the burst, the children.
 *
 * A blast is queued here and paid out later in the tick by `resolveBlasts`, because the
 * kill happens in the middle of a shot that is still walking the tick's one shared query
 * buffer, and because a burst that kills a second bomber wants a stack to land on rather
 * than recursion.
 */

import { ENEMIES, enemyIndex } from '../../../content/enemies';
import { Ev, TUNE, alloc, pushEvent, release, type World } from '../../world';
import { range } from '../../rng';
import { queryRadius } from '../../spatialHash';
import { hurtPlayer } from '../enemyProjectiles';
import { GOLDEN_ANGLE } from './shared';
import { spawnEnemy } from './spawn';

/**
 * How many blasts deep one detonation may chain.
 *
 * Four is enough to empty a chamber of bombers and still finite, which is the point: with
 * no depth in it, a run can end on the tick a grenadier is shot, because every bomb that
 * died went off inside every other one's radius, in one tick, forever.
 */
const MAX_BLAST_CHAIN = 4;

/**
 * Put a burst on the stack instead of resolving it.
 *
 * Returns false and counts the loss when the stack is full, which at thirty-two waiting
 * bursts means the floor is already on fire and one more would not be the thing that decides
 * the run. Counting it is the point: a burst that vanished silently is a bug nobody sees.
 *
 * Exported because the floor fires one too: a crusher plate is the same object to the sim as
 * a detonation, and paying it out through the same resolver is what makes "read the ring,
 * leave the ring" one rule in this game rather than two.
 */
export function queueBlast(w: World, x: number, y: number, r: number, dmg: number, depth: number): boolean {
  const stack = w.blasts;
  if (stack.count >= stack.cap) {
    stack.dropped++;
    return false;
  }
  const at = stack.count++;
  stack.x[at] = x;
  stack.y[at] = y;
  stack.r[at] = r;
  stack.dmg[at] = dmg;
  stack.chain[at] = depth;
  return true;
}

/**
 * Kill a dead enemy: score, the kill event, the XP shard the body drops, and whatever it
 * takes with it.
 *
 * Called from the damage pass the moment a hit takes an enemy to 0 HP rather than from a
 * sweep at the end of the tick, because a corpse left in the pool for a tick still blocks
 * the crowd and still takes shots. Releasing the slot here is also what keeps a second shot
 * in the same tick from spending a pierce on it: the hash query skips dead slots.
 *
 * Shard `kind` carries the archetype, which is where its XP value comes from.
 *
 * The two legacies a death can leave are both read from the body while it is still in its
 * slot, which is why they sit above the release: a blast is queued for `resolveBlasts` to
 * spend later in the tick, and the children a splitter comes apart into are put down around
 * where it stood, so a splitter killed in the middle of the room is a different situation
 * from one killed with its back to a wall.
 */
export function killEnemy(w: World, i: number): void {
  const enemies = w.enemies;
  const shards = w.shards;
  const def = ENEMIES[enemies.kind[i]];

  w.kills++;
  w.score += def.xp * 10;
  pushEvent(w, Ev.Kill, i, enemies.kind[i], enemies.x[i], enemies.y[i]);

  const s = alloc(shards);
  if (s >= 0) {
    shards.x[s] = enemies.x[i];
    shards.y[s] = enemies.y[i];
    // A small arc off the body, so a death burst scatters instead of stacking
    // every shard on one point.
    shards.vx[s] = range(w.rng, -1.2, 1.2);
    shards.vy[s] = range(w.rng, -1.2, 1.2);
    shards.kind[s] = enemies.kind[i];
    shards.life[s] = TUNE.shardLife;
  }

  const radius = def.params.blastRadius;
  if (radius !== undefined && radius > 0) {
    queueBlast(w, enemies.x[i], enemies.y[i], radius, def.params.blastDamage, w.blasts.depth);
  }

  const split = def.splits;
  if (split !== undefined) {
    const child = enemyIndex(split.def);
    if (child >= 0) {
      const childDef = ENEMIES[child];
      const gap = def.radius + childDef.radius + 0.18;
      // Evenly spaced, turned by a stride of the slot so a splitter does not always put its
      // children down in the same orientation. They arrive at full health, which is the cost
      // of the mechanic: three bodies that run most of the speed of the gun that just killed
      // their parent.
      for (let k = 0; k < split.count; k++) {
        const a = k * ((Math.PI * 2) / split.count) + i * GOLDEN_ANGLE;
        spawnEnemy(w, child, enemies.x[i] + Math.cos(a) * gap, enemies.y[i] + Math.sin(a) * gap);
      }
    }
  }

  release(enemies, i);
}

/**
 * Pay out the bursts the tick has built up, once per tick, after the weapons have run.
 *
 * Later than the kills that queued them for two reasons, and they are the reason blasts are
 * a stack at all: a shot resolving a pierce is still walking the tick's one shared query
 * buffer, and a blast that queried it there would rewrite the list the shot is standing in;
 * and a burst that kills a second bomber queues another burst, which wants a place to land
 * rather than a second copy of this function underneath the first.
 *
 * A burst takes damage off the player through the same i-frame gate a hug uses — it neither
 * bypasses it nor ignores it — and off other bodies through their armour, which is how a
 * chamber of exploders becomes a chain reaction you set off somewhere you would rather not
 * be standing. The depth cap and the guard both exist so no arrangement of bodies can make
 * one tick outlast the tick after it.
 */
export function resolveBlasts(w: World): void {
  const stack = w.blasts;
  if (stack.count === 0) return;

  const enemies = w.enemies;
  const player = w.player;
  let guard = stack.cap * 4;

  while (stack.count > 0 && guard-- > 0) {
    const at = --stack.count;
    const x = stack.x[at];
    const y = stack.y[at];
    const r = stack.r[at];
    const dmg = stack.dmg[at];
    const depth = stack.chain[at];
    if (depth >= MAX_BLAST_CHAIN) continue;
    stack.depth = depth + 1;

    const px = player.x - x;
    const py = player.y - y;
    const reach = r + TUNE.playerRadius;
    if (px * px + py * py <= reach * reach) hurtPlayer(w, dmg, 8);

    const found = queryRadius(
      w.hash,
      enemies.x,
      enemies.y,
      enemies.alive,
      x,
      y,
      r + TUNE.shotRadius,
      w.query,
    );

    for (let k = 0; k < found; k++) {
      const j = w.query[k];
      if (enemies.hp[j] <= 0) continue;

      const def = ENEMIES[enemies.kind[j]];
      const dx = enemies.x[j] - x;
      const dy = enemies.y[j] - y;
      const d2 = dx * dx + dy * dy;
      const bodyReach = r + def.radius;
      if (d2 > bodyReach * bodyReach) continue;

      // A burst is omnidirectional, so it pays the flat plate: directional armour is about
      // where damage came from, and a blast comes from everywhere at once.
      let dealt = dmg - def.armor;
      if (dealt < 1) dealt = 1;
      enemies.hp[j] -= dealt;
      pushEvent(w, Ev.Hit, -1, j, enemies.x[j], enemies.y[j]);
      if (enemies.hp[j] <= 0) killEnemy(w, j);
    }

    pushEvent(w, Ev.Explosion, -1, Math.round(r * 10), x, y);
  }

  stack.depth = 0;
  stack.count = 0;
}