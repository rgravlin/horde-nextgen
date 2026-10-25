/**
 * Wave spawner.
 *
 * A clock, not a script: batches arrive on a timer whose gap shrinks with the wave
 * index and whose size grows with it, so a chapter gets heavier the longer it runs.
 * Every batch lands just outside the 32x18 m view rect that surrounds the player
 * (DESIGN.md: about 30x18 m of floor is on screen), never inside it, so a pack
 * arrives from off-screen and the player has time to read it coming.
 *
 * Chapter wave scripts (T8) will drive pack composition and chokepoints from here.
 * Until then every batch is chasers, which is what the escalation test measures.
 */

import { DEFAULT_ENEMY, ENEMIES } from '../../content/enemies';
import { nextInt, range } from '../rng';
import { DT, TUNE, type World } from '../world';
import { spawnEnemy } from './enemies';

/** Sides of the view rect tried before a batch is skipped. */
const SIDE_TRIES = 4;

/** Batches a single tick may make up, so a stalled accumulator cannot spiral. */
const BATCHES_PER_TICK = 4;

/** m a spawn must stay inside the arena bounds; keeps bodies out of walls. */
const WALL_MARGIN = 0.5;

/**
 * Start or restart the clock for a chapter.
 *
 * Off by default in a fresh World: an idle world, a paused one and the test
 * fixtures are all expected to spawn nothing until a chapter actually begins.
 */
export function startWaves(w: World, fromWave = 1): void {
  w.wave.running = true;
  w.wave.index = fromWave;
  w.wave.timeLeft = TUNE.waveLength;
  w.wave.timer = TUNE.firstBatchDelay;
}

/** Stop the clock, for a cleared chapter or a run that ended. */
export function stopWaves(w: World): void {
  w.wave.running = false;
}

/** One tick of the clock: wave rollover, then as many batches as the timer owes. */
export function updateWaves(w: World): void {
  const wave = w.wave;
  if (!wave.running) return;

  wave.timeLeft -= DT;
  if (wave.timeLeft <= 0) {
    wave.index++;
    wave.timeLeft += TUNE.waveLength;
  }

  wave.timer -= DT;
  for (let n = 0; wave.timer <= 0 && n < BATCHES_PER_TICK; n++) {
    const size = batchSize(wave.index);
    for (let k = 0; k < size; k++) spawnOne(w);
    wave.timer += spawnGap(wave.index);
  }
}

/** Seconds between batches: 1.4 s at wave 1, decaying to a 0.3 s drumbeat. */
function spawnGap(waveIndex: number): number {
  const gap = TUNE.spawnGap * Math.pow(TUNE.spawnGapDecay, waveIndex - 1);
  return gap > TUNE.spawnGapFloor ? gap : TUNE.spawnGapFloor;
}

/** Bodies per batch: one at first, up to the cap, so late waves arrive as packs. */
function batchSize(waveIndex: number): number {
  const size = 1 + Math.floor((waveIndex - 1) / 2);
  return size < TUNE.batchCap ? size : TUNE.batchCap;
}

/**
 * Put one chaser just outside the view rect, on a side and at a point drawn from
 * world.rng.
 *
 * A side that would land it outside the arena is re-picked, so hugging a wall does
 * not switch the horde off; the sides still inside the arena keep working. When no
 * side works — a test arena smaller than the view rect — the batch is skipped and
 * the timer tries again next tick rather than spawning on top of the player.
 */
function spawnOne(w: World): void {
  const radius = ENEMIES[DEFAULT_ENEMY].radius;
  const lowX = w.minX + WALL_MARGIN + radius;
  const highX = w.maxX - WALL_MARGIN - radius;
  const lowY = w.minY + WALL_MARGIN + radius;
  const highY = w.maxY - WALL_MARGIN + radius;
  const px = w.player.x;
  const py = w.player.y;
  const startSide = nextInt(w.rng, SIDE_TRIES);

  for (let attempt = 0; attempt < SIDE_TRIES; attempt++) {
    const margin = range(w.rng, 0.5, TUNE.spawnMargin);
    let x = 0;
    let y = 0;

    switch ((startSide + attempt) % SIDE_TRIES) {
      case 0:
        x = px + TUNE.viewHalfX + margin;
        y = py + range(w.rng, -TUNE.viewHalfY, TUNE.viewHalfY);
        break;
      case 1:
        x = px - TUNE.viewHalfX - margin;
        y = py + range(w.rng, -TUNE.viewHalfY, TUNE.viewHalfY);
        break;
      case 2:
        y = py + TUNE.viewHalfY + margin;
        x = px + range(w.rng, -TUNE.viewHalfX, TUNE.viewHalfX);
        break;
      default:
        y = py - TUNE.viewHalfY - margin;
        x = px + range(w.rng, -TUNE.viewHalfX, TUNE.viewHalfX);
        break;
    }

    if (x < lowX || x > highX || y < lowY || y > highY) continue;
    spawnEnemy(w, DEFAULT_ENEMY, x, y);
    return;
  }
}
