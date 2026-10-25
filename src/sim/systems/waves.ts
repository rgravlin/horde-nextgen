/**
 * Wave spawner: a chapter's script, plus the drumbeat that fills the gaps in it.
 *
 * Two things put bodies down here and they answer to different halves of a chapter.
 *
 * The **script** is `LevelDef.waves` in `content/levels.ts`: packs the chapter authored, each
 * at a second and from an edge, so a level has set pieces — the charger volley that comes down
 * the conveyor lane at 0:40, the armoured wedge that arrives off both canal banks at once. A
 * scripted pack is the same in every run at every seed, which is what makes a level
 * *designable* rather than merely difficulty-numbered: the moment a chapter asks you to give
 * ground happens at the same second for everyone, and a scenario can pin it.
 *
 * The **fill** is the clock that was here first: a timer whose gap shrinks with the wave index
 * and whose size grows with it, drawing straight down the chapter's pack recipe and taking the
 * next batch where the last one stopped (see `WaveState.cursor`). It exists so the pressure
 * never lets up between the script's beats. Both halves are read straight off data, so a pack
 * is mixed by construction rather than by luck and the fifth body of wave 1 is the same
 * archetype in every run. A weighted bag would make "does this chapter ever show you a
 * charger" a matter of luck, which a browser scenario cannot assert on and a player cannot
 * learn from.
 *
 * Where a pack arrives is still random within the edge it was given, and that part has to stay
 * random: a fixed entry point is a path a player memorises by wave three.
 *
 * Placement obeys two rules, and both are pinned by tests. A body comes down **outside the
 * view rect** (32x18 m around the player, per DESIGN.md), because a spawn inside the player's
 * eyeline is a hit they never saw coming; and it never comes down **inside cover**. The second
 * rule used to be handled downstream — `spawnEnemy` shoves a body out of whatever it landed in
 * — which is right for a splinter that popped out of its parent and is a lie for a pack: pushed
 * out of a wall, the body arrives somewhere the script never pointed at, and a pack that
 * arrives through a wall reads as enemies walking out of the scenery. So the landing point is
 * tested here, against `pointBlocked`, before anything is spawned. Both rules hold by
 * construction rather than by luck: every point this file can pick is outside the rect, and a
 * point that is not clear floor is re-picked (deterministically, from `world.rng`) or the batch
 * moves on. A scripted pack is the one case that waits: it is retried on the following ticks,
 * at most `SCRIPT_TRIES` of them, so a set piece does not miss its second by one doorway — and
 * when the retries run out it is counted in `wave.skips` rather than dropped without a trace.
 *
 * The spawner also owns where supply crates appear. A pack landing off-screen is exactly the
 * "somewhere worth walking to" a crate wants to mark, so `markHotDrop` reads each batch's
 * landing point and, on a roll and only while the arena is already busy, leaves a crate there
 * (see `systems/pickups.ts`). This is the one place that knows both halves of the question —
 * is it far enough, is it crowded — so it lives here rather than at the point a kill resolves.
 */

import { DEFAULT_ENEMY, ENEMIES, enemyIndex } from '../../content/enemies';
import { ELITES, eliteIndex, levelAt, type BeatDef, type LevelDef } from '../../content/levels';
import { next, nextInt, range } from '../rng';
import { DT, TUNE, type World } from '../world';
import { spawnEnemy } from './enemies';
import { pointBlocked } from './obstacles';
import { dropChest } from './pickups';

/**
 * Where a pack comes from, relative to the player.
 *
 * Screen names, not maths names: the camera looks down −z with world +y going up the screen
 * (see `render/instancing.ts`), so `n` is the +y edge and `e` is +x. `any` leaves the side to
 * the roll, which is what a drumbeat batch does and what a chapter that wants to be attacked
 * from anywhere asks for.
 */
export const EDGE_IDS = ['any', 'e', 'w', 'n', 's', 'ne', 'nw', 'se', 'sw'] as const;

export type EdgeId = (typeof EDGE_IDS)[number];

/**
 * The geometry behind each entry of `EDGE_IDS`, in that order: outward sign on x, then on y.
 *
 * A zero on an axis means the band *runs* along that axis, which is what makes a side a line
 * to spread a pack along instead of a point to pile it on. Index 0 is `any` and carries no
 * geometry — it is answered with a roll over the four side bands (indices 1 to 4).
 */
