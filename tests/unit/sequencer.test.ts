import { describe, expect, it } from 'vitest';

import { SONGS, songForChapter } from '../../src/audio/songs';
import {
  BATCH_CAP,
  CATCH_UP,
  DENSITY_TIERS,
  MAX_INTENSITY,
  STEPS_PER_BAR,
  VOICE_IDS,
  checkSong,
  compileSong,
  createNoteBatch,
  createSequencer,
  intensityFor,
  nextIntensity,
  retune,
  scheduleNotes,
  type NoteBatch,
  type Sequencer,
  type SongDef,
} from '../../src/audio/sequencer';

/**
 * The music clock (ARCHITECTURE.md: the simulation is separate from rendering, and the parts with
 * invariants get driven in plain Node). The sequencer is the half of the audio layer that has
 * invariants and no audio device: a song is data, this is the thing that turns data into notes at
 * times, and it is legal to call it ten thousand times and insist the two halves came out the same.
 *
 * Three properties matter and the file is arranged around them: the same data written twice gives
 * the same notes (determinism — the promise the replay makes about the sim); the arrangement
 * thickens with the horde rather than with the clock (intensity adds layers); and the encounter
 * part exists only while the encounter does (the boss layer). The rest of the tests are the
 * plumbing that makes those three mean something: a checker that would actually catch a mis-sized
 * bar, a batch that stops rather than splitting a step, a gap in play that is dropped rather than
 * repaid.
 */

/** Where a test starts its clock. Anywhere away from zero keeps "in the past" out of the maths. */
const START = 10;

/** A batch wide enough that the cap is not what a test is accidentally measuring. */
const WIDE = 4096;

/**
 * Pump `steps` of music out of `seq`, one 16th note per call.
 *
 * The window is deliberately narrow. A request more than `CATCH_UP` ahead of the clock is a *gap*
 * in play as far as the clock is concerned — a pause, a tab in the background — and its rule about
 * a gap is to drop the backlog, so a test that asked for a whole bar in one call would be
 * measuring that rule instead of the notes. One step per pump is also what a frame that keeps up
 * actually asks for.
 */
function pumpSteps(
  seq: Sequencer,
  steps: number,
  intensity: number,
  bossAlive: boolean,
  batch: NoteBatch,
  each: (batch: NoteBatch) => void,
): void {
  for (let i = 0; i < steps; i++) {
    scheduleNotes(seq, seq.at + seq.song.secondsPerStep, intensity, bossAlive, batch);
    each(batch);
  }
}

function nameOf(batch: NoteBatch, i: number): string {
  return VOICE_IDS[batch.voice[i]];
}

/** The batch as numbers, exact rather than rounded-to-look-alike. */
function signature(batch: NoteBatch, into: number[]): number[] {
  for (let i = 0; i < batch.count; i++) {
    into.push(batch.track[i], batch.voice[i], batch.pitch[i]);
    // Six decimals is finer than the sequencer's own maths, so this compares the bits rather than
    // a rounded shadow of them: a deterministic pass reproduces the numbers exactly.
    into.push(Math.round(batch.time[i] * 1e6), Math.round(batch.dur[i] * 1e6), Math.round(batch.gain[i] * 1e6));
  }
  return into;
}

/** The same, read as `step voice pitch length` lines, for expectations a reader can check by eye. */
function grid(batch: NoteBatch, secondsPerStep: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < batch.count; i++) {
    const step = Math.round((batch.time[i] - START) / secondsPerStep);
    const hold = (Math.round((batch.dur[i] / secondsPerStep) * 100) / 100).toFixed(2);
    out.push(`step ${step} ${nameOf(batch, i)} ${batch.pitch[i]} x${hold}`);
  }
  return out;
}

/** How many notes came from one track, which is how the boss layer gets identified. */
function countTrack(batch: NoteBatch, track: number): number {
  let n = 0;
  for (let i = 0; i < batch.count; i++) if (batch.track[i] === track) n++;
  return n;
}

