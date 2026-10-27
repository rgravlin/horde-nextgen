/**
 * Headless replay: a run's input, recorded and played back.
 *
 * A replay is a *recipe* rather than a snapshot. It carries the seed, the chapter the run was
 * played in and one packed frame code per tick plus its aim pair and aim distance, and
 * `playReplay` rebuilds the run from the start by handing that input to `step`. That is what
 * keeps it a few tens of kilobytes for a whole chapter instead of a megabyte, and it is only
 * possible because the sim has no other input: no clock, no `Math.random`, no DOM
 * (ARCHITECTURE.md "Data flow"). A save says *what was*; a replay says *how it happened*, which
 * is the thing you want when a divergence needs hunting — replay a recorded run against a
 * changed build and `hashWorld` names the tick it stopped matching.
 *
 * **Why the aim numbers travel beside the packed code.** `input.ts` packs a tick into one Uint32,
 * and that is exact for the frames the sampler can raise from keys: it only ever writes `-1`,
 * `0` or `1` into the move pair, and the rest are flags. Aim is not like that — the sampler
 * projects the pointer onto the floor plane and normalises, which lands on an arbitrary
 * double — and aim is read by the player's facing, by every shot's direction and by the drone's
 * target choice, so a run replayed from the packed bits alone is a run fired a few micrometres
 * off each tick. Measured, that is not a rounding argument: a six-hundred-tick run with
 * pointer-derived aim ends on a different fingerprint when its aim is rebuilt from the bits.
 * The aim *distance* has no bits either — the word is already full — and it is not a rounding
 * argument at all: it decides where a lob burst lands, so a file without it would replay the
 * throw somewhere else. So the code carries what the channel was designed for and the doubles
 * carry the rest, which is the split `input.ts` itself names ("anything needing frame-exact
 * analogue input records the floats instead"). They stay doubles in the file rather than float
 * bits for the same reason: JSON round-trips a JS number exactly, and 32 bits would lose the
 * thing they are there to keep.
 *
 * **What is recorded is what was played.** `recordFrame` stores the frame as it went into
 * `step`, so `frameAt` gives that frame back and a run driven from a log reproduces itself
 * tick for tick. The alternative — record raw, play decoded — silently changes the run the
 * moment anyone feeds the log a frame the sampler could not have produced.
 *
 * Auto-fire travels in the file for the same reason the frames do: it decides whether the sim
 * shoots with no `fire` bit behind it, so a run recorded with it on cannot be replayed with it
 * off. Those are two runs, not one run played twice.
 *
 * A replay assumes the pool sizes `createWorld` gives a world by default, because a full pool
 * is a dropped body and the file has no room to say how full the pools were. The game always
 * runs at those sizes; a test that shrinks them has to record the sizes too, or record a
 * shorter run.
 */

import { createInputFrame, packFrame, unpackFrame, type InputFrame } from './input';
import { decodeBlob, encodeBlob } from './serialize';
import { step } from './step';
import { startChapter } from './systems/levels';
import { createWorld, type World } from './world';

/** The one replay shape this build writes, and the only one it reads. */
export const REPLAY_VERSION = 'v2';

/**
 * A run's input, in the form you record into.
 *
 * Flat lists rather than one object per tick: a chapter is several thousand ticks, and the
 * reason this file exists at all is to be cheap enough to keep.
 */
export interface FrameLog {
  /** What the run was seeded with; the whole fight follows from it. */
  seed: number;
  /** Whose chapter's floor it was played on, or null for the bare arena. */
  chapter: number | null;
  /** Whether the run let the sim fire on its own. */
  autoFire: boolean;
  /** One packed frame code per tick (`packFrame`'s output). */
  codes: number[];
  /** Aim x and y per tick, two entries per tick, at full precision. */
  aim: number[];
  /**
   * Aim distance per tick, in metres — the third aim number, which has no bits to live
   * in (`packFrame`'s word is full), so it rides here beside the pair.
   *
   * It decides where a lob burst lands, so leaving it out of the file would make a
   * replay of a catapult run a different fight from the run.
   */
  lob: number[];
}

