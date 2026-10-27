/**
 * Chapters 4 to 6: rooms that decide *where* a fight happens.
 *
 * The three floors here are built around one shape each and the script is written against that
 * shape: four bays with a doorway in each (the deck, where a faucet's young land in a room with
 * one way out), a ring of vessels with two doors (the rim, whose middle is a place you go
 * through rather than a place you stand) and a pillar lattice in a wide room (the thread floor,
 * where a twenty-four-body cloud has to be deleted through a gap and a shot taken across it has
 * to be taken down a lane).
 *
 * These are also the chapters where the bodies that arrived after the recipes were set start
 * being *used*: the faucet, the blink pair, the trench pack and the circling line. Each one
 * needs a different room than the one it would have been dropped into, and that is what a
 * chapter's floor plan is for here —
 *
 * - a teleporter only paints its strip over eight metres it can cross in a tick, and a
 *   burrower only digs a trench it can finish (`canTravel` is tested the tick the line is
 *   chosen, in `phaser.ts` and `burrowers.ts`), so a room that wants either of them needs
 *   aisles, not a maze;
 * - a sniper plants between eight and sixteen metres out and spends a line it painted, and an
 *   orbiter walks a 6.5 m ring while it aims, so a room that wants *them* needs the same aisles
 *   clear of cover rather than merely wide;
 * - a spawner does all its damage through bodies that land behind it, which reads on a floor
 *   with somewhere to walk and reads as a crowd on one without.
 *
 * Same builders and the same two dials as every other chapter — see `builders.ts` for the
 * shorthands, `factions.ts` for the named compositions and `types.ts` for what each field is
 * read by.
 */

import { DOCKS, REACTOR, acid, beat, crate, crusher, eliteBeat, pillar, tank, wall } from './builders';
import { eliteKitBeat, kitBeat } from './factions';
import type { LevelDef } from './types';

