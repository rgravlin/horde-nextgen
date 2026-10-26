/**
 * The synth: a WebAudio graph, built once, played from the game's frame.
 *
 * Everything here is generated. There are no audio files to load and no samples to ship, for
 * three reasons that outlast this task: a horde game's most important sounds happen hundreds of
 * times a second and only need to be *different* from each other, not high fidelity; a downloaded
 * loop would be a network dependency in a game whose whole point is that it runs offline from a
 * static build; and a voice built from oscillators can be capped, which is the only way a
 * thousand bodies does not mean a thousand sounds.
 *
 * ## The graph
 *
 * ```
 *   music voices ─▶ musicBus ─▶ duck ─┐
 *   sfx voices ───────────────────────┼─▶ master ─▶ limiter ─▶ destination
 *   voices with a tail ─▶ echoIn ─▶ delay ─▶ wet ─┘
 *                              └──── fb ───┘        (the delay's own feedback loop)
 * ```
 *
 * Four buses rather than one wire to the destination, because the settings file has four knobs
 * (`master`, `sfx`, `music`, `muted`) and DESIGN.md wants gunfire to sit *on top of* the music
 * rather than fight it for the same headroom. The limiter exists for the same reason: at the busy
 * end of a chapter the summed input is well over unity, and a compressor that gives way sounds
 * better than a hard clip.
 *
 * ## What keeps it cheap
 *
 * - **A polyphony cap with real bookkeeping.** `POLY` slots each hold the time they free up, so
 *   "too many voices" is a decision about what is already sounding rather than a per-frame budget
 *   that lets a thousand short clicks through. A voice that cannot get a slot is refused and
 *   counted, and the count is readable from outside.
 * - **A per-frame voice budget**, shared by the music and the event drain, cut when the measured
 *   frame time says the machine is behind. This is the audio half of TECH.md's "quality settings
 *   so it scales down", keyed off measured frame time rather than off the render tier, so the
 *   audio layer never has to know what a shadow map is.
 * - **Nothing allocated per frame that is not a voice.** The batch, the mixer state, the slot
 *   table and the level cache are all built with the engine.
 *
 * ## Time
 *
 * Notes are scheduled against the *audio* clock (`graph.currentTime`), which is the only clock
 * allowed to say when a sound happens. The game's fixed 1/60 s step decides what happens; this
 * file turns "a shotgun went off during the last three ticks" into sounds placed inside a
 * look-ahead window, because `sequencer.ts` keeps a fraction of a second of notes queued ahead
 * and the audio thread must never wait on the game thread.
 *
 * The whole file is written against the narrow `AudioGraph` port rather than `AudioContext`, so
 * `main.ts` hands over the real thing and a unit test hands over a fake that refuses a bad
 * automation call — which is the only way "it does not throw in the browser" is something we check
 * rather than hope for.
 */

import {
  createNoteBatch,
  createSequencer,
  nextIntensity,
  retune,
  scheduleNotes,
  type NoteBatch,
  type Sequencer,
} from './sequencer';
import { songForChapter } from './songs';
import {
  createSfxState,
  drainSfx,
  resetSfx,
  type SfxSink,
  type SfxState,
  type SfxView,
} from './sfx';

// ---------------------------------------------------------------------------
// The port: the slice of WebAudio this file uses.
// ---------------------------------------------------------------------------

/** An `AudioParam`, with only the automations the voices need. */
export interface ParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(value: number, time: number, constant: number): unknown;
}

export interface NodeLike {
  connect(dest: NodeLike): unknown;
  disconnect(): unknown;
}

export interface GainLike extends NodeLike {
  gain: ParamLike;
}

export interface OscLike extends NodeLike {
  type: string;
  frequency: ParamLike;
  detune: ParamLike;
  start(when: number): unknown;
  stop(when: number): unknown;
}

export interface SourceLike extends NodeLike {
  buffer: BufferLike | null;
  loop: boolean;
  playbackRate: ParamLike;
  start(when: number, offset?: number, duration?: number): unknown;
  stop(when: number): unknown;
}

export interface FilterLike extends NodeLike {
  type: string;
  frequency: ParamLike;
  Q: ParamLike;
}

export interface PannerLike extends NodeLike {
  pan: ParamLike;
}

export interface DelayLike extends NodeLike {
  delayTime: ParamLike;
}

