/**
 * The chapter arc: which floor is under the player, how far its wave script has run, and
 * what happens when the script is spent.
 *
 * This is the piece that makes a level a level rather than a difficulty number. Three things
 * it owns, and none of them are in `systems/waves.ts`:
 *
 * - **The floor.** A chapter's boxes and hazards are installed the moment it starts, in one
 *   call, from `content/levels.ts`. A fresh `World` has no geometry, and a chapter is the
 *   only door that puts any down — the same reason an idle world spawns nothing: every test
 *   fixture and the paused arena are expected to be *empty*, not quietly chapter 1.
 * - **The arc.** The drumbeat runs for the chapter's authored `duration`, then stops and the
 *   encounter walks in. A chapter that escalated forever was not a level, it was a timer.
 * - **The end.** Killing the encounter is how a chapter is cleared; the next one loads with
 *   its own floor and its own mix, and the run keeps going until the player dies or the last
 *   chapter falls.
 *
 * **Why the encounter is a door and not a wave.** `tests/unit/enemies-b.test.ts` pins that a
 * chapter's recipes deliver every drumbeat archetype, and the three bosses are excluded from
 * that set on purpose: a body you meet once at the end of a chapter is a different piece of
 * content from a body that appears in a pack, and putting them in the recipes would make the
 * encounter a thing you had already seen twenty times.
 */

import { ENEMIES, enemyIndex } from '../../content/enemies';
import { LEVELS, levelAt } from '../../content/levels';
import { acidAt, installLayout, installZones, pointBlocked, pushOut, pushedX, pushedY, tickZones } from './obstacles';
import { nextInt, range } from '../rng';
import { DT, Ev, Tele, TUNE, pushEvent, setArena, type World } from '../world';
import { hurtPlayer } from './enemyProjectiles';
import { killEnemy, queueBlast, spawnEnemy } from './enemies';
import { startWaves, stopWaves } from './waves';

/**
 * Where the chapter is. Held in `wave.phase` rather than beside it, because the wave clock
 * and the chapter arc are the same countdown read at two lengths: `index` says how deep into
 * the script the drumbeat is, `phase` says whether the script is what is left.
 */
export const Phase = {
  /** No chapter loaded: a fresh world, a paused one, a test fixture. Nothing spawns. */
  None: 0,
  /** The wave script is running. */
  Script: 1,
  /** The script is spent and the encounter is on the floor. */
  Encounter: 2,
  /** The encounter is dead; the next floor is being loaded. */
  Intermission: 3,
  /** Every chapter in the game has been cleared. */
  Cleared: 4,
} as const;

/** Seconds of quiet after the encounter: long enough to reload and to walk somewhere better. */
const INTERMISSION = 4;

/** m the encounter is put down away from the player, and how many times the spot is re-rolled. */
const DROP_RING = 22;
const DROP_TRIES = 4;

/** The y left over from the last `findDrop`, with its x. One pair of module slots, as everywhere else here. */
let dropX = 0;
let dropY = 0;

/**
 * Put chapter `index` under the player's feet and start its clock.
 *
 * Used by the game for the first chapter, for a restart, and for the chapter that loads when
 * this one is cleared. It replaces the floor rather than adding to it: a chapter's layout is
 * authored as a whole room, and a room with the previous room's walls still standing in it is
 * a room that cannot be read.
 */
export function startChapter(w: World, index: number): void {
  const at = index < 0 ? 0 : index;
  const level = levelAt(at);
  w.chapter = at;
  w.wave.phase = Phase.Script;
  w.wave.clearTime = 0;

  // The room first, then what stands in it: the arena is the fact the layout was drawn
  // around, and bodies have to be re-seated inside whichever room this chapter is.
  setArena(w, level.size);
  installLayout(w, level.props);
  installZones(w, level.hazards);
  settle(w);

  // The clock is reset through `startWaves` rather than written here: the recipe cursor
  // starting at the top of the chapter's first pack is that function's meaning, and a restart
  // that skipped it would resume a chapter's drumbeat halfway down its own recipe.
  startWaves(w, 1);
}

/** Take the floor away, for a run that ended or a world that never chose a chapter. */
export function endChapters(w: World): void {
  w.wave.phase = Phase.None;
  w.wave.clearTime = 0;
  stopWaves(w);
}

/**
 * Seat everyone who is on the floor inside the room the chapter just put under them.
 *
 * A chapter loads while bodies are standing where the next chapter's walls are, and a body
 * whose movement is blocked on both axes is not sheltered, it is sealed: invisible,
 * unshootable, and still counted. The arena can move too — a chapter declares its own
 * half-extents — so bodies left outside the new box are brought in by the same pass rather
 * than by the per-tick clamp, which would drop them wherever the straight line home happened
 * to end, cover or no cover.
 *
 * This runs once per chapter rather than once per tick, and it is the only place the sim
 * forgives an overlap — during play, geometry that a body is inside is refused by the same
 * test that keeps it out.
 */
