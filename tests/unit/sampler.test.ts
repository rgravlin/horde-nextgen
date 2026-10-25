import { describe, expect, it } from 'vitest';

import { InputSampler, type InputEventLike, type InputHost } from '../../src/input/sampler';
import { createInputFrame } from '../../src/sim/input';

/**
 * The input sampler (ARCHITECTURE.md "Input"). Handlers only set bits; `sample`
 * turns held state into one InputFrame and `takeCommands` drains the scene-level
 * one-shots. A fake host stands in for `window`, so these invariants hold without a
 * browser — and the sampler never mutates game state, only the frame.
 */

/** A host that records listeners and lets a test raise events against them. */
class FakeHost implements InputHost {
  private readonly listeners = new Map<string, Array<(e: InputEventLike) => void>>();

  addEventListener(type: string, listener: (e: InputEventLike) => void): void {
    const list = this.listeners.get(type);
    if (list) list.push(listener);
    else this.listeners.set(type, [listener]);
  }

  removeEventListener(type: string, listener: (e: InputEventLike) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
  }

  raise(type: string, e: InputEventLike): void {
    for (const listener of this.listeners.get(type) ?? []) listener(e);
  }
}

function makeSampler(project?: (x: number, y: number, out: { x: number; y: number }) => boolean) {
  const host = new FakeHost();
  const sampler = new InputSampler({ host, player: () => ({ x: 0, y: 0 }), project });
  return { host, sampler };
}

describe('input sampler', () => {
  it('maps a held move key to a frame axis while it is down', () => {
    const { host, sampler } = makeSampler();
    const frame = createInputFrame();

    host.raise('keydown', { code: 'KeyD' });
    sampler.sample(frame);
    expect(frame.moveX).toBe(1);
    expect(frame.moveY).toBe(0);

    host.raise('keyup', { code: 'KeyD' });
    sampler.sample(frame);
    expect(frame.moveX).toBe(0);
  });

  it('sums two held move keys for a diagonal, and normalises nothing (that is the sim)', () => {
    const { host, sampler } = makeSampler();
    const frame = createInputFrame();
    host.raise('keydown', { code: 'KeyD' });
    host.raise('keydown', { code: 'KeyW' });
    sampler.sample(frame);
    expect(frame.moveX).toBe(1);
    expect(frame.moveY).toBe(1);
  });

  it('keeps dash on every tick while Space is held', () => {
    const { host, sampler } = makeSampler();
    const frame = createInputFrame();
    host.raise('keydown', { code: 'Space' });
    sampler.sample(frame);
    expect(frame.dash).toBe(true);
    sampler.sample(frame);
    expect(frame.dash).toBe(true);
    host.raise('keyup', { code: 'Space' });
    sampler.sample(frame);
    expect(frame.dash).toBe(false);
  });

  it('reads fire from the primary pointer button only', () => {
    const { host, sampler } = makeSampler();
    const frame = createInputFrame();
    host.raise('pointerdown', { button: 2 });
    sampler.sample(frame);
    expect(frame.fire).toBe(false);
    host.raise('pointerdown', { button: 0 });
    sampler.sample(frame);
    expect(frame.fire).toBe(true);
    host.raise('pointerup', { button: 0 });
    sampler.sample(frame);
    expect(frame.fire).toBe(false);
  });

  it('reports a card pick once, then clears the latch', () => {
    const { host, sampler } = makeSampler();
    const frame = createInputFrame();
    host.raise('keydown', { code: 'Digit1' });
    sampler.sample(frame);
    expect(frame.pick).toBe(1);
    sampler.sample(frame);
    expect(frame.pick).toBe(0);
  });

  it('swaps on Q or the wheel, one intent per read', () => {
    const { host, sampler } = makeSampler();
    const frame = createInputFrame();
    host.raise('keydown', { code: 'KeyQ' });
    sampler.sample(frame);
    expect(frame.swap).toBe(true);
    sampler.sample(frame);
    expect(frame.swap).toBe(false);
    host.raise('wheel', { deltaY: 1 });
    sampler.sample(frame);
    expect(frame.swap).toBe(true);
  });

  it('drains scene-level commands once and separates them from held state', () => {
    const { host, sampler } = makeSampler();
    const cmds = { pause: false, accept: false, reroll: false };
    host.raise('keydown', { code: 'Escape' });
    expect(sampler.takeCommands(cmds).pause).toBe(true);
    expect(sampler.takeCommands(cmds).pause).toBe(false);
    host.raise('keydown', { code: 'Enter' });
    expect(sampler.takeCommands(cmds).accept).toBe(true);
    host.raise('keydown', { code: 'KeyR' });
    expect(sampler.takeCommands(cmds).reroll).toBe(true);
  });

  it('aims along the ray to the projected ground point', () => {
    // Pointer over the +y side of the floor: aim should come out as (0, 1).
    const { host, sampler } = makeSampler((_x, _y, out) => {
      out.x = 0;
      out.y = 5;
      return true;
    });
    const frame = createInputFrame();
    host.raise('mousemove', { clientX: 100, clientY: 100 });
    sampler.sample(frame);
    expect(frame.aimX).toBeCloseTo(0, 6);
    expect(frame.aimY).toBeCloseTo(1, 6);
  });

  it('keeps the last aim when the pointer leaves the floor', () => {
    let grounded = true;
    const { host, sampler } = makeSampler((_x, _y, out) => {
      if (!grounded) return false;
      out.x = 5;
      out.y = 0;
      return true;
    });
    const frame = createInputFrame();
    host.raise('mousemove', { clientX: 100, clientY: 100 });
    sampler.sample(frame);
    expect(frame.aimX).toBeCloseTo(1, 6);
    grounded = false;
    sampler.sample(frame);
    expect(frame.aimX).toBeCloseTo(1, 6);
  });

  it('releases every key when the window loses focus', () => {
    const { host, sampler } = makeSampler();
    const frame = createInputFrame();
    host.raise('keydown', { code: 'KeyD' });
    host.raise('blur', {});
    sampler.sample(frame);
    expect(frame.moveX).toBe(0);
  });
});