export interface CompLike extends NodeLike {
  threshold: ParamLike;
  ratio: ParamLike;
  attack: ParamLike;
  release: ParamLike;
}

export interface BufferLike {
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/** Everything a synth needs from an audio context. `AudioContext` satisfies it. */
export interface AudioGraph {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: NodeLike;
  readonly state?: string;
  resume?: () => unknown;
  createGain(): GainLike;
  createOscillator(): OscLike;
  createBufferSource(): SourceLike;
  createBuffer(channels: number, length: number, sampleRate: number): BufferLike;
  createBiquadFilter(): FilterLike;
  createStereoPanner(): PannerLike;
  createDelay(maxDelay: number): DelayLike;
  createDynamicsCompressor(): CompLike;
}

/** Where a problem goes: the same shape `persistence.ts` uses for a bad settings file. */
export type AudioProblem = (problem: string) => void;

// ---------------------------------------------------------------------------
// The engine's own view of the game: read-only.
// ---------------------------------------------------------------------------

/**
 * What the engine reads from the `World`.
 *
 * Bodies on the floor and whether the encounter is alive are the whole input to the arrangement,
 * and everything else is the event stream, so the engine never needs a gameplay type — and cannot
 * accidentally ask a question the sim has to answer again. `chapter` is here for the same reason
 * `persistence.ts` keeps it: it picks the song.
 */
export interface AudioView extends SfxView {
  readonly enemies: { readonly count: number };
  readonly boss: { readonly alive: boolean };
  readonly chapter: number;
}

/** The four knobs `persistence.ts` stores, in the shape the gains want. */
export interface AudioLevels {
  readonly master: number;
  readonly sfx: number;
  readonly music: number;
  readonly muted: boolean;
}

/** What one frame of audio did. Kept so a check can read the budget instead of guessing it. */
export interface AudioReport {
  /** Music voices started. */
  music: number;
  /** Event voices started. */
  sfx: number;
  /** Voices refused: no slot, no budget, or under the floor. */
  refused: number;
  /** The per-frame voice budget the frame ran with. */
  budget: number;
  /** The intensity tier the arrangement came from. */
  intensity: number;
}

/** The scene ids the duck table needs. Anything unknown plays at full level. */
export type SceneName = string;

export interface AudioEngine {
  /**
   * One browser frame of audio: pump the music, drain the events, set the levels.
   *
   * Called by the shell once per rendered frame, including the frozen ones — a pause is not a
   * reason for the soundtrack to stop, only a reason for it to get out of the way. Safe on a
   * World with no events, which is what a title screen is.
   */
  frame(world: AudioView, scene: SceneName, dt: number, levels: AudioLevels): void;
  /** The last frame's numbers. */
  readonly report: AudioReport;
  /** False once a call threw: audio gave up rather than spend the run's error budget. */
  readonly alive: boolean;
}

// ---------------------------------------------------------------------------
// Numbers worth arguing about.
// ---------------------------------------------------------------------------

/** Simultaneous voices, music and gunfire together. */
const POLY = 24;

/** Voices one frame may start, whatever the slots say. Cut when the machine is behind. */
const VOICES_PER_FRAME = 10;

/** Seconds of music queued ahead of the audio clock. */
const LOOK_AHEAD = 0.12;

/**
 * The frame time above which the voice budget shrinks, and the one below which it comes back.
 *
 * A 60 Hz target is 16.7 ms; past 22 ms the frame is already missing its budget and audio is the
 * cheapest thing to give up, because a thinner mix is the one degradation a player forgives. The
 * gap between the two numbers is the same hysteresis the intensity tiers use, for the same
 * reason: a knob that flickers at a threshold is worse than either setting on its own.
 */
const SLOW_FROM = 0.022;
const SLOW_BACK = 0.019;

/** How much of the frame-time history a decision looks at, as a smoothing factor. */
const SLOWING = 0.08;

/** Music duck, per scene. DESIGN.md: on the cards "the music ducks". */
const DUCK_FULL = 1;
const DUCK_CARDS = 0.32;
const DUCK_FROZEN = 0.45;

/** How fast a duck moves in and out, in seconds. */
const DUCK_TIME = 0.22;

/** Silence threshold for a voice's envelope tail. `exponentialRampToValueAtTime` cannot reach 0. */
const SILENCE = 0.0001;

/** Length of the shared white-noise buffer, in seconds. One buffer, many readers. */
const NOISE_SECONDS = 1.5;

/** How often to knock on a suspended audio context's door before going quiet about it. */
const RESUME_TRIES_EVERY = 60;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** A4 = 69, so 69 is 440 Hz. Voices want hertz; the sequencer writes note numbers. */
function hertz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * A voice: given where and how loud, make the sound, and return how long it occupies a slot
 * (0 means it declined).
 *
 * Builders are functions rather than data because a sound is a *shape* — which oscillators, what
 * filter, what tail — and `sfx.ts` already keeps the part that is data (which event wants which
 * sound, how loud, how often).
 */
type VoiceBuilder = (bus: NodeLike, t: number, dur: number, gain: number, pitch: number) => number;

export interface EngineOptions {
  /** Where a problem goes. Called a handful of times at most, never per frame. */
  note?: AudioProblem;
  /** Polyphony cap, for a test or a tier that wants fewer voices. */
  poly?: number;
  /** Per-frame voice budget. */
  voicesPerFrame?: number;
}

/**
 * Build the engine: the graph, the noise buffer, the voice tables, the sequencer.
 *
 * The caller owns the `AudioGraph`. When there is no audio device at all there is no engine to
 * build and the composition root plays without sound — the same way a machine with neither WebGPU
 * nor WebGL2 plays without a picture.
 */
export function createEngine(graph: AudioGraph, options: EngineOptions = {}): AudioEngine {
  const note = options.note;
  const poly = Math.max(1, options.poly ?? POLY);
  const frameVoices = Math.max(1, options.voicesPerFrame ?? VOICES_PER_FRAME);

  // --- the graph -----------------------------------------------------------

  const limiter = graph.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.22;
  limiter.connect(graph.destination);

  const master = graph.createGain();
  master.gain.value = 1;
  master.connect(limiter);

  /** The duck: one gain over the music, moved by the scene. */
  const duck = graph.createGain();
  duck.gain.value = DUCK_FULL;
  duck.connect(master);

  const musicBus = graph.createGain();
  musicBus.gain.value = 0.7;
  musicBus.connect(duck);

  const sfxBus = graph.createGain();
  sfxBus.gain.value = 1;
  sfxBus.connect(master);

  // The echo: a delay with its own feedback, fed by whoever asks for a tail. It returns to the
  // master path rather than to the sfx bus, so a lead line echoes too and the gunfire does not
  // have to pay for the music's tail. A cycle is only legal in WebAudio when something in it has
  // a delay, which is why `feedback` cannot simply be a wire.
  const echoIn = graph.createGain();
  echoIn.gain.value = 1;
  const delay = graph.createDelay(1);
  delay.delayTime.value = 0.23;
  const wet = graph.createGain();
  wet.gain.value = 0.34;
  const feedback = graph.createGain();
  feedback.gain.value = 0.34;
  echoIn.connect(delay);
  delay.connect(wet);
  wet.connect(master);
  delay.connect(feedback);
  feedback.connect(echoIn);

  // One noise buffer for every noisy voice, filled from the engine's own generator: never
  // `Math.random`, because a sound that differs between two runs of the same replay is a sound a
  // scenario cannot pin, and the replay's whole promise is that a run is reproducible.
  const noise = graph.createBuffer(1, Math.floor(NOISE_SECONDS * graph.sampleRate), graph.sampleRate);
  const noiseData = noise.getChannelData(0);
  let seed = 0x9e3779b9;
  for (let i = 0; i < noiseData.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noiseData[i] = (seed / 0xffffffff) * 2 - 1;
  }

  // --- polyphony ------------------------------------------------------------

  /** When each voice slot is free again, in audio seconds. */
  const slots = new Float64Array(poly);

  /**
   * Claim a voice slot for `dur` seconds from `t`.
   *
   * The first free slot wins; if none is free the voice is refused. A slot whose release time has
   * slipped into the past is reusable, so the table cannot fill itself with sounds that already
   * finished — which is what a long pause would otherwise do to it.
   */
  function claimSlot(t: number, dur: number): boolean {
    for (let i = 0; i < poly; i++) {
      if (slots[i] <= t) {
        slots[i] = t + dur;
        return true;
      }
    }
    return false;
  }

  /** Put a voice in the field. Only worth a panner when it is actually off-centre. */
  function place(node: NodeLike, pan: number): NodeLike {
    if (pan === 0) return node;
    const panner = graph.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    node.connect(panner);
    return panner;
  }

  /** One oscillator through a decaying gain, an optional lowpass and a pan. */
  function tone(
    bus: NodeLike,
    t: number,
    dur: number,
    peak: number,
    type: string,
    f0: number,
    f1: number,
    cut: number,
    pan: number,
    echo: boolean,
  ): void {
    const osc = graph.createOscillator();
    osc.type = type;
    const g = graph.createGain();
    osc.connect(g);
    let tail: NodeLike = g;

    if (cut > 0) {
      const filter = graph.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = clamp(cut, 20, 20000);
      tail = filter;
      g.connect(filter);
    }

    const panned = place(tail, pan);
    panned.connect(bus);
    if (echo) panned.connect(echoIn);

    const stop = t + Math.max(dur, 0.01);
    g.gain.setValueAtTime(Math.min(peak, 1), t);
    g.gain.exponentialRampToValueAtTime(SILENCE, stop);

    osc.frequency.setValueAtTime(Math.max(f0, 1), t);
    if (f1 > 0 && f1 !== f0) {
      // The sweep is the whole trick for a kick and for a falling laser; a constant-pitch voice
      // passes f1 === f0 and skips the automation.
      osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), stop);
    }

