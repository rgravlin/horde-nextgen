/**
 * The Endless Arena: one floor, and one ladder that never ends.
 *
 * This is not chapter eleven. A chapter is a script with an encounter at the end of it, and the
 * whole point of the arena is that there is no end to reach — no boss walks in at 1:30, no floor
 * loads after it, no victory. So it is not a row in `LEVELS` either: that array is the chapter
 * grid, `bestTimes` and `unlockedChapters` all index by it, and a run that never clears would
 * have nothing to write into a per-chapter column. The arena is a *mode* (`world.endless`) that
 * borrows one floor and one escalation table, and the table is this file.
 *
 * **Why the ladder has rungs at all.** The drumbeat's own curve is capped: `fillGap` bottoms out
 * at a 0.3 s floor (divided by the chapter's spawn rate) around wave 25 and `batchSize` caps at
 * `TUNE.batchCap`, so a mode that escalated only through those two dials would be at full
 * difficulty inside two minutes and flat for the remaining hour. A band changes the dials itself
 * — a batch cap, a gap divisor, an HP price and an elite rate per band — which buys a climb that
 * takes about five minutes to top out and then holds, rather than a wall at minute one.
 *
 * **The top rung is the ceiling, deliberately.** Nine tens of bodies a second is past the point
 * where more is harder and into the point where it is only slower: the pool caps at
 * `POOL_CAPS.enemies`, spawns into a full pool are refused, and a run that cannot be lost is not
 * a run. The last band is where it stops, and `tests/unit/arena.test.ts` pins that it stops.
 *
 * **What the floor is for.** Same two rules as every chapter: cover that reads, and lines that
 * are not blocked — a teleporter and a burrower spend the whole ring before they commit, and a
 * sniper needs eight metres of clear air to fly a bolt. So the ring is four bars with the corners
 * left open, a pillar circle that leaves the middle open enough to spawn in, and the pools and
 * plates off in the aisles rather than under the player's feet.
 */

import { REACTOR, acid, crate, crusher, pillar, tank, wall } from './builders';
import { eliteIndex } from './elites';
import type { PaletteDef, PropDef, HazardDef } from './types';

/**
 * One rung of the ladder.
 *
 * `from` is a wave index rather than a second, because the arena has no script to time: the wave
 * clock (`TUNE.waveLength` a wave) is the only clock it has, and the wave index is already what
 * the drumbeat's own dials read. `batch`, `rate`, `hp`, `elites` and `eliteChance` are the same
 * four dials `DifficultyDef` carries for a chapter, per rung instead of per floor; `packs` is a
 * drumbeat recipe, cycled rather than walked once (see `runFill` in `sim/systems/waves.ts`).
 */
export interface BandDef {
  readonly id: string;
  /** Shown in the HUD's top-centre panel next to the wave count. */
  readonly label: string;
  /** First wave index this band is in effect. Bands are listed in ascending `from`. */
  readonly from: number;
  readonly packs: readonly (readonly string[])[];
  /** Bodies per drumbeat batch, in the band's place of `TUNE.batchCap`. */
  readonly batch: number;
  /** Divisor on the seconds between batches, in the band's place of `difficulty.spawnRate`. */
  readonly rate: number;
  /** Multiplier on the HP of every body the band puts down. */
  readonly hp: number;
  /** Elite variants this band rolls, by id. */
  readonly elites: readonly string[];
  /** Chance a body arrives wearing one, 0..1. */
  readonly eliteChance: number;
}

/** The arena: its ladder, and the one floor it is fought on. */
export interface ArenaDef {
  readonly id: string;
  /** Shown instead of a chapter name while the run is an arena run. */
  readonly name: string;
  readonly bands: readonly BandDef[];
  readonly size: number;
  readonly palette: PaletteDef;
  readonly props: readonly PropDef[];
  readonly hazards: readonly HazardDef[];
}

/**
 * The ladder, hardest last.
 *
 * The first rung is already the Kill Floor's neighbourhood — the arena is only offered to someone
 * who has beaten it — and the last is about half again the campaign's maximum pressure. Every
 * name in every recipe is an archetype `content/enemies.ts` owns; `tests/unit/arena.test.ts`
 * reads them back through `enemyIndex` rather than trusting the spelling.
 */