function settle(w: World): void {
  const p = w.player;
  seat(w, TUNE.playerRadius, p.x, p.y);
  p.x = seatX;
  p.y = seatY;

  const enemies = w.enemies;
  for (let i = 0; i < enemies.cap; i++) {
    if (enemies.alive[i] === 0) continue;
    const r = ENEMIES[enemies.kind[i]].radius;
    seat(w, r, enemies.x[i], enemies.y[i]);
    enemies.x[i] = seatX;
    enemies.y[i] = seatY;
  }
}

/** Where `seat` put the last body. One pair of module slots, as everywhere else here. */
let seatX = 0;
let seatY = 0;

/**
 * Pull one body of radius `r` into the arena, then out of anything it now overlaps.
 *
 * Both halves in one order on purpose: clamping alone can land a body inside the new
 * chapter's cover, and pushing out alone leaves it outside the room the chapter is played in.
 */
function seat(w: World, r: number, x: number, y: number): void {
  let px = x < w.minX + r ? w.minX + r : x > w.maxX - r ? w.maxX - r : x;
  let py = y < w.minY + r ? w.minY + r : y > w.maxY - r ? w.maxY - r : y;

  const f = w.props;
  if (f.n > 0 && pointBlocked(f, px, py, r) && pushOut(f, r, px, py)) {
    px = pushedX();
    py = pushedY();
  }

  seatX = px;
  seatY = py;
}

/**
 * One tick of the chapter arc.
 *
 * Runs before the enemy pass, for two reasons that point the same way. The hazard damage and
 * a crusher's burst want to be paid out in the tick they happen in rather than the one after
 * it, and the tick a chapter ends is not also the tick a routine batch spawns: an arrival
 * that lands in the same tick as a pack reads as one big pack rather than as a change in what
 * the chapter is doing.
 */
export function updateLevels(w: World): void {
  const wave = w.wave;
  if (w.over || wave.phase === Phase.None || wave.phase === Phase.Cleared) return;

  const level = levelAt(w.chapter);
  tickHazards(w);

  if (wave.phase === Phase.Script) {
    if (wave.elapsed >= level.duration) startEncounter(w, level);
    return;
  }

  if (wave.phase === Phase.Encounter) {
    if (bossesAlive(w)) return;

    wave.phase = Phase.Intermission;
    wave.clearTime = INTERMISSION;
    return;
  }

  wave.clearTime -= DT;
  if (wave.clearTime > 0) return;

  // The last chapter clears rather than looping. What a cleared run *is* — a summary, an
  // unlock, a new game plus — belongs to the run-flow task; the honest answer here is that the
  // drumbeat stops and nothing further spawns.
  if (w.chapter >= LEVELS.length - 1) {
    wave.phase = Phase.Cleared;
    stopWaves(w);
    return;
  }
  startChapter(w, w.chapter + 1);
}

/**
 * The chapter's encounter: the bosses it named, plus an escort from the last row of its
 * recipe, put down together on a ring around the player.
 *
 * Three parts to this, and each is why the function is not one line.
 *
 * The escort exists because an encounter alone in an empty room is a health bar rather than a
 * fight; with a pack it is a shape you have to read. It comes from the chapter's own last
 * recipe row, so the escort is made of what the chapter has already taught.
 *
 * The drumbeat is switched off because a chapter that ends with an endless horde plus a boss
 * has two escalations competing, and the player cannot tell which one they are losing to.
 *
 * Bosses and escort go out on separate passes so every boss lands before any of its
 * company — a matron that arrives beside two healers should have someone to heal on the tick
 * she appears, and the order here is what makes that the case rather than a coincidence of
 * which side of the ring the draw picked.
 */
function startEncounter(w: World, level: (typeof LEVELS)[number]): void {
  const wave = w.wave;
  wave.phase = Phase.Encounter;
  stopWaves(w);

  const row = level.packs[level.packs.length - 1];
  const escort = row === undefined ? [] : row;

  for (let pass = 0; pass < 2; pass++) {
    const ids = pass === 0 ? level.bosses : escort;
    for (const id of ids) {
      const def = enemyIndex(id);
      if (def < 0) continue;
      const radius = ENEMIES[def].radius;
      if (pickDrop(w, radius)) spawnEnemy(w, def, dropX, dropY);
    }
  }
}

/**
 * Whether any live boss body is still on the floor.
 *
 * Exported because the shell has to say the same thing the chapter machine means by it:
 * `__forgeState().wave.bossAlive` and the HUD's boss plate read this, so the number a
 * scenario asserts on and the number the intermission waits for cannot drift apart.
 */
