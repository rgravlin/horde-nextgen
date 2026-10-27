/**
 * The gamepad reader: the other device that fills an `InputFrame`, read the same way the
 * keyboard is — once per tick, into the frame the sim polls (ARCHITECTURE.md "Data flow").
 *
 * A pad is not a keyboard, and the difference is the reason this is a file rather than six more
 * rows in the bind table:
 *
 * - **It has no events.** `navigator.getGamepads()` hands over a snapshot of whatever is pushed
 *   *right now*, which the sampler polls once a frame. A key reports its transitions and the
 *   browser remembers them for us; a polled button reports "down" every frame for as long as it
 *   is held. So the reader keeps last frame's pressed bits and reports only the edges: three
 *   seconds on the Start button is one pause, not 180 of them.
 * - **A button's meaning depends on the screen.** `A` is dash while a fight is running and card
 *   1 while a level-up is up — a keyboard has enough keys that one key can mean one thing, a
 *   pad has six buttons and a stick or two per thumb. `PadLayout` is that fact written down: the
 *   shell says which screen it is on, the reader picks a different table. Nothing else in the
 *   input layer is allowed to care, which is what keeps it out of the sampler.
 *
 * **The layout read here is the standard one** (`mapping === 'standard'`, the Gamepad API's
 * documented button-and-axis order), and a pad that does not report it is left alone: on a
 * non-standard pad index 0 is not necessarily the bottom face button, and guessing would hand the
 * player a controller whose buttons mean other buttons. TECH.md pins the mapping; the buttons this
 * game uses are RB and A for dash, LB and Y for swapping hands, Start for pause, the right stick
 * and the trigger for firing.
 *
 * **Sticks stay analog.** A half-pushed stick gives half speed, which is what `step.ts` means by
 * "a half-pushed stick stays half as fast". Inside the dead zone a stick gives nothing; past it
 * the reading is rescaled from zero, so clearing the zone does not jump to a quarter speed. That
 * rescale is why the dead zone is the same number the replay packer cuts at (`MOVE_DEAD`): a move
 * the pad emits is a move a replay can pack. The right stick's rescaled length goes into the frame
 * a second time as the aim *distance*, so a pad can put a lob somewhere rather than only along a
 * line (`PAD_AIM_RANGE`).
 *
 * Nothing here is stateful beyond one byte per button and three numbers for a stick, and the
 * pad's reading is *merged into* the frame the keyboard already wrote: a resting stick never
 * fights a keyboard, which is the only device conflict worth designing for.
 */

import { MOVE_DEAD, type InputFrame } from '../sim/input';
import { heldFlagOf, pickSlotOf, type BindAction } from './bindings';
import type { CommandBits } from './sampler';

/**
 * Both sticks' dead zone, in stick units (-1..1 per axis).
 *
 * `MOVE_DEAD`, not a copy of it: the replay packer calls a move under the same number
 * "centred" (`sim/input.ts`), and one constant is what keeps a pad-driven run and a replay of it
 * steering the same way.
 */
export const PAD_DEAD = MOVE_DEAD;

/**
 * Metres a full right-stick push aims a lob at, before the weapon clamps it to its own reach.
 *
 * A stick carries no distance, so this is a convention rather than a reading: pulled back the
 * throw is short, pushed out it reaches the weapon's full range, which is what a pad got before
 * the distance existed at all. Eighteen is the longest lob in the table, so a full push still
 * means "as far as this gun throws" and every shorter push means "where the thumb is pointing".
 */
export const PAD_AIM_RANGE = 18;

/**
 * Which screen the face buttons are read against.
 *
 * `'cards'` is the level-up choice screen; every other scene — play, pause, title, summary —
 * reads the play table, where the face buttons are fighting keys.
 */
export type PadLayout = 'play' | 'cards';

/** The part of a `GamepadButton` this file reads. */
export interface PadButtonLike {
  pressed?: boolean;
}

/**
 * The part of a `Gamepad` this file reads, written structally.
 *
 * The real thing satisfies it, and so does a plain object in a test, which is the point: the
 * pad layer is unit-testable with no browser and no controller (AGENTS.md).
 */
export interface PadLike {
  connected?: boolean;
  mapping?: string;
  /** The stable per-device string; also what the press memory is keyed by. */
  id?: string;
  axes?: ArrayLike<number> | null;
  buttons?: ArrayLike<PadButtonLike | null | undefined> | null;
}

/** Where the polled pad list comes from: `navigator.getGamepads` in the game, an array in a test. */
export type PadSource = () => readonly (PadLike | null | undefined)[];

export interface GamepadPorts {
  /** Defaults to `navigator.getGamepads`, which is nothing on a machine with no pad. */
  pads?: PadSource;
  /**
   * Where a poll that throws goes instead of disappearing: the same tally a sim assertion
   * failure and a failed save use, i.e. `__forgeState().errors` (AGENTS.md).
   */
  note?: (problem: string) => void;
}

