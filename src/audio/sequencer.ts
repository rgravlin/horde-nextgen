/**
 * The music clock: song data in, "which note sounds at what time" out.
 *
 * It lives apart from the synth for the same reason `loop.ts` lives apart from the renderer:
 * this is the part with invariants, and the part that needs no audio device to be checked. A
 * song here is a table of step patterns plus a tempo; this file decides *when* a note falls,
 * how long it holds, which instrument plays it and how loud it is; `synth.ts` decides what it
 * sounds like. Nothing in this file mentions `AudioContext`, `window` or a timer, so
 * `tests/unit/sequencer.test.ts` drives a whole track in plain Node, twice over, and asserts
 * the two passes came out identical.
 *
 * Three decisions worth keeping:
 *
 * - **Steps, not seconds.** The pattern is written on a 16-step-per-bar grid and the tempo is
 *   applied at the end (`secondsPerStep`), so a song is the same music at 128 and at 140 BPM
 *   and a bar is a fact a reader can count on the page.
 * - **No memory between steps beyond the step index itself.** What sounds at step N is a
 *   function of N, the table and the two numbers in the call. That is what makes the
 *   double-pass determinism test meaningful — and it is why a held note is spelled out in the
 *   data (`_`) rather than inferred from what played last time.
 * - **A gap is dropped, not repaid.** `CATCH_UP` mirrors `MAX_FRAME` in `loop.ts`: once the
 *   clock is further behind than that (a pause, a level-up freeze, a backgrounded tab) the
 *   backlog is discarded and the next note is scheduled from *now*. Music that would have
 *   sounded during a pause is not owed to the player, and paying it back as a chord of late
 *   notes is how procedural audio starts sounding broken.
 *
 * The pattern notation, one character per 16th note:
 *
 * - pitch tracks: `.` rest, `_` hold (the previous note carries on for this step too),
 *   `a`-`g` a note of the song's scale by degree, `A`-`G` the same degrees an octave up.
 * - drum tracks: `.` rest, `-` ghost (a quieter hit), `x` hit, `o` accent.
 *
 * An unrecognised character reads as a rest, and `checkSong` reports the bars that contain
 * one, so a typo is a failing test rather than a silent hole in a track.
 */

/**
 * The instruments a song can write for.
 *
 * The order is the numbering the synth's voice table and the batch's `voice` slot use, so it
 * is a list rather than a set: `VOICE_COUNT` sizes the scratch arrays and a new instrument is
 * one entry here plus one recipe in `synth.ts`.
 */
export const VOICE_IDS = ['kick', 'snare', 'hat', 'bass', 'pad', 'arp', 'lead', 'boss'] as const;

export type VoiceId = (typeof VOICE_IDS)[number];

export const VOICE_COUNT = VOICE_IDS.length;

/** 16th-note steps in a bar. A pattern row is exactly this long. */
export const STEPS_PER_BAR = 16;

/** How many notes one `scheduleNotes` call may write. See `NoteBatch`. */
export const BATCH_CAP = 48;

/**
 * Play seconds the sequencer may fall behind before the backlog is thrown away.
 *
 * Anything further behind than this is a gap in play (pause, cards, a stalled tab) rather than
 * a lag to recover from, and the look-ahead window the synth pumps into is a quarter of it.
 */
export const CATCH_UP = 0.2;

/**
 * Body counts at which the music thickens.
 *
 * These sit close to the numbers `DESIGN.md` cares about — a dozen bodies is a skirmish, a few
 * hundred is the horde — because the tier is the player's cue that the room has changed, and a
 * cue that arrives after the fight is not a cue.
 */
export const DENSITY_TIERS = [28, 90, 250] as const;

/** How many intensity tiers there are: 0 (the floor) through 3. */
export const MAX_INTENSITY = DENSITY_TIERS.length;

/** What a track is played on, and therefore how its steps are read. */
export type TrackKind = 'pitch' | 'drum';

/** One instrument's part in a song. Data only; see `songs.ts`. */
export interface TrackDef {
  readonly id: string;
  readonly voice: VoiceId;
  readonly kind: TrackKind;
  /** The part, one 16-character row per bar, cycled by bar. */
  readonly bars: readonly string[];
  /**
   * The lowest intensity tier at which this part plays. Omitted means 0: always there.
   *
   * This is the whole layering mechanism. A track with `from: 2` joins when the horde passes
   * 90 bodies and drops out when it thins back under 54, which is what lets one song cover an
   * empty arena and a screen full of bodies without either arrangement being written twice.
   */
  readonly from?: number;
  /** Only while the chapter's encounter is on the floor, and not a moment after. */
  readonly boss?: boolean;
  /**
   * Note length in steps, when the data does not spell the hold out with `_`.
   *
   * A pad says `length: 16` and writes one chord per bar; the bass spells its own holds
   * because they change mid-bar. Either way the length is bounded here, so a run of `_` cannot
   * hold a note past one bar by accident.
   */
  readonly length?: number;
  /** Mix, 0..1-ish. Multiplied by the per-step velocity when the note is written. */
  readonly gain?: number;
  /** Semitone offset for the whole part: -24 puts a pitch track two octaves down. */
  readonly semitones?: number;
}