export function bossesAlive(w: World): boolean {
  const enemies = w.enemies;
  for (let i = 0; i < enemies.cap; i++) {
    if (enemies.alive[i] === 0 || enemies.hp[i] <= 0) continue;
    if (ENEMIES[enemies.kind[i]].boss) return true;
  }
  return false;
}

/**
 * Find somewhere to put a body of `radius` down: on the ring around the player, clear of
 * cover, and not inside a hazard.
 *
 * Four sides, four attempts, the same shape as the wave spawner's own retry and for the same
 * reason: a fixed entry point is a path a player memorises by wave three, and the sides that
 * do work all keep working when one of them is a wall. A pool is excluded because an
 * encounter dropped into acid starts the fight already losing, which is not a lesson.
 */
function pickDrop(w: World, radius: number): boolean {
  const startSide = nextInt(w.rng, DROP_TRIES);
  for (let attempt = 0; attempt < DROP_TRIES; attempt++) {
    const margin = range(w.rng, 0, 6);
    const along = range(w.rng, -DROP_RING, DROP_RING);
    let x = 0;
    let y = 0;

    switch ((startSide + attempt) % DROP_TRIES) {
      case 0:
        x = w.player.x + DROP_RING + margin;
        y = w.player.y + along;
        break;
      case 1:
        x = w.player.x - DROP_RING - margin;
        y = w.player.y + along;
        break;
      case 2:
        y = w.player.y + DROP_RING + margin;
        x = w.player.x + along;
        break;
      default:
        y = w.player.y - DROP_RING - margin;
        x = w.player.x + along;
        break;
    }

    if (x < w.minX + radius || x > w.maxX - radius || y < w.minY + radius || y > w.maxY - radius) continue;
    if (pointBlocked(w.props, x, y, radius)) continue;
    if (acidAt(w.zones, x, y) > 0) continue;

    dropX = x;
    dropY = y;
    return true;
  }
  return false;
}

/**
 * One tick of the floor hazards.
 *
 * Acid takes its price through the same i-frame gate a hug uses rather than every tick, by
 * calling the same helper a hug uses: a pool that damaged on each of its sixty ticks a
 * second would out-think the shield, the iframes and the health bar all at once, and it
 * would read as a floor that drains rather than as a place you are standing. The number a
 * chapter writes down is per second, and the gate is what makes it cost that much and no
 * more. The shake weight is below a bolt's: standing in corrosion is a thing you are losing
 * a bit at a time to, and a jolt every half second would drown out the one that matters.
 *
 * Enemies pay it directly, on the tick's one shared query buffer's terms — there is no
 * query here at all, just the pool, because a pool is a place rather than a point and the
 * bodies that matter are the ones already inside it. That is the other half of why a hazard
 * is a position rather than a tax: a pool is a thing you lead a pack through, and it has to
 * take more off them than off you for that to be true.
 *
 * A body the pool finishes off goes through `killEnemy` rather than simply losing health,
 * for the reason every other death in the sim does: a corpse left in the pool still takes a
 * slot, still counts, and never stops anything. It also means an exploder baited into a pool
 * takes the pool's edge with it, which is the lesson the layouts are written to teach.
 */
function tickHazards(w: World): void {
  const zones = w.zones;
  if (zones.n === 0) return;

  const p = w.player;
  const dps = acidAt(zones, p.x, p.y);
  if (dps > 0) hurtPlayer(w, dps * TUNE.hurtIframes, 2);

  // The tell goes into the ring when the plate starts its warning and the burst when it
  // lands, twenty-seven ticks later for a chapter-5 plate. Both use the pooled shapes the
  // grenade already draws with: a crusher's warning and a grenade's landing ring are the same
  // thing on the floor — a circle that fills and then is not — and a second shape id for it
  // would be a second thing for the renderer to keep in step. The two handlers are module
  // functions rather than closures here so the tick that fires a plate still allocates
  // nothing; `tickZones` runs every tick and a pair of arrows per tick is a pair per tick
  // for as long as the chapter lasts.
  tickZones(w, tellPlate, strikePlate);

  const enemies = w.enemies;
  for (let i = 0; i < enemies.cap; i++) {
    if (enemies.alive[i] === 0 || enemies.hp[i] <= 0) continue;
    const cost = acidAt(zones, enemies.x[i], enemies.y[i]);
    if (cost <= 0) continue;
    enemies.hp[i] -= cost * DT;
    if (enemies.hp[i] <= 0) killEnemy(w, i);
  }
}

/** Open a plate's warning ring. See `tickHazards`. */
function tellPlate(w: World, x: number, y: number): void {
  pushEvent(w, Ev.Telegraph, -1, Tele.RingAt, x, y);
}

/** Drop a plate. A crusher is a burst, so it pays through the burst pass like any other. */
function strikePlate(w: World, x: number, y: number, r: number, dmg: number): void {
  queueBlast(w, x, y, r, dmg, 0);
}
