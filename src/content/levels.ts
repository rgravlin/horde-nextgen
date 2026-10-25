/**
 * Chapters: what a level *is*, in the three ways this sim can actually tell.
 *
 * A chapter here is a floor plan, a wave script and an elite roster, because those are the
 * things the simulation reads and therefore the things a player can feel and a test can pin.
 * The floor plan is boxes in world metres, installed into `sim/props.ts` when the chapter
 * starts and read back by the player's movement, every enemy's travel step, every round in
 * the air and the renderer's cover pass. The wave script is a recipe walked straight down.
 * The encounter at the end is a body from `content/enemies.ts` marked `boss`.
 *
 * Three rules the shape of this file exists to keep:
 *
 * - **The floor is the same shape for everyone.** Boxes are authored once and never moved,
 *   so a corridor is a fact about the chapter rather than about the seed, and a run replayed
 *   at the same seed walks the same rooms.
 * - **A recipe is knowable.** Each row is read straight down by `systems/waves.ts`, so the
 *   fifth body of wave 1 is the same archetype in every run on every seed. A weighted bag
 *   would make "does this chapter ever show you a charger" luck, which neither a browser
 *   scenario nor a player can learn from.
 * - **The ramp is in the data.** Later rows carry the bodies that punish standing still and
 *   the supports that make a pack take longer to die than its HP says, so the climb is
 *   something you can read off the page rather than tune by feel in code.
 *
 * Chapter 1's rows are the ones `content/enemies.ts` shipped with and the browser scenarios
 * assert against, so they are imported rather than copied: one source of truth (AGENTS.md),
 * and a recipe a test pins cannot drift away from the test.
 *
 * What a chapter carries beyond the recipe is the room itself: a floor size, a fog and
 * key-light tint, the cover and the hazards. Every one of those is read by something — the
 * arena by the chapter's own installation, the tint by the renderer's fog and key light, the
 * boxes and circles by `sim/systems/obstacles.ts` — because a field nothing consults is the
 * same kind of lie as a `corridor` field with no geometry behind it.
 */

import { PACKS } from './enemies';
import { PropKind, ZoneKind } from '../sim/systems/obstacles';

/**
 * An elite variant: a modifier applied to an archetype, never an archetype of its own.
 *
 * That distinction is load-bearing. The scenarios and the unit tests count enemies *by
 * archetype* — `byType.charger === 6`, "every archetype the roster owns reached the horde"
 * — and a charger-with-a-red-tint entered as a new row would turn every one of those counts
 * into a coin flip. An elite is therefore a scale factor on a body that is still whatever it
 * was, which is also how it reads on screen: the same silhouette, bigger, faster or live,
 * with a tell you can see from across the room.
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
   * (steering, the cap, the dash) and a variant that had to be threaded through all of them
   * would be a variant that quietly does nothing in half of them. One number at the single
   * travel tail every behaviour funnels through is the same effect, applied once.
   */
  readonly gait: number;
  /** Multiplier on the archetype's contact damage. */
  readonly touch: number;
  /** Flat armour added to whatever the archetype already pays. */
  readonly armor: number;
  /**
   * A burst the body leaves behind, which its archetype may not have had. Only the volatile
   * variant declares these, and the sim gives any body that carries them the same
   * fuse-and-blast behaviour an exploder has, so a variant never needs its own branch.
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
    // Thinner and meaner: it trades a quarter of its body for a third more speed and half
    // again the hug, which is the opposite trade to a bulwark rather than a bigger version
    // of one.
    hp: 0.75,
    gait: 1.3,
    touch: 1.35,
    armor: 0,
    accent: '#FF2A3C',
  },
  {
    id: 'volatile',
    label: 'Volatile',
    // Carries a burst it did not start with. Squishier than its archetype on purpose: the
    // answer is to shoot it away from the crowd, which is the same skill the exploder
    // teaches, priced higher because now it is a modifier on anything.
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

/**
 * One box or column of cover, authored as a centre and a size.
 *
 * `kind` is only ever a hint for the renderer — every kind collides the same way, which is
 * what keeps one code path instead of three, and `r` is what makes a kind round rather than
 * `kind` itself. A prop thinner than 1.2 m through the middle is refused when the chapter
 * loads (`sim/systems/obstacles.ts`), so the number is a constraint rather than a
 * suggestion: below that, a dashing body crosses the whole thing in one tick.
 */