/** Standard-mapping axis indices: two sticks, x first, then y, which points *down* the stick. */
const LEFT_X = 0;
const LEFT_Y = 1;
const RIGHT_X = 2;
const RIGHT_Y = 3;

/** The least a pad has to report for the indices below to mean what they say. */
const MIN_AXES = 4;
const MIN_BUTTONS = 10;

/**
 * Which standard-mapping button carries which action during a fight.
 *
 * The keys are the Gamepad API's indices, so `5` is RB and `0` is the bottom face button — the
 * order every pad that calls itself standard agrees on, which is why they are written as indices
 * rather than as names a vendor's sticker might contradict.
 */
const PLAY_BUTTONS = new Map<number, BindAction>([
  [7, 'fire'], // RT: the trigger, so a pad still fires with auto-fire switched off
  [5, 'dash'], // RB
  [0, 'dash'], // A
  [4, 'swap'], // LB
  [3, 'swap'], // Y
  [9, 'pause'], // Start
]);

/**
 * ... and with a level-up on screen, where the three face buttons are the three cards.
 *
 * Nothing steps while the cards are up, so `A` can stop being a dash here and still be one during
 * the fight: a button only ever has to mean one thing per screen.
 */
const CARD_BUTTONS = new Map<number, BindAction>([
  [0, 'pick1'], // A
  [2, 'pick2'], // X
  [3, 'pick3'], // Y
]);

/** The frame's own empty pad list, for a machine with no `navigator` at all. */
const NO_PADS: readonly (PadLike | null | undefined)[] = [];

/** What `getGamepads` has to look like to be called, described without naming `Navigator`. */
interface PadHost {
  getGamepads?: () => readonly (PadLike | null)[] | null;
}

/**
 * The default poll: `navigator.getGamepads`, or nothing.
 *
 * Called through `call` because the method needs `navigator` as its `this`, and read through a
 * structural type rather than the DOM's `Navigator` because which `navigator` declaration wins
 * depends on which `lib`/`@types` pair is loaded, which is not this file's business.
 */
function defaultPadSource(): PadSource {
  const host = (globalThis as { navigator?: PadHost }).navigator;
  const poll = host?.getGamepads;
  if (typeof poll !== 'function') return () => NO_PADS;
  return () => poll.call(host) ?? NO_PADS;
}

/**
 * The pad to read: the first connected one that reports the standard layout.
 *
 * Chrome returns a list with holes in it where a pad used to be, so `null` entries are skipped
 * rather than treated as an absence.
 */
function pickPad(pads: readonly (PadLike | null | undefined)[]): PadLike | null {
  for (const pad of pads) {
    if (pad === null || pad === undefined) continue;
    if (pad.connected === false) continue;
    if (pad.mapping !== 'standard') continue;
    return pad;
  }
  return null;
}

/**
 * One reader per run, holding one byte per button and nothing else.
 *
 * `read` is called by the sampler *after* the keyboard and mouse have written the frame, because
 * that is what lets it merge rather than clobber.
 */
export class GamepadReader {
  private readonly poll: PadSource;
  private readonly note?: (problem: string) => void;

  /** Last frame's pressed bits, one byte per button index, reused across frames. */
  private down = new Uint8Array(0);
  /** The pad `down` belongs to. Keyed on `id`, not object identity: a browser is free to hand
   *  over a fresh snapshot per poll, and treating that as a new pad would turn a held Start into
   *  a pause every frame. */
  private last = '';
  private pollFailed = false;

  /** Scratch for the stick being read: the vector and its squared length. */
  private readonly stick = { x: 0, y: 0, len2: 0 };

  constructor(ports: GamepadPorts = {}) {
    this.poll = ports.pads ?? defaultPadSource();
    this.note = ports.note;
  }

  /**
   * Read the pads into `frame` and `cmds`, both of which already carry the keyboard's answer.
   *
   * Three rules hold the two devices apart, and they are the whole merge policy:
   *
   * - Movement goes to whichever device is pushing harder, so a stick that is barely nudged
   *   cannot out-steer a held key and a resting stick cannot out-steer anything.
   * - Aim goes to the right stick *only* while it is out of its dead zone; otherwise the mouse
   *   keeps it, which is the same rule the pointer follows when it leaves the floor.
   * - A button is only ever added, never taken away: a pad cannot release a key.
   */
  read(layout: PadLayout, frame: InputFrame, cmds: CommandBits): void {
    if (this.pollFailed) return;

    let pads: readonly (PadLike | null | undefined)[];
    try {
      pads = this.poll();
    } catch (error) {
      this.fail(error);
      return;
    }

    const pad = pickPad(pads);
    if (pad === null) {
      this.last = '';
      return;
    }

    const axes = pad.axes;
    const buttons = pad.buttons;
    if (axes === null || axes === undefined || buttons === null || buttons === undefined) return;
    if (axes.length < MIN_AXES || buttons.length < MIN_BUTTONS) return;

    const key = pad.id ?? '';
    if (key !== this.last) {
      // A different pad: whatever was pressed belongs to the device that is gone.
      this.last = key;
      if (this.down.length < buttons.length) this.down = new Uint8Array(buttons.length);
      else this.down.fill(0);
    }

    this.readSticks(axes, frame);
    this.readButtons(buttons, layout === 'cards' ? CARD_BUTTONS : PLAY_BUTTONS, frame, cmds);
  }

