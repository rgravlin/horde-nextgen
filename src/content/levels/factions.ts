/**
 * The four enemy families, and the packs the campaign builds out of them.
 *
 * Why this file exists: a chapter's mix is the thing a player actually learns — "here comes the
 * cloud", "that's the armoured lot with guns behind it" — and the alternative to writing the
 * families down once is typing the same id lists into ten chapter files, where the first person
 * to tune one of them quietly changes what a chapter is made of. So the families are written
 * here, read out of `content/enemies.ts` rather than copied (AGENTS.md: one source of truth),
 * and the compositions two or more chapters share are written here once and *named* at the beat
 * that uses them.
 *
 * What this file is not: it is not a spawner. `kitBeat` expands a named composition into the
 * plain `BeatDef` `systems/waves.ts` already reads, at author time, so nothing in the sim has to
 * know a family exists. A chapter's timetable still says what arrives, at what second, off which
 * edge, and a fingerprinted run replays exactly the same horde — the kit is how a human reads
 * the script, not a second path through the code.
 *
 * The families are not four sizes of the same thing, and they are not decoration either: a body's
 * `faction` is what its body tint is picked from (`render/instancing.ts`), so a pack composed
 * from one family arrives on screen as one colour, which is the readable half of "mixed packs
 * with faction-like compositions". A kit is therefore named for the family that *leads* it; the
 * escorts it travels with are written beside it and belong to whichever family they came from.
 */

import { ENEMIES, type Faction } from '../enemies';
import type { EdgeId } from '../../sim/systems/waves';
import { beat, eliteBeat } from './builders';
import type { BeatDef } from './types';

/** The families, in the order `content/enemies.ts` declares the `Faction` union. */
export const FACTION_IDS = ['swarm', 'foundry', 'reactor', 'cult'] as const;

/**
 * One family: what its bodies do to a room, and the answer the room has to give them.
 *
 * `roster` is every body the family owns, derived from the archetype table. `packable` is that
 * list without the end-of-level encounters, because a boss is a door and not wave fodder — see
 * the note above `PACKS` in `content/enemies.ts` for why the recipes stop short of them.
 */
export interface FactionDef {
  readonly id: Faction;
  readonly label: string;
  /** What the family asks of the player, in one line. */
  readonly note: string;
  readonly roster: readonly string[];
  readonly packable: readonly string[];
}

/** The four families, read off the roster rather than retyped. */
export const FACTIONS: readonly FactionDef[] = (
  [
    {
      id: 'swarm',
      label: 'Swarm',
      note: 'arrives fast and in a line; answered with area damage or by giving up the floor',
    },
    {
      id: 'foundry',
      label: 'Foundry',
      note: 'arrives slowly behind armour; answered by walking round the plate, not through it',
    },
    {
      id: 'reactor',
      label: 'Reactor',
      note: 'arrives as a place that goes bad; answered by killing it somewhere else',
    },
    {
      id: 'cult',
      label: 'Cult',
      note: 'arrives at range and keeps its feet busy; answered by crossing the line it paints',
    },
  ] as const
).map((family): FactionDef => {
  const own = ENEMIES.filter((def) => def.faction === family.id);
  return {
    ...family,
    roster: own.map((def) => def.id),
    packable: own.filter((def) => def.boss !== true).map((def) => def.id),
  };
});

/** The family a single body belongs to, or `undefined` for a name the roster does not own. */
export function factionOf(id: string): Faction | undefined {
  return ENEMIES.find((def) => def.id === id)?.faction;
}

/** Every body a chapter may put in a pack for `faction`, bosses included out. */
export function packableOf(faction: Faction): readonly string[] {
  const family = FACTIONS.find((f) => f.id === faction);
  return family === undefined ? [] : family.packable;
}

/** A pack's contents the way a chapter writes them: `[archetype id, count]`, in arrival order. */
export type PackParts = readonly (readonly [string, number])[];

/**
 * One shared composition: the bodies a family puts down together, and how it is answered.
 *
 * `answer` is not a comment bolted onto data — it is the reason the composition is allowed to be
 * reused. A pack nobody can answer is a difficulty number, and a pack a player *can* answer has
 * now taught something in every chapter that sends it, which is the difference between a set
 * piece and a crowd.
 */
export interface FactionPack {
  readonly id: string;
  /** The family that leads it. The escorts belong to whoever owns them. */
  readonly faction: Faction;
  readonly label: string;
  readonly answer: string;
  readonly parts: PackParts;
}

