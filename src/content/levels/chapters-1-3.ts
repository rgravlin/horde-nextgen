/**
 * Chapters 1 to 3: the floors a player is still learning to read.
 *
 * These three are the ones the browser scenarios drive a first run across, which is why they
 * are the emptiest rooms in the game and why chapter 1's recipes are imported from
 * `content/enemies.ts` rather than re-typed here (one source of truth, AGENTS.md). What each
 * one teaches is written down above its own script: the bay teaches bodies one at a time, the
 * yard teaches them in lanes, the canal teaches armour — and the canal is where a chapter first
 * asks *what you are holding* rather than *where you are standing*.
 *
 * The shape is shared and lives one file up (`builders.ts`): `wall`/`crate`/`tank`/`pillar`
 * for cover, `acid`/`crusher` for the floor, `beat`/`eliteBeat` for a script. A chapter is
 * data read by `sim/systems/levels.ts`, `waves.ts` and the renderer, never code.
 */

import { PACKS } from '../enemies';
import { DOCKS, FOUNDRY, acid, beat, crate, eliteBeat, pillar, tank, wall } from './builders';
import type { LevelDef } from './types';

/** Chapters 1 to 3, in play order. See `index.ts` for what a chapter is. */
export const LEVELS_1_3: readonly LevelDef[] = [
  {
    id: 'loading-bay',
    name: 'Loading Bay',
    packs: PACKS,
    // The teaching order, timed. Swarmling clouds first (an area weapon's lesson), then the
    // splitter at 0:20 — deliberately seven seconds before the recipe reaches it at wave 3,
    // because the bay is where a player is supposed to meet "kill it away from the crowd" once
    // and alone. The charger comes in off the open +x gate, where a charge line has fourteen
    // metres of floor to run down and no crate to start behind. Everything after 0:40 is a
    // mix rather than a body, which is what the bay hands over to the yard.
    waves: [
      beat(12, 'any', ['swarmling', 12]),
      beat(20, 'any', ['splitter', 5]),
      beat(26, 'e', ['charger', 4]),
      beat(34, 'nw', ['exploder', 8]),
      beat(42, 'w', ['shooter', 5], ['chaser', 10]),
      beat(50, 'any', ['armored', 6], ['charger', 6]),
      beat(58, 'se', ['grenadier', 4], ['shooter', 4], ['chaser', 12]),
      beat(66, 'any', ['splitter', 6], ['exploder', 8], ['swarmling', 18]),
    ],
    duration: 78,
    difficulty: { spawnRate: 1, hp: 1 },
    elites: [],
    eliteChance: 0,
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
    // The lanes are the script's subject. Two beats come down the conveyor itself (`n` and
    // `s`), so a pack arrives along a lane instead of across the yard, and the rest spread.
    // The bulwark pack at 1:06 is the variant's introduction: five armoured bodies and a
    // dozen chasers, arriving over the corner tank, which is the first pack in the game that
    // has to be answered by moving rather than by pulling the trigger.
    waves: [
      beat(10, 'any', ['swarmling', 10], ['charger', 4]),
      beat(18, 'n', ['exploder', 6], ['chaser', 8]),
      beat(26, 'any', ['charger', 5], ['shooter', 4]),
      beat(34, 's', ['swarmling', 16], ['exploder', 6]),
      beat(42, 'e', ['armored', 5], ['charger', 4]),
      beat(50, 'any', ['splitter', 6], ['exploder', 6], ['shooter', 4]),
      beat(58, 'n', ['charger', 6], ['healer', 3], ['exploder', 6]),
      eliteBeat(66, 'nw', 'bulwark', ['armored', 5], ['chaser', 8]),
      beat(74, 'any', ['exploder', 8], ['charger', 6], ['healer', 4]),
    ],
    duration: 82,
    difficulty: { spawnRate: 1.12, hp: 1.08 },
    elites: ['bulwark'],
    // A whisper of a chance: one bulwark in a wave is a thing to notice, which is the whole
    // job of a variant's introduction.
    eliteChance: 0.05,
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
    // Armour from the first beat, and the two long walls decide the edges: the canal's packs
    // come in off `e` and `w`, through the twelve-metre gaps at either end, so the armoured
    // wedge runs the length of the room instead of dropping into the pools beside the player.
    // The two elite beats are the chapter's argument for existing — a bulwark column up the
    // middle at 0:56 and a frenzy channel down the south wall at 1:12, both of which are
    // answered by giving ground, which is what the canal's shape is for.
    waves: [
      beat(8, 'any', ['armored', 4], ['chaser', 8]),
      beat(16, 'e', ['charger', 5], ['armored', 4]),
      beat(24, 'any', ['swarmling', 14], ['shooter', 4]),
      beat(32, 'w', ['armored', 5], ['exploder', 6]),
      beat(40, 'any', ['splitter', 6], ['armored', 5]),
      beat(48, 'e', ['grenadier', 4], ['charger', 5], ['armored', 4]),
      eliteBeat(56, 'any', 'bulwark', ['armored', 6], ['healer', 3]),
      beat(64, 'nw', ['exploder', 8], ['splitter', 5], ['chaser', 10]),
      eliteBeat(72, 's', 'frenzy', ['chaser', 10], ['swarmling', 14]),
    ],
    duration: 84,
    difficulty: { spawnRate: 1.22, hp: 1.16 },
    elites: ['bulwark', 'frenzy'],
    eliteChance: 0.08,
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
];
