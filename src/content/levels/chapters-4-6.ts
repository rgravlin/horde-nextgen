/**
 * Chapters 4 to 6: rooms that decide *where* a fight happens.
 *
 * The three floors here are built around one shape each and the script is written against that
 * shape: four pods with a doorway in each (the deck, where a splitter that dies in a pod
 * hatches in a room with one way out), a ring of vessels with two gaps (the rim, whose middle
 * is a place you go through rather than a place you stand) and a pillar lattice in a wide room
 * (the thread floor, where a forty-body cloud has to be deleted through a gap). These are also
 * the chapters where variants start being *sent* rather than rolled, so `eliteBeat` is used on
 * every one of them.
 *
 * Same builders and the same two dials as every other chapter — see `builders.ts` for the
 * shorthands and `types.ts` for what each field is read by.
 */

import { DOCKS, REACTOR, acid, beat, crate, crusher, eliteBeat, pillar, tank, wall } from './builders';
import type { LevelDef } from './types';

/** Chapters 4 to 6, in play order. See `index.ts` for what a chapter is. */
export const LEVELS_4_6: readonly LevelDef[] = [
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
    // Four pods with a doorway in each, and the corner beats drop splitters into them: a
    // splitter that dies in a pod hatches four splinters in a room with one way out, which is
    // the deck's lesson, timed four times rather than rolled. The two straight-through beats
    // (`any`) are the ones that arrive while the player is still standing in the open middle,
    // and the frenzy pack at 0:58 is the answer to anyone who stops moving to watch for them.
    waves: [
      beat(10, 'any', ['swarmling', 12], ['splitter', 4]),
      beat(18, 'nw', ['splitter', 6], ['chaser', 8]),
      beat(26, 'se', ['exploder', 6], ['splitter', 5]),
      beat(34, 'any', ['shooter', 5], ['splitter', 6]),
      beat(42, 'ne', ['charger', 5], ['splitter', 6], ['exploder', 5]),
      beat(50, 'sw', ['armored', 5], ['splitter', 6]),
      eliteBeat(58, 'any', 'frenzy', ['charger', 5], ['chaser', 8]),
      beat(66, 'nw', ['splitter', 7], ['grenadier', 4], ['healer', 3]),
      beat(74, 'any', ['armored', 5], ['splitter', 7], ['exploder', 6], ['charger', 4]),
    ],
    duration: 84,
    difficulty: { spawnRate: 1.32, hp: 1.24 },
    elites: ['bulwark', 'frenzy'],
    eliteChance: 0.1,
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
    // The detonations are timed against the room's two crushers. Ten exploders arrive at 0:08
    // and eight at every beat to 0:44, because the chapter's answer is to shoot them somewhere
    // other than on top of you, and the ring of vessels with two gaps is where "somewhere
    // other" has to be found. The volatile packs price the same lesson up: a volatile exploder
    // is a body you want dead down a lane, not in the middle.
    waves: [
      beat(8, 'any', ['exploder', 10], ['chaser', 8]),
      beat(18, 'e', ['exploder', 8], ['charger', 4]),
      beat(26, 'any', ['swarmling', 16], ['exploder', 8]),
      beat(34, 'w', ['armored', 5], ['exploder', 8], ['shooter', 4]),
      beat(44, 'n', ['grenadier', 4], ['exploder', 8], ['charger', 5]),
      eliteBeat(54, 'any', 'volatile', ['exploder', 8], ['chaser', 6]),
      beat(62, 'se', ['splitter', 6], ['exploder', 8], ['healer', 3]),
      eliteBeat(70, 'nw', 'bulwark', ['armored', 6], ['exploder', 6]),
      beat(78, 'any', ['exploder', 10], ['charger', 6], ['grenadier', 4], ['healer', 3]),
    ],
    duration: 86,
    difficulty: { spawnRate: 1.4, hp: 1.32 },
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.12,
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
    // Clouds, not packs: twenty-four bodies at a time, eight times over the chapter, because
    // the thread floor is the chapter that asks what you are holding. The pillar lattice is
    // what makes that answerable — a cloud that has to come between two pillars arrives in
    // twos — and the `any` beats are the ones that arrive from everywhere at once, which is
    // what a chapter with no cover in its middle is for.
    waves: [
      beat(8, 'any', ['swarmling', 20], ['chaser', 6]),
      beat(18, 'n', ['swarmling', 24], ['charger', 4]),
      beat(28, 'sw', ['swarmling', 22], ['exploder', 5], ['shooter', 4]),
      beat(38, 'any', ['chaser', 12], ['swarmling', 20]),
      beat(48, 'ne', ['charger', 6], ['swarmling', 22]),
      beat(56, 'any', ['armored', 5], ['swarmling', 24], ['shooter', 4]),
      eliteBeat(64, 'nw', 'frenzy', ['charger', 6], ['chaser', 10]),
      beat(72, 'se', ['splitter', 6], ['exploder', 6], ['swarmling', 20], ['healer', 3]),
      beat(80, 'any', ['swarmling', 26], ['charger', 6], ['armored', 4], ['grenadier', 4]),
    ],
    duration: 88,
    difficulty: { spawnRate: 1.48, hp: 1.4 },
    elites: ['frenzy', 'volatile'],
    eliteChance: 0.14,
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
];
