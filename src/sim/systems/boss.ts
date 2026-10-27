/**
 * The chapter's encounter: the door a chapter ends on.
 *
 * This file is the half of the chapter arc that is *about the fight*: the moment the wave
 * script is spent, who walks in, where they stand, and what has to be true for the chapter to
 * be over. The floor they walk onto — the arena, the cover, the hazards — is `systems/levels.ts`.
 *
 * Three rules hold here, and each one exists because the version without it was wrong:
 *
 * - **The encounter arrives the tick the script ends,** not the one after. The chapter arc runs
 *   before the broad-phase rebuild in `step.ts` precisely so a body that walks in is in the
 *   grid the tick it arrives; a boss that is not in the grid is a boss nothing can shoot for a
 *   step, and a chapter that ends on a boss who then cannot be hit is a bug shaped like a
 *   difficulty curve.
 * - **The encounter is a shape, not a health bar.** It comes in with an escort drawn from the
 *   chapter's own last recipe row, and the bosses land before any of it, so a matron that
 *   arrives beside two healers has someone to mend on the tick she appears. That is the same
 *   reason the drumbeat gets switched off: two escalations in one tick read as one big pack
 *   rather than as a change in what the chapter is doing.
 * - **Where it lands is searched, not assumed.** The ring used to be one distance, probed four
 *   ways, and a chapter that could not find clear floor at that one distance ended with no
 *   encounter at all — four seconds of quiet and then the next room. The search now walks the
 *   ring inward, so a boss that cannot come in at twenty-two metres comes in at eight rather
 *   than not at all, and the residue that still finds nowhere to stand is counted in
 *   `world.boss.skips` instead of vanishing.
 *
 * **On what the encounter is made of.** The three bodies a chapter can end on are behaviours in
 * `systems/enemies/bosses.ts` (`brute`, `brooder`, `matron`), not a boss class of their own: the slam
 * ring, the brood and the bolt fan are each an answer to a skill the trash already taught. What
 * this file adds is not damage but the fight's *stage* — the escort, the landing point, and the
 * fact that killing them moves the run on.
 */

import { ENEMIES, enemyIndex } from '../../content/enemies';
import { LEVELS, levelAt } from '../../content/levels';
import { nextInt, range } from '../rng';
import { spawnEnemy } from './enemies';
import { acidAt, pointBlocked } from './obstacles';
import { Phase, startChapter } from './levels';
import { stopWaves } from './waves';
import { DT, type World } from '../world';

/** Seconds of quiet after the encounter: long enough to reload and to walk somewhere better. */
const INTERMISSION = 4;

/**
 * The rings, in metres out from the player, a landing point is looked for on — furthest first.
 *
 * The top rung is the old single ring. The rungs under it are the fix: a chapter that spent its
 * script with the player in a corner, or with the whole ring under cover, used to have no
 * encounter at all. Distance is a preference here, and the one thing that is not a preference
 * is that whatever walks in is standing on clear floor the player can see and shoot.
 */
const RINGS = [22, 17, 13, 10, 8];

/** How many sides each ring is probed on: +x, -x, +y, -y, entered at a random one. */
const SIDES = 4;

/** How far out along a side the point may sit, so a drop is not always dead-abreast. */
const MARGIN = 6;

/** A chapter with no last recipe row, which is the only empty list this file needs. */
const NO_PACK: readonly string[] = [];

/** The last point `pickDrop` accepted, with the body that asked for it. Module slots, as
 *  everywhere else here: one pair of floats rather than an object per drop. */
let dropX = 0;
let dropY = 0;

/**
 * One tick of the chapter arc, from the script's end to the next chapter's start.
 *
 * The three phases it moves through are `Phase` in `systems/levels.ts`: the script running,
 * the encounter on the floor, and the intermission that carries the run to the next room. A
 * cleared run stops here rather than looping — the last chapter sets `victory` and the drumbeat
 * does not come back, because a run that cannot end is a scoreboard, not a campaign.
 *
 * An arena run has no arc to walk: no script to spend, no encounter to open and no next floor to
 * load, so the whole file stands down for it. The ladder in `content/levels/arena.ts` is the
 * arena's escalation, and it stops at its last band rather than resolving into a boss.
 */
export function updateBoss(w: World): void {
  const wave = w.wave;
  if (w.over || w.endless || wave.phase === Phase.None || wave.phase === Phase.Cleared) return;

  if (wave.phase === Phase.Script) {
    if (wave.elapsed < levelAt(w.chapter).duration) return;
    openEncounter(w);
  }

  if (wave.phase === Phase.Encounter) {
    refresh(w);
    if (w.boss.alive) return;

    // Nothing of the encounter is left on the floor — it was killed, or it never found anywhere
    // to stand. Either way this chapter is done: the flag says so while the intermission runs,
    // and the floor that replaces it clears the flag again.
    w.chapterComplete = true;
    wave.phase = Phase.Intermission;
    wave.clearTime = INTERMISSION;
    return;
  }

  wave.clearTime -= DT;
  if (wave.clearTime > 0) return;
  w.chapterComplete = false;

  if (w.chapter >= LEVELS.length - 1) {
    w.victory = true;
    wave.phase = Phase.Cleared;
    stopWaves(w);
    return;
  }

  startChapter(w, w.chapter + 1);
}