/** A three-part tune written so that every number in it is worth asserting on. */
const THREE_PART: SongDef = {
  id: 'three-part',
  bpm: 120,
  scale: [0, 2, 4, 5, 7, 9, 11],
  root: 60,
  tracks: [
    { id: 'kick', voice: 'kick', kind: 'drum', bars: ['x...x...x...x...'] },
    { id: 'pad', voice: 'pad', kind: 'pitch', length: 4, bars: ['a_________a_______'] },
    {
      id: 'lead',
      voice: 'lead',
      kind: 'pitch',
      from: 1,
      length: 1,
      semitones: 12,
      gain: 0.5,
      bars: ['a.g.A...........'],
    },
  ],
};

/** Four parts that all hit every step, for filling a batch on purpose. */
const FOUR_DOWN: SongDef = {
  id: 'four-down',
  bpm: 240,
  scale: [0, 2, 4],
  root: 60,
  tracks: [
    { id: 'kick', voice: 'kick', kind: 'drum', bars: ['xxxxxxxx'] },
    { id: 'hat', voice: 'hat', kind: 'drum', bars: ['o--o--o-'] },
    { id: 'bass', voice: 'bass', kind: 'pitch', bars: ['aaaaaaaa'] },
    { id: 'lead', voice: 'lead', kind: 'pitch', bars: ['cccccccc'] },
  ],
};

describe('song data', () => {
  it('ships three songs the clock can read', () => {
    expect(SONGS).toHaveLength(3);
    for (const song of SONGS) {
      // `checkSong` reports mis-sized bars, letters that are not steps, unknown instruments and a
      // `from` outside the tiers. All three tracks are hand-typed rows of sixteen characters,
      // which is exactly the kind of thing that goes wrong quietly.
      expect(checkSong(song)).toEqual([]);
      expect(compileSong(song).secondsPerStep).toBeGreaterThan(0);
      // Every floor has an encounter, and an encounter has to have something to sound like.
      expect(song.tracks.some((t) => t.boss === true)).toBe(true);
    }
  });

  it('gives each song parts for every tier, so the arrangement can thicken', () => {
    for (const song of SONGS) {
      const tiers = new Set<number>(song.tracks.map((t) => t.from ?? 0));
      for (let tier = 0; tier <= MAX_INTENSITY; tier++) {
        expect(tiers.has(tier), `${song.id} has no part entering at tier ${tier}`).toBe(true);
      }
    }
  });

  it('checks the notation instead of trusting it', () => {
    const broken: SongDef = {
      id: 'broken',
      bpm: 120,
      scale: [0, 2, 4],
      root: 60,
      tracks: [
        // One step short: everything after it in that track lands a sixteenth early.
        { id: 'short', voice: 'kick', kind: 'drum', bars: ['x...x...x...x..'] },
        // A capital in a drum row is not a drum step, so it would read as a rest.
        { id: 'quiet', voice: 'hat', kind: 'drum', bars: ['x...x...x...x..A'] },
        // No such instrument.
        { id: 'ghost', voice: 'tuba' as never, kind: 'pitch', bars: ['a_______a_______'] },
        // A part that can never be reached.
        { id: 'late', voice: 'bass', kind: 'pitch', from: 9, bars: ['a.a.a.a.a.a.a.a.'] },
      ],
    };
    const problems = checkSong(broken);
    expect(problems).toHaveLength(4);
    const text = problems.join('\n');
    expect(text).toContain('15 steps, expected 16');
    expect(text).toContain("'A' is not a drum step");
    expect(text).toContain("'tuba' is not an instrument");
    expect(text).toContain('outside 0..3');
  });

  it('covers ten chapters with three songs and keeps playing past the tenth', () => {
    const floors: string[] = [];
    for (let chapter = 0; chapter < 10; chapter++) floors.push(songForChapter(chapter).id);
    expect(new Set(floors).size).toBe(3);
    expect(floors.slice(0, 3)).toEqual(['loading-bay', 'loading-bay', 'loading-bay']);
    expect(floors.slice(3, 6)).toEqual(['coolant-deck', 'coolant-deck', 'coolant-deck']);
    expect(floors.slice(6)).toEqual(['kill-floor', 'kill-floor', 'kill-floor', 'kill-floor']);

    // A longer campaign, or a chapter grid counted from 1: the fold-back is by *position*, so
    // floor eleven is not the same thing as floor one. A negative index folds the same way.
    expect(songForChapter(10).id).toBe('coolant-deck');
    expect(songForChapter(11).id).toBe('kill-floor');
    expect(songForChapter(12).id).toBe('loading-bay');
    expect(songForChapter(-1).id).toBe('kill-floor');
  });
});