/** A song: one tempo, one scale, one register, and the parts that share them. */
export interface SongDef {
  readonly id: string;
  readonly bpm: number;
  /**
   * Semitone offsets above the root, walked as degrees.
   *
   * Seven entries, so `a`-`g` is one octave of the scale and `A` is `a` an octave up. A degree
   * number past the end wraps and raises the octave, which is what a letter beyond `g` would
   * do if a track ever used one.
   */
  readonly scale: readonly number[];
  /** MIDI note number of degree 0. 69 is A4, where middle C-ish sits for our purposes. */
  readonly root: number;
  readonly tracks: readonly TrackDef[];
}

/** A track with its notation decoded into the byte grid the scheduler reads. */
export interface CompiledTrack {
  readonly id: string;
  /** Index into `VOICE_IDS`. */
  readonly voice: number;
  readonly drum: boolean;
  readonly from: number;
  readonly boss: boolean;
  /** Longest note, in steps, including any `_` that extends it. */
  readonly length: number;
  readonly gain: number;
  readonly semitones: number;
  /**
   * One code per step slot.
   *
   * -1 is a rest and 0 is a hold on a pitch track. Above 0 the meaning depends on the kind: a
   * pitch track's code is the degree plus 1, a drum track's is a `velocityOf` key. Both fit in
   * a signed byte, which is what lets one array serve either kind.
   */
  readonly steps: Int8Array;
}

/** A song ready to be played: the parts plus the tempo maths already done. */
export interface CompiledSong {
  readonly id: string;
  readonly secondsPerStep: number;
  readonly scale: readonly number[];
  readonly root: number;
  readonly tracks: readonly CompiledTrack[];
}

/**
 * The notes one pump produced, in the order they fall.
 *
 * Struct-of-arrays for the same reason the pools are: the synth reads this every frame, and a
 * fresh object per note would be the allocation the frame budget is written against. The batch
 * belongs to the caller and is reused — `scheduleNotes` resets `count` rather than returning a
 * new one — so an idle frame writes nothing and allocates nothing.
 */
export interface NoteBatch {
  readonly cap: number;
  /** Which `tracks` entry the note came from, so a reader can tell the boss layer from the bass. */
  readonly track: Uint8Array;
  readonly voice: Uint8Array;
  /** Absolute audio-clock seconds at which the note starts. */
  readonly time: Float32Array;
  readonly dur: Float32Array;
  /** MIDI note number; 0 on a drum hit, which has no pitch. */
  readonly pitch: Int16Array;
  readonly gain: Float32Array;
  count: number;
  /** Notes dropped because the batch was full; keeps the loss observable. */
  dropped: number;
}

/** Where the music is in its song. */
export interface Sequencer {
  readonly song: CompiledSong;
  /** The next 16th-note position to schedule. */
  step: number;
  /** Audio-clock seconds at which `step` sounds. */
  at: number;
  /** Scratch: which parts are playing right now, indexed by track. */
  readonly active: Uint8Array;
}

const REST = -1;
const HOLD = 0;

/** The pitch letters, low octave then high. Position in the string is the degree. */
const PITCH_LOW = 'abcdefg';
const PITCH_HIGH = 'ABCDEFG';

function decodePitch(ch: string): number {
  if (ch === '_' || ch === '-') return HOLD;
  const low = PITCH_LOW.indexOf(ch);
  if (low >= 0) return low + 1;
  const high = PITCH_HIGH.indexOf(ch);
  if (high >= 0) return high + 1 + PITCH_LOW.length;
  return REST;
}

/** A drum step's loudness, keyed by its code. Beside the decoder so the two cannot disagree. */
export function velocityOf(code: number): number {
  if (code === 1) return 1;
  if (code === 2) return 1.35;
  if (code === 3) return 0.45;
  return 0;
}

function decodeDrum(ch: string): number {
  if (ch === 'x') return 1;
  if (ch === 'o') return 2;
  if (ch === '-') return 3;
  return REST;
}

/** True when a character is legal in that kind of track. `.` is always legal. */
function isStepChar(ch: string, kind: TrackKind): boolean {
  if (ch === '.') return true;
  return kind === 'drum' ? velocityOf(decodeDrum(ch)) > 0 : decodePitch(ch) !== REST;
}