const BANDS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/** Side bands `any` rolls over, and the ones a refused landing re-picks across. */
const SIDE_BANDS = 4;

/** Landing points tried on a band before the batch moves on to the next one. */
const LAND_TRIES = 4;

/** Points tried for one body around its pack's landing point before it goes on the point. */
const BODY_TRIES = 3;

/** m a pack is spread along its band, and how far outward its bodies may sit from it. */
const PACK_SPREAD = 13;
const PACK_DEPTH = 3;

/** m a landing point keeps off a wall, so a body is not put down with its skin in cover. */
const WALL_MARGIN = 0.5;

/** Scripted packs a single tick may land, so several beats timed together stay one beat. */
const BEATS_PER_TICK = 3;

/** Batches a single tick may make up, so a stalled accumulator cannot spiral. */
const BATCHES_PER_TICK = 4;

/**
 * Ticks a scripted pack is refused a landing point for before it is given up on.
 *
 * Half a second of fresh rolls, which is more than any of the ten layouts needs: a refusal
 * means the ring outside the view rect is covered for that body's footprint all the way round,
 * and a pack is better missed than forced through cover. The cap exists because the script
 * walks one pack at a time, so a pack that never landed would hold the ones behind it.
 */
const SCRIPT_TRIES = 30;

/** The band the batch being placed is landing on, and its landing point. */
let landBand = 1;
let landX = 0;
let landY = 0;

/** Scratch for the point being tested, kept apart from the landing point it was spread from. */
let tryX = 0;
let tryY = 0;

/**
 * Start or restart the clock for a chapter.
 *
 * Off by default in a fresh World: an idle world, a paused one and the test fixtures are all
 * expected to spawn nothing until a chapter actually begins. Both clocks restart — the recipe
 * cursor at the top of the chapter's first pack and the script clock at second zero — so a
 * restart replays the same horde, which is the whole point of authoring it.
 */
export function startWaves(w: World, fromWave = 1): void {
  w.wave.running = true;
  w.wave.index = fromWave;
  w.wave.timeLeft = TUNE.waveLength;
  w.wave.timer = TUNE.firstBatchDelay;
  w.wave.cursor = 0;
  w.wave.elapsed = 0;
  w.wave.script = 0;
  w.wave.tries = 0;
  w.wave.skips = 0;
}

/** Stop the clock, for a cleared chapter or a run that ended. */
export function stopWaves(w: World): void {
  w.wave.running = false;
}

/**
 * One tick of the clock: wave rollover, then the script's beats, then the drumbeat.
 *
 * The script runs first and on purpose. A fill batch that jumped ahead of a beat would move
 * the set piece the chapter was built around, and a beat that had to wait for the drumbeat
 * would land in the middle of a crowd and read as one bigger crowd.
 */
export function updateWaves(w: World): void {
  const wave = w.wave;
  if (!wave.running) return;

  const level = levelAt(w.chapter);
  const hard = level.difficulty;

  wave.timeLeft -= DT;
  if (wave.timeLeft <= 0) {
    wave.index++;
    wave.timeLeft += TUNE.waveLength;
  }

  // The chapter's own clock, which is what a beat's `t` is measured against and what
  // `systems/levels.ts` waits for before it lets the encounter in. It runs beside the wave
  // index rather than replacing it: the index is the drumbeat's escalation and the HUD's wave
  // count, and both stay readable while a script is what decides the shape of a chapter.
  wave.elapsed += DT;

  for (let n = 0; n < BEATS_PER_TICK; n++) {
    if (wave.script >= level.waves.length) break;
    const beat = level.waves[wave.script];
    if (beat.t > wave.elapsed) break;
    if (runBeat(w, beat, hard.hp)) {
      wave.script++;
      wave.tries = 0;
      continue;
    }

    // No clear floor on the edge the script pointed at, so nothing came down this tick and the
    // same pack is retried next tick with a fresh roll — a set piece worth authoring is worth
    // waiting a few ticks for. After SCRIPT_TRIES of those it is given up on and counted:
    // holding the script there would push every pack behind it off the end of the chapter, and
    // a chapter that silently lost one is a chapter nobody can find afterwards.
    if (wave.tries < SCRIPT_TRIES) {
      wave.tries++;
      break;
    }
    wave.script++;
    wave.skips++;
    wave.tries = 0;
  }

  wave.timer -= DT;
  for (let n = 0; wave.timer <= 0 && n < BATCHES_PER_TICK; n++) {
    const size = batchSize(wave.index);
    runFill(w, level, wave.index, size, hard.hp);
    // Forward by the size of the batch that just went, not by one: the next batch starts
    // where this one ran out, which is what keeps a batch mixed instead of repeating the same
    // five archetypes in the same order every time.
    wave.cursor += size;
    wave.timer += fillGap(wave.index, hard.spawnRate);
  }
}