describe('the clock', () => {
  it('writes the same notes twice from the same data and the same script', () => {
    // The determinism requirement, at the size the game runs at: seven seconds of the busiest
    // arrangement, pumped a step at a time, twice, on two sequencers that never met.
    const notes: number[] = [];
    pumpSteps(createSequencer(SONGS[0], START), 70, MAX_INTENSITY, false, createNoteBatch(WIDE), (b) => {
      signature(b, notes);
    });
    const first = [...notes];

    const again: number[] = [];
    let dropped = 0;
    pumpSteps(createSequencer(SONGS[0], START), 70, MAX_INTENSITY, false, createNoteBatch(WIDE), (b) => {
      signature(b, again);
      dropped += b.dropped;
    });

    // Six numbers per note, and nothing vacuous: a silent sequencer would agree with itself.
    expect(first.length).toBeGreaterThan(1200);
    expect(again).toEqual(first);
    // And nothing was lost on the way, which is what makes the equality about the notes rather
    // than about two halves of the same truncation.
    expect(dropped).toBe(0);
  });

  it('decodes the notation the way it is documented', () => {
    const seq = createSequencer(THREE_PART, START);
    const batch = createNoteBatch(64);
    // 120 BPM puts a sixteenth at exactly 0.125 s, so a bar is two seconds and the arithmetic
    // under these expectations is arithmetic a reader can do on the page.
    pumpSteps(seq, STEPS_PER_BAR, 0, false, batch, () => {});

    // Four kicks a bar, and a pad that holds four steps and restarts. A `.` in a pitch row is a
    // rest and a `_` is a hold, which is why the pad's twelve held steps make two notes. Pumped
    // a step at a time, and still exactly one bar's worth: the batch never split a step.
    expect(seq.step).toBe(STEPS_PER_BAR);
    const heard: string[] = [];
    pumpSteps(createSequencer(THREE_PART, START), STEPS_PER_BAR, 0, false, batch, (b) => {
      for (const line of grid(b, 0.125)) heard.push(line);
    });
    expect(heard).toEqual([
      'step 0 kick 0 x1.00',
      'step 0 pad 60 x4.00',
      'step 4 kick 0 x1.00',
      'step 8 kick 0 x1.00',
      'step 10 pad 60 x4.00',
      'step 12 kick 0 x1.00',
    ]);
  });

  it('lifts a capital an octave, pushes a part by its offset, and mixes it by its gain', () => {
    const seq = createSequencer(THREE_PART, START);
    const batch = createNoteBatch(64);
    const lead: string[] = [];
    const gains: number[] = [];
    pumpSteps(seq, STEPS_PER_BAR, 1, false, batch, (b) => {
      for (const line of grid(b, 0.125)) if (line.includes(' lead ')) lead.push(line);
      for (let i = 0; i < b.count; i++) gains.push(Math.round(b.gain[i] * 100) / 100);
    });

    // The lead is in at tier 1. `a` and `g` are the first and seventh degrees of a seven-note
    // scale and `A` is `a` an octave above it, all three twelve semitones higher again because the
    // part says so. `g` is the top of the scale, so it is the degree a whole tone under the
    // octave rather than the octave itself.
    expect(lead).toEqual(['step 0 lead 72 x1.00', 'step 2 lead 83 x1.00', 'step 4 lead 84 x1.00']);
    expect(gains).toContain(0.5);
    expect(gains).toContain(1);
  });

  it('drops a gap in play instead of repaying it', () => {
    const seq = createSequencer(SONGS[0], START);
    const batch = createNoteBatch(WIDE);

    pumpSteps(seq, 8, MAX_INTENSITY, false, batch, () => {});
    const before = batch.count;

    // Five seconds with nothing scheduled: a pause, a level-up freeze, a tab sent to the
    // background. The backlog is a fifth of a track, and paying it back would be a chord of late
    // notes, so the clock is dragged to the present instead.
    scheduleNotes(seq, START + 5, MAX_INTENSITY, false, batch);

    expect(before).toBeGreaterThan(0);
    expect(batch.count).toBeLessThan(60);
    expect(seq.at).toBeGreaterThanOrEqual(START + 5);
    // The catch-up window is what the rule is written in, so the number is worth pinning: a
    // quarter-second of lag is still played, and anything longer is a gap rather than a lag.
    expect(CATCH_UP).toBeGreaterThan(0.1);
  });

  it('refuses to schedule in the future it was handed, and recovers', () => {
    const seq = createSequencer(SONGS[0], START + 30);
    const batch = createNoteBatch(WIDE);
    // A resumed audio context reports a clock far ahead of the sequencer's own.
    scheduleNotes(seq, START, MAX_INTENSITY, false, batch);
    expect(seq.at).toBeGreaterThanOrEqual(START);
    expect(seq.at).toBeLessThan(START + 1);

    // The next frame is ordinary again, and nothing in it reaches back before the present.
    pumpSteps(seq, 8, MAX_INTENSITY, false, batch, () => {});
    expect(batch.count).toBeGreaterThan(0);
    for (let i = 0; i < batch.count; i++) expect(batch.time[i]).toBeLessThanOrEqual(START + 1);
  });

  it('gives the engine a batch that the shipped songs never fill', () => {
    // `synth.ts` builds one batch for the whole run and refills it every frame, so the default
    // width is a fact about the shipped content rather than a random number: a song dense enough
    // to overflow it would lose notes every frame, quietly, forever. A full look-ahead first
    // (what the frame after a retune asks for), then frame-sized windows at 60 fps, with the
    // encounter on because that is when the table is fullest.
    for (const song of SONGS) {
      const batch = createNoteBatch();
      expect(batch.cap).toBe(BATCH_CAP);

      const seq = createSequencer(song, START);
      let played = 0;

      scheduleNotes(seq, START + 0.12, MAX_INTENSITY, true, batch);
      expect(batch.dropped).toBe(0);
      played += batch.count;

      for (let f = 0; f < 240; f++) {
        scheduleNotes(seq, seq.at + 1 / 60, MAX_INTENSITY, true, batch);
        expect(batch.dropped).toBe(0);
        played += batch.count;
      }

      expect(played).toBeGreaterThan(0);
    }
  });

  it('stops a full batch one step short instead of splitting a step', () => {
    const song = FOUR_DOWN;
    const sps = compileSong(song).secondsPerStep;
    const window = 3 * sps;
    const end = START + 2;

    // The same two seconds of the busiest fixture, twice: once with a batch wide enough that
    // nothing is ever refused, once with a batch that fills after eight notes. Four parts all
    // hitting every step means twelve notes per window, so the cap really does engage.
    const windows: number[] = [];
    for (let at = START; at < end; at += window) windows.push(at + window);

    const wide = createNoteBatch(WIDE);
    const whole = createSequencer(song, START);
    const reference: number[] = [];
    for (const until of windows) {
      scheduleNotes(whole, until, MAX_INTENSITY, false, wide);
      signature(wide, reference);
      expect(wide.dropped).toBe(0);
    }

    const small = createNoteBatch(8);
    const stepped = createSequencer(song, START);
    const joined: number[] = [];
    let capped = 0;
    let pumps = 0;
    for (const until of windows) {
      for (;;) {
        pumps++;
        scheduleNotes(stepped, until, MAX_INTENSITY, false, small);
        signature(small, joined);
        capped += small.dropped;
        if (small.dropped === 0) break;
        expect(pumps).toBeLessThan(200);
      }
    }

    expect(capped).toBeGreaterThan(0);
    // The whole point: a step that does not fit stops the pump, so the next pump resumes at the
    // *next* step rather than re-emitting the kicks of the one it left half-written.
    expect(joined).toEqual(reference);
    expect(stepped.at).toBeGreaterThanOrEqual(end);
  });
});

