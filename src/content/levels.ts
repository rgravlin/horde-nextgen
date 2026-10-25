/**
 * Chapters: what a level *is*, in the two ways this sim can actually tell.
 *
 * A chapter here is a wave script and an elite roster, because those are the two things
 * the simulation reads and therefore the two things a player can feel and a test can
 * pin. It is deliberately not a layout: there is no static geometry in the broad phase
 * to make a corridor out of, and a `corridor` field nothing read would be a level
 * description that lies. When obstacles arrive, they arrive here as a field the hash
 * and the renderer both consume.
 *
 * Two rules the shape of this file exists to keep:
 *
 * - **A recipe is knowable.** Each row is walked straight down by `systems/waves.ts`,
 *   so the fifth body of wave 1 is the same archetype in every run on every seed. A
 *   weighted bag would make "does this chapter ever show you a charger" luck, which
 *   neither a browser scenario nor a player can learn from.
 * - **The ramp is in the data.** Later rows carry the bodies that punish standing still
 *   and the supports that make a pack take longer to die than its HP says, so the climb
 *   is something you can read off the page rather than tune by feel in code.
 *
 * Chapter 1's rows are the ones `content/enemies.ts` shipped with and the browser
 * scenarios assert against, so they are imported rather than copied: one source of
 * truth (AGENTS.md), and a recipe a test pins cannot drift away from the test.
 */

import { PACKS } from './enemies';

/**
 * An elite variant: a modifier applied to an archetype, never an archetype of its own.
 *
 * That distinction is load-bearing. The scenarios and the unit tests count enemies *by
 * archetype* — `byType.charger === 6`, "every archetype the roster owns reached the
 * horde" — and a charger-with-a-red-tint entered as a new row would turn every one of
 * those counts into a coin flip. An elite is therefore a scale factor on a body that is
 * still whatever it was, which is also how it reads on screen: the same silhouette,
 * bigger, faster or live, with a tell you can see from across the room.
 */
export interface EliteDef {
  readonly id: string;
  readonly label: string;
  /** Multiplier on the archetype's HP. */
  readonly hp: number;
  /**
   * Multiplier on how far the body travels per tick.
   *
   * A scale on travel rather than on `speed`, because `speed` is read in a dozen places
   * (steering, the cap, the dash) and a variant that had to be threaded through all of
   * them would be a variant that quietly does nothing in half of them. One number at the
   * single travel tail every behaviour funnels through is the same effect, applied once.
   */
  readonly gait: number;
  /** Multiplier on the archetype's contact damage. */
  readonly touch: number;
  /** Flat armour added to whatever the archetype already pays. */
  readonly armor: number;
  /**
   * A burst the body leaves behind, which its archetype may not have had. Only the
   * volatile variant declares these, and the sim gives any body that carries them the
   * same fuse-and-blast behaviour an exploder has, so a variant never needs its own
   * branch.
   */
  readonly blastRadius?: number;
  readonly blastDamage?: number;
  /** Emissive tint for the variant's outline (DESIGN.md: telegraphs are Threat Red). */
  readonly accent: string;
}

export const ELITES: readonly EliteDef[] = [
  {
    id: 'bulwark',
    label: 'Bulwark',
    hp: 1.75,
    gait: 1,
    touch: 1,
    armor: 3,
    accent: '#F2B233',
  },
  {
    id: 'frenzy',
    label: 'Frenzy',
    // Thinner and meaner: it trades a quarter of its body for a third more speed and
    // half again the hug, which is the opposite trade to a bulwark rather than a bigger
    // version of one.
    hp: 0.75,
    gait: 1.3,
    touch: 1.35,
    armor: 0,
    accent: '#FF2A3C',
  },
  {
    id: 'volatile',
    label: 'Volatile',
    // Carries a burst it did not start with. Squishier than its archetype on purpose:
    // the answer is to shoot it away from the crowd, which is the same skill the
    // exploder teaches, priced higher because now it is a modifier on anything.
    hp: 0.8,
    gait: 1,
    touch: 1,
    armor: 0,
    blastRadius: 2.2,
    blastDamage: 18,
    accent: '#9B5CFF',
  },
];

/** Id to table index, built once so a chapter names a variant rather than a row. */
export const ELITE_BY_ID: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < ELITES.length; i++) map[ELITES[i].id] = i;
  return map;
})();

