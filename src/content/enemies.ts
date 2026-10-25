/**
 * Enemy content: the EnemyDef schema, the archetypes the sim can spawn and the wave
 * recipes that mix them into packs.
 *
 * `ai` names a behaviour in src/sim/systems/enemies.ts and `params` are the numbers
 * that behaviour reads, so a new archetype is a data entry unless it genuinely needs
 * a new movement or attack pattern. The parameter names are documented where the
 * behaviour uses them, and a behaviour owns its keys rather than sharing one flat
 * namespace.
 */

export type Faction = 'swarm' | 'foundry' | 'reactor' | 'cult';

/**
 * Behaviour ids, in the order the `AI` record in systems/enemies.ts lists them.
 * That record is keyed by this union, so an id without a behaviour is a
 * typecheck error instead of an enemy that quietly stands still.
 */
export const AI_IDS = ['chaser', 'swarmling', 'charger', 'exploder', 'splitter', 'armored'] as const;

export type AiId = (typeof AI_IDS)[number];

/**
 * What a body breaks into when it dies, named by id rather than by row number so
 * reordering the table cannot quietly point a splitter at the wrong child.
 */
export interface SplitDef {
  readonly def: string;
  /** Copies spawned. The pool's cap still applies; a full pool spawns none. */
  readonly count: number;
}

export interface EnemyDef {
  readonly id: string;
  readonly faction: Faction;
  readonly hp: number;
  /** Cruise speed in m/s. */
  readonly speed: number;
  /** Collision radius in m. */
  readonly radius: number;
  /**
   * Damage each hit loses to it, after falloff. A body with `armorSide` set only pays
   * that much inside its facing arc — see `armorAgainst` in systems/enemies.ts.
   */
  readonly armor: number;
  /** XP its shard is worth. */
  readonly xp: number;
  readonly ai: AiId;
  /**
   * Numbers the behaviour reads. Keys are documented where the behaviour uses
   * them, and a behaviour owns its keys rather than sharing one flat namespace.
   */
  readonly params: Readonly<Record<string, number>>;
  /** Death split, for the bodies that come apart into smaller ones. */
  readonly splits?: SplitDef;
  /** Emissive core colour. Bodies stay dark matte (DESIGN.md 'Palette'). */
  readonly accent: string;
}

/**
 * The pack each wave draws, as ids, walked in order rather than drawn from a bag.
 *
 * The spawner reads a batch straight down the recipe and starts the next batch where
 * this one stopped, so a pack is always mixed and what arrives is knowable: the fifth
 * body of wave 1 is a charger in every run. That is deliberate. A weighted bag would
 * make "does this chapter ever show you a charger" a matter of luck, and a browser
 * scenario has to be able to assert on it.
 *
 * The last row carries on for every wave past the end of the list.
 */
export const PACKS: readonly (readonly string[])[] = [
  // Two bodies that walk at you, then the first thing that does not.
  ['chaser', 'swarmling', 'chaser', 'swarmling', 'charger'],
  ['swarmling', 'chaser', 'charger', 'exploder', 'chaser'],
  ['charger', 'swarmling', 'exploder', 'chaser', 'splitter'],
  ['charger', 'exploder', 'armored', 'swarmling', 'splitter'],
  ['exploder', 'armored', 'splitter', 'charger', 'swarmling', 'exploder'],
  ['splitter', 'charger', 'armored', 'exploder', 'swarmling', 'charger', 'armored'],
];

/** The only archetype the wave spawner falls back to if a recipe names nothing else. */
export const DEFAULT_ENEMY = 0;

/**
 * Roles, so two archetypes are never the same answer.
 *
 * The three that arrive fast (chaser, swarmling, splinter) are cheap bodies meant to
 * be cleared by an area weapon; the charger and the armored are the ones that punish
 * standing still; the exploder and the splitter are the ones it is worth shooting
 * before they reach the crowd, because killing them somewhere other than on top of you
 * is the whole skill of the pair.
 */