export interface PropDef {
  readonly kind: number;
  readonly x: number;
  readonly y: number;
  /** Full width and height in metres, not half-extents. */
  readonly w: number;
  readonly h: number;
  /** Set for a round prop: its radius, which is the shape the sim actually tests. */
  readonly r?: number;
}

/**
 * One hazard on the floor.
 *
 * `dps` means damage per second on an acid pool and damage per blow on a crusher; `gap` and
 * `warn` are only read by a crusher, and `warn` is the seconds of tell it gets first, which
 * every one here sets above the 0.4 s DESIGN.md asks for. A hazard hurts whichever side is
 * standing in it, and that is the design rather than a detail: a pool you can bait a pack
 * into is a position, and a pool that only punishes the player is wallpaper with a tax.
 */
export interface HazardDef {
  readonly kind: number;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly dps: number;
  readonly gap?: number;
  readonly warn?: number;
}

/**
 * One chapter's air: what the fog and the one key light are tinted to.
 *
 * DESIGN.md's three chapter families (teal docks, amber foundry, violet reactor) are the
 * three entries below, and they are tints rather than new palettes: the colour *roles* the
 * brief pins never change, so a chapter differs in the colour of its gloom, not in what
 * each colour means. Both values stay near Void so the horizon and the floor keep agreeing.
 */
export interface PaletteDef {
  /** Fog and sky colour, read by the renderer when the chapter loads. */
  readonly fog: string;
  /** Tint on the shadow-casting key light. */
  readonly key: string;
}

const DOCKS: PaletteDef = { fog: '#0B1D20', key: '#9FD9E4' };
const FOUNDRY: PaletteDef = { fog: '#1A1206', key: '#F2B233' };
const REACTOR: PaletteDef = { fog: '#150C22', key: '#B48CFF' };

export interface LevelDef {
  readonly id: string;
  /** Shown in the HUD's top-centre panel. */
  readonly name: string;
  /**
   * Wave recipes, one row per wave, carried on past the end of the list by the last row. A
   * row is read straight down and the next wave starts where this one stopped, so the mix is
   * a fact about the chapter rather than about the seed.
   */
  readonly packs: readonly (readonly string[])[];
  /** Elite variants this chapter rolls, by id. */
  readonly elites: readonly string[];
  /**
   * Chance a spawned body comes in elite, 0..1.
   *
   * Zero for the first two chapters, and that is not a gap in the data: the whole point of
   * the early chapters is a body you learn once and then recognise, and a charger is not a
   * lesson while half of them are also something else. It also keeps every seeded run that
   * predates the variants exactly the run it already was, since a chapter that rolls none
   * draws no random numbers at all.
   */
  readonly eliteChance: number;
  /**
   * Waves of drumbeat before the encounter walks in. Eight at a 12 s wave is 96 s of
   * escalation, which is roughly the length of run DESIGN.md wants before a chapter changes
   * what it is asking of you.
   */
  readonly waves: number;
  /**
   * The bodies the chapter ends on, by archetype id.
   *
   * They arrive together, with an escort from the chapter's last recipe row, once the script
   * is spent — see `systems/levels.ts`. A list rather than one id because a chapter is
   * allowed to end on more than one thing, and the last room ends on all three.
   */
  readonly bosses: readonly string[];
  /**
   * Half-edge of the chapter's arena in metres, clamped to the floor the World was built
   * with. It is the playable box rather than the drawn one: a chapter that wants to be
   * fought in a corridor says so here, and the spawner, the drops and the clamp all read it.
   */
  readonly size: number;
  /** Fog and key-light tint, applied when the chapter loads. */
  readonly palette: PaletteDef;
  /** Static cover. Installed once, at the same moment the wave clock starts. */
  readonly props: readonly PropDef[];
  /** Floor hazards. */
  readonly hazards: readonly HazardDef[];
}