/** Chapters 4 to 6, in play order. See `index.ts` for what a chapter is. */
export const LEVELS_4_6: readonly LevelDef[] = [
  {
    id: 'coolant-deck',
    name: 'Coolant Deck',
    // Splitters all the way down, with the faucet that makes them look small. The deck is the
    // chapter that makes "kill it away from the crowd" a decision you have to make four times a
    // wave, and the spawner is that decision asked twice as sharply: shut it before its young
    // land, which costs you the ground in front of it. The two new bodies it travels with are
    // the ones that cross a room rather than walk across it, which the deck's two long aisles
    // give them room to do.
    packs: [
      ['splitter', 'swarmling', 'splitter', 'spawner', 'chaser'],
      ['splitter', 'exploder', 'shooter', 'spawner', 'charger', 'teleporter'],
      ['exploder', 'splitter', 'armored', 'grenadier', 'sniper', 'spawner'],
      ['armored', 'splitter', 'healer', 'grenadier', 'charger', 'teleporter', 'spawner'],
      ['grenadier', 'splitter', 'armored', 'shooter', 'exploder', 'spawner', 'burrower'],
      ['splitter', 'armored', 'spawner', 'exploder', 'sniper', 'teleporter', 'burrower', 'swarmling'],
    ],
    // Four beats drop into a bay and five down an aisle. The corner beats are the deck's own
    // lesson, timed four times rather than rolled: a splitter or a faucet that dies in a bay
    // pays out inside a room with one doorway, and the player is the one who decides which bay.
    // The `any` beats are the ones that arrive while the player is still standing in the open
    // middle, and the frenzy pack at 0:58 is the answer to anyone who stops moving to watch for
    // them. The trench pack at 1:14 arrives from everywhere at once, which is the only way a
    // trench is worth reading: five rings on the floor and nowhere to stand in all of them.
    waves: [
      beat(10, 'any', ['swarmling', 12], ['splitter', 4]),
      kitBeat(18, 'nw', 'drum'),
      kitBeat(26, 'se', 'faucet'),
      kitBeat(34, 'any', 'bombers'),
      beat(42, 'ne', ['splitter', 6], ['teleporter', 4], ['charger', 5]),
      kitBeat(50, 'sw', 'wedge'),
      eliteBeat(58, 'any', 'frenzy', ['charger', 5], ['chaser', 8]),
      kitBeat(66, 'nw', 'faucet'),
      kitBeat(74, 'any', 'trench'),
    ],
    duration: 84,
    difficulty: { spawnRate: 1.32, hp: 1.24 },
    elites: ['bulwark', 'frenzy'],
    eliteChance: 0.1,
    bosses: ['broodmother', 'broodmother'],
    size: 52,
    palette: DOCKS,
    // Four bays, each two faces of a square with the doorway left at the inner corner, and a
    // spine of two faces with a gate at the middle. The bays are why the deck's lesson is about
    // *where* a kill happens: a splitter that comes apart in a bay pays its four young into a
    // room with one way out, and the spine gate is what stops the middle being a place to stand
    // while that happens. The two long aisles east and west of the bays stay clear of cover,
    // which is what the blink pair at 0:42 and the trench pack at 1:14 need: both bodies are
    // answered by leaving a line they painted, and neither paints one over eight metres of
    // wall. The crushers price those two aisles instead, so running them is a route and not a
    // free lap, and the pools sit inside the bays, where the kill the chapter asks for has to
    // be made somewhere.
    props: [
      wall(-17, 19, 18, 2),
      wall(-25, 10, 2, 16),
      wall(17, 19, 18, 2),
      wall(25, 10, 2, 16),
      wall(-17, -19, 18, 2),
      wall(-25, -10, 2, 16),
      wall(17, -19, 18, 2),
      wall(25, -10, 2, 16),
      wall(-9, 0, 10, 2),
      wall(9, 0, 10, 2),
      crate(0, 24, 3),
      crate(0, -24, 3),
    ],
    hazards: [
      acid(-17, 10, 3.2, 12),
      acid(17, 10, 3.2, 12),
      acid(-17, -10, 3.2, 12),
      acid(17, -10, 3.2, 12),
      crusher(31, 0, 2.6, 45),
      crusher(-31, 0, 2.6, 45),
    ],
  },
  {
    id: 'reactor-rim',
    name: 'Reactor Rim',
    // Everything that detonates, plus the two bodies whose damage is also a place: the faucet
    // that puts a brood down behind itself and the trench that is dug where you are standing.
    // The answer is the same one the exploder taught and the chapter is short on room to think
    // about it, which is the point of a ring whose middle is a lane.
    packs: [
      ['exploder', 'exploder', 'charger', 'swarmling', 'spawner'],
      ['exploder', 'shooter', 'armored', 'exploder', 'charger', 'burrower'],
      ['grenadier', 'exploder', 'healer', 'spawner', 'splitter', 'charger'],
      ['exploder', 'grenadier', 'armored', 'shooter', 'healer', 'spawner', 'exploder'],
      ['armored', 'exploder', 'grenadier', 'spawner', 'healer', 'charger', 'burrower'],
      ['grenadier', 'exploder', 'armored', 'splitter', 'charger', 'shooter', 'spawner'],
    ],
    // The detonations are timed against the ring's four plates. Ten bodies at 0:08 and eight at
    // every beat to 0:44, because the chapter's answer is to shoot them somewhere other than on
    // top of you and the two doors are where "somewhere other" has to be found. The volatile
    // packs price the same lesson up: a volatile exploder is a body you want dead down a lane,
    // not in the middle, and the trench pack at 1:18 arrives on the open ring outside the
    // vessels, where five trenches can be dug end to end.
    waves: [
      kitBeat(8, 'any', 'drum'),
      beat(18, 'e', ['exploder', 8], ['charger', 4]),
      kitBeat(26, 'any', 'cloud'),
      beat(34, 'w', ['armored', 5], ['exploder', 8], ['shooter', 4]),
      kitBeat(44, 'n', 'bombers'),
      eliteKitBeat(54, 'any', 'volatile', 'drum'),
      beat(62, 'se', ['splitter', 6], ['exploder', 8], ['healer', 3]),
      eliteKitBeat(70, 'nw', 'bulwark', 'wedge'),
      kitBeat(78, 'any', 'trench'),
    ],
    duration: 86,
    difficulty: { spawnRate: 1.4, hp: 1.32 },
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.12,
    bosses: ['matron'],
    size: 46,
    palette: REACTOR,
    // A ring of eight vessels with two doors, and two short walls laid as chokes just inside
    // it. The rim is the first chapter whose middle is a place you go through rather than a
    // place you stand, and the plates sit in the two lanes that ring leaves — east and west —
    // so running the ring is a route with a price on it rather than a free lap. The vessels are
    // close enough together that nothing arrives *through* them: the spawner at 0:08 and the
    // trench pack at 1:18 both come down on the open water outside the ring, which is where a
    // brood landing behind its own body, and a trench run five metres long, are both still
    // things the player can see coming.
    props: [
      tank(0, 18, 4),
      tank(0, -18, 4),
      tank(18, 0, 4),
      tank(-18, 0, 4),
      tank(14, 13, 3.5),
      tank(-14, 13, 3.5),
      tank(14, -13, 3.5),
      tank(-14, -13, 3.5),
      wall(9, 3, 10, 2),
      wall(-9, -3, 10, 2),
      crate(0, 26, 2.5),
      crate(0, -26, 2.5),
    ],
    hazards: [
      acid(0, 9, 3.5, 14),
      acid(0, -9, 3.5, 14),
      crusher(24, 0, 2.6, 45),
      crusher(-24, 0, 2.6, 45),
      crusher(0, 24, 2.4, 40),
      crusher(0, -24, 2.4, 40),
    ],
  },
  {
    id: 'thread-floor',
    name: 'Thread Floor',
    // The swarm chapter, and the one that carries every body that arrived after the recipes
    // were written: the circling line, the blink pair, the trench pack and the faucet, on a
    // drumbeat that stays cloud-forward. Clouds are the thing a chapter is *about* here; the
    // bodies that came after them are what the chapter stops protecting you from once you have
    // learned to delete a cloud, which is why the last five beats of its script all name at
    // least one of them.
    packs: [
      ['swarmling', 'swarmling', 'chaser', 'swarmling', 'charger', 'swarmling'],
      ['swarmling', 'charger', 'exploder', 'swarmling', 'shooter', 'chaser', 'orbiter'],
      ['charger', 'swarmling', 'splitter', 'shooter', 'armored', 'teleporter'],
      ['swarmling', 'armored', 'grenadier', 'charger', 'shooter', 'healer', 'burrower'],
      ['armored', 'swarmling', 'exploder', 'splitter', 'charger', 'grenadier', 'spawner'],
      ['splitter', 'charger', 'armored', 'swarmling', 'exploder', 'healer', 'sniper', 'teleporter'],
    ],
    // Twenty-four bodies at a time, eight beats over the chapter, because the thread floor is
    // the chapter that asks what you are holding. The lattice is what makes that answerable — a
    // cloud that has to come between two columns arrives in twos — and the `any` beats are the
    // ones that arrive from everywhere at once, which is what a chapter whose middle is a lane
    // is for. The circling line at 0:38 and the blink pair at 1:20 both want that lane: an
    // orbiter walks a 6.5 m ring around wherever you are standing, and a teleporter paints
    // eight metres of floor before it crosses them, so both are sent into the room that has the
    // most floor in it and neither is sent into the lattice, where the ring and the line would
    // both stop at a column.
    waves: [
      kitBeat(8, 'any', 'cloud'),
      kitBeat(18, 'n', 'lane'),
      beat(28, 'sw', ['swarmling', 20], ['exploder', 5], ['shooter', 4]),
      kitBeat(38, 'any', 'circle'),
      kitBeat(48, 'ne', 'trench'),
      kitBeat(56, 'any', 'wedge'),
      eliteKitBeat(64, 'nw', 'frenzy', 'charge'),
      beat(72, 'se', ['splitter', 6], ['exploder', 6], ['swarmling', 20], ['healer', 3]),
      kitBeat(80, 'any', 'blink'),
    ],
    duration: 88,
    difficulty: { spawnRate: 1.48, hp: 1.4 },
    elites: ['frenzy', 'volatile'],
    eliteChance: 0.14,
    bosses: ['matron', 'matron'],
    size: 60,
    palette: DOCKS,
    // Twelve columns on a lattice with the gaps left wide, in the widest room in the campaign,
    // and one clear lane running east-west through the middle of it — the lane is the layout's
    // whole argument. A cloud of twenty-four has to be deletable with one good sweep and it is,
    // but the sweep has to be aimed somewhere; the lane is where the chapter's marks are sent
    // (the sniper joins the recipe at its last row and the blink pair lands in it at 1:20), so
    // it is kept clear of cover end to end, which is the only reason a sniper sent down it has
    // a shot and the only reason a teleporter sent down it has a line. The two plates sit at
    // either end of that lane, which is what running it costs; the four pools sit in the
    // lattice and in the two lanes either side of it, where a pack being herded can be left in
    // one, and never in the middle.
    props: [
      pillar(-24, 12),
      pillar(-12, 12),
      pillar(0, 12),
      pillar(12, 12),
      pillar(24, 12),
      pillar(-24, -12),
      pillar(-12, -12),
      pillar(0, -12),
      pillar(12, -12),
      pillar(24, -12),
      pillar(-30, 20),
      pillar(30, -20),
      tank(0, 26, 4),
      tank(0, -26, 4),
    ],
    hazards: [
      acid(-14, 20, 3, 12),
      acid(14, -20, 3, 12),
      acid(0, 8, 3, 12),
      acid(0, -8, 3, 12),
      crusher(26, 0, 2.6, 50),
      crusher(-26, 0, 2.6, 50),
    ],
  },
];