describe('intensity', () => {
  it('adds a layer at each tier, and keeps the ones it already had', () => {
    for (const song of SONGS) {
      const ids = compileSong(song).tracks.map((t) => t.id);
      const heard: string[][] = [];
      const counts: number[] = [];

      for (let tier = 0; tier <= MAX_INTENSITY; tier++) {
        const batch = createNoteBatch(WIDE);
        const set = new Set<string>();
        let total = 0;
        pumpSteps(createSequencer(song, START), 36, tier, false, batch, (b) => {
          for (let i = 0; i < b.count; i++) set.add(ids[b.track[i]]);
          total += b.count;
        });
        heard.push([...set].sort());
        counts.push(total);
      }

      for (let tier = 1; tier <= MAX_INTENSITY; tier++) {
        // Nothing drops out on the way up, and something arrives at every step up.
        for (const part of heard[tier - 1]) expect(heard[tier], `${song.id} tier ${tier}`).toContain(part);
        expect(heard[tier].length, `${song.id} tier ${tier}`).toBeGreaterThan(heard[tier - 1].length);
        expect(counts[tier], `${song.id} tier ${tier}`).toBeGreaterThan(counts[tier - 1]);
      }
    }
  });

  it('keeps the snares, the arps, the leads and the encounter out of the bed', () => {
    for (const song of SONGS) {
      const bed = new Set<string>();
      const bedBatch = createNoteBatch(WIDE);
      let bedNotes = 0;
      pumpSteps(createSequencer(song, START), 36, 0, false, bedBatch, (b) => {
        for (let i = 0; i < b.count; i++) bed.add(nameOf(b, i));
        bedNotes += b.count;
      });
      expect(bedNotes).toBeGreaterThan(0);
      for (const earned of ['snare', 'arp', 'lead', 'boss']) {
        expect(bed.has(earned), `${song.id} plays ${earned} at tier 0`).toBe(false);
      }

      // And they are all there by the top tier, so the absence above is an arrangement rather
      // than a part nobody ever wrote.
      const top = new Set<string>();
      const topBatch = createNoteBatch(WIDE);
      let topNotes = 0;
      pumpSteps(createSequencer(song, START), 36, MAX_INTENSITY, false, topBatch, (b) => {
        for (let i = 0; i < b.count; i++) top.add(nameOf(b, i));
        topNotes += b.count;
      });
      expect(top.has('lead')).toBe(true);
      expect(top.has('arp')).toBe(true);
      expect(topNotes).toBeGreaterThan(bedNotes * 2);
    }
  });

  it('lifts the bed for the encounter before the floor is thick', () => {
    expect(intensityFor(0, false)).toBe(0);
    expect(intensityFor(DENSITY_TIERS[0], false)).toBe(1);
    expect(intensityFor(DENSITY_TIERS[1], false)).toBe(2);
    expect(intensityFor(DENSITY_TIERS[2], false)).toBe(3);
    expect(intensityFor(0, true)).toBe(2);
    expect(intensityFor(999, true)).toBe(MAX_INTENSITY);
  });

  it('holds a tier until the floor has actually emptied', () => {
    // A horde hovering at 90 bodies is the ordinary case, and a track that flickered between two
    // arrangements several times a second would be worse than either arrangement on its own.
    expect(nextIntensity(2, 90, false)).toBe(2);
    expect(nextIntensity(2, 60, false)).toBe(2);
    expect(nextIntensity(2, 53, false)).toBe(1);
    // Coming down is one step at a time; going up is immediate.
    expect(nextIntensity(3, 100, false)).toBe(2);
    expect(nextIntensity(0, 400, false)).toBe(MAX_INTENSITY);
    // An empty floor is an empty arrangement, and a boss on its own holds the bed up.
    expect(nextIntensity(2, 0, false)).toBe(0);
    expect(nextIntensity(2, 10, true)).toBe(2);
  });
});