/** Acid shorthand: a pool that costs `dps` a second while anything stands in it. */
function acid(x: number, y: number, r: number, dps: number): HazardDef {
  return { kind: ZoneKind.Acid, x, y, r, dps };
}

/**
 * Crusher shorthand: a plate that tells for `warn` seconds and then hits for `dps`, every
 * `gap` seconds. The two defaults are the chapter-5 numbers and are only ever overridden to
 * make a room meaner, never to shorten the tell below what a player can read.
 */
function crusher(x: number, y: number, r: number, dps: number, gap = 3.2, warn = 0.45): HazardDef {
  return { kind: ZoneKind.Crusher, x, y, r, dps, gap, warn };
}

/** Wall shorthand. */
function wall(x: number, y: number, w: number, h: number): PropDef {
  return { kind: PropKind.Wall, x, y, w, h };
}

/** Cover shorthand: the same box, drawn as a crate. */
function crate(x: number, y: number, s = 2): PropDef {
  return { kind: PropKind.Crate, x, y, w: s, h: s };
}

/** Vessel shorthand. */
function tank(x: number, y: number, s = 3): PropDef {
  return { kind: PropKind.Tank, x, y, w: s, h: s };
}

/**
 * Column shorthand: the one round prop.
 *
 * `w`/`h` carry the diameter so the drawing pass reads one set of numbers for every prop,
 * and the radius goes in beside them because that is the shape the collision tests — the box
 * around a column is not the column.
 */
function pillar(x: number, y: number, r = 1.25): PropDef {
  return { kind: PropKind.Pillar, x, y, w: r * 2, h: r * 2, r };
}