/**
 * Decode the notation into the byte grid, so the per-frame path reads numbers.
 *
 * Called when a chapter's song is chosen — once per floor, not once per frame — so the work
 * here is allowed to be string handling.
 */
export function compileSong(song: SongDef): CompiledSong {
  const tracks: CompiledTrack[] = [];
  for (const def of song.tracks) {
    const bars = def.bars.length > 0 ? def.bars.length : 1;
    const steps = new Int8Array(bars * STEPS_PER_BAR);
    const drum = def.kind === 'drum';
    for (let bar = 0; bar < bars; bar++) {
      const row = def.bars[bar] ?? '';
      for (let i = 0; i < STEPS_PER_BAR; i++) {
        const ch = row[i] ?? '.';
        steps[bar * STEPS_PER_BAR + i] = drum ? decodeDrum(ch) : decodePitch(ch);
      }
    }
    tracks.push({
      id: def.id,
      voice: (VOICE_IDS as readonly string[]).indexOf(def.voice),
      drum,
      from: def.from ?? 0,
      boss: def.boss === true,
      length: def.length ?? 1,
      gain: def.gain ?? 1,
      semitones: def.semitones ?? 0,
      steps,
    });
  }

  const bpm = song.bpm > 0 ? song.bpm : 120;
  return {
    id: song.id,
    // One beat is a quarter note, which is four of these steps.
    secondsPerStep: 60 / bpm / 4,
    scale: song.scale,
    root: song.root,
    tracks,
  };
}

/**
 * Everything wrong with a song's data, as readable strings.
 *
 * A pattern is only music while it lines up with the grid: a 15-character bar pushes that
 * track a step early against every other part, and a stray capital in a drum row reads as a
 * rest. Both are silent, so they are checked rather than trusted — the test calls this on
 * every song in `songs.ts`.
 */
export function checkSong(song: SongDef): string[] {
  const problems: string[] = [];
  if (!(song.bpm > 0)) problems.push(`${song.id}: bpm ${song.bpm} is not a tempo`);
  if (song.scale.length === 0) problems.push(`${song.id}: no scale`);
  if (song.tracks.length === 0) problems.push(`${song.id}: no tracks`);
  if (song.tracks.length > 255) problems.push(`${song.id}: ${song.tracks.length} tracks (a batch slot is a byte)`);

  for (const def of song.tracks) {
    if ((VOICE_IDS as readonly string[]).indexOf(def.voice) < 0) {
      problems.push(`${def.id}: voice '${def.voice}' is not an instrument`);
    }
    if (def.bars.length === 0) problems.push(`${def.id}: empty`);
    for (let bar = 0; bar < def.bars.length; bar++) {
      const row = def.bars[bar];
      if (row.length !== STEPS_PER_BAR) {
        problems.push(`${def.id} bar ${bar}: ${row.length} steps, expected ${STEPS_PER_BAR}`);
        continue;
      }
      for (let i = 0; i < row.length; i++) {
        if (!isStepChar(row[i], def.kind)) {
          problems.push(`${def.id} bar ${bar} step ${i}: '${row[i]}' is not a ${def.kind} step`);
        }
      }
    }
    if (def.from !== undefined && (def.from < 0 || def.from > MAX_INTENSITY)) {
      problems.push(`${def.id}: from ${def.from} is outside 0..${MAX_INTENSITY}`);
    }
  }
  return problems;
}

export function createNoteBatch(cap: number = BATCH_CAP): NoteBatch {
  return {
    cap,
    track: new Uint8Array(cap),
    voice: new Uint8Array(cap),
    time: new Float32Array(cap),
    dur: new Float32Array(cap),
    pitch: new Int16Array(cap),
    gain: new Float32Array(cap),
    count: 0,
    dropped: 0,
  };
}

export function createSequencer(song: SongDef, at: number = 0): Sequencer {
  const compiled = compileSong(song);
  return {
    song: compiled,
    step: 0,
    at,
    active: new Uint8Array(compiled.tracks.length),
  };
}

/**
 * Put a new song under the sequencer and start it from the top, now.
 *
 * A chapter change swaps the track (see `songForChapter` in `songs.ts`): a run that carried the
 * old floor's music into a new floor would be one song doing the work of three. The clock is
 * re-anchored at `at` rather than left where it was, because the incoming track has no backlog
 * to catch up on. A same-song call returns the same sequencer, so the state is not rebuilt on
 * a frame that merely re-asked.
 */
export function retune(seq: Sequencer, song: SongDef, at: number): Sequencer {
  if (seq.song.id === song.id) return seq;
  const compiled = compileSong(song);
  return {
    song: compiled,
    step: 0,
    at,
    active: new Uint8Array(compiled.tracks.length),
  };
}