/** Index of `id`, or -1 when nothing answers to that name. */
export function eliteIndex(id: string): number {
  const i = ELITE_BY_ID[id];
  return i === undefined ? -1 : i;
}

export interface LevelDef {
  readonly id: string;
  /** Shown in the HUD's top-centre panel. */
  readonly name: string;
  /**
   * Wave recipes, one row per wave, carried on past the end of the list by the last
   * row. A row is read straight down and the next wave starts where this one stopped,
   * so the mix is a fact about the chapter rather than about the seed.
   */
  readonly packs: readonly (readonly string[])[];
  /** Elite variants this chapter rolls, by id. */
  readonly elites: readonly string[];
  /**
   * Chance a spawned body comes in elite, 0..1.
   *
   * Zero for the first two chapters, and that is not a gap in the data: the whole point
   * of the early chapters is a body you learn once and then recognise, and a charger is
   * not a lesson while half of them are also something else. It also keeps every seeded
   * run that predates the variants exactly the run it already was, since a chapter that
   * rolls none draws no random numbers at all.
   */
  readonly eliteChance: number;
}

export const LEVELS: readonly LevelDef[] = [
  {
    id: 'loading-bay',
    name: 'Loading Bay',
    packs: PACKS,
    elites: [],
    eliteChance: 0,
  },
  {
    id: 'conveyor-yard',
    name: 'Conveyor Yard',
    // The exploder and the charger arrive a wave earlier than they did in chapter 1 and
    // the ranged trio joins at wave 2 rather than 3: the yard is where the chapter stops
    // teaching bodies one at a time and starts putting them together.
    packs: [
      ['swarmling', 'charger', 'exploder', 'chaser', 'charger'],
      ['charger', 'exploder', 'shooter', 'swarmling', 'chaser', 'exploder'],
      ['exploder', 'splitter', 'shooter', 'charger', 'armored', 'chaser'],
      ['armored', 'exploder', 'splitter', 'grenadier', 'charger', 'swarmling'],
      ['splitter', 'armored', 'grenadier', 'charger', 'healer', 'exploder', 'splitter'],
      ['armored', 'grenadier', 'splitter', 'charger', 'shooter', 'healer', 'exploder'],
    ],
    elites: ['bulwark'],
    // A whisper of a chance: one bulwark in a wave is a thing to notice, which is the
    // whole job of a variant's introduction.
    eliteChance: 0.05,
  },
  {
    id: 'slag-canal',
    name: 'Slag Canal',
    // Armour from the first batch, so the chapter opens by asking what you are holding:
    // a pistol round pays 1 through a bulwark's plate and the answer is a position, not
    // a faster trigger finger.
    packs: [
      ['armored', 'chaser', 'charger', 'armored', 'swarmling'],
      ['armored', 'charger', 'exploder', 'shooter', 'armored', 'charger'],
      ['splitter', 'armored', 'shooter', 'grenadier', 'charger', 'exploder'],
      ['armored', 'splitter', 'grenadier', 'healer', 'charger', 'armored', 'exploder'],
      ['grenadier', 'armored', 'healer', 'splitter', 'charger', 'shooter', 'armored'],
      ['armored', 'grenadier', 'splitter', 'exploder', 'charger', 'healer', 'armored'],
    ],
    elites: ['bulwark', 'frenzy'],
    eliteChance: 0.08,
  },
  {
    id: 'coolant-deck',
    name: 'Coolant Deck',
    // Splitters all the way down: the deck is the chapter that makes "kill it away from
    // the crowd" a decision you have to make four times a wave.
    packs: [
      ['splitter', 'swarmling', 'splitter', 'chaser', 'exploder'],
      ['splitter', 'exploder', 'shooter', 'splitter', 'charger', 'swarmling'],
      ['splitter', 'armored', 'grenadier', 'exploder', 'shooter', 'splitter'],
      ['armored', 'splitter', 'healer', 'grenadier', 'charger', 'exploder', 'splitter'],
      ['grenadier', 'splitter', 'armored', 'shooter', 'exploder', 'healer', 'charger'],
      ['splitter', 'armored', 'grenadier', 'exploder', 'splitter', 'charger', 'healer'],
    ],
    elites: ['bulwark', 'frenzy'],
    eliteChance: 0.1,
  },
  {
    id: 'reactor-rim',
    name: 'Reactor Rim',
    // Everything that detonates, on a recipe that pairs it with everything that heals.
    // The answer is prioritisation, and the chapter is short on room to think about it.
    packs: [
      ['exploder', 'exploder', 'charger', 'swarmling', 'exploder'],
      ['exploder', 'shooter', 'armored', 'exploder', 'charger', 'splitter'],
      ['grenadier', 'exploder', 'healer', 'armored', 'splitter', 'charger'],
      ['exploder', 'grenadier', 'armored', 'shooter', 'healer', 'splitter', 'exploder'],
      ['armored', 'exploder', 'grenadier', 'splitter', 'healer', 'charger', 'exploder'],
      ['grenadier', 'exploder', 'armored', 'splitter', 'charger', 'shooter', 'healer'],
    ],
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.12,
  },
  {
    id: 'thread-floor',
    name: 'Thread Floor',
    // The swarm chapter: forty-body clouds and the charger that arrives behind one, with
    // the healer added once the pack is big enough that mending six bodies is a real
    // thing that happens.
    packs: [
      ['swarmling', 'swarmling', 'chaser', 'swarmling', 'charger', 'swarmling'],
      ['swarmling', 'charger', 'exploder', 'swarmling', 'shooter', 'chaser'],
      ['charger', 'swarmling', 'splitter', 'shooter', 'armored', 'swarmling'],
      ['swarmling', 'armored', 'grenadier', 'charger', 'shooter', 'healer'],
      ['armored', 'swarmling', 'exploder', 'splitter', 'charger', 'grenadier', 'healer'],
      ['splitter', 'charger', 'armored', 'swarmling', 'exploder', 'healer', 'shooter'],
    ],
    elites: ['frenzy', 'volatile'],
    eliteChance: 0.14,
  },
  {
    id: 'cinder-vault',
    name: 'Cinder Vault',
    // No chaff. Every row is a body that either shoots, bursts, or takes a hit for
    // something else, which is the chapter's whole argument for existing.
    packs: [
      ['armored', 'shooter', 'exploder', 'armored', 'charger'],
      ['armored', 'grenadier', 'shooter', 'splitter', 'healer', 'exploder'],
      ['grenadier', 'armored', 'healer', 'shooter', 'exploder', 'splitter'],
      ['armored', 'exploder', 'grenadier', 'healer', 'splitter', 'shooter', 'charger'],
      ['healer', 'armored', 'grenadier', 'exploder', 'shooter', 'splitter', 'armored'],
      ['grenadier', 'armored', 'exploder', 'shooter', 'healer', 'splitter', 'charger'],
    ],
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.16,
  },
  {
    id: 'long-room',
    name: 'The Long Room',
    // Everything, at once, from the first batch, and the highest elite rate in the
    // game. Eight chapters in, the last room is allowed to be unfair in a way that is
    // legible: nothing here is new, it is only all arriving together.
    packs: [
      ['armored', 'charger', 'exploder', 'shooter', 'splitter', 'grenadier'],
      ['armored', 'healer', 'grenadier', 'exploder', 'charger', 'splitter', 'shooter'],
      ['splitter', 'armored', 'shooter', 'healer', 'exploder', 'grenadier', 'charger'],
      ['grenadier', 'armored', 'exploder', 'splitter', 'shooter', 'charger', 'healer'],
      ['armored', 'grenadier', 'healer', 'exploder', 'splitter', 'shooter', 'charger'],
      ['exploder', 'armored', 'splitter', 'grenadier', 'charger', 'shooter', 'healer'],
    ],
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.18,
  },
];

/** The chapter a run plays at index `i`, clamped so a long run never falls off. */
export function levelAt(index: number): LevelDef {
  const at = index < 0 ? 0 : index >= LEVELS.length ? LEVELS.length - 1 : index;
  return LEVELS[at];
}

/**
 * The same rosters as `ELITES` indices, resolved once.
 *
 * The spawner draws an elite on every body it puts down, and a name lookup there would
 * be a dictionary probe sixty times a second to answer a question the chapter already
 * knows. Resolved at load, and a name that matches nothing is dropped here rather than
 * at spawn time, so a typo in a roster costs a variant and not a bug.
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