/**
 * Land one scripted pack: everything it names, this tick, on the edge it names.
 *
 * One landing point for the whole pack, then the bodies spread around it, because a pack is
 * supposed to look like one thing arriving — the way it does on the map, in the radar's ring of
 * contacts, and in the amount of gun the player has to point at it.
 *
 * Whether the pack came down. `false` means its edge had no clear floor this tick — the caller
 * decides whether to try again, which is the honest half of the rule: a wave refused for want of
 * a doorway empties a chapter quietly, so a refusal has to be countable rather than silent.
 */
function runBeat(w: World, beat: BeatDef, hpScale: number): boolean {
  const pack = beat.pack;
  const radius = widestRadius(pack);
  const edge = beat.edge;
  const at = EDGE_IDS.indexOf(edge);
  landBand = at > 0 ? at : 1 + nextInt(w.rng, SIDE_BANDS);
  if (!pickLanding(w, landBand, radius)) return false;

  // A named variant is a fact about the pack, so it beats the per-body roll further down.
  const elite = beat.elite === undefined ? -1 : eliteIndex(beat.elite);
  let entry = -1;

  for (let i = 0; i < pack.length; i++) {
    const group = pack[i];
    const found = enemyIndex(group[0]);
    // A name that matches nothing falls back to the default archetype rather than to nothing:
    // a typo in a script should make a chapter the wrong shape, which someone notices, rather
    // than quietly empty it. Same rule the recipe rows have always followed.
    const def = found >= 0 ? found : DEFAULT_ENEMY;
    for (let k = 0; k < group[1]; k++) {
      const slot = dropBody(w, def, elite, hpScale);
      if (slot >= 0 && entry < 0) entry = slot;
    }
  }

  markHotDrop(w, entry);
  return true;
}

/**
 * One drumbeat batch: the recipe's next run of archetypes, on a side drawn from the roll.
 *
 * The side is rolled rather than authored because the fill has no author. Where the script
 * points, the drumbeat just keeps the floor busy, and a drumbeat that always came from the
 * same side would be a pattern to sit in.
 */
function runFill(w: World, level: LevelDef, waveIndex: number, size: number, hpScale: number): void {
  const rows = level.packs;
  if (rows.length === 0) return;
  // The last row carries on for every wave past the end of the list, which is what lets a
  // chapter be shorter than it is long.
  const at = waveIndex - 1 < rows.length ? waveIndex - 1 : rows.length - 1;
  const row = rows[at];

  landBand = 1 + nextInt(w.rng, SIDE_BANDS);
  let radius = 0;
  for (let i = 0; i < size; i++) {
    const r = ENEMIES[archetypeAt(row, w.wave.cursor + i)].radius;
    if (r > radius) radius = r;
  }
  if (!pickLanding(w, landBand, radius)) return;

  let entry = -1;
  for (let i = 0; i < size; i++) {
    const slot = dropBody(w, archetypeAt(row, w.wave.cursor + i), -1, hpScale);
    if (slot >= 0 && entry < 0) entry = slot;
  }
  markHotDrop(w, entry);
}

/**
 * Put one body of `def` down, somewhere around the batch's landing point.
 *
 * The points tried are spread along the band and *outward* only, so a body that has to be
 * re-picked still cannot end up inside the view rect it started outside. When every spread
 * point is covered the body goes on the landing point itself, which was tested clear for the
 * widest body in the batch — that is why the check here can afford to be three tries rather
 * than a search.
 */