describe('the boss layer', () => {
  it('sounds only while the encounter is alive', () => {
    for (const song of SONGS) {
      const boss = compileSong(song).tracks.findIndex((t) => t.boss === true);
      expect(boss).toBeGreaterThanOrEqual(0);

      let silent = 0;
      let loud = 0;
      pumpSteps(createSequencer(song, START), 36, MAX_INTENSITY, false, createNoteBatch(WIDE), (b) => {
        silent += countTrack(b, boss);
      });
      pumpSteps(createSequencer(song, START), 36, MAX_INTENSITY, true, createNoteBatch(WIDE), (b) => {
        loud += countTrack(b, boss);
      });

      expect(silent, `${song.id} plays its encounter part with no encounter`).toBe(0);
      expect(loud).toBeGreaterThan(0);
    }
  });

  it('stops the moment the encounter falls', () => {
    const song = SONGS[0];
    const boss = compileSong(song).tracks.findIndex((t) => t.boss === true);
    const seq = createSequencer(song, START);
    const batch = createNoteBatch(WIDE);

    // Three windows on one sequencer: alive, dead, alive. The part follows the flag with no
    // memory of its own, which is what makes it a fact about the floor rather than a fade. The
    // batch is one object reused by every pump, so the count is taken inside each pump rather
    // than after the window, where only the last step's notes would still be in it.
    let first = 0;
    let middle = 0;
    let last = 0;
    pumpSteps(seq, 36, MAX_INTENSITY, true, batch, (b) => {
      first += countTrack(b, boss);
    });
    pumpSteps(seq, 36, MAX_INTENSITY, false, batch, (b) => {
      middle += countTrack(b, boss);
    });
    pumpSteps(seq, 36, MAX_INTENSITY, true, batch, (b) => {
      last += countTrack(b, boss);
    });

    expect(first).toBeGreaterThan(0);
    expect(middle).toBe(0);
    expect(last).toBeGreaterThan(0);
  });
});

describe('retune', () => {
  it('keeps the clock when the song has not changed', () => {
    const seq = createSequencer(SONGS[0], START);
    // Chapters 1 and 2 both play the loading bay; a chapter change is not a song change.
    expect(retune(seq, songForChapter(1), START + 3)).toBe(seq);
  });

  it('starts a new song from the top, now, with no backlog', () => {
    const first = createSequencer(SONGS[0], START);
    const batch = createNoteBatch(WIDE);
    pumpSteps(first, 36, MAX_INTENSITY, false, batch, () => {});
    const moved = retune(first, songForChapter(9), 20);

    expect(moved).not.toBe(first);
    expect(moved.song.id).toBe('kill-floor');
    expect(moved.step).toBe(0);
    expect(moved.at).toBe(20);
    expect(moved.active.length).toBe(moved.song.tracks.length);

    // A new track starts where the audio clock is, not four seconds behind it, and it starts with
    // the whole arrangement in place rather than the bed it would have been two seconds in.
    pumpSteps(moved, 8, MAX_INTENSITY, true, batch, () => {});
    expect(batch.count).toBeGreaterThan(0);
    for (let i = 0; i < batch.count; i++) expect(batch.time[i]).toBeGreaterThanOrEqual(20);
  });
});