/**
 * The shared compositions, keyed by id so a chapter names one and a typo is a typecheck error
 * rather than a beat that silently ships a chaser.
 */
export const FACTION_PACKS = {
  // ── swarm: bodies that arrive fast, and in a line ──────────────────────────────────────
  cloud: {
    id: 'cloud',
    faction: 'swarm',
    label: 'a cloud',
    parts: [['swarmling', 18], ['chaser', 6]],
    answer: 'area damage, or give up the floor it is walking over',
  },
  lane: {
    id: 'lane',
    faction: 'swarm',
    label: 'a lane',
    parts: [['chaser', 8], ['swarmling', 12], ['charger', 4]],
    answer: 'a hug screen with a charge behind it: break the line, then kill the tail',
  },
  charge: {
    id: 'charge',
    faction: 'swarm',
    label: 'a charge volley',
    parts: [['charger', 6], ['chaser', 8]],
    answer: 'step off the line it paints, and do it in an aisle with room to run past',
  },
  trench: {
    id: 'trench',
    faction: 'swarm',
    label: 'a trench pack',
    parts: [['burrower', 5], ['swarmling', 12]],
    answer: 'leave the ring it digs, and leave it while the cloud is still coming',
  },
  // ── reactor: detonation, and bodies that make bodies ────────────────────────────────────
  drum: {
    id: 'drum',
    faction: 'reactor',
    label: 'a drum',
    parts: [['splitter', 5], ['exploder', 6]],
    answer: 'kill both somewhere other than on top of the crowd',
  },
  faucet: {
    id: 'faucet',
    faction: 'reactor',
    label: 'a faucet and its escorts',
    parts: [['spawner', 3], ['chaser', 8]],
    answer: 'shut the faucet before its young land, which costs the ground in front of it',
  },
  bombers: {
    id: 'bombers',
    faction: 'reactor',
    label: 'a bombing run',
    parts: [['grenadier', 4], ['exploder', 6], ['spawner', 2]],
    answer: 'shells, a burst and a brood at once; none of it answered by standing still',
  },
  // ── cult: guns, marks, and the support that mends what they miss ────────────────────────
  line: {
    id: 'line',
    faction: 'cult',
    label: 'a firing line',
    parts: [['shooter', 5], ['sniper', 3]],
    answer: 'get off the open floor it wants, or cross it — backing away is chased',
  },
  circle: {
    id: 'circle',
    faction: 'cult',
    label: 'a circling line',
    parts: [['orbiter', 4], ['shooter', 4]],
    answer: 'walk through the ring rather than out of it',
  },
  blink: {
    id: 'blink',
    faction: 'cult',
    label: 'a blink pair',
    parts: [['teleporter', 4], ['sniper', 2]],
    answer: 'stop where the strip it painted does not land, and where its line does not run',
  },
  supports: {
    id: 'supports',
    faction: 'cult',
    label: 'a supported pack',
    parts: [['healer', 3], ['shooter', 4], ['orbiter', 3]],
    answer: 'kill the support first or the pack takes twice as long to die',
  },
  // ── foundry: armour, and the guns that stand behind it ──────────────────────────────────
  wedge: {
    id: 'wedge',
    faction: 'foundry',
    label: 'a wedge',
    parts: [['armored', 5], ['chaser', 8]],
    answer: 'go round the plate; the tail is the soft half',
  },
  armorGuns: {
    id: 'armorGuns',
    faction: 'foundry',
    label: 'armour with guns behind it',
    parts: [['armored', 4], ['grenadier', 4], ['sniper', 3]],
    answer: 'the plate is a screen, not the fight: the guns are the fight',
  },
} as const satisfies Record<string, FactionPack>;

/** Every kit name, so a chapter's script cannot invent one. */
export type PackId = keyof typeof FACTION_PACKS;

/**
 * Put a named composition on the floor at a second and an edge.
 *
 * Expanded at author time into the same `BeatDef` a hand-written `beat(...)` produces, which is
 * what keeps `systems/waves.ts` reading one shape of timetable.
 */
export function kitBeat(t: number, edge: EdgeId, id: PackId): BeatDef {
  return beat(t, edge, ...FACTION_PACKS[id].parts);
}

/**
 * The same composition arriving *in* a variant, which is how a chapter sends a variant rather
 * than rolling one — see `eliteBeat` in `builders.ts` for why that difference is the point.
 */
export function eliteKitBeat(t: number, edge: EdgeId, elite: string, id: PackId): BeatDef {
  return eliteBeat(t, edge, elite, ...FACTION_PACKS[id].parts);
}