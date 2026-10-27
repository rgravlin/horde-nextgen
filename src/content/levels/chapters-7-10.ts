/**
 * Chapters 7 to 10: rooms that will not let anybody stand still.
 *
 * Nothing new walks in here — the last four chapters are the whole roster arriving together in
 * four rooms that each remove one way of coping. The vault has no straight line through it, so a
 * shot at the middle is fired along a wall face; the Long Room is that line, twice, with three
 * walls across the middle and every beat in its script spending a bolt down one of the two
 * aisles; the dock gives a charger two berths to build a run-up in and charges the short line
 * across with crushers; the kill floor has one cross of walls in it and is playable at its spawn
 * rate only because of that cross.
 *
 * Between them these four chapters put every archetype the roster owns on the floor, which is
 * what the brief asks of the last four chapters of a ten-chapter campaign and is the reason the
 * scripts are written as named compositions rather than as counts: `armorGuns` at 0:18 in the
 * vault and `armorGuns` again at 1:18 in the kill floor are the same thing arriving twice, and
 * the second time it arrives in a room with nowhere to put it down.
 *
 * A room that sends a teleporter or a burrower has to be a room with somewhere to do it: both
 * test the whole line before they commit to it, so a chapter that wants either one has to leave
 * eight metres of clear floor somewhere, and a chapter that wants a sniper has to leave a line
 * that a bolt can fly. That, not difficulty, is what changes in the four floors below, and it is
 * why two of them send a trench pack and two decline one: in a room whose floor is mostly wall
 * the burrower spends the chapter walking, which is a different body with the same name.
 *
 * These four carry the highest `difficulty` pairs and the highest elite rates in the campaign,
 * which is the ramp `tests/unit/waves.test.ts` reads as a product rather than as a feeling.
 */

import { DOCKS, FOUNDRY, REACTOR, acid, beat, crate, crusher, eliteBeat, tank, wall } from './builders';
import { eliteKitBeat, kitBeat } from './factions';
import type { LevelDef } from './types';