const BANDS: readonly BandDef[] = [
  {
    id: 'vanguard',
    label: 'Vanguard',
    from: 1,
    packs: [
      ['chaser', 'swarmling', 'chaser', 'charger'],
      ['swarmling', 'chaser', 'exploder', 'charger'],
    ],
    batch: 6,
    rate: 1.4,
    hp: 1.15,
    elites: [],
    eliteChance: 0,
  },
  {
    id: 'raiders',
    label: 'Raiders',
    from: 4,
    packs: [
      ['chaser', 'charger', 'swarmling', 'shooter'],
      ['exploder', 'splitter', 'chaser', 'burrower'],
      ['charger', 'charger', 'swarmling', 'shooter', 'sniper'],
    ],
    batch: 7,
    rate: 1.55,
    hp: 1.3,
    elites: ['frenzy'],
    eliteChance: 0.08,
  },
  {
    id: 'siege',
    label: 'Siege',
    from: 8,
    packs: [
      ['armored', 'shooter', 'exploder', 'armored', 'charger'],
      ['grenadier', 'armored', 'shooter', 'splitter', 'healer'],
      ['armored', 'exploder', 'grenadier', 'shooter', 'orbiter'],
    ],
    batch: 8,
    rate: 1.7,
    hp: 1.45,
    elites: ['bulwark', 'frenzy'],
    eliteChance: 0.12,
  },
  {
    id: 'cascade',
    label: 'Cascade',
    from: 13,
    packs: [
      ['armored', 'grenadier', 'healer', 'shooter', 'exploder', 'splitter'],
      ['teleporter', 'shooter', 'sniper', 'armored', 'orbiter'],
      ['spawner', 'chaser', 'grenadier', 'exploder', 'splitter', 'healer'],
    ],
    batch: 9,
    rate: 1.85,
    hp: 1.6,
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.16,
  },
  {
    id: 'meltdown',
    label: 'Meltdown',
    from: 19,
    packs: [
      ['armored', 'grenadier', 'healer', 'sniper', 'teleporter', 'exploder'],
      ['spawner', 'orbiter', 'shooter', 'armored', 'burrower', 'charger'],
      ['teleporter', 'sniper', 'orbiter', 'grenadier', 'healer', 'splitter'],
    ],
    batch: 11,
    rate: 2.1,
    hp: 1.9,
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.22,
  },
  {
    id: 'annihilation',
    label: 'Annihilation',
    from: 26,
    packs: [
      ['armored', 'grenadier', 'healer', 'sniper', 'teleporter', 'orbiter', 'spawner'],
      ['burrower', 'charger', 'armored', 'shooter', 'exploder', 'splitter', 'healer'],
    ],
    batch: 12,
    rate: 2.35,
    hp: 2.1,
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.26,
  },
];

/**
 * The ring.
 *
 * Four bars with the corners open, a circle of columns, and the corrosion and the plates out in
 * the aisles. The middle is deliberately empty: the run starts at the origin, and a floor whose
 * centre is a wall starts the player inside one.
 */
const PROPS: readonly PropDef[] = [
  wall(0, 14, 14, 1.6),
  wall(0, -14, 14, 1.6),
  wall(14, 0, 1.6, 14),
  wall(-14, 0, 1.6, 14),
  pillar(15.5, 15.5, 1.3),
  pillar(-15.5, 15.5, 1.3),
  pillar(15.5, -15.5, 1.3),
  pillar(-15.5, -15.5, 1.3),
  pillar(26, 0, 1.2),
  pillar(-26, 0, 1.2),
  pillar(0, 26, 1.2),
  pillar(0, -26, 1.2),
  tank(0, 8, 3),
  tank(-8, -3, 3),
  crate(20, 8),
  crate(-20, 8),
  crate(20, -8),
  crate(-20, -8),
  crate(6, 21),
  crate(-6, -21),
  crate(31, 27),
  crate(-31, -27),
  wall(-30, 26, 16, 1.8),
  wall(30, -26, 16, 1.8),
  wall(28, 26, 1.8, 12),
  wall(-28, -26, 1.8, 12),
];

const HAZARDS: readonly HazardDef[] = [
  acid(0, -6, 5, 7),
  acid(-22, 12, 4.5, 8),
  acid(20, -18, 5.5, 6),
  acid(30, 24, 4, 9),
  crusher(-8, 6, 3.2, 26),
  crusher(16, 14, 3.2, 26),
  crusher(-28, -14, 2.6, 22),
];

/** The floor a run that has finished the campaign plays on, and the ladder it climbs. */
export const ARENA: ArenaDef = {
  id: 'endless-arena',
  name: 'Endless Arena',
  bands: BANDS,
  // Wider than any chapter: the arena's pressure is a rate, and a rate needs room to arrive in.
  size: 56,
  palette: REACTOR,
  props: PROPS,
  hazards: HAZARDS,
};

/**
 * Which rung wave `index` is fought at, as a `bands` index.
 *
 * A scan over six rows rather than a division, because the rungs are not evenly spaced and the
 * spacing is the tuning: a division would have to be rewritten the moment a rung moves.
 */
export function bandIndexAt(waveIndex: number): number {
  const bands = ARENA.bands;
  let at = 0;
  for (let i = 1; i < bands.length; i++) {
    if (waveIndex < bands[i].from) break;
    at = i;
  }
  return at;
}

/** The rung itself. Shared, so a spawner that asks every tick allocates nothing. */
export function bandAt(waveIndex: number): BandDef {
  return ARENA.bands[bandIndexAt(waveIndex)];
}

/** Each rung's elite roster, resolved against `elites.ts` once, the way a chapter's is. */
export const ARENA_ROSTERS: readonly (readonly number[])[] = ARENA.bands.map((band) => {
  const roster: number[] = [];
  for (const id of band.elites) {
    const i = eliteIndex(id);
    if (i >= 0 && roster.indexOf(i) < 0) roster.push(i);
  }
  return roster;
});

/** The variants the rung under `waveIndex` rolls. */
export function arenaRosterAt(waveIndex: number): readonly number[] {
  return ARENA_ROSTERS[bandIndexAt(waveIndex)];
}