export const ENEMIES: readonly EnemyDef[] = [
  {
    id: 'chaser',
    faction: 'swarm',
    hp: 20,
    speed: 3.4,
    radius: 0.45,
    armor: 0,
    xp: 1,
    ai: 'chaser',
    // sepRadius: personal space in m. sepPush: how hard a neighbour is shoved
    // aside. touchRange: reach beyond the two collision radii. touchDamage: HP
    // lost per contact, gated by the player's i-frames. faceLag: how fast the
    // body's facing catches up with where it is actually going, in fractions of a
    // second (high = instant).
    params: { sepRadius: 1.1, sepPush: 1.6, touchRange: 0.3, touchDamage: 6, faceLag: 12 },
    accent: '#FF2E97',
  },
  {
    id: 'swarmling',
    faction: 'swarm',
    // Fast, cheap and useless alone: it arrives in a cloud of twenty and its whole
    // job is to make the player spend an area weapon or give up ground.
    hp: 9,
    speed: 4.6,
    radius: 0.3,
    armor: 0,
    xp: 1,
    ai: 'swarmling',
    // swayAmp: half-width of the weave, in radians. swayHz: how many weaves a second.
    // The cloud spreads across its own approach instead of marching in one file, which
    // is what stops a pack of twenty arriving as one lane that any gun deletes.
    params: {
      sepRadius: 0.75,
      sepPush: 2.2,
      touchRange: 0.25,
      touchDamage: 4,
      faceLag: 14,
      swayAmp: 0.34,
      swayHz: 5.5,
    },
    accent: '#FF2E97',
  },
  {
    id: 'charger',
    faction: 'swarm',
    hp: 46,
    // Stalks slower than a chaser so the charge reads, and pays for the 13 m/s of it
    // with a wind-up long enough to step out of (DESIGN.md: at least 0.4 s of
    // telegraph) and a recover long enough to punish missing.
    speed: 3.1,
    radius: 0.5,
    armor: 1,
    xp: 4,
    ai: 'charger',
    // armRange: how close it has to get to commit. nearRange: inside this it just
    // walks, because a charge from arm's length is not a charge. windup, dashTime,
    // recover: seconds in each phase. dashSpeed: m/s during the dash. stalk: seconds
    // of stalking before it will commit again.
    params: {
      sepRadius: 1.2,
      sepPush: 1.8,
      touchRange: 0.3,
      touchDamage: 9,
      faceLag: 10,
      armRange: 9,
      nearRange: 2.5,
      windup: 0.5,
      dashTime: 0.5,
      dashSpeed: 13,
      recover: 0.4,
      stalk: 0.6,
    },
    accent: '#FF2E97',
  },
  {
    id: 'exploder',
    faction: 'reactor',
    // A bomb with legs. Slow and squishy; the danger is the 26 HP it pays out when it
    // goes, which it will do on death if nobody shoots it early.
    hp: 18,
    speed: 2.9,
    radius: 0.5,
    armor: 0,
    xp: 3,
    ai: 'exploder',
    // armRange: distance at which it starts the fuse. fuseTime: seconds of flashing
    // before it bursts. blastRadius, blastDamage: the burst, which hurts the player
    // and other bodies alike.
    params: {
      sepRadius: 1.3,
      sepPush: 1.4,
      touchRange: 0.3,
      touchDamage: 5,
      faceLag: 10,
      armRange: 3.6,
      fuseTime: 0.5,
      blastRadius: 3.2,
      blastDamage: 26,
    },
    accent: '#9B5CFF',
  },
  {
    id: 'splitter',
    faction: 'reactor',
    // Heavy, slow and lurching: readable at a distance, and worth killing away from
    // the crowd, because the four bodies it leaves behind are faster than it is.
    hp: 44,
    speed: 2.6,
    radius: 0.62,
    armor: 1,
    xp: 4,
    ai: 'splitter',
    params: {
      sepRadius: 1.4,
      sepPush: 1.5,
      touchRange: 0.3,
      touchDamage: 7,
      faceLag: 8,
      swayAmp: 0.5,
      swayHz: 1.6,
    },
    splits: { def: 'splinter', count: 3 },
    accent: '#9B5CFF',
  },
  {
    id: 'splinter',
    faction: 'reactor',
    // What a splitter leaves behind: half the body, most of the speed, and no split of
    // its own, so a run cannot cascade into an infinite crowd.
    hp: 7,
    speed: 4.4,
    radius: 0.24,
    armor: 0,
    xp: 1,
    ai: 'swarmling',
    params: {
      sepRadius: 0.7,
      sepPush: 2.4,
      touchRange: 0.2,
      touchDamage: 3,
      faceLag: 16,
      swayAmp: 0.45,
      swayHz: 7,
    },
    accent: '#9B5CFF',
  },
  {
    id: 'armored',
    faction: 'foundry',
    // The wall. Its 7 of armour only counts inside ±60° of its facing, and its facing
    // follows where it is going rather than where you are, so walking past it — or
    // knocking it sideways and shooting the flat side — is what makes the armour a
    // positioning puzzle instead of a tax.
    hp: 80,
    speed: 2.5,
    radius: 0.62,
    armor: 7,
    xp: 6,
    ai: 'armored',
    // standoff: the ring size it holds once it arrives. orbit: fraction of its speed
    // it spends circling rather than closing. turnTime: seconds per side of that
    // circle. armorArc: cosine of the half-angle the plate covers (0.5 is 60°).
    // armorSide: fraction of the plate kept outside that arc.
    params: {
      sepRadius: 1.5,
      sepPush: 2,
      touchRange: 0.3,
      touchDamage: 11,
      faceLag: 2.6,
      standoff: 4,
      orbit: 0.8,
      turnTime: 2.4,
      armorArc: 0.5,
      armorSide: 0,
    },
    accent: '#F2B233',
  },
];

/** Id to table index, built once so a recipe or a split can name an archetype. */
export const ENEMY_BY_ID: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < ENEMIES.length; i++) map[ENEMIES[i].id] = i;
  return map;
})();

/** Index of `id`, or -1 when nothing answers to that name. */
export function enemyIndex(id: string): number {
  const i = ENEMY_BY_ID[id];
  return i === undefined ? -1 : i;
}
