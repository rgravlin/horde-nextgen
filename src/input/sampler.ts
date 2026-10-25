/**
 * The input sampler: the only place DOM devices are read (ARCHITECTURE.md "Input").
 *
 * Handlers never change game state. They set bits in the sampler's own scratch
 * state; once per tick the app calls `sample()`, which writes one `InputFrame`, and
 * that frame is what `step()` sees — so a run can be replayed from a frame log and a
 * unit test can drive gameplay without a browser (TECH.md "Input").
 *
 * Two kinds of thing come off the devices and they are kept apart on purpose:
 *
 * - **State** (held keys, pointer position, button) becomes an `InputFrame` field,
 *   read the same way every tick, so holding a key keeps working.
 * - **Latched one-shots** (Escape, Enter, R) are consumed once by the app, which
 *   decides what they mean in the current scene. The sampler has no idea whether the
 *   game is paused: `takeCommands` only reports what was pressed.
 *
 * The host is injected so a test can hand it a fake: `addEventListener` and
 * `removeEventListener` are all this file needs from it.
 */

import { resetFrame, type InputFrame } from '../sim/input';

/** The part of a key or pointer event this file reads. */
export interface InputEventLike {
  /** Physical key code, e.g. 'KeyD' or 'Digit1'. */
  code?: string;
  /** Pointer button index; 0 is the primary button. */
  button?: number;
  clientX?: number;
  clientY?: number;
  deltaY?: number;
  preventDefault?(): void;
}

/** Anything that can carry listeners: `window` in the game, a fake in a test. */
export interface InputHost {
  addEventListener(type: string, listener: (e: InputEventLike) => void): void;
  removeEventListener(type: string, listener: (e: InputEventLike) => void): void;
}

/** Scene-level keys, drained once per frame by the app. */
export interface CommandBits {
  /** Escape or P: toggle the pause. */
  pause: boolean;
  /** Enter: start from the menu, restart from the summary. */
  accept: boolean;
  /** R: reroll the level-up offer. */
  reroll: boolean;
}

export interface SamplerPorts {
  /** Where listeners go. Defaults to `window` when there is one. */
  host?: InputHost;
  /**
   * Project a client-space pointer position onto the ground plane, writing the
   * world point into `out`; false when the pointer is not over the floor. Left out,
   * the aim stays wherever it last pointed.
   */
  project?: (clientX: number, clientY: number, out: { x: number; y: number }) => boolean;
  /** Where the aim is measured from — the player, read fresh every sample. */
  player: () => { x: number; y: number };
}

/** Below this length an aim vector is a shrug, not a direction. */
const EPS = 1e-6;

/** Keys that pause, accept and reroll. Everything else is held state. */
const PAUSE_KEYS = new Set(['Escape', 'KeyP']);
const ACCEPT_KEYS = new Set(['Enter', 'NumpadEnter']);
const REROLL_KEYS = new Set(['KeyR']);
const DASH_KEYS = new Set(['Space', 'ShiftLeft', 'ShiftRight']);
const PICK_KEYS = new Map([
  ['Digit1', 1],
  ['Digit2', 2],
  ['Digit3', 3],
  ['Numpad1', 1],
  ['Numpad2', 2],
  ['Numpad3', 3],
]);

/** Code -> [moveX, moveY], in world axes: +x is east, +y is the far side of the floor. */
const MOVE_KEYS = new Map<string, readonly [number, number]>([
  ['KeyW', [0, 1]],
  ['ArrowUp', [0, 1]],
  ['KeyS', [0, -1]],
  ['ArrowDown', [0, -1]],
  ['KeyA', [-1, 0]],
  ['ArrowLeft', [-1, 0]],
  ['KeyD', [1, 0]],
  ['ArrowRight', [1, 0]],
]);

/** Keys whose default (scrolling the page) has to be swallowed while held. */
const SWALLOWED = new Set([...DASH_KEYS, ...MOVE_KEYS.keys()]);

function defaultHost(): InputHost {
  const none = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return typeof window === 'undefined' ? none : window;
}

/**
 * One instance per run, holding one pointer position and one set of held keys.
 *
 * Nothing here allocates per tick: the frame, the command bits and the ground-point
 * scratch are all allocated with the sampler and reused.
 */
export class InputSampler {
  private readonly ports: SamplerPorts;
  private readonly host: InputHost;
  private readonly down = new Set<string>();
  private readonly ground = { x: 0, y: 0 };
  private readonly commands: CommandBits = { pause: false, accept: false, reroll: false };