function dropBody(w: World, def: number, elite: number, hpScale: number): number {
  const radius = ENEMIES[def].radius;

  for (let n = 0; n < BODY_TRIES; n++) {
    spreadPoint(w);
    if (clear(w, tryX, tryY, radius)) return putDown(w, def, tryX, tryY, elite, hpScale);
  }
  return putDown(w, def, landX, landY, elite, hpScale);
}

/**
 * Drop one body at (x, y) and give it the chapter's price.
 *
 * HP is rebuilt from the archetype rather than multiplied from whatever the pool holds, so this
 * is idempotent: a body costs `base × variant × chapter`, once, whatever the per-body elite
 * roll inside `spawnEnemy` decided first. The variant slot is written here because the same
 * call also sets what the body does with it — touch damage and gait are read back off
 * `enemies.elite` by the enemy pass — so overwriting the slot is what makes an authored
 * variant real rather than decorative.
 */
function putDown(w: World, def: number, x: number, y: number, elite: number, hpScale: number): number {
  const slot = spawnEnemy(w, def, x, y);
  if (slot < 0) return -1;

  const enemies = w.enemies;
  let variant = enemies.elite[slot];
  if (elite >= 0) {
    enemies.elite[slot] = elite + 1;
    variant = elite + 1;
  }

  let hp = ENEMIES[def].hp;
  if (variant > 0) hp *= ELITES[variant - 1].hp;
  enemies.hp[slot] = hp * hpScale;
  return slot;
}

/**
 * Find a landing point for bodies that need `radius` metres of clear floor.
 *
 * The point sits on the boundary of the view rect pushed outward by between 0.5 m and the
 * spawn margin, so "outside the player's eyeline" is a property of the geometry rather than a
 * rule something has to remember to enforce. `landBand` is tried first, then the four sides:
 * a pack the script sent down a walled lane still arrives, from the next direction that works,
 * rather than not arriving at all. A chapter that wants a corridor to be the only way in says
 * so by putting a wall there, and the pack comes through the gap the layout left.
 */
function pickLanding(w: World, band: number, radius: number): boolean {
  if (bandFits(w, band, radius)) return true;
  for (let side = 1; side <= SIDE_BANDS; side++) {
    if (side === band) continue;
    if (bandFits(w, side, radius)) {
      // Retarget, not just relocate: `spreadPoint` reads the band to decide which way is
      // outward, and a pack spread along the wrong axis would be spread back into the view
      // rect the landing point was chosen to clear.
      landBand = side;
      return true;
    }
  }
  return false;
}

/** Try `LAND_TRIES` points on band `b`, leaving the first clear one in `landX`/`landY`. */
function bandFits(w: World, b: number, radius: number): boolean {
  for (let n = 0; n < LAND_TRIES; n++) {
    bandPoint(w, b);
    if (clear(w, landX, landY, radius)) return true;
  }
  return false;
}

/**
 * Roll a point on band `b`: outside the view rect on the band's own axis, somewhere along it.
 *
 * Corner bands push out on both axes, which is why they are the ones a chapter uses to make
 * the player turn rather than run: a pack off the north-east corner arrives at an angle the
 * view rect does not have a side for.
 */
function bandPoint(w: World, b: number): void {
  const band = BANDS[b];
  const sx = band[0];
  const sy = band[1];
  const px = w.player.x;
  const py = w.player.y;

  if (sx !== 0 && sy !== 0) {
    landX = px + sx * (TUNE.viewHalfX + range(w.rng, 1, TUNE.spawnMargin + 2));
    landY = py + sy * (TUNE.viewHalfY + range(w.rng, 1, TUNE.spawnMargin + 2));
    return;
  }

  if (sx !== 0) {
    landX = px + sx * (TUNE.viewHalfX + range(w.rng, 0.5, TUNE.spawnMargin + 2));
    landY = py + range(w.rng, -TUNE.viewHalfY, TUNE.viewHalfY);
    return;
  }

  landY = py + sy * (TUNE.viewHalfY + range(w.rng, 0.5, TUNE.spawnMargin + 2));
  landX = px + range(w.rng, -TUNE.viewHalfX, TUNE.viewHalfX);
}

