import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/game/app';
import { GamepadReader, PAD_DEAD, type PadLike, type PadSource } from '../../src/input/gamepad';
import { InputSampler, type InputEventLike, type InputHost } from '../../src/input/sampler';
import { createInputFrame, packFrame, resetFrame, unpackFrame, type InputFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { awardXp, xpForLevel } from '../../src/sim/systems/pickups';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { createWorld, type World } from '../../src/sim/world';

/**
 * The gamepad half of the input layer (TECH.md "Input"): two sticks, six buttons and one
 * screen-dependent meaning for the face buttons, read off a device that reports held state rather
 * than events.
 *
 * Everything here runs against a plain object shaped like a `Gamepad`, which is why `PadLike`
 * exists — the real thing satisfies it, so a test needs neither a browser nor a controller. The
 * stick numbers are the *device's*: `axes[1]` and `axes[3]` point down the stick while the world's
 * +y runs north, so a stick pushed up has to come out as a positive `moveY`.
 */

/** The standard layout's seventeen buttons, pressed at each listed index. */
function buttons(pressed: readonly number[] = []): Array<{ pressed: boolean }> {
  const out: Array<{ pressed: boolean }> = [];
  for (let i = 0; i < 17; i++) out.push({ pressed: pressed.includes(i) });
  return out;
}

/** One standard-mapping pad: the four stick axes, then the buttons. */
function pad(
  sticks: readonly [number, number, number, number],
  pressed: readonly number[] = [],
  id = 'pad-a',
): PadLike {
  return { connected: true, mapping: 'standard', id, axes: [...sticks], buttons: buttons(pressed) };
}

/** The same device described again, which is what a polling browser hands over each frame. */
function snapshotOf(source: PadLike): PadLike {
  return {
    connected: source.connected,
    mapping: source.mapping,
    id: source.id,
    axes: source.axes == null ? undefined : Array.from(source.axes),
    buttons:
      source.buttons == null
        ? undefined
        : Array.from(source.buttons, (button) => ({ pressed: button?.pressed === true })),
  };
}

/** A pad list a test can rewrite between frames. */
function rig(...pads: readonly (PadLike | null | undefined)[]) {
  let list: readonly (PadLike | null | undefined)[] = pads;
  return {
    poll(): readonly (PadLike | null | undefined)[] {
      return list;
    },
    set(...next: readonly (PadLike | null | undefined)[]): void {
      list = next;
    },
  };
}

/** One frame off `reader`, with the command bits left beside it rather than inside the frame. */
function read(
  reader: GamepadReader,
  frame = createInputFrame(),
  layout: 'play' | 'cards' = 'play',
): InputFrame {
  reader.read(layout, frame, { pause: false, accept: false, reroll: false });
  return frame;
}

/** One frame off `reader`, keeping only the scene-level bits. */
function commands(reader: GamepadReader, layout: 'play' | 'cards' = 'play') {
  const cmds = { pause: false, accept: false, reroll: false };
  reader.read(layout, createInputFrame(), cmds);
  return cmds;
}

function length(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

describe('gamepad sticks', () => {
  it('moves with the left stick, and a stick pushed up means north', () => {
    const reader = new GamepadReader({ pads: () => [pad([-0.5, -0.5, 0, 0])] });
    const frame = read(reader);

    // Pushed up and left, so the frame has to come out up and left: the device's +y runs down the
    // stick and the world's +y runs north.
    expect(frame.moveX).toBeCloseTo(-0.4482, 4);
    expect(frame.moveY).toBeCloseTo(0.4482, 4);
  });

  it('dead-zones a stick by length, not per axis', () => {
    expect(PAD_DEAD).toBe(0.2);

    // A diagonal nudge: each axis is under 0.2 while the stick's own length is not, and the zone
    // is a circle, so this one counts as steering.
    const nudge = new GamepadReader({ pads: () => [pad([0.19, 0.19, 0.19, 0.19])] });
    const nudged = read(nudge);
    expect(length(nudged.moveX, nudged.moveY)).toBeGreaterThan(0);

    const resting = new GamepadReader({ pads: () => [pad([0.1, 0.1, 0.1, 0.1])] });
    const frame = createInputFrame();
    frame.aimY = 1;
    read(resting, frame);

    expect(frame.moveX).toBe(0);
    expect(frame.moveY).toBe(0);
    expect(frame.aimX).toBe(0);
    expect(frame.aimY).toBe(1);
    expect(frame.fire).toBe(false);
  });

  it('rescales from zero past the dead zone, so a full push is still a full speed', () => {
    const half = new GamepadReader({ pads: () => [pad([0.5, 0, 0, 0])] });
    expect(read(half).moveX).toBeCloseTo((0.5 - 0.2) / 0.8, 6);

    const full = new GamepadReader({ pads: () => [pad([1, 0, 0, 0])] });
    expect(read(full).moveX).toBeCloseTo(1, 6);
  });

  it('caps a diagonal stick at unit length, so it is not faster than a key', () => {
    const reader = new GamepadReader({ pads: () => [pad([1, 1, 0, 0])] });
    const frame = read(reader);

    // The sim caps the move pair at unit length; a reading that arrived already over it would be
    // squashed onto a different line than the one the thumb was making.
    expect(length(frame.moveX, frame.moveY)).toBeLessThanOrEqual(1.0000001);
    expect(frame.moveX).toBeCloseTo(-frame.moveY, 9);
  });

  it('steers with the right stick and fires while it is out of its dead zone', () => {
    const reader = new GamepadReader({ pads: () => [pad([0, 0, 1, 0])] });
    const frame = createInputFrame();
    frame.aimY = 1;
    read(reader, frame);

    expect(length(frame.aimX, frame.aimY)).toBeCloseTo(1, 6);
    expect(frame.aimX).toBeCloseTo(1, 6);
    expect(frame.aimY).toBeCloseTo(0, 6);
    expect(frame.fire).toBe(true);
  });

  it('leaves the last aim alone once the right stick comes back to the middle', () => {
    const rigged = rig(pad([0, 0, 1, 0]));
    const reader = new GamepadReader({ pads: rigged.poll });
    expect(read(reader).aimX).toBeCloseTo(1, 6);

    // A fresh frame, because the aim it arrives carrying is the mouse's: the pad adds a steering
    // input, it does not carry the pointer's answer over from the frame before.
    rigged.set(pad([0, 0, 0, 0]));
    const frame = createInputFrame();
    frame.aimY = 1;
    read(reader, frame);

    expect(frame.aimX).toBe(0);
    expect(frame.aimY).toBe(1);
    expect(frame.aimDist).toBe(0);
    expect(frame.fire).toBe(false);
  });

  it('keeps a stick that reports nothing out of the frame', () => {
    const blank = { mapping: 'standard', axes: [NaN, NaN, NaN, NaN], buttons: buttons() };
    const frame = read(new GamepadReader({ pads: () => [blank] }));

    expect(frame.moveX).toBe(0);
    expect(frame.aimX).toBe(0);
    expect(frame.fire).toBe(false);
  });
});

describe('gamepad buttons', () => {
  it('fires from the trigger without any aim attached', () => {
    const reader = new GamepadReader({ pads: () => [pad([0, 0, 0, 0], [7])] });
    const frame = createInputFrame();
    frame.aimY = 1;
    read(reader, frame);

    expect(frame.fire).toBe(true);
    expect(frame.aimY).toBe(1);
    expect(frame.dash).toBe(false);
  });

  it('dashes from RB or A, on every frame either is held', () => {
    const rigged = rig(pad([0, 0, 0, 0], [5]));
    const reader = new GamepadReader({ pads: rigged.poll });

    // A polled button is a *held* action, like Space on the keyboard: the sim's dash wants it
    // every tick, so treating it as an edge would dash once and stop.
    expect(read(reader).dash).toBe(true);
    expect(read(reader).dash).toBe(true);

    rigged.set(pad([0, 0, 0, 0]));
    expect(read(reader).dash).toBe(false);

    rigged.set(pad([0, 0, 0, 0], [0]));
    expect(read(reader).dash).toBe(true);
  });

  it('swaps from LB or Y, once per press rather than once per frame', () => {
    const rigged = rig(pad([0, 0, 0, 0], [4]));
    const reader = new GamepadReader({ pads: rigged.poll });

    expect(read(reader).swap).toBe(true);
    expect(read(reader).swap).toBe(false);

    rigged.set(pad([0, 0, 0, 0]));
    expect(read(reader).swap).toBe(false);

    rigged.set(pad([0, 0, 0, 0], [3]));
    expect(read(reader).swap).toBe(true);
  });

  it('pauses from Start, once per press', () => {
    const rigged = rig(pad([0, 0, 0, 0], [9]));
    const reader = new GamepadReader({ pads: rigged.poll });

    expect(commands(reader).pause).toBe(true);
    expect(commands(reader).pause).toBe(false);

    rigged.set(pad([0, 0, 0, 0]));
    expect(commands(reader).pause).toBe(false);
    rigged.set(pad([0, 0, 0, 0], [9]));
    expect(commands(reader).pause).toBe(true);
  });

  it('reads the face buttons as the three cards, with a level-up on screen', () => {
    const pickOf = (pressed: readonly number[]): number => {
      const reader = new GamepadReader({ pads: () => [pad([0, 0, 0, 0], pressed)] });
      return read(reader, createInputFrame(), 'cards').pick;
    };

    expect(pickOf([0])).toBe(1);
    expect(pickOf([2])).toBe(2);
    expect(pickOf([3])).toBe(3);
  });

  it('does not dash with a card button, or pick a card with a dash button', () => {
    const pads = () => [pad([0, 0, 0, 0], [0])];
    const inFight = read(new GamepadReader({ pads }));
    expect(inFight.dash).toBe(true);
    expect(inFight.pick).toBe(0);

    const atCards = read(new GamepadReader({ pads }), createInputFrame(), 'cards');
    expect(atCards.pick).toBe(1);
    expect(atCards.dash).toBe(false);
  });

  it('leaves the keyboard a chance to pick, when both reach for the same card', () => {
    const reader = new GamepadReader({ pads: () => [pad([0, 0, 0, 0], [2])] });
    const frame = createInputFrame();
    frame.pick = 2;
    expect(read(reader, frame, 'cards').pick).toBe(2);
  });
});

describe('gamepad devices', () => {
  it('leaves a pad that does not report the standard layout alone', () => {
    const weird = { connected: true, mapping: 'unknown', id: 'weird', axes: [1, 1, 1, 1], buttons: buttons([0, 4, 9]) };
    const reader = new GamepadReader({ pads: () => [weird] });
    const frame = read(reader);

    expect(frame.moveX).toBe(0);
    expect(frame.swap).toBe(false);
    expect(frame.pick).toBe(0);
  });

  it('skips the holes in the pad list and reads the first standard pad', () => {
    const rigged = rig(null, { mapping: 'unknown', axes: [1, 1, 1, 1], buttons: buttons() }, pad([1, 0, 0, 0]));
    expect(read(new GamepadReader({ pads: rigged.poll })).moveX).toBeCloseTo(1, 6);
  });

  it('needs a stick and a Start button before it will read a pad at all', () => {
    const stubs: PadLike[] = [
      { mapping: 'standard' },
      { mapping: 'standard', axes: [1, 1, 1, 1] },
      { mapping: 'standard', axes: [1, 1], buttons: buttons([4]) },
      { mapping: 'standard', axes: [1, 1, 1, 1], buttons: buttons([4]).slice(0, 6) },
    ];

    for (const stub of stubs) {
      const frame = read(new GamepadReader({ pads: () => [stub] }));
      expect(frame.swap).toBe(false);
      expect(frame.moveX).toBe(0);
    }
  });

  it('starts a replacement pad with no press memory, so its held buttons count as presses', () => {
    const rigged = rig(pad([0, 0, 0, 0], [4]));
    const reader = new GamepadReader({ pads: rigged.poll });
    expect(read(reader).swap).toBe(true);

    // A second controller that arrives with LB already down is a new press, not the old one still
    // held: the reader keys its memory on the device id for exactly this.
    rigged.set(pad([0, 0, 0, 0], [4], 'pad-b'));
    expect(read(reader).swap).toBe(true);

    // And a held button stays one press, whichever pad it is held on.
    expect(read(reader).swap).toBe(false);
  });

  it("keeps one pad's press memory across the snapshots a poll hands over", () => {
    const first = pad([0, 0, 0, 0], [4]);
    const rigged = rig(first);
    const reader = new GamepadReader({ pads: rigged.poll });
    expect(read(reader).swap).toBe(true);

    // Same device, same buttons, new objects: a browser may snapshot per poll, and if that read
    // as a fresh pad every frame, a held Start would pause once a frame.
    expect(read(reader).swap).toBe(false);
    rigged.set(snapshotOf(first));
    expect(read(reader).swap).toBe(false);
  });

  it('runs with no pad source at all, which is what a headless run does', () => {
    const reader = new GamepadReader();
    const frame = createInputFrame();
    frame.aimX = 1;

    expect(() => read(reader, frame)).not.toThrow();
    expect(frame.moveX).toBe(0);
    expect(frame.fire).toBe(false);
  });

  it('counts a poll that throws, once, and then stops polling', () => {
    const notes: string[] = [];
    let throws = 0;
    const reader = new GamepadReader({
      pads: () => {
        throws++;
        throw new Error('the device went away mid-poll');
      },
      note: (problem) => notes.push(problem),
    });

    const first = read(reader);
    const second = read(reader);

    // Reported rather than swallowed (AGENTS.md), and only once: a device that throws every frame
    // would bury the overlay in the same line sixty times a second.
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('the device went away mid-poll');
    expect(throws).toBe(1);
    expect(first.fire).toBe(false);
    expect(second.moveX).toBe(0);
  });
});

describe('gamepad and keyboard in one frame', () => {
  /** The sampler's host, cut down to what these tests raise. */
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

  function samplerWith(pads: () => readonly (PadLike | null | undefined)[], project?: (x: number, y: number, out: { x: number; y: number }) => boolean) {
    const host = new FakeHost();
    const sampler = new InputSampler({ host, player: () => ({ x: 0, y: 0 }), project, pads });
    return { host, sampler };
  }

  it('adds a stick to a held key instead of fighting it', () => {
    const { host, sampler } = samplerWith(() => [pad([-0.3, 0, 0, 0])]);
    const frame = createInputFrame();

    host.raise('keydown', { code: 'KeyD' });
    sampler.sample(frame);

    // A stick only just past its dead zone is not a steering input, and a key held across the
    // desk is: the weaker of the two loses, which is the whole point of comparing them.
    expect(frame.moveX).toBe(1);
  });

  it('lets a held key win a tie, and takes the stick when nothing is held', () => {
    const sticks = () => [pad([-1, 0, 0, 0])];

    // One key is already a full-length push, so a full stick only ties it, and the tie goes to the
    // keyboard: keys are what this game was playable with before a pad existed.
    const withKey = samplerWith(sticks);
    const held = createInputFrame();
    withKey.host.raise('keydown', { code: 'KeyD' });
    withKey.sampler.sample(held);
    expect(held.moveX).toBe(1);

    // With nobody holding a key, the same stick owns the move.
    const padOnly = samplerWith(sticks);
    const alone = createInputFrame();
    padOnly.sampler.sample(alone);
    expect(alone.moveX).toBeCloseTo(-1, 6);
  });

  it('keeps the mouse aim while the pad lies flat, and steers once it is not', () => {
    const rigged = rig(pad([0, 0, 0, 0]));
    const { sampler } = samplerWith(rigged.poll, (_x, _y, out) => {
      out.x = 0;
      out.y = 5;
      return true;
    });
    const frame = createInputFrame();

    // The pointer sits 5 m north of the player, so the mouse aims north and nothing is fired.
    sampler.sample(frame);
    expect(frame.aimY).toBeCloseTo(1, 6);
    expect(frame.fire).toBe(false);

    // A right stick pushed east, which is somewhere the mouse is not pointing.
    rigged.set(pad([0, 0, 1, 0]));
    sampler.sample(frame);
    expect(frame.aimX).toBeCloseTo(1, 6);
    expect(frame.aimY).toBeCloseTo(0, 6);
    expect(frame.fire).toBe(true);
  });

  it('carries a Start press into the scene commands, once', () => {
    const rigged = rig(pad([0, 0, 0, 0], [9]));
    const { sampler } = samplerWith(rigged.poll);
    const frame = createInputFrame();
    const cmds = { pause: false, accept: false, reroll: false };

    // The app drains before it samples, so a press written during one frame is read by the next.
    sampler.takeCommands(cmds);
    sampler.sample(frame);
    expect(sampler.takeCommands(cmds).pause).toBe(true);
    sampler.sample(frame);
    expect(sampler.takeCommands(cmds).pause).toBe(false);
  });
});

describe('the shell reads the pad too', () => {
  /**
   * An app with no renderer, no overlay and no shelf, over a pad the test rewrites.
   *
   * `createApp` is the door `main.ts` uses, so this is the only place the pad's route through the
   * scene machine is pinned rather than the frame in isolation: which layout a frame is read
   * against, and where a Start press lands. 100 ms per frame buys the loop's five-step cap, so
   * one frame is 1/12 s of play.
   */
  function shellWith(pads: PadSource) {
    const app = createApp({ view: null, hud: null, seed: 1, backend: 'none', storage: null, pads });
    let now = 0;

    function frames(count: number): void {
      for (let i = 0; i < count; i++) {
        now += 100;
        app.advance(now);
      }
    }

    return { app, frames };
  }

  it('steers the run the shell is playing, with no keyboard anywhere near it', () => {
    // Left stick east, right stick north.
    const rigged = rig(pad([0.9, 0, 0, -0.9]));
    const { app, frames } = shellWith(rigged.poll);
    app.command('start');
    const before = app.world.player.x;

    // Auto-fire off, so the stick is the only thing aiming and the only thing firing, and the
    // mouse has nothing to say: with no view there is nothing to project a pointer through.
    app.setSetting('autoFire', false);
    frames(30);

    expect(app.scene).toBe('playing');
    expect(app.world.player.x).toBeGreaterThan(before + 1);
    expect(app.world.player.aimY).toBeGreaterThan(0.9);
    expect(Math.abs(app.world.player.aimX)).toBeLessThan(0.1);
    expect(app.state().errors).toBe(0);
  });

  it('pauses on a Start press, and holds the pause while the button stays down', () => {
    const rigged = rig(pad([0, 0, 0, 0], [9]));
    const { app, frames } = shellWith(rigged.poll);
    app.command('start');

    // One frame of lag is the price of a polled device: the press is written during one frame and
    // drained at the top of the next, where the scene machine decides what it means.
    frames(1);
    expect(app.scene).toBe('playing');
    frames(1);
    expect(app.scene).toBe('paused');

    // Still held, and still one pause. A polled button that re-fired every frame would have
    // toggled the game back off somewhere in here.
    frames(5);
    expect(app.scene).toBe('paused');

    // Letting go is not a press either; only the next transition is.
    rigged.set(pad([0, 0, 0, 0]));
    frames(1);
    expect(app.scene).toBe('paused');

    rigged.set(pad([0, 0, 0, 0], [9]));
    frames(2);
    expect(app.scene).toBe('playing');
  });

  it('reads the face buttons as cards once the offer is up, but not while it was already held', () => {
    const rigged = rig(pad([0, 0, 0, 0], [0]));
    const { app, frames } = shellWith(rigged.poll);
    app.command('start');

    // A was down before the offer opened, where it means dash; the frame that opens the offer is
    // read against the play table, because the layout is taken from the scene at the top of it.
    awardXp(app.world, xpForLevel(1));
    frames(1);
    expect(app.scene).toBe('levelup');

    frames(3);
    expect(app.world.pendingLevelUp).toBe(true);
    expect(app.scene).toBe('levelup');

    // Released, then pressed: that is a press, and it takes the left card.
    rigged.set(pad([0, 0, 0, 0]));
    frames(1);
    rigged.set(pad([0, 0, 0, 0], [0]));
    frames(2);

    expect(app.world.pendingLevelUp).toBe(false);
    expect(app.world.player.level).toBe(2);
    expect(app.scene).toBe('playing');
    expect(app.state().errors).toBe(0);
  });
});

describe('a pad frame is a game frame', () => {
  /** Run ticks on one pad reading, the way the fixed-step loop does. */
  function play(w: World, reader: GamepadReader, ticks: number, layout: 'play' | 'cards' = 'play'): void {
    const frame = createInputFrame();
    for (let t = 0; t < ticks; t++) {
      // Cleared first because that is what `InputSampler.sample` does: the pad only ever adds to a
      // frame, so a frame reused without a reset would hold its trigger down from tick one.
      resetFrame(frame);
      reader.read(layout, frame, { pause: false, accept: false, reroll: false });
      step(w, frame);
    }
  }

  it('walks the player, with no browser and no controller', () => {
    const w = createWorld(7);
    const reader = new GamepadReader({ pads: () => [pad([0.8, 0, 0, 0])] });
    const before = w.player.x;

    play(w, reader, 60);

    expect(w.player.x).toBeGreaterThan(before + 1);
  });

  it('shoots what the stick points at, with auto-fire off', () => {
    const w = createWorld(7);
    const victim = spawnEnemy(w, 0, 5, 0);
    const reader = new GamepadReader({ pads: () => [pad([0, 0, 1, 0], [7])] });

    // `autoFire` is false on a fresh World, so the only thing making these shots is the trigger,
    // and a held trigger is also what keeps the round on the stick's line rather than leading the
    // nearest body (`wantsFire` in `systems/weapons.ts`).
    expect(w.autoFire).toBe(false);
    play(w, reader, 60);

    expect(w.enemies.alive[victim]).toBe(0);
  });

  it('takes the level-up card the pad picks', () => {
    const w = createWorld(7);

    // Exactly one level owed, so taking the card does not immediately open a second offer and the
    // `pendingLevelUp` below reads as "the pick landed" rather than "the screen is still up".
    awardXp(w, xpForLevel(1));
    expect(w.pendingLevelUp).toBe(true);

    play(w, new GamepadReader({ pads: () => [pad([0, 0, 0, 0], [0])] }), 1, 'cards');

    expect(w.pendingLevelUp).toBe(false);
    expect(w.player.level).toBe(2);
  });

  it('agrees with the replay packer about where a stick stops being a direction', () => {
    const inside = createInputFrame();
    read(new GamepadReader({ pads: () => [pad([0.15, 0, 0, 0])] }), inside);
    expect(unpackFrame(packFrame(inside), createInputFrame()).moveX).toBe(0);

    const outside = createInputFrame();
    read(new GamepadReader({ pads: () => [pad([0.6, 0, 0, 0])] }), outside);
    expect(outside.moveX).toBeGreaterThan(PAD_DEAD);
    expect(unpackFrame(packFrame(outside), createInputFrame()).moveX).toBe(1);
  });
});