  private pointerX = 0;
  private pointerY = 0;
  private firing = false;
  private swapLatch = false;
  private pickLatch = 0;
  private aimX = 1;
  private aimY = 0;

  /** The listeners actually registered, so `dispose` can take them back. */
  private readonly bound: Array<[string, (e: InputEventLike) => void]> = [];

  constructor(ports: SamplerPorts) {
    this.ports = ports;
    this.host = ports.host ?? defaultHost();

    this.on('keydown', (e) => this.handleKey(e, true));
    this.on('keyup', (e) => this.handleKey(e, false));
    this.on('blur', () => this.releaseAll());
    this.on('mousemove', (e) => {
      if (typeof e.clientX === 'number') this.pointerX = e.clientX;
      if (typeof e.clientY === 'number') this.pointerY = e.clientY;
    });
    this.on('pointerdown', (e) => {
      if (e.button === 0) this.firing = true;
    });
    this.on('pointerup', (e) => {
      if (e.button === 0) this.firing = false;
    });
    // The wheel swaps hands. Read as state rather than a latch so a spinning wheel
    // cannot stack ten swaps into one tick.
    this.on('wheel', () => {
      this.swapLatch = true;
    });
  }

  private on(type: string, listener: (e: InputEventLike) => void): void {
    this.host.addEventListener(type, listener);
    this.bound.push([type, listener]);
  }

  private handleKey(e: InputEventLike, pressed: boolean): void {
    const code = e.code;
    if (!code) return;

    if (pressed) {
      if (SWALLOWED.has(code)) e.preventDefault?.();
      // A held key repeats; only the first transition means anything.
      if (this.down.has(code)) return;
      this.down.add(code);

      if (PAUSE_KEYS.has(code)) this.commands.pause = true;
      else if (ACCEPT_KEYS.has(code)) this.commands.accept = true;
      else if (REROLL_KEYS.has(code)) this.commands.reroll = true;
      else {
        const pick = PICK_KEYS.get(code);
        if (pick !== undefined) this.pickLatch = pick;
        if (code === 'KeyQ') this.swapLatch = true;
      }
    } else {
      this.down.delete(code);
    }
  }

  /** Losing the window loses the keys: nothing may stay held through a focus loss. */
  private releaseAll(): void {
    this.down.clear();
    this.firing = false;
  }

  /**
   * Fill one tick's frame from the devices, in place.
   *
   * Movement and aim are sampled from held state; the swap, pick and dash one-shots
   * are latches that clear as they are read, so one press is one tick of intent no
   * matter how long the key stays down.
   */
  sample(frame: InputFrame): void {
    resetFrame(frame);

    for (const code of this.down) {
      const move = MOVE_KEYS.get(code);
      if (move) {
        frame.moveX += move[0];
        frame.moveY += move[1];
      }
    }

    for (const code of DASH_KEYS) {
      if (this.down.has(code)) {
        frame.dash = true;
        break;
      }
    }

    frame.fire = this.firing;
    frame.swap = this.swapLatch;
    this.swapLatch = false;
    frame.pick = this.pickLatch;
    this.pickLatch = 0;

    this.sampleAim(frame);
  }

  /**
   * Aim at the ground point under the pointer.
   *
   * The direction, not the point, goes into the frame: a 20 m shot and a 2 m one
   * leave along the same line, and keeping the last aim when the pointer leaves the
   * floor is what stops the gun snapping to the player when the cursor drifts over
   * the sky.
   */
  private sampleAim(frame: InputFrame): void {
    const project = this.ports.project;
    if (project) {
      if (project(this.pointerX, this.pointerY, this.ground)) {
        const from = this.ports.player();
        const dx = this.ground.x - from.x;
        const dy = this.ground.y - from.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length > EPS) {
          this.aimX = dx / length;
          this.aimY = dy / length;
        }
      }
    }
    frame.aimX = this.aimX;
    frame.aimY = this.aimY;
  }

  /**
   * Copy the scene-level latches into `out` and clear them: one press is one use,
   * whoever reads it, and the app decides what the press means in this scene.
   */
  takeCommands(out: CommandBits): CommandBits {
    out.pause = this.commands.pause;
    out.accept = this.commands.accept;
    out.reroll = this.commands.reroll;
    this.commands.pause = false;
    this.commands.accept = false;
    this.commands.reroll = false;
    return out;
  }

  /** Tear the listeners back down; only used when a run is torn down for a reload. */
  dispose(): void {
    for (const [type, listener] of this.bound) this.host.removeEventListener(type, listener);
    this.bound.length = 0;
    this.releaseAll();
  }
}
