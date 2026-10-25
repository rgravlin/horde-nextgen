/**
 * Enemy pass: behaviours, contact damage and deaths.
 *
 * `AI` is the dispatch table: one small function per behaviour, keyed by the ai id
 * the content names, so an archetype stays data and a behaviour nobody wrote is a
 * typecheck error rather than an enemy that quietly stands still. A behaviour
 * writes only through the pooled arrays and keeps its state machine in the pool's
 * `state` slot, so nothing here allocates.
 */

import { ENEMIES, type AiId, type EnemyDef } from '../../content/enemies';
import { range } from '../rng';
import { queryRadius } from '../spatialHash';
import { DT, Ev, TUNE, alloc, pushEvent, release, type World } from '../world';

/** One tick of one enemy's behaviour. */
type AiFn = (w: World, i: number) => void;

/**
 * Keys are the ai ids in content/enemies.ts and the record has to cover all of
 * them, which is what makes adding an id without adding a behaviour fail the
 * typecheck.
 */
const AI: Record<AiId, AiFn> = {
  chaser: seekChaser,
};

/** Separation stops paying for itself past this many neighbours examined. */
const SEP_CAP = 24;

/**
 * Put an enemy of `def` at (x, y), healthy and with its archetype's HP.
 *
 * Shared by the wave spawner, the debug spawn hook and the tests, so a spawned
 * enemy always starts the way content says it does. Returns the slot, or -1 when
 * the pool is full.
 */
export function spawnEnemy(w: World, def: number, x: number, y: number): number {
  const i = alloc(w.enemies);
  if (i < 0) return -1;
  const enemy = w.enemies;
  enemy.x[i] = x;
  enemy.y[i] = y;
  enemy.kind[i] = def;
  enemy.hp[i] = ENEMIES[def].hp;
  pushEvent(w, Ev.Spawn, i, def, x, y);
  return i;
}

/**
 * Run every live enemy's behaviour, then let it hit the player.
 *
 * Also leaves `enemyNear` behind: the closest enemy distance measured before
 * anything moved, which is what the auto-fire decision reads. Enemies already at
 * 0 HP are skipped — the damage pass that killed them has already dropped their
 * shard and given the slot back.
 */
export function updateEnemies(w: World): void {
  const enemies = w.enemies;
  const player = w.player;
  let nearest2 = Infinity;

  for (let i = 0; i < enemies.cap; i++) {
    if (enemies.alive[i] === 0) continue;
    if (enemies.hp[i] <= 0) continue;

    const dx = player.x - enemies.x[i];
    const dy = player.y - enemies.y[i];
    const d2 = dx * dx + dy * dy;
    if (d2 < nearest2) nearest2 = d2;

    const def = ENEMIES[enemies.kind[i]];
    AI[def.ai](w, i);
    contact(w, def, d2);
  }

  w.enemyNear = nearest2 === Infinity ? Infinity : Math.sqrt(nearest2);
}

/**
 * Seek the player through the crowd.
 *
 * Two states, both in `state`: above 0 the enemy is staggering from a hit and
 * rides the shove it was given, otherwise it steers at the player and shoves
 * neighbours out of its personal space, so the pack presses as a crowd with gaps
 * instead of one overlapping blob (DESIGN.md: the horde has to stay readable).
 */
function seekChaser(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];

  if (enemies.state[i] > 0) {
    enemies.state[i]--;
    advance(w, i, def);
    return;
  }

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

  // Cap the sum so a shove cannot make a chaser faster than its own dash.
  const cap = def.speed * 1.35;
  const speed2 = vx * vx + vy * vy;
  if (speed2 > cap * cap) {
    const k = cap / Math.sqrt(speed2);
    vx *= k;
    vy *= k;
  }

  enemies.vx[i] = vx;
  enemies.vy[i] = vy;
  advance(w, i, def);
}

/** One tick of travel, kept inside the arena so a pack cannot flank through a wall. */
function advance(w: World, i: number, def: EnemyDef): void {
  const enemies = w.enemies;
  enemies.x[i] += enemies.vx[i] * DT;
  enemies.y[i] += enemies.vy[i] * DT;
  enemies.x[i] = Math.min(Math.max(enemies.x[i], w.minX + def.radius), w.maxX - def.radius);
  enemies.y[i] = Math.min(Math.max(enemies.y[i], w.minY + def.radius), w.maxY - def.radius);
}

/**
 * Contact damage, gated by i-frames.
 *
 * The first hit spends the player's invulnerability, so a pack that arrives all
 * at once costs one hit rather than one per body — which is what keeps a horde of
 * a thousand survivable. `d2` is the squared distance from before the enemy moved.
 */
function contact(w: World, def: EnemyDef, d2: number): void {
  const player = w.player;
  if (!player.alive || player.iframes > 0) return;

  const reach = TUNE.playerRadius + def.radius + def.params.touchRange;
  if (d2 > reach * reach) return;

  const dmg = def.params.touchDamage;
  player.hp = player.hp > dmg ? player.hp - dmg : 0;
  player.iframes = TUNE.hurtIframes;
  // `a` is trauma x 10, which is how the camera turns this into shake.
  pushEvent(w, Ev.Shake, 3, 0, player.x, player.y);

  if (player.hp <= 0) {
    player.alive = false;
    w.over = true;
    pushEvent(w, Ev.Death, 0, 0, player.x, player.y);
  }
}

/**
 * Kill a dead enemy: score, the kill event, and the XP shard the body drops.
 *
 * Called from the damage pass the moment a hit takes an enemy to 0 HP rather than
 * from a sweep at the end of the tick, because a corpse left in the pool for a
 * tick still blocks the crowd and still takes shots. Releasing the slot here is
 * also what keeps a second shot in the same tick from spending a pierce on it:
 * the hash query skips dead slots.
 *
 * Shard `kind` carries the archetype, which is where its XP value comes from.
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

  release(enemies, i);
}