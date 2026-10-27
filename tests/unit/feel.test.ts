import { describe, expect, it } from 'vitest';

import { PerspectiveCamera, Scene } from 'three/webgpu';

import { createPost, PUNCH_TIME } from '../../src/render/post';
import { profileFor } from '../../src/render/quality';
import { DECAY, DEFAULT_SCALE, MAX_TRAUMA, SHAKE_GAIN, createShake, shakeOffset } from '../../src/render/shake';

/**
 * The frame's two reactions to a big hit: the camera's trauma and the post chain's punch.
 *
 * They were cut out of `quality.test.ts` when that file grew past what one can read at once;
 * nothing here changed, only where it lives. Both are read-only cosmetics (ARCHITECTURE.md
 * invariant 4), so the two things worth pinning are that the maths is the maths DESIGN.md names —
 * trauma², the 120 ms punch, the 0.7 default — and that a chain which throws takes itself out
 * instead of taking the frame with it.
 *
 * `shakeOffset`'s expected values come out of the formula in DESIGN.md rather than from what the
 * code happens to produce, which is the only way a wrong constant in that formula is caught
 * rather than blessed.
 */

// ---------------------------------------------------------------------------
// shake
// ---------------------------------------------------------------------------

describe('camera trauma', () => {
  it('scales with the square of the trauma', () => {
    // DESIGN.md's "trauma²": at half trauma the travel is a quarter, which is what makes a jolt
    // read as a shove that settles rather than as a dimmer fading out.
    expect(shakeOffset(1, 1)).toBeCloseTo(SHAKE_GAIN, 10);
    expect(shakeOffset(0.5, 1)).toBeCloseTo(SHAKE_GAIN * 0.25, 10);
    expect(shakeOffset(0.5, 1)).toBeLessThan(shakeOffset(1, 1) / 2);
  });

  it('lands at 0.35 × 0.7 at full trauma and the default scale', () => {
    // The number the design brief names, worked out here rather than read off the code.
    expect(DEFAULT_SCALE).toBe(0.7);
    expect(shakeOffset(1, DEFAULT_SCALE)).toBeCloseTo(0.35 * 0.7, 10);
  });

  it('clamps trauma and scale instead of trusting its callers', () => {
    expect(shakeOffset(5, 5)).toBeCloseTo(SHAKE_GAIN, 10);
    expect(shakeOffset(-1, 1)).toBe(0);
    expect(shakeOffset(1, 0)).toBe(0);
  });

  it('spends a full jolt in about two thirds of a second', () => {
    const rig = createShake();
    rig.addTrauma(MAX_TRAUMA);
    // Half the decay time still has a third of the trauma left, so the rate is pinned and not
    // merely "it stops eventually"; 45 frames of 1/60 is past the 0.667 s the cap takes.
    for (let i = 0; i < 20; i++) rig.update(1 / 60);
    expect(rig.trauma).toBeGreaterThan(1 / 3);
    expect(rig.trauma).toBeCloseTo(1 - DECAY * (20 / 60), 6);
    for (let i = 20; i < 45; i++) rig.update(1 / 60);
    expect(rig.trauma).toBe(0);
  });

  it('never lets a burst stack past the cap, and never decays below zero', () => {
    const rig = createShake();
    rig.addTrauma(0.7);
    rig.addTrauma(0.7);
    rig.addTrauma(0.7);
    expect(rig.trauma).toBe(MAX_TRAUMA);

    // Three bolts in one tick are one big shake, not three, and a long quiet run has to settle
    // at exactly zero rather than drift negative.
    for (let i = 0; i < 600; i++) {
      rig.update(1 / 60);
      expect(rig.trauma).toBeGreaterThanOrEqual(0);
    }
  });

  it('ignores a jolt that is not a jolt', () => {
    const rig = createShake();
    rig.addTrauma(0);
    rig.addTrauma(-0.5);
    rig.addTrauma(Number.NaN);
    expect(rig.trauma).toBe(0);
  });

  it('keeps the offset inside its own envelope', () => {
    const rig = createShake();
    rig.addTrauma(MAX_TRAUMA);
    const at = { x: 0, z: 0 };
    for (let i = 0; i < 120; i++) {
      rig.peek(at);
      const limit = shakeOffset(rig.trauma, DEFAULT_SCALE);
      // The noise walks between -1 and 1 on each axis, so no axis may exceed the amplitude.
      expect(Math.abs(at.x)).toBeLessThanOrEqual(limit + 1e-9);
      expect(Math.abs(at.z)).toBeLessThanOrEqual(limit + 1e-9);
      rig.update(1 / 60);
    }
  });

  it('writes zeros when the player turns shake off', () => {
    const rig = createShake();
    const at = { x: 99, z: 99 };
    rig.setScale(0);
    rig.addTrauma(MAX_TRAUMA);
    rig.peek(at);
    expect(at).toEqual({ x: 0, z: 0 });
  });

  it('is the same shake for the same run', () => {
    // The noise is a hash of a step counter rather than `Math.random`, so a replay's camera
    // moves the way the run that was played did — which is what lets a scenario be replayed.
    const trace = (seedScale: number): number[] => {
      const rig = createShake(seedScale);
      rig.addTrauma(0.8);
      const out: number[] = [];
      for (let i = 0; i < 40; i++) {
        const at = { x: 0, z: 0 };
        rig.peek(at);
        out.push(at.x, at.z);
        rig.update(1 / 60);
      }
      return out;
    };
    const a = trace(0.7);
    const b = trace(0.7);
    expect(a).toEqual(b);
    // And the rig actually moves: a rig pinned to one number would pass the equality above.
    expect(new Set(a.map((v) => v.toFixed(4))).size).toBeGreaterThan(2);
    expect(Math.max(...a.map(Math.abs))).toBeGreaterThan(0);
  });

  it('decays nothing on a frame that ran no steps', () => {
    // The renderer hands `update(0)` on a held frame (the pause, the level-up freeze), so a
    // paused screen holds its camera still instead of quietly settling it.
    const rig = createShake();
    rig.addTrauma(0.6);
    const before = { x: 0, z: 0 };
    rig.peek(before);
    for (let i = 0; i < 30; i++) rig.update(0);
    const after = { x: 0, z: 0 };
    rig.peek(after);
    expect(rig.trauma).toBeCloseTo(0.6, 10);
    expect(after).toEqual(before);
  });

  it('takes a settings change mid-run', () => {
    const rig = createShake();
    rig.addTrauma(1);
    const loud = { x: 0, z: 0 };
    rig.peek(loud);
    rig.setScale(0);
    const quiet = { x: 0, z: 0 };
    rig.peek(quiet);
    expect(Math.hypot(loud.x, loud.z)).toBeGreaterThan(0);
    expect(quiet).toEqual({ x: 0, z: 0 });
  });
});

