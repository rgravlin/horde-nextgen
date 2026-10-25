/**
 * The fixed-step clock: how a wall-clock animation frame turns into 0..5 sim
 * ticks and one interpolation alpha (TECH.md "Simulation and rendering").
 *
 * It lives apart from the renderer and the app for one reason: those need a
 * browser, and this is the part with invariants worth pinning down in a unit test.
 * Gameplay time is only ever counted in 1/60 s slices — a long frame runs more
 * ticks, never bigger ones — and time that cannot be paid for inside the step cap
 * is thrown away rather than banked, so returning to a backgrounded tab does not
 * fast-forward a run into a wall of enemies.
 */

import { DT } from '../sim/world';

/** Ticks a single frame may run: five at 60 Hz is 83 ms of catch-up. */
export const MAX_STEPS = 5;

/** Longest gap between frames that still counts as play, in seconds. */
export const MAX_FRAME = 0.25;

export interface Clock {
  /** Play time banked but not yet stepped, in seconds. Always below `DT`. */
  acc: number;
  /** Timestamp in ms of the previous frame, -1 before the first one. */
  last: number;
}

export function createClock(): Clock {
  return { acc: 0, last: -1 };
}

/** What one frame did; `runFrame` fills the caller's copy so nothing allocates. */
export interface FrameReport {
  /** Ticks stepped this frame. */
  steps: number;
  /** Interpolation point inside the next tick, 0..1, for the renderer. */
  alpha: number;
  /** Real seconds since the previous frame, capped at MAX_FRAME. */
  dt: number;
  /** Play time discarded by the step cap, in seconds. */
  dropped: number;
}

export function createFrameReport(): FrameReport {
  return { steps: 0, alpha: 0, dt: 0, dropped: 0 };
}

/**
 * Run the ticks a frame is owed, writing its summary into `out`.
 *
 * `frozen` is the pause: the accumulator is cleared rather than held, because a
 * pause that banks time hands it back as a burst the moment play resumes.
 */
export function runFrame(
  clock: Clock,
  nowMs: number,
  frozen: boolean,
  step: () => void,
  out: FrameReport,
): FrameReport {
  const dt = clock.last < 0 ? 0 : (nowMs - clock.last) / 1000;
  clock.last = nowMs;

  // Capped, so a two-second stall costs two seconds of skipped game rather than
  // two seconds of instant death.
  const elapsed = dt > MAX_FRAME ? MAX_FRAME : dt > 0 ? dt : 0;

  out.dt = elapsed;
  out.dropped = 0;
  out.steps = 0;

  if (frozen) {
    clock.acc = 0;
    out.alpha = 0;
    return out;
  }

  clock.acc += elapsed;

  while (clock.acc >= DT && out.steps < MAX_STEPS) {
    step();
    clock.acc -= DT;
    out.steps++;
  }

  if (out.steps === MAX_STEPS && clock.acc > 0) {
    out.dropped = clock.acc;
    clock.acc = 0;
  }

  out.alpha = clock.acc / DT;
  return out;
}
