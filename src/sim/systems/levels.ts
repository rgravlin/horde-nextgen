/**
 * The chapter floor: which room is under the player, who is standing in it, and what the floor
 * charges them for standing in it.
 *
 * This is the half of a level that is *about the room*, and it is deliberately the half that
 * knows nothing about bosses. A chapter's boxes and hazards are installed the moment it starts,
 * in one call, from `content/levels.ts`. A fresh `World` has no geometry, and a chapter is the
 * only door that puts any down — the same reason an idle world spawns nothing: every test
 * fixture and the paused arena are expected to be *empty*, not quietly chapter 1.
 *
 * The encounter that ends a chapter, the intermission that follows it and the victory that
 * follows the last one are in `systems/boss.ts`; this file hands over the floor and gets the
 * next one ready. The split is the same one the weapons and their projectiles already use —
 * trigger here, pay-out there — and it keeps one rule true that is easy to lose: nothing in the
 * room file has to know what a boss is in order to know what acid is.
 *
 * **Why the arc is a door and not a wave.** `tests/unit/enemies-b.test.ts` pins that a
 * chapter's recipes deliver every drumbeat archetype, and the three bosses are excluded from
 * that set on purpose: a body you meet once at the end of a chapter is a different piece of
 * content from a body that appears in a pack, and putting them in the recipes would make the
 * encounter a thing you had already seen twenty times.
 */

import { ENEMIES } from '../../content/enemies';
import { levelAt } from '../../content/levels';
import { acidAt, installLayout, installZones, pointBlocked, pushOut, pushedX, pushedY, tickZones } from './obstacles';
import { DT, Ev, Tele, TUNE, pushEvent, setArena, type World } from '../world';
import { hurtPlayer } from './enemyProjectiles';
import { killEnemy, queueBlast, underground } from './enemies';
import { startWaves, stopWaves } from './waves';

/**
 * Where the chapter is. Held in `wave.phase` rather than beside it, because the wave clock
 * and the chapter arc are the same countdown read at two lengths: `index` says how deep into
 * the script the drumbeat is, `phase` says whether the script is what is left.
 *
 * `systems/boss.ts` is what moves a chapter through the last three of these; this file only
 * asks whether the arc still wants the floor's hazard pass running.
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

  // A chapter loads with no encounter on the floor and no chapter yet behind the player. Both
  // are written here rather than cleared by whoever is about to load the room, because the same
  // function serves a first chapter, a restart and the next chapter, and a `victory` left over
  // from the run before would end this one before it started.
  w.chapterComplete = false;
  w.victory = false;
  const boss = w.boss;
  boss.alive = false;
  boss.hp = 0;
  boss.maxHp = 0;
  boss.name = '';
  boss.skips = 0;

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
 * One tick of the floor: the acid and the plates.
 *
 * Runs before the enemy pass, for two reasons that point the same way. The hazard damage and a
 * crusher's burst want to be paid out in the tick they happen in rather than the one after it,
 * and the tick a chapter ends is not also the tick a routine batch spawns: an arrival that lands
 * in the same tick as a pack reads as one big pack rather than as a change in what the chapter
 * is doing.
 *
 * It keeps running through the encounter and the intermission, and stops with the chapter: a
 * floor that stopped charging the moment its boss walked in would be a room whose hazard
 * switched off for the part of the fight with the most bodies in it.
 */
export function updateHazards(w: World): void {
  const wave = w.wave;
  if (w.over || wave.phase === Phase.None || wave.phase === Phase.Cleared) return;
  tickHazards(w);
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
    // A body under the floor is not standing in the acid above it, any more than a shot can
    // reach it down there. Same rule the burn tick uses.
    if (underground(enemies.phase[i])) continue;
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