/** A track plays when the horde is thick enough for it, and a boss part only during a boss. */
function trackOn(track: CompiledTrack, intensity: number, bossAlive: boolean): boolean {
  if (track.boss) return bossAlive;
  return intensity >= track.from;
}

/** Semitones above the song's root for a written degree, wrapping the scale into octaves. */
function midiOf(song: CompiledSong, track: CompiledTrack, code: number): number {
  const deg = code - 1;
  const scale = song.scale;
  const wrap = Math.floor(deg / scale.length);
  return song.root + scale[deg % scale.length] + 12 * wrap + track.semitones;
}

/** How many steps a note lasts: the data's holds, up to the track's own ceiling. */
function holdSteps(track: CompiledTrack, pos: number): number {
  let held = 1;
  const len = track.steps.length;
  while (held < track.length) {
    if (track.steps[(pos + held) % len] !== HOLD) break;
    held++;
  }
  return held;
}

/**
 * Fill `out` with every note that should start before `until`, walking the clock forward.
 *
 * `out` is the caller's and comes back with `count` reset; `seq` ends with `at` at or past
 * `until`, which is what keeps the next pump picking up where this one stopped instead of
 * replaying the same seconds — unless the batch filled first, in which case `dropped` says so and
 * the clock stops one step short of wherever it had got to. Notes are written in step order and,
 * inside a step, in track order, so the same call on the same state writes the same batch twice —
 * the property the test pins. A layer that is not playing is skipped before its steps are read,
 * which is what makes "intensity adds layers" a fact about the data rather than about the player.
 */
export function scheduleNotes(
  seq: Sequencer,
  until: number,
  intensity: number,
  bossAlive: boolean,
  out: NoteBatch,
): NoteBatch {
  out.count = 0;
  out.dropped = 0;

  const song = seq.song;
  const sps = song.secondsPerStep;
  const tracks = song.tracks;

  // A clock somehow ahead of the request (a resumed context, a restored zero) is dragged back
  // to the present rather than left scheduling in the future.
  if (seq.at > until + CATCH_UP) seq.at = until;

  // The gap rule, once per pump rather than once per note.
  if (seq.at < until - CATCH_UP) seq.at = until;

  for (let i = 0; i < tracks.length; i++) {
    seq.active[i] = trackOn(tracks[i], intensity, bossAlive) ? 1 : 0;
  }

  // A pump's work is bounded by the track count, so this bound really means "one pump costs a
  // fixed amount of time". It only bites if `secondsPerStep` came out absurdly small.
  let guard = 0;
  const guardCap = out.cap + 16;

  while (seq.at < until && guard++ < guardCap) {
    // A step is written whole or not at all. Reserving the track count, rather than checking room
    // per note, means a full batch stops the pump one step early instead of splitting one: the
    // next pump cannot re-emit a kick that was already scheduled, which is what half a step would
    // sound like — the same hit twice inside a sixteenth.
    if (out.count + tracks.length > out.cap) {
      out.dropped++;
      break;
    }

    for (let i = 0; i < tracks.length; i++) {
      if (seq.active[i] === 0) continue;
      const track = tracks[i];
      const pos = seq.step % track.steps.length;
      const code = track.steps[pos];
      if (code <= HOLD) continue;

      const gain = track.gain * (track.drum ? velocityOf(code) : 1);
      if (gain <= 0) continue;

      const k = out.count++;
      out.track[k] = i;
      out.voice[k] = track.voice;
      out.time[k] = seq.at;
      out.dur[k] = holdSteps(track, pos) * sps;
      out.pitch[k] = track.drum ? 0 : midiOf(song, track, code);
      out.gain[k] = gain;
    }

    seq.at += sps;
    seq.step++;
  }

  return out;
}

/**
 * The intensity tier a floor is at right now.
 *
 * Bodies on the floor, plus the encounter: a boss lifts the bed to at least tier 2 even if it
 * arrived with an empty room, because the encounter is the moment the track was written for.
 */
export function intensityFor(bodies: number, bossAlive: boolean): number {
  let tier = 0;
  while (tier < DENSITY_TIERS.length && bodies >= DENSITY_TIERS[tier]) tier++;
  if (bossAlive && tier < 2) tier = 2;
  return tier;
}

/**
 * The same tier, with hysteresis.
 *
 * Going up is immediate — a wall of bodies arriving is worth hearing now — but coming back down
 * needs the floor to empty past 60% of the count that raised the tier. Without it, a horde
 * hovering at the threshold makes the music flicker between two arrangements several times a
 * second, which is worse than either arrangement on its own.
 */
export function nextIntensity(current: number, bodies: number, bossAlive: boolean): number {
  const up = intensityFor(bodies, bossAlive);
  if (up > current) return up;
  if (current <= 0) return up;
  const floor = DENSITY_TIERS[current - 1] * 0.6;
  return bodies >= floor ? current : up;
}