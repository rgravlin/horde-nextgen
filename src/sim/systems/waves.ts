/**
 * Wave spawner.
 *
 * A clock, not a script: batches arrive on a timer whose gap shrinks with the wave index
 * and whose size grows with it, so a chapter gets heavier the longer it runs. Every batch
 * lands just outside the 32x18 m view rect that surrounds the player (DESIGN.md: about
 * 30x18 m of floor is on screen), never inside it, so a pack arrives from off-screen and
 * the player has time to read it coming.
 *
 * What arrives is data. Each wave has a pack recipe in `content/enemies.ts` and the
 * spawner reads it straight down, taking the next batch where the last one stopped — see
 * `WaveState.cursor` — so a pack is mixed by construction rather than by luck and the
 * fifth body of wave 1 is a charger in every run. That is deliberate on two counts. A
 * weighted bag would make "does this chapter ever show you a charger" a matter of luck,
 * which a browser scenario cannot assert on and a player cannot learn; and a pack of one
 * archetype reads as one mechanic rather than as a horde, which is the difference the mixed
 * compositions in DESIGN.md are for.
 *
 * Where it arrives is still random, and that part has to stay random: a fixed entry point
 * is a path a player memorises by wave three.
 *
 * The spawner also owns where supply crates appear. A pack landing off-screen is exactly
 * the "somewhere worth walking to" a crate wants to mark, so `markHotDrop` reads each
 * batch's landing point and, on a roll and only while the arena is already busy, leaves a
 * crate there (see `systems/pickups.ts`). This is the one place that knows both halves of
 * the question — is it far enough, is it crowded — so it lives here rather than at the
 * point a kill resolves.
 */

import { DEFAULT_ENEMY, ENEMIES, PACKS, enemyIndex } from '../../content/enemies';
import { next, nextInt, range } from '../rng';
import { DT, TUNE, type World } from '../world';
import { spawnEnemy } from './enemies';
import { dropChest } from './pickups';

/** Sides of the view rect tried before a batch is skipped. */
const SIDE_TRIES = 4;

/** Batches a single tick may make up, so a stalled accumulator cannot spiral. */
const BATCHES_PER_TICK = 4;

/** m a spawn must stay inside the arena bounds; keeps bodies out of walls. */
const WALL_MARGIN = 0.5;

/**
 * Start or restart the clock for a chapter.
 *
 * Off by default in a fresh World: an idle world, a paused one and the test fixtures are
 * all expected to spawn nothing until a chapter actually begins. The recipe cursor starts
 * at the top of the chapter's first pack, so a restart replays the same horde.
 */
export function startWaves(w: World, fromWave = 1): void {
  w.wave.running = true;
  w.wave.index = fromWave;
  w.wave.timeLeft = TUNE.waveLength;
  w.wave.timer = TUNE.firstBatchDelay;
  w.wave.cursor = 0;
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
    const pack = packFor(wave.index);
    // Remember where the batch landed: a crate marks the spot a pack just came together,
    // so the first body that got down is the entry the player would have to walk to.
    let entry = -1;
    for (let k = 0; k < size; k++) {
      const slot = spawnOne(w, archetypeAt(pack, wave.cursor + k));
      if (slot >= 0 && entry < 0) entry = slot;
    }
    // Forward by the size of the batch that just went, not by one: the next pack starts
    // where this one ran out, which is what keeps a batch mixed instead of repeating the
    // same five archetypes in the same order every time.
    wave.cursor += size;
    wave.timer += spawnGap(wave.index);
    markHotDrop(w, entry);
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

/** The recipe a wave draws from. The last row carries on past the end of the list. */
function packFor(waveIndex: number): readonly string[] {
  const row = PACKS[waveIndex - 1];
  return row === undefined ? PACKS[PACKS.length - 1] : row;
}

/**
 * The archetype at one position in a recipe, as a table index.
 *
 * A name that matches nothing falls back to the default archetype rather than to nothing:
 * a typo in a recipe should make a wave the wrong shape, which is a thing someone notices,
 * rather than quietly empty it.
 */
function archetypeAt(pack: readonly string[], cursor: number): number {
  const index = enemyIndex(pack[cursor % pack.length]);
  return index >= 0 ? index : DEFAULT_ENEMY;
}

/**
 * Put one body of `def` just outside the view rect, on a side and at a point drawn from
 * world.rng, and return the enemy slot it landed in, or -1 when no side worked.
 *
 * A side that would land it outside the arena is re-picked, so hugging a wall does not
 * switch the horde off; the sides still inside the arena keep working. When no side works
 * — a test arena smaller than the view rect — the batch is skipped and the timer tries
 * again next tick rather than spawning on top of the player. The margin is measured from
 * the archetype's own body, because a 0.24 m splinter and a 0.62 m armored are not the
 * same thing to put down beside a wall.
 */
function spawnOne(w: World, def: number): number {
  const radius = ENEMIES[def].radius;
  const lowX = w.minX + WALL_MARGIN + radius;
  const highX = w.maxX - WALL_MARGIN - radius;
  const lowY = w.minY + WALL_MARGIN + radius;
  const highY = w.maxY - WALL_MARGIN - radius;
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
    return spawnEnemy(w, def, x, y);
  }
  return -1;
}

/**
 * Mark a hot drop where a pack just arrived.
 *
 * A crate is only a reward if it sends the player somewhere on purpose, so it drops where
 * a fresh pack is assembling rather than where the player already stands, and only when
 * the arena is already busy enough that the detour has something to spend it on. A pack
 * lands just outside the view rect, which is always at least `chestMinDist` out, so the
 * crate is a walk by construction; the distance test is the guard for the small test
 * arenas where a spawn cannot clear the rect and the batch lands closer (or nowhere).
 *
 * `count` is the cheap stand-in for "busy": this runs in its own slot after the damage
 * passes, so it could query, but "enough bodies at once" is really the same question the
 * whole spawner asks, and one comparison keeps the default (thinning) case free.
 */
function markHotDrop(w: World, entry: number): void {
  if (entry < 0 || w.enemies.count < TUNE.chestPackFloor) return;

  const x = w.enemies.x[entry];
  const y = w.enemies.y[entry];
  const dx = x - w.player.x;
  const dy = y - w.player.y;
  if (dx * dx + dy * dy < TUNE.chestMinDist * TUNE.chestMinDist) return;

  if (next(w.rng) < TUNE.chestChance) dropChest(w, x, y);
}