export const LEVELS: readonly LevelDef[] = [
  {
    id: 'loading-bay',
    name: 'Loading Bay',
    packs: PACKS,
    elites: [],
    eliteChance: 0,
    waves: 6,
    bosses: ['broodmother'],
    size: 60,
    palette: DOCKS,
    // Deliberately the emptiest floor in the game, and that is a load-bearing decision
    // rather than an unfinished one. The bay is where a player learns to read bodies, and
    // the browser scenarios drive a first run across it: the origin stays clear and the
    // twelve metres straight down +x stay clear so a held movement key goes somewhere. What
    // cover there is sits upfield and leaves a gate wider than any body that has to walk
    // through it. The three columns are the first round cover in the game for the same
    // reason: a pillar is something you walk past, and the bay is where a player learns that
    // cover has a shape.
    props: [crate(18, -14), crate(21, -14), crate(-20, 10, 2.5), wall(-14, -18, 10, 2), pillar(-9, 12, 1.5), pillar(12, 9, 1.5), pillar(10, -11, 1.5)],
    hazards: [acid(24, 12, 3, 10)],
  },
  {
    id: 'conveyor-yard',
    name: 'Conveyor Yard',
    // The exploder and the charger arrive a wave earlier than they did in chapter 1 and the
    // ranged trio joins at wave 2 rather than 3: the yard is where the chapter stops teaching
    // bodies one at a time and starts putting them together.
    packs: [
      ['swarmling', 'charger', 'exploder', 'chaser', 'charger'],
      ['charger', 'exploder', 'shooter', 'swarmling', 'chaser', 'exploder'],
      ['exploder', 'splitter', 'shooter', 'charger', 'armored', 'chaser'],
      ['armored', 'exploder', 'splitter', 'grenadier', 'charger', 'swarmling'],
      ['splitter', 'armored', 'grenadier', 'charger', 'healer', 'exploder', 'splitter'],
      ['armored', 'grenadier', 'splitter', 'charger', 'shooter', 'healer', 'exploder'],
    ],
    elites: ['bulwark'],
    // A whisper of a chance: one bulwark in a wave is a thing to notice, which is the whole
    // job of a variant's introduction.
    eliteChance: 0.05,
    waves: 6,
    bosses: ['broodmother'],
    size: 54,
    palette: FOUNDRY,
    // Two runs of crates laid as a conveyor: the lanes read as somewhere to run down and
    // they break a swarm's line into two lines, which is the lesson the yard teaches. The
    // lanes stop short of the origin so the first twenty seconds are not fought in a
    // corridor.
    props: [
      wall(-26, 6, 2, 22),
      wall(-14, 6, 2, 22),
      wall(14, -8, 2, 22),
      wall(26, -8, 2, 22),
      crate(-6, -20),
      crate(-2, -20),
      crate(6, 20),
      crate(10, 20),
      tank(-22, -22, 3.5),
      tank(22, 22, 3.5),
    ],
    hazards: [acid(-20, -6, 3.2, 12), acid(20, 6, 3.2, 12)],
  },
  {
    id: 'slag-canal',
    name: 'Slag Canal',
    // Armour from the first batch, so the chapter opens by asking what you are holding: a
    // pistol round pays 1 through a bulwark's plate and the answer is a position, not a
    // faster trigger finger.
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
    waves: 6,
    bosses: ['atlas'],
    size: 50,
    palette: FOUNDRY,
    // The canal: two long walls with the pools in the bottom of them. Standing in the
    // middle of the map is a thing the player has to choose, which is the whole point of
    // putting acid where the shortest path runs — so the pools sit on that line east and
    // west of the crates rather than under the spawn point. A run that begins in corrosion
    // was never offered a choice, and the gaps at each end are twelve metres, so the
    // armoured chapter ends on an armoured body that can actually get to the fight.
    props: [
      wall(0, 13, 46, 2),
      wall(0, -13, 46, 2),
      wall(-25, 0, 2, 10),
      wall(25, 0, 2, 10),
      crate(-8, 0, 2.5),
      crate(8, 0, 2.5),
    ],
    hazards: [acid(13, 0, 2.5, 14), acid(-13, 0, 2.5, 14), acid(21, 0, 2.5, 12)],
  },
  {
    id: 'coolant-deck',
    name: 'Coolant Deck',
    // Splitters all the way down: the deck is the chapter that makes "kill it away from the
    // crowd" a decision you have to make four times a wave.
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
    waves: 7,
    bosses: ['broodmother', 'broodmother'],
    size: 52,
    palette: DOCKS,
    // Four pods with a doorway in each: a splitter that dies in a pod hatches four splinters
    // in a room with one way out, which is why the deck's own lesson is about where a kill
    // happens and not about whether it happens. The centre stays open so the player is not
    // sealed in a corner at the start.
    props: [
      wall(-16, 16, 16, 2),
      wall(-22, 8, 2, 12),
      wall(16, 16, 16, 2),
      wall(22, 8, 2, 12),
      wall(-16, -16, 16, 2),
      wall(-22, -8, 2, 12),
      wall(16, -16, 16, 2),
      wall(22, -8, 2, 12),
      crate(0, 22, 3),
      crate(0, -22, 3),
    ],
    hazards: [acid(-18, 18, 3, 12), acid(18, -18, 3, 12), acid(18, 18, 2.5, 10), acid(-18, -18, 2.5, 10)],
  },
  {
    id: 'reactor-rim',
    name: 'Reactor Rim',
    // Everything that detonates, on a recipe that pairs it with everything that heals. The
    // answer is prioritisation, and the chapter is short on room to think about it.
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
    waves: 7,
    bosses: ['matron'],
    size: 46,
    palette: REACTOR,
    // A ring of vessels with two gaps: the rim is the first chapter whose middle is a place
    // you go through rather than a place you stand, and the crushers sit in the two lanes
    // that ring leaves, so running the ring is a route with a price on it rather than a free
    // lap.
    props: [
      tank(0, 18, 4),
      tank(0, -18, 4),
      tank(18, 0, 4),
      tank(-18, 0, 4),
      wall(12, 12, 10, 2),
      wall(-12, 12, 10, 2),
      wall(12, -12, 10, 2),
      wall(-12, -12, 10, 2),
      crate(0, 26, 2.5),
      crate(0, -26, 2.5),
    ],
    hazards: [acid(0, 8, 3.5, 14), acid(0, -8, 3.5, 14), crusher(24, 0, 2.6, 45), crusher(-24, 0, 2.6, 45)],
  },
  {
    id: 'thread-floor',
    name: 'Thread Floor',
    // The swarm chapter: forty-body clouds and the charger that arrives behind one, with the
    // healer added once the pack is big enough that mending six bodies is a real thing that
    // happens.
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
    waves: 7,
    bosses: ['matron', 'matron'],
    size: 60,
    palette: DOCKS,
    // Sparse pillars in a wide room, laid on a lattice with the gaps left wide. A cloud of
    // forty has to be deletable with one good sweep, and it still is — but a pillar field
    // means the sweep has to be aimed somewhere, and a swarm that funnels is a swarm that
    // arrives in twos instead of forties.
    props: [
      pillar(-20, 12),
      pillar(-8, 12),
      pillar(6, 12),
      pillar(20, 12),
      pillar(-20, -12),
      pillar(-8, -12),
      pillar(6, -12),
      pillar(20, -12),
      pillar(-14, 0),
      pillar(14, 0),
      tank(0, 24, 4),
      tank(0, -24, 4),
    ],
    hazards: [acid(-14, 20, 3, 12), acid(14, -20, 3, 12)],
  },
  {
    id: 'cinder-vault',
    name: 'Cinder Vault',
    // No chaff. Every row is a body that either shoots, bursts, or takes a hit for something
    // else, which is the chapter's whole argument for existing.
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
    waves: 8,
    bosses: ['atlas'],
    size: 48,
    palette: FOUNDRY,
    // The pinwheel: four walls turned about the middle, so the vault has no straight line
    // through it at all and every shot fired at the centre is fired along a face. This is
    // the chapter where a shooter's band and a grenadier's landing ring have to be read
    // around a corner, and the crushers are the reward for giving ground. The pools sit in
    // the two lanes the pinwheel leaves, where a body being herded can be left in one, and
    // not in the eye of the pinwheel: that is where a run starts, and a chapter may not open
    // by charging you for a floor you were dropped onto.
    props: [
      wall(9, 3, 18, 2),
      wall(-9, -3, 18, 2),
      wall(3, -9, 2, 18),
      wall(-3, 9, 2, 18),
      wall(24, 20, 12, 2),
      wall(-24, -20, 12, 2),
      crate(20, -18, 3),
      crate(-20, 18, 3),
    ],
    hazards: [acid(-7, -8, 3, 16), acid(7, 8, 3, 16), crusher(18, 10, 2.6, 50), crusher(-18, -10, 2.6, 50)],
  },
  {
    id: 'long-room',
    name: 'The Long Room',
    // Everything, at once, from the first batch, and the highest elite rate in the game.
    // Eight chapters in, the last room is allowed to be unfair in a way that is legible:
    // nothing here is new, it is only all arriving together.
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
    waves: 8,
    bosses: ['matron', 'atlas'],
    size: 52,
    palette: REACTOR,
    // Three long aisles with six-metre doors between them: the name is the layout. Long
    // sights run the whole way, which is what a chapter that opens with a sniper's whole
    // kit is for, and the doors are the only places a charge can be answered with a wall.
    props: [
      wall(0, 10, 52, 2),
      wall(0, -10, 52, 2),
      wall(-18, 0, 2, 12),
      wall(6, 0, 2, 12),
      wall(26, 0, 2, 12),
      crate(-30, 22, 3),
      crate(30, -22, 3),
    ],
    hazards: [acid(-10, 0, 3, 14), acid(16, 0, 3, 14), crusher(0, 20, 2.8, 55), crusher(0, -20, 2.8, 55)],
  },
  {
    id: 'dry-dock',
    name: 'Dry Dock',
    // The two bodies the vault kept out come back: chargers, because the dock is the chapter
    // that makes a charge line something you have to answer with geometry, and the ranged
    // trio at a rate that means a volley is always in the air.
    packs: [
      ['charger', 'chaser', 'shooter', 'charger', 'swarmling'],
      ['charger', 'shooter', 'exploder', 'charger', 'armored', 'chaser'],
      ['charger', 'grenadier', 'shooter', 'splitter', 'charger', 'exploder'],
      ['armored', 'charger', 'grenadier', 'healer', 'shooter', 'charger', 'splitter'],
      ['charger', 'armored', 'grenadier', 'exploder', 'charger', 'healer', 'shooter'],
      ['splitter', 'charger', 'armored', 'grenadier', 'charger', 'exploder', 'healer'],
    ],
    elites: ['bulwark', 'frenzy'],
    eliteChance: 0.16,
    waves: 8,
    bosses: ['atlas', 'broodmother'],
    size: 54,
    palette: DOCKS,
    // Two dry berths: long boxes with one door each, and the crushers in the open water
    // between them. A charger has to run its line down an aisle to be worth anything, and
    // the aisles are the layout's answer to that; the plates in the middle are the price of
    // the shorter line across.
    props: [
      wall(-12, 16, 2, 24),
      wall(12, 16, 2, 24),
      wall(-12, -16, 2, 24),
      wall(12, -16, 2, 24),
      wall(0, 28, 26, 2),
      wall(0, -28, 26, 2),
      crate(-24, 0, 3),
      crate(24, 0, 3),
      tank(-28, 20, 4),
      tank(28, -20, 4),
    ],
    hazards: [acid(0, 12, 3, 14), acid(0, -12, 3, 14), crusher(0, 0, 3, 55), crusher(-20, 24, 2.6, 45), crusher(20, -24, 2.6, 45)],
  },
  {
    id: 'kill-floor',
    name: 'Kill Floor',
    // Everything the roster owns, all of it from the first batch, at the top elite rate. The
    // last chapter is not allowed to have a lesson in it; it is allowed to have every lesson
    // at once, in a room that gives nowhere to put them down.
    packs: [
      ['armored', 'charger', 'exploder', 'shooter', 'splitter', 'grenadier', 'healer'],
      ['charger', 'armored', 'grenadier', 'healer', 'exploder', 'charger', 'splitter', 'shooter'],
      ['splitter', 'armored', 'shooter', 'healer', 'exploder', 'grenadier', 'charger', 'chaser'],
      ['grenadier', 'armored', 'exploder', 'splitter', 'shooter', 'charger', 'healer', 'swarmling'],
      ['armored', 'grenadier', 'healer', 'exploder', 'splitter', 'shooter', 'charger', 'exploder'],
      ['exploder', 'armored', 'splitter', 'grenadier', 'charger', 'shooter', 'healer', 'armored'],
    ],
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.2,
    waves: 8,
    bosses: ['broodmother', 'matron', 'atlas'],
    size: 44,
    palette: REACTOR,
    // A cross of walls with the four corners left as open killing fields. The cross is the
    // only cover in the room and it is the reason the room is playable at this rate: a pack
    // has to come round a corner to reach the middle, and the plates at the four corners of
    // the cross are where a run that stops moving ends.
    props: [
      wall(0, 0, 34, 2),
      wall(0, 0, 2, 34),
      wall(24, 14, 12, 2),
      wall(-24, -14, 12, 2),
      wall(14, -24, 2, 12),
      wall(-14, 24, 2, 12),
      crate(28, 28, 3),
      crate(-28, -28, 3),
      crate(-28, 28, 3),
      crate(28, -28, 3),
    ],
    hazards: [
      acid(0, 12, 3.2, 16),
      acid(0, -12, 3.2, 16),
      acid(12, 0, 3.2, 16),
      acid(-12, 0, 3.2, 16),
      crusher(18, 18, 2.8, 60),
      crusher(-18, -18, 2.8, 60),
      crusher(-18, 18, 2.8, 60),
      crusher(18, -18, 2.8, 60),
    ],
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