/** Chapters 7 to 10, in play order. See `index.ts` for what a chapter is. */
export const LEVELS_7_10: readonly LevelDef[] = [
  {
    id: 'cinder-vault',
    name: 'Cinder Vault',
    // No chaff. Every row is a body that either shoots, bursts, or takes a hit for something
    // else, which is the chapter's whole argument for existing, and from its third row the
    // bodies that shoot do it from a moving circle or from across the room rather than from a
    // standstill. Armour leads every row: the plate is a screen, and the fight is behind it.
    packs: [
      ['armored', 'shooter', 'exploder', 'armored', 'charger'],
      ['armored', 'grenadier', 'shooter', 'splitter', 'healer', 'exploder'],
      ['grenadier', 'armored', 'healer', 'shooter', 'exploder', 'orbiter'],
      ['armored', 'exploder', 'grenadier', 'healer', 'splitter', 'shooter', 'sniper'],
      ['healer', 'armored', 'grenadier', 'exploder', 'shooter', 'splitter', 'teleporter'],
      ['grenadier', 'armored', 'exploder', 'shooter', 'healer', 'sniper', 'orbiter'],
    ],
    // Nothing arrives in the open here. Every beat names a side the pinwheel's faces sit
    // across, so a pack either comes through a door or has to walk around a wall to get to the
    // middle, and the two `any` beats are the chapter asking you to read two things at once.
    // The vault's own argument, in data: no chaff, and the elites start carrying bodies rather
    // than tints — a bulwark wedge at 0:54 and a drum of volatile exploders at 1:10. The
    // circling line at 0:28 and the blink pair at 1:10 are both sent along the faces rather
    // than into the eye of the pinwheel, because both of them spend a line and neither one
    // paints it over cover.
    waves: [
      beat(8, 'any', ['armored', 5], ['shooter', 4]),
      kitBeat(18, 'e', 'armorGuns'),
      kitBeat(28, 'any', 'circle'),
      beat(36, 'nw', ['splitter', 6], ['shooter', 5], ['healer', 3]),
      beat(46, 'se', ['armored', 6], ['charger', 5]),
      eliteBeat(54, 'any', 'bulwark', ['armored', 6], ['healer', 3]),
      kitBeat(62, 'n', 'bombers'),
      kitBeat(70, 's', 'blink'),
      kitBeat(78, 'any', 'armorGuns'),
    ],
    duration: 90,
    difficulty: { spawnRate: 1.56, hp: 1.48 },
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.16,
    bosses: ['atlas'],
    size: 48,
    palette: FOUNDRY,
    // The pinwheel: four walls turned about the middle, so the vault has no straight line
    // through it at all and every shot fired at the centre is fired along a face. This is the
    // chapter where a shooter's band and a grenadier's landing ring have to be read around a
    // corner.
    //
    // The four faces are fourteen metres rather than the eighteen they were, and that is the
    // two marks being allowed into the room: an orbiter walks a 6.5 m ring and a teleporter
    // paints eight metres of strip before it spends them, and both tests are taken from wherever
    // the body happens to be standing, so a pinwheel with eighteen-metre arms is a room where
    // neither ever happens and the two best answers to a plate are quietly switched off. Shorter
    // faces keep the corner, open the four quarters the pinwheel turns between, and leave the
    // vault's own argument intact — there is still no straight run at the middle. The pools sit
    // in the two lanes the pinwheel leaves, where a body being herded can be left in one, and
    // not in the eye: that is where a run starts, and a chapter may not open by charging you
    // for a floor you were dropped onto.
    props: [
      wall(8, 3, 14, 2),
      wall(-8, -3, 14, 2),
      wall(3, -8, 2, 14),
      wall(-3, 8, 2, 14),
      wall(24, 20, 12, 2),
      wall(-24, -20, 12, 2),
      crate(20, -18, 3),
      crate(-20, 18, 3),
    ],
    hazards: [
      acid(-7, -8, 3, 16),
      acid(7, 8, 3, 16),
      crusher(18, 10, 2.6, 50),
      crusher(-18, -10, 2.6, 50),
      crusher(22, 14, 2.4, 45),
      crusher(-22, -14, 2.4, 45),
    ],
  },
  {
    id: 'long-room',
    name: 'The Long Room',
    // Everything the room can fight, from the first batch, and the highest elite rate in the
    // game. Eight chapters in, the last long room is allowed to be unfair in a way that is
    // legible: nothing here is new, it is only all arriving together — and the sniper is in
    // every row, because the room it was drawn for is this one. The body kept *out* is the
    // burrower, for the reason given under the script below.
    packs: [
      ['armored', 'charger', 'exploder', 'shooter', 'sniper', 'grenadier'],
      ['armored', 'healer', 'grenadier', 'exploder', 'sniper', 'splitter', 'shooter'],
      ['splitter', 'armored', 'shooter', 'healer', 'sniper', 'teleporter', 'grenadier'],
      ['grenadier', 'armored', 'exploder', 'sniper', 'shooter', 'orbiter', 'healer'],
      ['armored', 'grenadier', 'healer', 'exploder', 'orbiter', 'sniper', 'shooter', 'teleporter'],
      ['exploder', 'armored', 'splitter', 'grenadier', 'sniper', 'shooter', 'healer', 'orbiter'],
    ],
    // The aisles run east-west, so the beats that spend a line are given `e` and `w`: a firing
    // line arrives down an aisle with a clear sight and a six-metre door to be answered through.
    // The circling line at 0:38 is the one beat aimed at the middle, where a 6.5 m ring can
    // actually be walked, and the two blink packs are the chapter asking you to read a strip
    // painted in one aisle and spent in another.
    //
    // There is no trench pack here, and that is the room's decision rather than an oversight. A
    // burrower only goes under the floor when it can see 5.2 m of clear floor at the player,
    // and a room built out of two forty-metre walls is mostly line that fails that test: with
    // the trench kit in this script it never went under once in a whole play-through, out of
    // four thousand ticks of being close enough and ready to dig. That is a set piece switched
    // off, not delayed, so the chapter's bodies are the ones its geometry serves — the marks
    // that spend a bolt down a clear aisle — and 0:56 is the same argument with a mender
    // behind it. `burrower` is out of the drumbeat for the same reason; the Dock and the Kill
    // Floor are where a trench pack has somewhere to dig, and it digs there.
    waves: [
      kitBeat(8, 'e', 'line'),
      kitBeat(18, 'any', 'armorGuns'),
      kitBeat(28, 'w', 'line'),
      kitBeat(38, 'any', 'circle'),
      kitBeat(46, 'e', 'blink'),
      beat(56, 'n', ['shooter', 6], ['sniper', 4], ['healer', 3]),
      kitBeat(64, 'w', 'supports'),
      beat(74, 'any', ['splitter', 6], ['exploder', 8], ['sniper', 4]),
      kitBeat(82, 'any', 'blink'),
    ],
    duration: 92,
    difficulty: { spawnRate: 1.64, hp: 1.56 },
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.18,
    bosses: ['matron', 'atlas'],
    size: 52,
    palette: REACTOR,
    // Two long walls with the ends left open, and three twelve-metre walls across the middle:
    // the name is the layout. Long sights run the whole way, which is what a chapter that opens
    // with a firing line is for — the two long walls are staggered rather than paired so the
    // north aisle and the south aisle are each clear end to end, and a bolt fired down either
    // one only stops when it runs out of room. Each cross wall leaves three metres at either
    // end, so there are six ways into the middle band and nearly every one is watched from the
    // other side; the four plates price its two ends, which is the deck a run walks to get
    // anywhere in this room.
    props: [
      wall(-6, 10, 40, 2),
      wall(6, -10, 40, 2),
      wall(-18, 0, 2, 12),
      wall(4, 0, 2, 12),
      wall(26, 0, 2, 12),
      crate(-34, 20, 3),
      crate(34, -20, 3),
    ],
    hazards: [
      acid(-10, 0, 3, 14),
      acid(16, 0, 3, 14),
      crusher(0, 20, 2.8, 55),
      crusher(0, -20, 2.8, 55),
      crusher(-30, 0, 2.6, 50),
      crusher(30, 0, 2.6, 50),
    ],
  },
  {
    id: 'dry-dock',
    name: 'Dry Dock',
    // The two bodies the vault kept out come back, and the two that break the walking default
    // with them: chargers, because the dock is the chapter that makes a charge line something
    // you have to answer with geometry, and the trench pack, because a berth is a room in which
    // a five-metre dig can be finished and the open water is where four of them land at once.
    // The ranged trio and the faucet run at a rate that means a volley is always in the air.
    packs: [
      ['charger', 'chaser', 'shooter', 'charger', 'spawner'],
      ['charger', 'shooter', 'exploder', 'charger', 'armored', 'burrower'],
      ['charger', 'grenadier', 'shooter', 'splitter', 'charger', 'teleporter'],
      ['armored', 'charger', 'grenadier', 'healer', 'shooter', 'charger', 'spawner'],
      ['charger', 'armored', 'grenadier', 'exploder', 'burrower', 'healer', 'shooter'],
      ['splitter', 'charger', 'armored', 'grenadier', 'teleporter', 'exploder', 'healer', 'spawner'],
    ],
    // Charger volleys, six and seven strong, timed down the two berths and across the open
    // water between them. A charge is only a threat with a run-up, so the beats that name a
    // side are the ones that land in a berth or down the water, and the `any` beats are the ones
    // that land on the plates — which is the chapter's price for standing still in the short
    // line across. The two trench packs are sent at 0:18 and 1:14 for the same reason: the dock
    // is the one room in the campaign where a burrower can dig twice without stopping.
    waves: [
      kitBeat(8, 'any', 'charge'),
      kitBeat(18, 'n', 'trench'),
      kitBeat(28, 'any', 'wedge'),
      kitBeat(38, 's', 'charge'),
      kitBeat(48, 'w', 'faucet'),
      eliteBeat(56, 'e', 'frenzy', ['charger', 7], ['chaser', 8]),
      kitBeat(64, 'any', 'supports'),
      kitBeat(74, 'n', 'trench'),
      eliteKitBeat(84, 'any', 'bulwark', 'wedge'),
    ],
    duration: 94,
    difficulty: { spawnRate: 1.72, hp: 1.64 },
    elites: ['bulwark', 'frenzy'],
    eliteChance: 0.16,
    bosses: ['atlas', 'broodmother'],
    size: 54,
    palette: DOCKS,
    // Two dry berths: long rooms with two doors each, and the crushers in the open water between
    // them. A charger has to run its line down a berth to be worth anything, and the berths are
    // the layout's answer to that; the plates in the middle are the price of the shorter line
    // across.
    //
    // The berth walls stop twenty metres short of the berths' own ends, which is what the two
    // doors are. A berth with one door is a corridor and a corridor is answered by standing in
    // it; a berth with two is a room you can give the far end of, which is the answer a trench
    // pack needs — five rings on the floor and two ways off them. The water between the berths
    // is eight metres of clear deck the whole width of the dock, and it is the reason the
    // faucet at 0:48 and the two trench packs land where they do rather than in a berth.
    props: [
      wall(-12, 16, 2, 20),
      wall(12, 16, 2, 20),
      wall(-12, -16, 2, 20),
      wall(12, -16, 2, 20),
      wall(0, 28, 26, 2),
      wall(0, -28, 26, 2),
      crate(-24, 0, 3),
      crate(24, 0, 3),
      tank(-28, 20, 4),
      tank(28, -20, 4),
      tank(-28, -20, 4),
      tank(28, 20, 4),
    ],
    hazards: [
      acid(0, 12, 3, 14),
      acid(0, -12, 3, 14),
      crusher(0, 0, 3, 55),
      crusher(-20, 24, 2.6, 45),
      crusher(20, -24, 2.6, 45),
    ],
  },
  {
    id: 'kill-floor',
    name: 'Kill Floor',
    // Everything the roster owns, all of it from the first batch, at the top elite rate. The
    // last chapter is not allowed to have a lesson in it; it is allowed to have every lesson at
    // once, in a room that gives nowhere to put them down. Every composition the campaign names
    // appears in this script, and every archetype the recipes are allowed to carry appears in
    // its drumbeat.
    packs: [
      ['armored', 'charger', 'exploder', 'shooter', 'splitter', 'grenadier', 'healer'],
      ['charger', 'armored', 'grenadier', 'healer', 'exploder', 'teleporter', 'splitter', 'shooter'],
      ['splitter', 'armored', 'shooter', 'healer', 'exploder', 'grenadier', 'sniper', 'chaser'],
      ['grenadier', 'armored', 'exploder', 'splitter', 'shooter', 'burrower', 'healer', 'swarmling'],
      ['armored', 'grenadier', 'healer', 'exploder', 'spawner', 'shooter', 'orbiter', 'teleporter'],
      ['exploder', 'armored', 'splitter', 'grenadier', 'charger', 'sniper', 'healer', 'spawner', 'burrower'],
    ],
    // Nine beats, every archetype the drumbeat is allowed to carry, and the two elite packs at
    // 0:56 and 1:24 that arrive on either side of the cross rather than down it. Nothing here is
    // new and none of it is fair in a room with nowhere to put anything down: the last chapter is
    // every lesson at once, which is why its script names three and four compositions in a pack
    // rather than one.
    waves: [
      kitBeat(8, 'any', 'lane'),
      kitBeat(18, 'ne', 'bombers'),
      kitBeat(28, 'any', 'armorGuns'),
      kitBeat(38, 'sw', 'circle'),
      kitBeat(48, 'any', 'supports'),
      eliteKitBeat(56, 'nw', 'volatile', 'drum'),
      kitBeat(64, 'se', 'wedge'),
      kitBeat(74, 'any', 'trench'),
      eliteKitBeat(84, 'any', 'frenzy', 'lane'),
    ],
    duration: 96,
    difficulty: { spawnRate: 1.8, hp: 1.72 },
    elites: ['bulwark', 'frenzy', 'volatile'],
    eliteChance: 0.2,
    bosses: ['broodmother', 'matron', 'atlas'],
    size: 44,
    palette: REACTOR,
    // A cross of walls with the four corners left as open killing fields. The cross is the only
    // cover in the room and it is the reason the room is playable at this rate: a pack has to
    // come round a corner to reach the middle, and the plates at the four corners of the cross
    // are where a run that stops moving ends.
    //
    // The four arms and the four corner crates are what the chapter's blink and trench packs are
    // spent against: every one of them lands outside the cross, on open floor, where a teleporter
    // has eight metres to cross and a burrower has five to dig, which is the honest reading of
    // "nowhere to put anything down" — the room has no cover to hide behind rather than no room
    // to walk.
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