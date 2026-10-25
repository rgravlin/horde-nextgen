import { describe, expect, it } from 'vitest';

import { createClock, createFrameReport, runFrame, MAX_STEPS, MAX_FRAME } from '../../src/game/loop';
import { DT } from '../../src/sim/world';

/**
 * The fixed-step accumulator (TECH.md "Simulation and rendering"). It is the one
 * piece of the browser loop that has invariants worth pinning without a browser:
 * gameplay time advances only in 1/60 s slices, a long frame runs more steps rather
 * than bigger ones, and time beyond the per-frame cap is dropped, not banked.
 *
 * Timings sit a clear half-tick away from a step boundary so the counts never hinge
 * on floating-point rounding.
 */

/** One clock, primed with a first frame at t = 0 (which runs no steps). */
function primedClock(): ReturnType<typeof createClock> {
  const clock = createClock();
  runFrame(clock, 0, false, () => {}, createFrameReport());
  return clock;
}

describe('fixed-step clock', () => {
  it('runs no steps on the very first frame (no elapsed time yet)', () => {
    const clock = createClock();
    const report = createFrameReport();
    runFrame(clock, 0, false, () => {}, report);
    expect(report.steps).toBe(0);
    expect(clock.acc).toBe(0);
  });

  it('runs one step for one and a half ticks and leaves a sub-tick remainder', () => {
    const clock = primedClock();
    const report = createFrameReport();
    // 25 ms is one and a half ticks: one step, then a half-tick of alpha left over.
    runFrame(clock, 25, false, () => {}, report);
    expect(report.steps).toBe(1);
    expect(report.alpha).toBeGreaterThan(0);
    expect(report.alpha).toBeLessThan(1);
    expect(clock.acc).toBeLessThan(DT);
  });

  it('caps at MAX_STEPS and drops the rest rather than banking a burst', () => {
    const clock = primedClock();
    const report = createFrameReport();
    // A one-second stall is far past the cap of five steps.
    runFrame(clock, 1000, false, () => {}, report);
    expect(report.steps).toBe(MAX_STEPS);
    expect(report.dropped).toBeGreaterThan(0);
    // The unspent time is gone, so the next frame does not inherit the backlog.
    expect(clock.acc).toBe(0);
  });

  it('clamps a giant frame to MAX_FRAME of play time', () => {
    const clock = primedClock();
    const report = createFrameReport();
    runFrame(clock, 60_000, false, () => {}, report);
    expect(report.dt).toBeCloseTo(MAX_FRAME, 6);
    expect(report.steps).toBe(MAX_STEPS);
  });

  it('freezes: a paused frame runs no steps and clears the banked time', () => {
    const clock = primedClock();
    const warm = createFrameReport();
    // Bank a little time on a short play frame...
    runFrame(clock, 25, false, () => {}, warm);
    expect(clock.acc).toBeGreaterThan(0);

    // ...then a frozen frame must run nothing and throw the bank away.
    let stepped = 0;
    const report = createFrameReport();
    runFrame(clock, 1000, true, () => stepped++, report);
    expect(stepped).toBe(0);
    expect(report.steps).toBe(0);
    expect(clock.acc).toBe(0);
    expect(report.alpha).toBe(0);
  });

  it('advances the same number of steps for the same elapsed time', () => {
    // Two clocks with identical frame timings must produce identical step counts —
    // the property a run's determinism across a browser session rests on.
    const frames = [0, 25, 50, 70, 100, 140];
    const a = runSequence(primedClock(), frames);
    const b = runSequence(primedClock(), frames);
    expect(a).toEqual(b);
    expect(a.reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
  });
});

function runSequence(clock: ReturnType<typeof createClock>, times: number[]): number[] {
  const steps: number[] = [];
  for (const t of times) {
    const report = createFrameReport();
    runFrame(clock, t, false, () => {}, report);
    steps.push(report.steps);
  }
  return steps;
}