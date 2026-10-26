/**
 * The soundtrack: three tracks, as data.
 *
 * They are data rather than code for the reason every other content table is (AGENTS.md): a
 * song is something to read and argue about, and a change of groove should not mean a change of
 * program. Each entry is a tempo, a scale, a register and a set of parts on the 16-step grid
 * `sequencer.ts` defines; `synth.ts` turns a part into oscillators.
 *
 * Three tracks for ten chapters, because a procedural score is a small number of ideas played
 * at the right thickness. Each track covers a run of floors and its layers peel on in tiers:
 * what plays at intensity 0 is the empty-room bed, and by tier 3 the whole table is going. A
 * chapter therefore gets one *song* and up to four *arrangements* of it, which is why ten
 * chapters do not need ten tunes — and why chapter 9 sounds different from chapter 8 even
 * though `CHAPTER_SONGS` names the same track.
 *
 * The `from` numbers are the arrangement. Reading one is reading the plan: a part that only
 * joins at tier 2 is a reward for surviving the first half of a floor, and the `boss` part is
 * only ever in during the encounter, so the moment the boss dies the wail stops with it.
 *
 * Notation is spelled out at the top of `sequencer.ts`; `tests/unit/sequencer.test.ts` runs
 * `checkSong` over everything here, so a mis-sized bar is a failing test.
 */

import type { SongDef } from './sequencer';

/** Natural minor: dark without being evil. `a` is the tonic, `c` its minor third. */
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/** Phrygian: the flat second, which reads as a threat rather than as a minor key. */
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];

/**
 * Phrygian dominant: the flat second *and* the raised third.
 *
 * It is the most strained scale of the three, which is the point of putting it under the last
 * four floors — the scale that only just holds together is the one that goes with a player who
 * has run out of room.
 */
const PHRYGIAN_DOMINANT = [0, 1, 4, 5, 7, 8, 10];

/**
 * Chapters 1-3: the loading bay, the conveyor yard and the slag canal.
 *
 * Four-on-the-floor, a bass that sits on the tonic, and nothing above the waist until the
 * horde is two digits deep. This is the track a player meets with a pistol and eleven rounds,
 * so the arrangement that has no hats and no lead is not an early version of the rest — it is
 * the sound of a room with fewer than twenty-eight things trying to kill them.
 */
const LOADING_BAY: SongDef = {
  id: 'loading-bay',
  bpm: 132,
  scale: MINOR,
  root: 57, // A3
  tracks: [
    {
      id: 'kick',
      voice: 'kick',
      kind: 'drum',
      bars: ['x...x...x...x...', 'x...x...x...x..o'],
    },
    {
      id: 'kick-run',
      voice: 'kick',
      kind: 'drum',
      from: 2,
      gain: 0.75,
      bars: ['x...x...x..oxxo.', 'x...x..ox..oxxo.'],
    },
    {
      id: 'hats',
      voice: 'hat',
      kind: 'drum',
      from: 1,
      gain: 0.5,
      bars: ['x-x-x-x-x-x-x-x-', 'x-x-x-o-x-x-x-o-'],
    },
    {
      id: 'snare',
      voice: 'snare',
      kind: 'drum',
      from: 2,
      gain: 0.7,
      bars: ['....x.......x...', '....x.....o.x.-.'],
    },
    {
      id: 'bass',
      voice: 'bass',
      kind: 'pitch',
      length: 2,
      semitones: -24,
      gain: 0.85,
      bars: ['a.a.a.a.a._.g._.', 'a.a._.d._.d.a._.', 'g._.g._.a.a.d._.', 'd._.d._.g.g.a._.'],
    },
    {
      id: 'pad',
      voice: 'pad',
      kind: 'pitch',
      length: 8,
      gain: 0.3,
      bars: ['a_______d_______', 'c_______g_______'],
    },
    {
      id: 'arp',
      voice: 'arp',
      kind: 'pitch',
      from: 2,
      length: 2,
      semitones: 12,
      gain: 0.34,
      bars: ['acegacegacegaceg', 'acegacegacegaceg'],
    },
    {
      id: 'lead',
      voice: 'lead',
      kind: 'pitch',
      from: 3,
      length: 2,
      semitones: 12,
      gain: 0.42,
      bars: ['e.g.A._.d.f.e._.', 'A.g.e.d_.c.A_.c.'],
    },
    {
      id: 'boss-wail',
      voice: 'boss',
      kind: 'pitch',
      boss: true,
      length: 6,
      semitones: -12,
      gain: 0.5,
      bars: ['a._._._.b._.a._.', 'b._.a._.g._.a._.'],
    },
  ],
};