    osc.start(t);
    osc.stop(stop + 0.02);
  }

  /** A noise burst: the shared buffer read from a fresh offset, through a filter. */
  function burst(
    bus: NodeLike,
    t: number,
    dur: number,
    peak: number,
    filterType: string,
    freq: number,
    q: number,
    rate: number,
    pan: number,
    echo: boolean,
  ): void {
    const src = graph.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = clamp(rate, 0.25, 4);
    const g = graph.createGain();
    src.connect(g);
    let tail: NodeLike = g;

    if (filterType !== 'none') {
      const filter = graph.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = clamp(freq, 20, 20000);
      filter.Q.value = q;
      tail = filter;
      g.connect(filter);
    }

    const panned = place(tail, pan);
    panned.connect(bus);
    if (echo) panned.connect(echoIn);

    const len = Math.max(dur, 0.008);
    g.gain.setValueAtTime(Math.min(peak, 1), t);
    g.gain.exponentialRampToValueAtTime(SILENCE, t + len);

    // A different offset every time, so a hundred identical ticks do not phase into one buzz.
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const span = Math.max(noise.length - Math.ceil((len + 0.01) * noise.sampleRate) - 1, 1);
    const offset = (seed % span) / noise.sampleRate;
    src.start(t, offset, len + 0.005);
    src.stop(t + len + 0.01);
  }

  // --- the music voices, indexed by `VOICE_IDS` ----------------------------

  const musicVoices: VoiceBuilder[] = [
    // kick: a drop in pitch, which is what a synthesised kick has to do to read as one.
    (bus, t, dur, gain) => {
      const len = Math.min(dur, 0.16);
      tone(bus, t, len, 0.85 * gain, 'sine', 128, 46, 0, 0, false);
      return len;
    },
    // snare: a noise body plus a tuned skin, so it reads on phone speakers too.
    (bus, t, dur, gain) => {
      const len = Math.min(dur, 0.15);
      burst(bus, t, len, 0.5 * gain, 'bandpass', 1900, 0.7, 1, 0, false);
      tone(bus, t, 0.05, 0.28 * gain, 'triangle', 210, 150, 0, 0, false);
      return len;
    },
    // hat: very short, very bright, the cheapest thing on the page.
    (bus, t, dur, gain) => {
      const len = Math.min(dur, 0.06);
      burst(bus, t, len, 0.32 * gain, 'highpass', 7200, 0.8, 2, 0, false);
      return len;
    },
    // bass: a saw over a sub an octave below it, behind a mean lowpass.
    (bus, t, dur, gain, pitch) => {
      const len = Math.min(dur, 0.28);
      const f = hertz(pitch);
      tone(bus, t, len, 0.5 * gain, 'sawtooth', f, f, 240, 0, false);
      tone(bus, t, len, 0.34 * gain, 'sine', f / 2, f / 2, 0, 0, false);
      return len;
    },
    // pad: slow in, slow out, three slightly detuned layers wide.
    (bus, t, dur, gain, pitch) => {
      const len = Math.min(Math.max(dur, 0.4), 2.4);
      const f = hertz(pitch);
      tone(bus, t, len, 0.22 * gain, 'triangle', f, f, 1200, -0.3, false);
      tone(bus, t, len, 0.2 * gain, 'triangle', f * 1.004, f * 1.004, 900, 0.3, false);
      tone(bus, t, len * 0.8, 0.14 * gain, 'sawtooth', f * 0.5, f * 0.5, 600, 0, true);
      return len;
    },
    // arp: short, bright, and the one music voice that always wants the echo.
    (bus, t, dur, gain, pitch) => {
      const len = Math.min(dur, 0.14);
      const f = hertz(pitch);
      tone(bus, t, len, 0.3 * gain, 'triangle', f, f, 3200, 0, true);
      return len;
    },
    // lead: square through a lowpass, with a tail.
    (bus, t, dur, gain, pitch) => {
      const len = Math.min(dur, 0.3);
      const f = hertz(pitch);
      tone(bus, t, len, 0.26 * gain, 'square', f, f, 2600, 0, true);
      return len;
    },
    // boss: two detuned saws sweeping a lowpass down over more than a second. It is the only
    // voice with no percussive shape in it on purpose — everything else in the track has a beat
    // to sit against, and the encounter is meant to sound like it does not.
    (bus, t, dur, gain, pitch) => {
      const len = Math.min(Math.max(dur, 0.5), 1.4);
      const f = hertz(pitch);
      tone(bus, t, len, 0.3 * gain, 'sawtooth', f, f * 0.5, 1400, -0.2, true);
      tone(bus, t, len, 0.26 * gain, 'sawtooth', f * 1.01, f * 0.5, 700, 0.2, true);
      return len;
    },
  ];

  // --- the event voices, indexed by `RECIPES` -------------------------------

  /** A gun: a click of noise plus a body, sized by how big the gun is. */
  function gun(peak: number, hiss: number, body: number, tail: number, echo: boolean): VoiceBuilder {
    return (bus, t, _dur, gain) => {
      burst(bus, t, hiss, 0.55 * peak * gain, 'bandpass', 2600, 0.9, 1.6, 0, echo);
      tone(bus, t, tail, 0.5 * peak * gain, 'square', body, body * 0.4, 2200, 0, echo);
      return tail;
    };
  }

  const eventVoices: VoiceBuilder[] = [
    // 0 none: the id a lookup returns when there is nothing to hear.
    () => 0,
    // 1-3 the light gun, the heavy gun, the sniper. One gets longer as the other gets rarer: a
    // gun that fires ten times a second cannot afford a tail, one that fires twice a second can.
    gun(0.5, 0.045, 900, 0.05, false),
    gun(0.8, 0.09, 420, 0.12, false),
    gun(0.95, 0.2, 240, 0.34, true),
    // 4 bowDraw: a released string — a thin descending pluck, no blast.
    (bus, t, _d, gain) => {
      tone(bus, t, 0.09, 0.4 * gain, 'triangle', 1400, 500, 0, 0, false);
      burst(bus, t, 0.05, 0.22 * gain, 'highpass', 3800, 0.7, 2, 0, false);
      return 0.1;
    },
    // 5 flailSwing: a whoosh, bandpassed noise with the centre pushed up and back down.
    (bus, t, _d, gain) => {
      burst(bus, t, 0.22, 0.3 * gain, 'bandpass', 900, 1.4, 0.8, 0, false);
      return 0.22;
    },
    // 6 catapultLob: a creak and a release.
    (bus, t, _d, gain) => {
      tone(bus, t, 0.26, 0.4 * gain, 'sawtooth', 180, 90, 1200, 0, true);
      burst(bus, t, 0.06, 0.3 * gain, 'bandpass', 1500, 1.2, 1.2, 0, false);
      return 0.28;
    },
    // 7 plasmaRepeater: a bright descending blip.
    (bus, t, _d, gain) => {
      tone(bus, t, 0.09, 0.4 * gain, 'square', 2100, 700, 4000, 0, true);
      return 0.09;
    },
    // 8 chainLightning: three crackles a few milliseconds apart, which is what reads as a bolt
    // rather than as a hiss.
    (bus, t, _d, gain) => {
      burst(bus, t, 0.03, 0.4 * gain, 'highpass', 4200, 0.9, 2.4, 0, true);
      burst(bus, t + 0.02, 0.035, 0.3 * gain, 'highpass', 5200, 0.9, 3, 0, true);
      burst(bus, t + 0.05, 0.05, 0.22 * gain, 'highpass', 3400, 0.9, 1.8, 0, true);
      return 0.1;
    },
    // 9 lanceBeam: one segment of a continuous beam. The sim emits a ping every 0.12 s rather
    // than every tick, so a segment has to be about that long or the beam stutters.
    (bus, t, _d, gain) => {
      tone(bus, t, 0.16, 0.3 * gain, 'sawtooth', 640, 640, 3000, 0, true);
      tone(bus, t, 0.16, 0.18 * gain, 'square', 320, 320, 1800, 0, false);
      return 0.16;
    },
    // 10 singularity: a low swell bending down, which is as close as two oscillators get to a
    // vacuum.
    (bus, t, _d, gain) => {
      tone(bus, t, 0.5, 0.45 * gain, 'sine', 160, 40, 400, 0, true);
      burst(bus, t, 0.34, 0.3 * gain, 'bandpass', 600, 2.4, 0.6, 0, true);
      return 0.52;
    },
    // 11 enemyBolt: a hiss, deliberately meaner than the player's guns so a round that lands is
    // audibly not one they fired.
    (bus, t, _d, gain) => {
      burst(bus, t, 0.07, 0.3 * gain, 'bandpass', 1400, 1.6, 1.1, 0, false);
      return 0.07;
    },
    // 12 enemyGrenade: the lob's arc, heard where it was thrown from.
    (bus, t, _d, gain) => {
      burst(bus, t, 0.14, 0.3 * gain, 'bandpass', 1100, 1.8, 0.9, 0, true);
      return 0.14;
    },
    // 13 impact: the tick a round makes on a body. The cheapest voice here and by far the most
    // often asked for, which is why its gap in `sfx.ts` is the tightest.
    (bus, t, _d, gain, pitch) => {
      burst(bus, t, 0.025, 0.3 * gain, 'bandpass', 3100 + pitch * 40, 1.4, 2, 0, false);
      return 0.03;
    },
    // 14 killSmall.
    (bus, t, _d, gain) => {
      burst(bus, t, 0.11, 0.3 * gain, 'lowpass', 1600, 0.9, 1.3, 0, false);
      tone(bus, t, 0.12, 0.22 * gain, 'triangle', 420, 140, 0, 0, false);
      return 0.13;
    },
    // 15 killBig.
    (bus, t, _d, gain) => {
      burst(bus, t, 0.3, 0.45 * gain, 'lowpass', 900, 1.1, 0.7, 0, true);
      tone(bus, t, 0.36, 0.35 * gain, 'sawtooth', 180, 60, 900, 0, true);
      return 0.38;
    },
    // 16 explosion: the whole reason the mix has a limiter.
    (bus, t, _d, gain) => {
      burst(bus, t, 0.5, 0.7 * gain, 'lowpass', 2400, 0.6, 0.8, 0, true);
      tone(bus, t, 0.42, 0.55 * gain, 'sine', 90, 34, 0, 0, true);
      return 0.55;
    },
    // 17 pickup: a ping, pitched by what the drop was worth.
    (bus, t, _d, gain, pitch) => {
      const f = 700 + pitch * 40;
      tone(bus, t, 0.08, 0.24 * gain, 'triangle', f, f + 200, 0, 0, true);
      return 0.09;
    },
    // 18 levelUp: four rising notes. The cards freeze the playfield and the music ducks by then,
    // so this is the one moment the mix is deliberately clear.
    (bus, t, _d, gain) => {
      for (let i = 0; i < 4; i++) {
        const f = hertz(72 + [0, 4, 7, 12][i]);
        tone(bus, t + i * 0.09, 0.24, 0.34 * gain, 'triangle', f, f, 4000, 0, true);
      }
      return 0.6;
    },
    // 19 death: a long descending fall over a low band.
    (bus, t, _d, gain) => {
      tone(bus, t, 1.6, 0.6 * gain, 'sawtooth', 520, 40, 1600, 0, true);
      tone(bus, t, 1.8, 0.4 * gain, 'sine', 70, 30, 0, 0, false);
      return 1.9;
    },
    // 20 hurt: a low thud plus a short noise slap, felt more than heard.
    (bus, t, _d, gain) => {
      tone(bus, t, 0.14, 0.5 * gain, 'sine', 140, 60, 0, 0, false);
      burst(bus, t, 0.06, 0.34 * gain, 'bandpass', 700, 1.1, 0.9, 0, false);
      return 0.15;
    },
    // 21 dash: a whoosh with the centre rising, which is how a dodge reads.
    (bus, t, _d, gain) => {
      burst(bus, t, 0.2, 0.34 * gain, 'bandpass', 1700, 1.2, 1.5, 0, false);
      return 0.21;
    },
    // 22 heal: a soft two-note chime, quiet because a healer pulses often.
    (bus, t, _d, gain) => {
      tone(bus, t, 0.3, 0.2 * gain, 'sine', 520, 520, 0, 0, true);
      tone(bus, t + 0.06, 0.3, 0.16 * gain, 'sine', 660, 660, 0, 0, true);
      return 0.36;
    },
    // 23 warn: a telegraph. Deliberately short and dry — it is a warning, not a sound effect.
    (bus, t, _d, gain, pitch) => {
      tone(bus, t, 0.09, 0.3 * gain, 'square', 1200 + pitch * 10, 800, 2200, 0, false);
      return 0.1;
    },
  ];

  // --- per-frame state, allocated once --------------------------------------

  /** The live sequencer. Swapped when the floor changes (see `retune` in `sequencer.ts`). */
  let seq: Sequencer = createSequencer(songForChapter(0), 0);
  const batch: NoteBatch = createNoteBatch();
  const sfx: SfxState = createSfxState();

  let intensity = 0;
  let slow = 0;
  let budget = frameVoices;
  let lastScene = '';
  let lastMaster = -1;
  let lastSfx = -1;
  let lastMusic = -1;
  let lastMuted = false;
  let alive = true;
  let frames = 0;

  /** The World the last frame was called with, or null before the first call. */
  let seenWorld: AudioView | null = null;

  const report: AudioReport = { music: 0, sfx: 0, refused: 0, budget: frameVoices, intensity: 0 };

  const sink: SfxSink = {
    play(recipe, gain, pan, pitch) {
      if (budget <= 0) return false;
      const build = eventVoices[recipe];
      if (build === undefined) return false;
      const t = graph.currentTime;
      if (!claimSlot(t, 0.25)) {
        report.refused++;
        return false;
      }

      // The voice's stereo position is only known here, at the mixer, so the panner is built
      // first and handed to the builder as the destination. That way one panner covers every layer
      // of a voice (a gun is two sources, a bolt is one), instead of a panner per source, and a
      // sound dead ahead — most of them, since a horde arrives from all sides at once — spends
      // nothing at all.
      let bus: NodeLike = sfxBus;
      if (pan !== 0) {
        const panner = graph.createStereoPanner();
        panner.pan.value = clamp(pan, -1, 1);
        panner.connect(sfxBus);
        bus = panner;
      }

      build(bus, t, 0, gain, pitch);
      report.sfx++;
      budget--;
      return true;
    },
  };

  /**
   * Push a scene change into the duck, and only on a change.
   *
   * Sixty automation calls a second on one param is how a fade turns into a hum, so the scene is
   * remembered rather than re-read. Frozen scenes duck: `levelup` and `summary` hardest, because
   * those are the two screens DESIGN.md wants the music out of; every other non-playing scene
   * (title, menus, pause) gets the gentler cut, which is "the soundtrack is now background".
   */
  function applyDuck(scene: SceneName, t: number): void {
    if (scene === lastScene) return;
    lastScene = scene;
    const target =
      scene === 'playing' ? DUCK_FULL : scene === 'levelup' || scene === 'summary' ? DUCK_CARDS : DUCK_FROZEN;
    duck.gain.setTargetAtTime(target, t, DUCK_TIME / 3);
  }

  /**
   * Push the settings knobs into three gains, when a knob moved.
   *
   * The mute is folded in rather than kept as a fourth gain because `persistence.ts` says what it
   * is: "every gain at zero, kept beside them rather than folded into `master` so turning the
   * sound back up gives the sound that was set".
   */
  function applyLevels(levels: AudioLevels, t: number): void {
    if (
      levels.master === lastMaster &&
      levels.sfx === lastSfx &&
      levels.music === lastMusic &&
      levels.muted === lastMuted
    ) {
      return;
    }
    lastMaster = levels.master;
    lastSfx = levels.sfx;
    lastMusic = levels.music;
    lastMuted = levels.muted;
    const on = levels.muted ? 0 : 1;
    master.gain.setTargetAtTime(on * clamp(levels.master, 0, 1), t, 0.02);
    sfxBus.gain.setTargetAtTime(on * clamp(levels.sfx, 0, 1), t, 0.02);
    musicBus.gain.setTargetAtTime(on * clamp(levels.music, 0, 1), t, 0.02);
  }

  const engine: AudioEngine = {
    get report(): AudioReport {
      return report;
    },
    get alive(): boolean {
      return alive;
    },

    frame(world: AudioView, scene: SceneName, dt: number, levels: AudioLevels): void {
      if (!alive) return;

      report.music = 0;
      report.sfx = 0;
      report.refused = 0;

      try {
        // The clock is read inside the guard, so "the engine never throws at its caller" is true
        // rather than nearly true: the app calls this once a frame and has no room to make a
        // judgement call sixty times a second about whether a broken sound device is worth the
        // run's error budget.
        const t = graph.currentTime;

        // A new World is a new run: forget the event cursor, the voice slots and the arrangement.
        // `resetSfx` puts the cursor at the *end* of the new ring, which is also what stops a
        // loaded save from replaying the seconds it was saved with.
        if (world !== seenWorld) {
          seenWorld = world;
          resetSfx(sfx, world);
          slots.fill(0);
          intensity = 0;
          slow = 0;
          seq = createSequencer(songForChapter(world.chapter), t);
        }

        // Autoplay policy: a context starts suspended and only a gesture lets it run, so the
        // first thing every frame does is knock — at a distance, so a locked context costs one
        // call a second rather than one a frame.
        frames++;
        if (graph.state !== undefined && graph.state !== 'running' && frames % RESUME_TRIES_EVERY === 1) {
          graph.resume?.();
        }

        applyLevels(levels, t);
        applyDuck(scene, t);

        // The arrangement: bodies on the floor plus the encounter, with hysteresis.
        intensity = nextIntensity(intensity, world.enemies.count, world.boss.alive);
        report.intensity = intensity;

        // The frame's voice budget, from the frame times most recently spent. Measured rather
        // than tiered, so a machine that is fine with a thousand bodies keeps its full mix and one
        // that is not gets out of the way without anyone opening a settings screen.
        slow = slow * (1 - SLOWING) + Math.min(dt, 0.25) * SLOWING;
        budget = slow > SLOW_FROM ? 2 : slow > SLOW_BACK ? 5 : frameVoices;
        report.budget = budget;

        // Music, first: it is the part that has to be early, since a late note is a wrong note.
        const tuned = retune(seq, songForChapter(world.chapter), t);
        if (tuned !== seq) seq = tuned;

        if (budget > 0) {
          scheduleNotes(seq, t + LOOK_AHEAD, intensity, world.boss.alive, batch);
          for (let i = 0; i < batch.count; i++) {
            if (budget <= 0) {
              report.refused++;
              continue;
            }
            const voice = musicVoices[batch.voice[i]];
            if (voice === undefined) continue;
            // A note whose time has already gone by is played immediately rather than dropped: it
            // is still the right note, only late, and `CATCH_UP` has already thrown away anything
            // too old to be worth hearing.
            const at = Math.max(batch.time[i], t);
            const dur = batch.dur[i];
            if (!claimSlot(at, dur + 0.05)) {
              report.refused++;
              continue;
            }
            voice(musicBus, at, dur, batch.gain[i], batch.pitch[i]);
            report.music++;
            budget--;
          }
        }

        // Gunfire: the events written since the last frame, budget and gaps permitting. The mixer
        // and the sink share one budget, which is why `sfx.budget` is loaded and read back.
        sfx.now = t;
        sfx.budget = budget;
        drainSfx(world, sink, sfx);
      } catch (error) {
        // One report, then quiet. A synth that threw every frame would spend the run's whole
        // error budget on the first bad note, and the run would still be unplayable.
        alive = false;
        if (note !== undefined) note(`audio: ${String(error)}`);
      }
    },
  };

  return engine;
}