/** The file form of a run: the same three lists, one packed and two plain. */
export interface Replay {
  v: string;
  seed: number;
  chapter: number | null;
  autoFire: boolean;
  /** How many ticks the run lasts, which is how many codes the file carries. */
  ticks: number;
  /** The packed frame codes, twelve bytes of the following blob's first four per tick. */
  codes: string;
  /** The aim pairs, two doubles per tick, exact. */
  aim: number[];
  /** The aim distances, one double per tick, in metres. */
  lob: number[];
}

/** Begin recording. The chapter is part of the recipe, so it has to be known at the start. */
export function createLog(seed: number, chapter: number | null, autoFire = false): FrameLog {
  return { seed, chapter, autoFire, codes: [], aim: [], lob: [] };
}

/** Record one tick. Call it with the same frame you are about to hand to `step`. */
export function recordFrame(log: FrameLog, frame: InputFrame): void {
  log.codes.push(packFrame(frame));
  log.aim.push(frame.aimX, frame.aimY);
  log.lob.push(frame.aimDist);
}

/**
 * Read tick `at` back into `out`.
 *
 * Staying inside the log is the caller's business, as it is everywhere the project indexes a
 * pool: `playReplay` walks the length, and a test that wants a prefix takes a slice.
 */
export function frameAt(log: FrameLog, at: number, out: InputFrame): InputFrame {
  unpackFrame(log.codes[at], out);
  out.aimX = log.aim[at * 2];
  out.aimY = log.aim[at * 2 + 1];
  out.aimDist = log.lob[at];
  return out;
}

/** Write it out. Every value in the result is plain JSON. */
export function writeReplay(log: FrameLog): Replay {
  return {
    v: REPLAY_VERSION,
    seed: log.seed,
    chapter: log.chapter,
    autoFire: log.autoFire,
    ticks: log.codes.length,
    codes: encodeBlob([Uint32Array.from(log.codes)]),
    aim: log.aim.slice(),
    lob: log.lob.slice(),
  };
}

/**
 * Read a replay back, or null if what was handed over is not one.
 *
 * The shape is checked rather than trusted, including the one thing a truncated file breaks:
 * `codes` has to decode to exactly four bytes a tick, `aim` to two doubles and `lob` to one,
 * because a log that lost its tail would otherwise play a shorter run and look like it worked.
 * A v1 file (no `lob`) is read as no replay rather than played with the aim distance missing:
 * the files this build writes carry it, and a replay that quietly lobs further than the run did
 * is a replay of a different fight.
 */
export function readReplay(data: unknown): FrameLog | null {
  if (typeof data !== 'object' || data === null) return null;
  const file = data as Record<string, unknown>;
  if (file.v !== REPLAY_VERSION) return null;
  if (typeof file.seed !== 'number' || !Number.isFinite(file.seed)) return null;
  if (typeof file.autoFire !== 'boolean') return null;

  const chapter = file.chapter;
  if (chapter !== null) {
    if (!Number.isInteger(chapter) || (chapter as number) < 0) return null;
  }
  if (!Number.isInteger(file.ticks) || (file.ticks as number) < 0) return null;
  if (typeof file.codes !== 'string' || !Array.isArray(file.aim) || !Array.isArray(file.lob)) return null;

  const ticks = file.ticks as number;
  if (file.aim.length !== ticks * 2 || file.lob.length !== ticks) return null;
  for (const v of file.aim) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  for (const v of file.lob) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }

  const codes = new Uint32Array(ticks);
  if (!decodeBlob(file.codes, [codes])) return null;

  return {
    seed: file.seed as number,
    chapter: chapter === null ? null : (chapter as number),
    autoFire: file.autoFire as boolean,
    codes: Array.from(codes),
    aim: file.aim.slice() as number[],
    lob: file.lob.slice() as number[],
  };
}

/**
 * Play a recorded run to the end and hand back the world it reached.
 *
 * The world is built the way a run always starts — seeded, then given its chapter's floor —
 * and then stepped once per recorded tick. Nothing here reads a clock: the caller decides
 * whether that happens in a test, at the bench, or while somebody watches.
 */
export function playReplay(log: FrameLog): World {
  const w = createWorld(log.seed);
  w.autoFire = log.autoFire;
  if (log.chapter !== null) startChapter(w, log.chapter);

  const frame = createInputFrame();
  for (let i = 0; i < log.codes.length; i++) {
    step(w, frameAt(log, i, frame));
  }
  return w;
}