/**
 * Chapters 4-6: the coolant deck, the reactor rim and the thread floor.
 *
 * Ten BPM faster and syncopated, with the flat second doing the work. The hats run sixteenths
 * from tier 1 and a second bass enters at tier 2 an octave above the first, because by chapter
 * 4 the player has at least two weapons and the floor has cover — the music has to leave gaps
 * for the shotgun to be heard in.
 */
const COOLANT_DECK: SongDef = {
  id: 'coolant-deck',
  bpm: 142,
  scale: PHRYGIAN,
  root: 62, // D4
  tracks: [
    {
      id: 'kick',
      voice: 'kick',
      kind: 'drum',
      bars: ['x.....x.x.....x.', 'x.....x.x..ox...'],
    },
    {
      id: 'kick-drive',
      voice: 'kick',
      kind: 'drum',
      from: 2,
      gain: 0.7,
      bars: ['x..ox...x..ox..o', 'x...x..ox.x.x..o'],
    },
    {
      id: 'hats',
      voice: 'hat',
      kind: 'drum',
      from: 1,
      gain: 0.45,
      bars: ['xxx-xxx-xxx-xxx-', 'x-x-xox-x-x-xox-'],
    },
    {
      id: 'snare',
      voice: 'snare',
      kind: 'drum',
      from: 1,
      gain: 0.65,
      bars: ['..x.......x...x.', '....x...o...x...'],
    },
    {
      id: 'bass',
      voice: 'bass',
      kind: 'pitch',
      length: 2,
      semitones: -24,
      gain: 0.85,
      bars: ['a.a.a_.a_.a.b.a_', 'a.a.b_.a_.d.a_.g'],
    },
    {
      id: 'bass-top',
      voice: 'bass',
      kind: 'pitch',
      from: 2,
      length: 1,
      semitones: -12,
      gain: 0.5,
      bars: ['..d...d...a...a.', '..g...d...b...a.'],
    },
    {
      id: 'pad',
      voice: 'pad',
      kind: 'pitch',
      length: 16,
      gain: 0.26,
      bars: ['a_______________', 'c_______________'],
    },
    {
      id: 'arp',
      voice: 'arp',
      kind: 'pitch',
      from: 2,
      length: 1,
      semitones: 12,
      gain: 0.3,
      bars: ['acdacdacdacdacad', 'acegace_Acegace_'],
    },
    {
      id: 'lead',
      voice: 'lead',
      kind: 'pitch',
      from: 3,
      length: 2,
      semitones: 12,
      gain: 0.4,
      bars: ['A..g..e..d..c...', 'A.c.e_.d.A_.c.d.'],
    },
    {
      id: 'boss-wail',
      voice: 'boss',
      kind: 'pitch',
      boss: true,
      length: 4,
      semitones: -12,
      gain: 0.5,
      bars: ['a.b_.b_a.g_.a.b.', 'b_.ag_.ab_.a....'],
    },
  ],
};

/**
 * Chapters 7-10: the cinder vault, the long room, the dry dock and the kill floor.
 *
 * The fastest and the thinnest: the drums are busy but the register is low, and the lead only
 * arrives with the last of the difficulty ramps. The phrygian-dominant third (`d`, four
 * semitones up) is what gives the track its tension, so it is in the bass rather than
 * decorating it.
 */
