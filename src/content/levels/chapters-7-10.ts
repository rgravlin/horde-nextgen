/**
 * Chapters 7 to 10: rooms that will not let anybody stand still.
 *
 * Nothing new walks in here — the last four chapters are the whole roster arriving together in
 * four rooms that each remove one way of coping. The vault has no straight line through it, so
 * a shot at the middle is fired along a wall face; the Long Room is that line, twice, with
 * six-metre doors as the only place a charge can be answered; the dock gives a charger two
 * aisles to build a run-up in and charges the short line across with crushers; the kill floor
 * has one cross of walls in it and is playable at its spawn rate only because of that cross.
 *
 * These four carry the highest `difficulty` pairs and the highest elite rates in the campaign,
 * which is the ramp `tests/unit/waves.test.ts` reads as a product rather than as a feeling.
 */

import { DOCKS, FOUNDRY, REACTOR, acid, beat, crate, crusher, eliteBeat, tank, wall } from './builders';
import type { LevelDef } from './types';

/** Chapters 7 to 10, in play order. See `index.ts` for what a chapter is. */
export const LEVELS_7_10: readonly LevelDef[] = [
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
    // Nothing arrives in the open here. Every beat names a side the pinwheel's faces sit
    // across, so a pack either comes through a door or has to walk around a wall to get to the
    // middle, and the two `any` beats are the chapter asking you to read two things at once.
    // The vault's own argument, in data: no chaff, and the elites start carrying bodies rather
    // than tints — bulwark armour at 0:54 and a volatile pack at 1:10.
    waves: [
      beat(8, 'any', ['armored', 5], ['shooter', 4]),
      beat(18, 'e', ['armored', 5], ['grenadier', 4]),
      beat(28, 'any', ['exploder', 8], ['armored', 5]),
      beat(36, 'nw', ['splitter', 6], ['shooter', 5], ['healer', 3]),
      beat(46, 'se', ['armored', 6], ['charger', 5]),
      eliteBeat(54, 'any', 'bulwark', ['armored', 6], ['healer', 3]),
      beat(62, 'n', ['grenadier', 5], ['exploder', 8], ['splitter', 5]),
      eliteBeat(70, 's', 'volatile', ['exploder', 8], ['chaser', 8]),
      beat(78, 'any', ['armored', 6], ['splitter', 6], ['shooter', 5], ['healer', 3]),
    ],
    duration: 90,
    difficulty: { spawnRate: 1.56, hp: 1.48 },
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.16,
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
    // The aisles run east-west, so the ranged beats are given `e` and `w`: a shooter volley
    // arrives down an aisle with a clear sight and a six-metre door to be answered through.
    // The chargers then get the two beats that land in the open water between the plates,
    // where a charge line is worth something, and the frenzy pack at 0:56 is the one that
    // arrives while the player is still looking east.
    waves: [
      beat(8, 'e', ['shooter', 6], ['chaser', 8]),
      beat(18, 'any', ['armored', 5], ['charger', 5]),
      beat(28, 'w', ['grenadier', 5], ['shooter', 5]),
      beat(38, 'e', ['splitter', 6], ['armored', 5]),
      beat(46, 'any', ['exploder', 8], ['charger', 5], ['shooter', 4]),
      eliteBeat(56, 'n', 'frenzy', ['charger', 6], ['swarmling', 14]),
      beat(64, 'w', ['armored', 6], ['healer', 3], ['grenadier', 4]),
      beat(74, 'any', ['splitter', 6], ['exploder', 8], ['shooter', 5]),
      eliteBeat(82, 'any', 'volatile', ['exploder', 8], ['armored', 5]),
    ],
    duration: 92,
    difficulty: { spawnRate: 1.64, hp: 1.56 },
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.18,
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
    // Charger volleys, six and seven strong, timed down the two berths and across the open
    // water between them. A charge is only a threat with a run-up, so the beats that name a
    // side are the ones that land in an aisle and the `any` beats are the ones that land on
    // the plates — which is the chapter's price for standing still in the short line across.
    waves: [
      beat(8, 'any', ['charger', 6], ['chaser', 8]),
      beat(18, 'n', ['charger', 6], ['shooter', 4]),
      beat(28, 'any', ['armored', 5], ['exploder', 6]),
      beat(38, 's', ['charger', 7], ['swarmling', 14]),
      beat(48, 'w', ['splitter', 6], ['charger', 5], ['shooter', 4]),
      eliteBeat(56, 'e', 'frenzy', ['charger', 7], ['chaser', 8]),
      beat(64, 'any', ['armored', 6], ['healer', 3], ['exploder', 6]),
      beat(74, 'n', ['charger', 6], ['grenadier', 5], ['splitter', 5]),
      eliteBeat(84, 'any', 'bulwark', ['armored', 6], ['charger', 5]),
    ],
    duration: 94,
    difficulty: { spawnRate: 1.72, hp: 1.64 },
    elites: ['bulwark', 'frenzy'],
    eliteChance: 0.16,
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
    // Nine beats, every archetype the drumbeat is allowed to carry, and the two elite packs
    // at 0:56 and 1:24 that arrive on either side of the cross rather than down it. Nothing
    // here is new and none of it is fair in a room with nowhere to put anything down: the last
    // chapter is every lesson at once, which is why its script is the only one that names
    // three things in a pack four times over.
    waves: [
      beat(8, 'any', ['armored', 5], ['charger', 5], ['chaser', 8]),
      beat(18, 'ne', ['exploder', 8], ['shooter', 5]),
      beat(28, 'any', ['splitter', 6], ['armored', 5], ['grenadier', 4]),
      beat(38, 'sw', ['charger', 6], ['healer', 3], ['exploder', 6]),
      beat(48, 'any', ['armored', 6], ['shooter', 5], ['splitter', 5]),
      eliteBeat(56, 'nw', 'volatile', ['exploder', 8], ['chaser', 8]),
      beat(64, 'se', ['charger', 6], ['armored', 5], ['healer', 3], ['grenadier', 4]),
      beat(74, 'any', ['splitter', 6], ['exploder', 8], ['shooter', 5], ['swarmling', 18]),
      eliteBeat(84, 'any', 'frenzy', ['chaser', 10], ['charger', 6], ['armored', 4]),
    ],
    duration: 96,
    difficulty: { spawnRate: 1.8, hp: 1.72 },
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.2,
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