/**
 * Whether the chapter's encounter is still on the floor.
 *
 * Reads the flag `refresh` writes rather than walking the pool again: the shell's boss plate and
 * the intermission's exit test have to be the same fact, or a scenario can be shown a boss the
 * chapter machine has already stopped waiting for.
 */
export function bossesAlive(w: World): boolean {
  return w.boss.alive;
}

/**
 * Put the chapter's encounter down.
 *
 * Bosses first and then the escort, on separate passes, so every boss is on the floor before any
 * of its company — the reason a matron arrives with someone to heal rather than healing the
 * floor. Escort bodies are dropped rather than forced: a pack that cannot find clear floor is a
 * smaller pack, and a boss fight with three fewer chargers is still the fight the chapter was
 * drawn around.
 */
function openEncounter(w: World): void {
  const wave = w.wave;
  wave.phase = Phase.Encounter;
  // Switched off for the fight. A chapter that ends with an endless horde plus a boss has two
  // escalations competing, and the player cannot tell which one they are losing to.
  stopWaves(w);

  const level = levelAt(w.chapter);
  const boss = w.boss;
  // The bar's full length is whatever actually walked in, elite rolls included, so it is
  // counted here off the slots rather than off the archetype table.
  boss.maxHp = 0;

  const last = level.packs.length - 1;
  for (let pass = 0; pass < 2; pass++) {
    const ids = pass === 0 ? level.bosses : last < 0 ? NO_PACK : level.packs[last];
    for (let k = 0; k < ids.length; k++) {
      const kind = enemyIndex(ids[k]);
      if (kind < 0) continue;
      const radius = ENEMIES[kind].radius;
      if (!pickDrop(w, radius)) {
        // Only the bosses are counted as the encounter. Losing an escort body is a smaller pack;
        // losing the boss is a chapter that ends on an empty room, and that one has to be
        // findable from the outside.
        if (pass === 0) boss.skips++;
        continue;
      }
      const slot = spawnEnemy(w, kind, dropX, dropY);
      if (slot < 0) continue;
      if (pass === 0) boss.maxHp += w.enemies.hp[slot];
    }
  }
}

/**
 * Refresh the boss read from the floor: is the encounter up, and what does it still weigh?
 *
 * One walk of the enemy pool per tick, and only while an encounter is out — the same pass also
 * answers the question that ends the chapter, so the HP bar a player reads and the thing that
 * ends the fight cannot be a tick out of step with each other. Bodies at zero HP do not count,
 * whether or not the pool has handed their slot back yet.
 */
function refresh(w: World): void {
  const boss = w.boss;
  const enemies = w.enemies;
  let hp = 0;
  let name = '';

  for (let i = 0; i < enemies.cap; i++) {
    if (enemies.alive[i] === 0 || enemies.hp[i] <= 0) continue;
    const def = ENEMIES[enemies.kind[i]];
    if (def.boss !== true) continue;
    hp += enemies.hp[i];
    if (name === '') name = def.id;
  }

  if (name === '') {
    boss.alive = false;
    boss.hp = 0;
    boss.maxHp = 0;
    boss.name = '';
    return;
  }

  boss.alive = true;
  boss.hp = hp;
  boss.name = name;
}

/**
 * Find somewhere to put a body of `radius` down: on a ring around the player, on clear floor,
 * and not in a hazard.
 *
 * Four sides a ring, walked inward, the same shape as the wave spawner's own retry and for the
 * same reason: a fixed entry point is a path a player memorises by wave three, and the sides
 * that do work all keep working when one of them is a wall. Pools are excluded because an
 * encounter dropped into acid starts the fight already losing, which is not a lesson.
 *
 * The lower rungs are inside the view rect, and that is the trade: a boss that walks in from
 * eight metres is readable (it has a name plate, a tell and a full second of wind-up before
 * anything lands) in a way that a chapter with no boss at all is not.
 */
function pickDrop(w: World, radius: number): boolean {
  for (let r = 0; r < RINGS.length; r++) {
    const ring = RINGS[r];
    const startSide = nextInt(w.rng, SIDES);

    for (let attempt = 0; attempt < SIDES; attempt++) {
      const margin = range(w.rng, 0, MARGIN);
      const along = range(w.rng, -ring, ring);
      let x = 0;
      let y = 0;

      switch ((startSide + attempt) % SIDES) {
        case 0:
          x = w.player.x + ring + margin;
          y = w.player.y + along;
          break;
        case 1:
          x = w.player.x - ring - margin;
          y = w.player.y + along;
          break;
        case 2:
          y = w.player.y + ring + margin;
          x = w.player.x + along;
          break;
        default:
          y = w.player.y - ring - margin;
          x = w.player.x + along;
          break;
      }

      if (x < w.minX + radius || x > w.maxX - radius || y < w.minY + radius || y > w.maxY - radius) {
        continue;
      }
      if (pointBlocked(w.props, x, y, radius)) continue;
      if (acidAt(w.zones, x, y) > 0) continue;

      dropX = x;
      dropY = y;
      return true;
    }
  }

  return false;
}