const KILL_FLOOR: SongDef = {
  id: 'kill-floor',
  bpm: 152,
  scale: PHRYGIAN_DOMINANT,
  root: 52, // E3
  tracks: [
    {
      id: 'kick',
      voice: 'kick',
      kind: 'drum',
      bars: ['x..ox...x..ox...', 'x..ox...x..ox..o'],
    },
    {
      id: 'kick-drive',
      voice: 'kick',
      kind: 'drum',
      from: 1,
      gain: 0.7,
      bars: ['x.ox.x.oxx.ox.o.', 'xo.x.oxoxo.x.ox.'],
    },
    {
      id: 'hats',
      voice: 'hat',
      kind: 'drum',
      from: 0,
      gain: 0.4,
      bars: ['x.xxx.xxx.xxx.xx', '.o.o.o.o.o.o.o.o'],
    },
    {
      id: 'snare',
      voice: 'snare',
      kind: 'drum',
      from: 1,
      gain: 0.6,
      bars: ['....x...x...x..-', '..x...x....x....'],
    },
    {
      id: 'bass',
      voice: 'bass',
      kind: 'pitch',
      length: 2,
      semitones: -24,
      gain: 0.9,
      bars: ['a.a.a_d_.a.a.d_a', 'd_.a.a_d_.a.a._.'],
    },
    {
      id: 'bass-top',
      voice: 'bass',
      kind: 'pitch',
      from: 2,
      length: 1,
      semitones: -12,
      gain: 0.45,
      bars: ['..d...d..._.d...', '..g...d...b..._.'],
    },
    {
      id: 'pad',
      voice: 'pad',
      kind: 'pitch',
      from: 1,
      length: 16,
      gain: 0.24,
      bars: ['a_______________', 'b_______________'],
    },
    {
      id: 'arp',
      voice: 'arp',
      kind: 'pitch',
      from: 2,
      length: 1,
      semitones: 12,
      gain: 0.3,
      bars: ['abdb_acdb_abdb_a', 'ac_db_d_ac_db_d_'],
    },
    {
      id: 'lead',
      voice: 'lead',
      kind: 'pitch',
      from: 3,
      length: 2,
      semitones: 12,
      gain: 0.4,
      bars: ['A_.d.c.d_.A_.c.d', 'b.A_.g.e_.d.c_.A'],
    },
    {
      id: 'boss-wail',
      voice: 'boss',
      kind: 'pitch',
      boss: true,
      length: 3,
      semitones: -12,
      gain: 0.55,
      bars: ['a.b.d_.b.a.g_.f.', 'd_.b_.a.d_.g.a.b'],
    },
  ],
};

/** Everything that exists, in the order a chapter grid walks it. */
export const SONGS: readonly SongDef[] = [LOADING_BAY, COOLANT_DECK, KILL_FLOOR];

/**
 * Which track each of the ten floors plays.
 *
 * Three songs over ten chapters, three-plus-three-four, is a choice rather than a limit: the
 * first three floors are the foundry, the middle three are the plant at full tilt, and the last
 * four are what happens after the coolant goes. A chapter that needs its own tune is one line
 * here plus one `SongDef` above.
 */
const CHAPTER_SONGS: readonly string[] = [
  'loading-bay',
  'loading-bay',
  'loading-bay',
  'coolant-deck',
  'coolant-deck',
  'coolant-deck',
  'kill-floor',
  'kill-floor',
  'kill-floor',
  'kill-floor',
];

const BY_ID = new Map<string, SongDef>(SONGS.map((s) => [s.id, s]));

/**
 * The track for floor `chapter`.
 *
 * A chapter past the end of the table folds back *by position* (`chapter % SONGS.length`) rather
 * than stopping the music, so a run that reaches floor eleven (the arena, a longer campaign) still
 * has a bed under it. The lookup is two steps on purpose: the table holds names and `BY_ID` holds
 * tracks, and folding back has to hand `BY_ID` a name.
 */
export function songForChapter(chapter: number): SongDef {
  const named = BY_ID.get(CHAPTER_SONGS[chapter] ?? '');
  if (named !== undefined) return named;
  const n = SONGS.length;
  return SONGS[((chapter % n) + n) % n];
}