/** Spread one body around the landing point, outward only, leaving it in `tryX`/`tryY`. */
function spreadPoint(w: World): void {
  const band = BANDS[landBand];
  const sx = band[0];
  const sy = band[1];

  if (sx !== 0 && sy !== 0) {
    tryX = landX + sx * range(w.rng, 0, PACK_DEPTH * 2);
    tryY = landY + sy * range(w.rng, 0, PACK_DEPTH * 2);
    return;
  }

  if (sx !== 0) {
    tryX = landX + sx * range(w.rng, 0, PACK_DEPTH);
    tryY = landY + range(w.rng, -PACK_SPREAD * 0.5, PACK_SPREAD * 0.5);
    return;
  }

  tryY = landY + sy * range(w.rng, 0, PACK_DEPTH);
  tryX = landX + range(w.rng, -PACK_SPREAD * 0.5, PACK_SPREAD * 0.5);
}

/**
 * Whether a body of `radius` can stand at (x, y): in the arena, and not in cover.
 *
 * The arena half is checked with the margin the spawner has always kept, because a body put
 * down with half its body outside the room is clamped by `spawnEnemy` into wherever the clamp
 * lands, and a clamp does not ask about walls. With no cover installed this is one compare and
 * a half — the shape every fixture and the idle arena is in.
 */
function clear(w: World, x: number, y: number, radius: number): boolean {
  const lowX = w.minX + WALL_MARGIN + radius;
  const highX = w.maxX - WALL_MARGIN - radius;
  const lowY = w.minY + WALL_MARGIN + radius;
  const highY = w.maxY - WALL_MARGIN - radius;
  if (x < lowX || x > highX || y < lowY || y > highY) return false;
  return !pointBlocked(w.props, x, y, radius);
}

/** The widest body in a scripted pack, which is the footprint its landing point needs. */
function widestRadius(pack: readonly (readonly [string, number])[]): number {
  let radius = 0;
  for (let i = 0; i < pack.length; i++) {
    const found = enemyIndex(pack[i][0]);
    const r = found >= 0 ? ENEMIES[found].radius : ENEMIES[DEFAULT_ENEMY].radius;
    if (r > radius) radius = r;
  }
  return radius;
}

/**
 * Seconds between drumbeat batches: 1.4 s at wave 1, decaying to a 0.3 s floor, then divided
 * by the chapter's spawn rate.
 *
 * The rate is a divisor on the gap rather than a multiplier on the batch size because a bigger
 * batch arrives as one blob while a shorter gap arrives as pressure, and the chapter's
 * difficulty is meant to be the second one. It divides the whole curve, so a hard chapter is
 * meaner from its first batch rather than only once the waves have wound up.
 */
function fillGap(waveIndex: number, spawnRate: number): number {
  const decayed = TUNE.spawnGap * Math.pow(TUNE.spawnGapDecay, waveIndex - 1);
  const gap = (decayed > TUNE.spawnGapFloor ? decayed : TUNE.spawnGapFloor) / spawnRate;
  return gap > 0.12 ? gap : 0.12;
}

/** Bodies per batch: one at first, up to the cap, so late waves arrive as packs. */
function batchSize(waveIndex: number): number {
  const size = 1 + Math.floor((waveIndex - 1) / 2);
  return size < TUNE.batchCap ? size : TUNE.batchCap;
}

/**
 * The archetype at one position in a recipe, as a table index.
 *
 * A name that matches nothing falls back to the default archetype rather than to nothing, for
 * the reason it always has: a recipe is data and data gets mistyped.
 */
function archetypeAt(row: readonly string[], cursor: number): number {
  const index = enemyIndex(row[cursor % row.length]);
  return index >= 0 ? index : DEFAULT_ENEMY;
}

/**
 * Mark a hot drop where a pack just arrived.
 *
 * A crate is only a reward if it sends the player somewhere on purpose, so it drops where a
 * fresh pack is assembling rather than where the player already stands, and only when the
 * arena is already busy enough that the detour has something to spend it on. A pack lands just
 * outside the view rect, which is always at least `chestMinDist` out, so the crate is a walk
 * by construction; the distance test is the guard for the small test arenas where a spawn
 * cannot clear the rect and the batch lands closer (or nowhere).
 *
 * `count` is the cheap stand-in for "busy": this runs in its own slot after the damage
 * passes, so it could query, but "enough bodies at once" is really the same question the whole
 * spawner asks, and one comparison keeps the default (thinning) case free.
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