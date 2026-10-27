/**
 * Chapters: what a level *is*, and the ten of them a run plays.
 *
 * A chapter is a floor plan, a wave script and an elite roster, because those are the things
 * the simulation reads and therefore the things a player can feel and a test can pin. The floor
 * plan is boxes in world metres, installed into `sim/systems/obstacles.ts` when the chapter
 * starts and read back by the player's movement, every enemy's travel step, every round in the
 * air and the renderer's cover pass. The wave script is a list of timed packs with a drumbeat
 * fill underneath it, both read by `sim/systems/waves.ts`. The encounter at the end is a body
 * from `content/enemies.ts` marked `boss`.
 *
 * The folder is that split, by who reads what: `types.ts` is the schema, `elites.ts` the three
 * variants every chapter shares, `builders.ts` the shorthands the floors are written with, and
 * three files of chapters in play order — 1 to 3, 4 to 6, 7 to 10 — grouped because a chapter
 * range is the thing you want open next to the one you are tuning. This file is the wiring and
 * the two lookups that need the whole campaign at once. Outside the folder the public surface
 * is what is exported at the bottom of this file, and it is the same surface the single file
 * had; `tests/unit/levels-split.test.ts` is what keeps it that way.
 *
 * Three rules the shape of these files exists to keep:
 *
 * - **The floor is the same shape for everyone.** Boxes are authored once and never moved,
 *   so a corridor is a fact about the chapter rather than about the seed, and a run replayed
 *   at the same seed walks the same rooms.
 * - **A script is knowable.** Each pack lands at a second and from a side, and the fill walks
 *   its recipe straight down, so the fifth body of wave 1 is the same archetype in every run on
 *   every seed. A weighted bag would make "does this chapter ever show you a charger" luck,
 *   which neither a browser scenario nor a player can learn from.
 * - **The ramp is in the data.** Later chapters carry the bodies that punish standing still and
 *   the supports that make a pack take longer to die than its HP says, and they carry them
 *   faster and tougher — one `difficulty` pair per chapter, so the climb is something you can
 *   read off the page rather than tune by feel in code.
 *
 * Chapter 1's recipes are the ones `content/enemies.ts` shipped with and the browser scenarios
 * assert against, so they are imported rather than copied: one source of truth (AGENTS.md), and
 * a recipe a test pins cannot drift away from the test.
 *
 * What a chapter carries beyond the script is the room itself: a floor size, a fog and
 * key-light tint, the cover and the hazards. Every one of those is read by something — the
 * arena by the chapter's own installation, the tint by the renderer's fog and key light, the
 * boxes and circles by `sim/systems/obstacles.ts` — because a field nothing consults is the
 * same kind of lie as a `corridor` field with no geometry behind it.
 *
 * **On chapter length.** `duration` is seconds of script before the encounter walks in, and the
 * ten chapters run 78 to 96 s of it — thirteen to sixteen minutes of campaign. That is shorter
 * than a five-minute stage, and the reason is the fill: the drumbeat's batches grow with the
 * wave index while its gap shrinks, so a chapter's second half is a rate rather than a cap, and
 * a stage that ran to five minutes would spend its last third trying to spawn into a full
 * 2,048-body pool. Lengthening a chapter means slowing that curve in the same edit, and
 * `tests/unit/obstacles.test.ts` — which runs a chapter out to its encounter inside a tick
 * budget — is the check that says so first.
 */

import { ARENA, ARENA_ROSTERS, arenaRosterAt, bandAt, bandIndexAt } from './arena';
import { ELITE_BY_ID, ELITES, eliteIndex } from './elites';
import { LEVELS_1_3 } from './chapters-1-3';
import { LEVELS_4_6 } from './chapters-4-6';
import { LEVELS_7_10 } from './chapters-7-10';
import type { LevelDef } from './types';

/**
 * The campaign, in play order.
 *
 * Three files, one per chapter range, joined here rather than in one long array so a chapter is
 * found by counting three floors to a page instead of scrolling a thousand lines. The order the
 * joined array holds is the order the campaign runs and the order
 * `tests/unit/levels-split.test.ts` pins by id.
 */
export const LEVELS: readonly LevelDef[] = [...LEVELS_1_3, ...LEVELS_4_6, ...LEVELS_7_10];

/** The chapter a run plays at index `i`, clamped so a long run never falls off. */
export function levelAt(index: number): LevelDef {
  const at = index < 0 ? 0 : index >= LEVELS.length ? LEVELS.length - 1 : index;
  return LEVELS[at];
}

/**
 * The same rosters as `ELITES` indices, resolved once.
 *
 * The spawner draws an elite on every body it puts down, and a name lookup there would be a
 * dictionary probe sixty times a second to answer a question the chapter already knows.
 * Resolved at load, and a name that matches nothing is dropped here rather than at spawn
 * time, so a typo in a roster costs a variant and not a bug.
 */
export const LEVEL_ELITES: readonly (readonly number[])[] = LEVELS.map((level) => {
  const roster: number[] = [];
  for (const id of level.elites) {
    const i = eliteIndex(id);
    if (i >= 0 && roster.indexOf(i) < 0) roster.push(i);
  }
  return roster;
});

/** The elite roster for chapter `index`, clamped the same way `levelAt` clamps. */
export function eliteRosterAt(index: number): readonly number[] {
  const at = index < 0 ? 0 : index >= LEVEL_ELITES.length ? LEVEL_ELITES.length - 1 : index;
  return LEVEL_ELITES[at];
}

// The Endless Arena comes through the same door (see `arena.ts` for why it is not an eleventh
// chapter). `levelAt` stays a *chapter* lookup — it clamps, and a clamped arena would hand back
// Loading Bay — so a caller that has a layout key rather than a chapter index takes the arena
// apart from it: `key < 0 ? ARENA : levelAt(key)`.
export { ARENA, ARENA_ROSTERS, arenaRosterAt, bandAt, bandIndexAt };
export type { ArenaDef, BandDef } from './arena';

// The rest of the campaign comes in through this file: `sim/systems/{waves,boss,levels,powerups}.ts`,
// the two enemy spawn modules and the HUD's chapter tiles all read a chapter through here, so
// adding a chapter file means adding one line above and one entry in it.
export { ELITES, ELITE_BY_ID, eliteIndex };
export type {
  BeatDef,
  DifficultyDef,
  EliteDef,
  HazardDef,
  LevelDef,
  PaletteDef,
  PropDef,
} from './types';
