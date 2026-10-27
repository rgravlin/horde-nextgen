/**
 * Spawner: a body whose damage is other bodies.
 *
 * It has no shot, no burst and no charge, which is what makes it different from the
 * broodmother rather than a small one: the boss is a wall you walk around while its brood
 * closes behind you, and this is an escort you are meant to *decide* about. Every second it
 * stands is three more bodies on the floor, so the chapter asks the question the healer
 * asks — do I spend the now-gun on the support or on the crowd it is standing behind — and
 * prices it higher, because the crowd here is the one that arrives.
 *
 * Its feet are the other half of that question and they are deliberately unwelcome. While
 * it still has a brood to pay it keeps `keepMin` metres between itself and the player:
 * backing off rather than pressing in means the answer is never "let it walk into the gun",
 * it is "go and get it", and going and getting it costs the ground the pack in front of it
 * is standing on. It also lays its young *behind* itself, fanned across its back, so the
 * chase walks you through the trail — the splitter's lesson, spent on a body that keeps
 * paying it out for eight seconds first.
 *
 * Once the broods are gone it stops backing off and walks at you at a shade over its cruise.
 * That is not a second mechanic bolted on: it is how the faucet tells you it has run dry. A
 * support that retreats for eight seconds and then does nothing would be a decoration you
 * could ignore, and one that retreats forever would be a body you cannot make stop. The
 * change of feet is the read, and the read is the cue to have killed it four seconds ago.
 */

import { ENEMIES, enemyIndex, type EnemyDef } from '../../../content/enemies';
import { DT, type World } from '../../world';
import { spawnEnemy } from './spawn';
import { drive } from './shared';

/** Radians between the young in one brood, measured across the body's back. */
const FAN = 0.55;

/**
 * One tick of the spawner.
 *
 * `phase` counts the broods already paid out against the def's `spawnBroods`, and `timer` is
 * the beat — the same two slots the broodmother runs its broods on, and for the same reason:
 * this behaviour wants a countdown and a counter, and the pool gives one clock per body.
 */
export function spawnerRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];

  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

  const armed = enemies.phase[i] < def.params.spawnBroods;
  if (armed && enemies.timer[i] <= 0) {
    enemies.timer[i] = def.params.spawnGap;
    enemies.phase[i]++;
    layBrood(w, i, def);
  }

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

  // Armed and inside the distance it is trying to hold: run the other way. Past that
  // distance, or out of broods, it comes — and it comes on the same bearing either way, so
  // the only difference a player can feel between the two halves is which way the sac is
  // going, which is exactly the difference the archetype is built on. The one point of
  // plate is what buys the retreat its time: a body that runs while it empties still has to
  // be caught, and a chase it chooses is a chase the player has to spend ground on.
  const away = armed && d < def.params.keepMin;
  const speed = def.speed * (armed ? 1 : def.params.brawlerSpeed);
  drive(w, i, def, (away ? -nx : nx) * speed, (away ? -ny : ny) * speed);
}

/**
 * Put one brood down behind the body, on the side away from the player.
 *
 * Behind it, and that is the whole design: young that drop between the spawner and the
 * player would arrive inside the player's eyeline, which is the one thing the wave spawner
 * refuses to do for a pack and this refuses for a brood, and they would land in the middle
 * of the gun fire that is already aimed at their parent. Behind it, they do the slower and
 * worse kind of damage — they make the room you are standing in smaller.
 *
 * The young start at full health, which is the cost of the mechanic, and the pool's cap
 * still applies: `spawnEnemy` returns -1 on a full pool, so a chapter that fills the arena
 * stops growing rather than growing past the arrays.
 */
function layBrood(w: World, i: number, def: EnemyDef): void {
  const enemies = w.enemies;
  const young = def.brood;
  if (young === undefined) return;

  const child = enemyIndex(young.def);
  if (child < 0) return;

  const childDef = ENEMIES[child];
  const player = w.player;
  const gap = def.radius + childDef.radius + def.params.spawnSpread;

  // The fan opens across the back, centred on the line away from the player, so at least
  // one of them always lands somewhere the player has to walk over to reach the parent.
  const back = Math.atan2(enemies.y[i] - player.y, enemies.x[i] - player.x);
  const half = (young.count - 1) / 2;
  for (let k = 0; k < young.count; k++) {
    const a = back + (k - half) * FAN;
    spawnEnemy(w, child, enemies.x[i] + Math.cos(a) * gap, enemies.y[i] + Math.sin(a) * gap);
  }
}