// ---------------------------------------------------------------------------
// post chain
// ---------------------------------------------------------------------------

/** Something shaped like a renderer and about as useful as one: the chain must cope anyway. */
const brokenRenderer = {} as never;

describe('the post chain', () => {
  const camera = new PerspectiveCamera(40, 16 / 9, 0.1, 200);

  it('builds nothing at Low, and says so', () => {
    // Low is not a failure: no bloom and no chroma is the tier doing its job, and the caller
    // learns to draw plain because `render` answers false.
    const chain = createPost(brokenRenderer, new Scene(), camera, profileFor('low'));
    expect(chain.active).toBe(false);
    expect(chain.label).toBe('none');
    expect(chain.render()).toBe(false);
    // The punch and the decay have to be safe no-ops on a chain that does not exist.
    chain.punch(0.01);
    chain.update(1 / 60);
    expect(chain.render()).toBe(false);
  });

  it('builds the chain on the tiers that pay for it', () => {
    const high = createPost(brokenRenderer, new Scene(), camera, profileFor('high'));
    expect(high.active).toBe(true);
    expect(high.label).toBe('bloom+chroma');
  });

  it('takes itself out after one frame that threw', () => {
    // The guard ARCHITECTURE.md invariant 4 asks for: a GPU path that fails has to lose the
    // effect and keep the game, and the caller has to be able to tell.
    const chain = createPost(brokenRenderer, new Scene(), camera, profileFor('high'));
    expect(chain.render()).toBe(false);
    expect(chain.active).toBe(false);
    expect(chain.render()).toBe(false);
    chain.disable();
    expect(chain.active).toBe(false);
  });

  it('keeps the punch to the 120 ms the design names', () => {
    // The length is the design decision (DESIGN.md: "a chromatic aberration punch of about
    // 120 ms on big hits"), so it is pinned as a constant; the fall itself moves a uniform and
    // is checked by the browser scenario.
    expect(PUNCH_TIME).toBeCloseTo(0.12, 6);
    const chain = createPost(brokenRenderer, new Scene(), camera, profileFor('high'));
    // A punch taken before the first frame must not throw, and must not keep the chain alive.
    chain.punch(0.016);
    chain.update(1);
    expect(chain.render()).toBe(false);
  });
});