  /**
   * Fold both sticks into the frame.
   *
   * The world's +y is north and screen-up (`render/instancing.ts`) while a stick's +y runs down
   * the stick, so both readings come in negated: push the stick up, go north.
   */
  private readSticks(axes: ArrayLike<number>, frame: InputFrame): void {
    const stick = this.stick;

    if (this.readStick(axes, LEFT_X, LEFT_Y)) {
      if (stick.len2 > frame.moveX * frame.moveX + frame.moveY * frame.moveY) {
        frame.moveX = stick.x;
        frame.moveY = stick.y;
      }
    }

    if (this.readStick(axes, RIGHT_X, RIGHT_Y)) {
      // The pair goes in normalised because `step.ts` divides its length out — so the stick's own
      // magnitude is not wasted, it goes in beside the pair as the throw distance, which is the
      // only way a pad can aim the two weapons that resolve where they land. A full push is the
      // weapon's full reach (`PAD_AIM_RANGE`), a pulled-back stick a shorter one.
      const mag = Math.sqrt(stick.len2);
      const k = 1 / mag;
      frame.aimX = stick.x * k;
      frame.aimY = stick.y * k;
      frame.aimDist = mag * PAD_AIM_RANGE;
      // Firing while aimed, and a held trigger is also what makes the shot go where the stick
      // points: auto-fire leads the nearest body instead of steering (`wantsFire`, and the
      // `auto` argument of `fire`, in `systems/weapons.ts`).
      frame.fire = true;
    }
  }

  /**
   * Read one stick into `this.stick`, dead-zoned, rescaled from zero, capped to unit length.
   *
   * False means "inside the dead zone", which is also the answer for a `NaN` reading: a pad that
   * reports nothing is a pad nobody is steering with.
   */
  private readStick(axes: ArrayLike<number>, xAt: number, yAt: number): boolean {
    const x = axes[xAt] ?? 0;
    const y = -(axes[yAt] ?? 0);
    const length = Math.sqrt(x * x + y * y);
    if (!(length > PAD_DEAD)) return false;

    const magnitude = length > 1 ? 1 : (length - PAD_DEAD) / (1 - PAD_DEAD);
    const k = magnitude / length;
    const stick = this.stick;
    stick.x = x * k;
    stick.y = y * k;
    stick.len2 = magnitude * magnitude;
    return true;
  }

  /**
   * Spend the pad's buttons: a `hold` action is read again every frame it is down, a `press`
   * action once per edge.
   *
   * Which of the two an action is does not come from this file: `heldFlagOf` is how the keyboard
   * decides the same question, so a pad and a key that both mean `dash` are held the same way.
   */
  private readButtons(
    buttons: ArrayLike<PadButtonLike | null | undefined>,
    table: ReadonlyMap<number, BindAction>,
    frame: InputFrame,
    cmds: CommandBits,
  ): void {
    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      const pressed = button !== null && button !== undefined && button.pressed === true;
      const wasDown = this.down[i] !== 0;
      this.down[i] = pressed ? 1 : 0;
      if (!pressed) continue;

      const action = table.get(i);
      if (action === undefined) continue;

      const flag = heldFlagOf(action);
      if (flag !== undefined) {
        frame[flag] = true;
        continue;
      }
      if (wasDown) continue;

      switch (action) {
        case 'swap':
          frame.swap = true;
          break;
        case 'pause':
          cmds.pause = true;
          break;
        default: {
          const slot = pickSlotOf(action);
          // The keyboard's card key wins when both are pressed: the number row is the way this
          // screen was playable before a pad existed.
          if (slot > 0 && frame.pick === 0) frame.pick = slot;
        }
      }
    }
  }

  /**
   * A poll that throws is a broken device rather than a bad frame: say so once, then stop
   * reading it. A device that costs the frame its whole step budget would take the game with it.
   */
  private fail(error: unknown): void {
    if (this.pollFailed) return;
    this.pollFailed = true;
    this.note?.(`gamepad poll failed; pad input is off (${String(error)})`);
  }
}