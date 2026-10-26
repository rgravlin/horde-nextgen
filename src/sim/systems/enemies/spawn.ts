/**
 * Putting a body down: the one way an enemy arrives, whether a wave clock, a debug hook or
 * a splitter's children asked for it.
 */

import { ENEMIES } from '../../../content/enemies';
import { ELITES } from '../../../content/levels';
import { Ev, alloc, pushEvent, type World } from '../../world';
import { pointBlocked, pushOut, pushedX, pushedY } from '../obstacles';
import { eliteRoster, rollElite } from '../powerups';
import { GOLDEN_ANGLE } from './shared';

/**
 * Put an enemy of `def` at (x, y), healthy and with its archetype's HP.
 *
 * Shared by the wave spawner, the debug spawn hook and the tests, so a spawned enemy
 * always starts the way content says it does. The position is pulled inside the arena by
 * its own radius, because those three callers each have their own idea of where a body may
 * go and only the clamp has to be the same answer in all of them. Returns the slot, or -1
 * when the pool is full.
 */
export function spawnEnemy(w: World, def: number, x: number, y: number): number {
  const i = alloc(w.enemies);
  if (i < 0) return -1;
  const enemy = w.enemies;
  const shape = ENEMIES[def];
  let px = Math.min(Math.max(x, w.minX + shape.radius), w.maxX - shape.radius);
  let py = Math.min(Math.max(y, w.minY + shape.radius), w.maxY - shape.radius);

  // A body put down inside cover comes out of the cover on the far side, which is the one
  // arrival this game has no warning for: the telegraphs all face the other way. So a spawn
  // point that is not clear is moved to the nearest one that is, and a spawn point with no
  // clear room within eight metres still puts the body down — a wave refused for want of a
  // doorway would empty a chapter silently, and an empty chapter is the harder bug to see.
  if (w.props.n > 0 && pointBlocked(w.props, px, py, shape.radius) && pushOut(w.props, shape.radius, px, py)) {
    px = pushedX();
    py = pushedY();
  }

  enemy.x[i] = px;
  enemy.y[i] = py;
  enemy.kind[i] = def;

  // The variant is rolled here rather than in the spawner because three doors put bodies
  // down (the wave clock, the debug hook and a splitter's children) and only the last one
  // would remember to ask. `rollElite` draws nothing on a chapter that declares no
  // variants, so the seeded runs that predate them are untouched.
  const variant = rollElite(w, eliteRoster(w));
  const elite = variant >= 0 ? ELITES[variant] : undefined;
  if (elite !== undefined) enemy.elite[i] = variant + 1;

  enemy.hp[i] = elite === undefined ? shape.hp : shape.hp * elite.hp;

  // A body arrives looking at the player, which is the honest default — it is what it
  // will be walking toward — and it means directional armour has something to read on the
  // tick a body appears. A zero facing reads as unarmoured in `armorAgainst`, so leaving
  // the facing to be derived would make the first shot at every armored a free one.
  const dx = w.player.x - px;
  const dy = w.player.y - py;
  const d2 = dx * dx + dy * dy;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    enemy.fx[i] = dx / d;
    enemy.fy[i] = dy / d;
  } else {
    enemy.fx[i] = 1;
    enemy.fy[i] = 0;
  }

  // The weave offset for the bodies that weave, taken from the slot rather than from
  // world.rng: a stride of the golden angle puts consecutive slots as far apart in phase as
  // they can be, so a cloud of forty arrives spread across its own approach instead of
  // swinging as one. Cheaper than a draw, and it does not shift the random stream that
  // every seeded test downstream of here reads.
  if ((shape.params.swayAmp ?? 0) > 0) enemy.timer[i] = (i * GOLDEN_ANGLE) % (Math.PI * 2);

  // A body whose damage arrives as a brood has its first beat wound at spawn rather than
  // left at zero: a boss that looses children on the tick it appears never gives the player
  // the seconds the fight is won in, and the whole lesson is "deal with it before the brood
  // lands". Only the brooder declares `spawnGap`, so nothing else's clock moves.
  const beat = shape.params.spawnGap;
  if (beat !== undefined) enemy.timer[i] = beat;

  pushEvent(w, Ev.Spawn, i, def, px, py);
  return i;
}