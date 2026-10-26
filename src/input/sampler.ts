/**
 * The input sampler: the only place DOM devices are read (ARCHITECTURE.md "Input").
 *
 * Handlers never change game state. They set bits in the sampler's own scratch
 * state; once per tick the app calls `sample()`, which writes one `InputFrame`, and
 * that frame is what `step()` sees — so a run can be replayed from a frame log and a
 * unit test can drive gameplay without a browser (TECH.md "Input").
 *
 * Three kinds of thing come off the devices and they are kept apart on purpose:
 *
 * - **State** (held keys, pointer position, button, stick axis) becomes an
 *   `InputFrame` field, read the same way every tick, so holding a key keeps working.
 * - **Latched one-shots** (Escape, Enter, R, the pad's Start) are consumed once by the app, which
 *   decides what they mean in the current scene. The sampler has no idea whether the game is
 *   paused: `takeCommands` only reports what was pressed.
 * - **A layout**, which says what the pad's face buttons mean this frame — dash and swap, or the
 *   three level-up cards. The app knows the screen and the sampler does not, so the app hands it
 *   over as an argument instead of the input layer guessing at a scene it cannot see.
 *
 * Which key means what is not in this file: it comes from `bindings.ts` as a compiled `BindTable`,
 * the one map the Controls tab edits too. That is what makes a remap real — the settings screen
 * changes the table, `setBindings` hands the sampler the new one, and the next key press is
 * already read under it. The gamepad keeps its own small table in `gamepad.ts` and shares this
 * file's action vocabulary: buttons are polled rather than delivered as events, so they need edge
 * tracking of their own, and a stick is not a key under any mapping.
 *
 * The host is injected so a test can hand it a fake: `addEventListener` and
 * `removeEventListener` are all this file needs from it. The pad list is injected the same way.
 */

import { buildBinds, heldFlagOf, moveVectorOf, pickSlotOf, type BindTable } from './bindings';
import { GamepadReader, type PadLayout, type PadSource } from './gamepad';
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
  /**
   * The bind map to read keys through. Left out, the sampler uses the shipped default
   * (`buildBinds()`), which is what the sampler's own tests and a headless run do.
   */
  bindings?: BindTable;
  /**
   * Where the gamepads come from. Defaults to `navigator.getGamepads`, which is an empty list on
   * a machine without one and in a Node test, so the pad half of the sampler costs one call and a
   * handful of comparisons until somebody plugs a controller in.
   */
  pads?: PadSource;
  /** Where a pad poll that throws is reported, rather than swallowed. */
  note?: (problem: string) => void;
}

/** Below this length an aim vector is a shrug, not a direction. */
const EPS = 1e-6;

/**
 * A pointer button as a bind source (`Mouse0` for the primary button), or undefined.
 *
 * A button is a source rather than a hard-coded "button 0 means fire" so the Controls tab can
 * offer it: fire on the mouse is a default, not a law.
 */
function pointerSource(e: InputEventLike): string | undefined {
  return typeof e.button === 'number' ? `Mouse${e.button}` : undefined;
}

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
  private readonly held = new Set<'dash' | 'fire'>();
  private readonly ground = { x: 0, y: 0 };
  private readonly commands: CommandBits = { pause: false, accept: false, reroll: false };
  private readonly pad: GamepadReader;

  private binds: BindTable;
  private pointerX = 0;
  private pointerY = 0;
  private swapLatch = false;
  private pickLatch = 0;
  private aimX = 1;
  private aimY = 0;

  /** The listeners actually registered, so `dispose` can take them back. */
  private readonly bound: Array<[string, (e: InputEventLike) => void]> = [];

  constructor(ports: SamplerPorts) {
    this.ports = ports;
    this.host = ports.host ?? defaultHost();
    this.binds = ports.bindings ?? buildBinds();
    this.pad = new GamepadReader({ pads: ports.pads, note: ports.note });

    this.on('keydown', (e) => this.handleKey(e, true));
    this.on('keyup', (e) => this.handleKey(e, false));
    this.on('blur', () => this.releaseAll());
    this.on('mousemove', (e) => {
      if (typeof e.clientX === 'number') this.pointerX = e.clientX;
      if (typeof e.clientY === 'number') this.pointerY = e.clientY;
    });
    this.on('pointerdown', (e) => {
      const source = pointerSource(e);
      if (source !== undefined) this.press(source);
    });
    this.on('pointerup', (e) => {
      const source = pointerSource(e);
      if (source !== undefined) this.release(source);
    });
    // The wheel swaps hands. Read as state rather than a latch so a spinning wheel
    // cannot stack ten swaps into one tick. It is not a bind, so it is not remappable
    // and not taken away by a remap of `swap` — the `hint` on that row says so.
    this.on('wheel', () => {
      this.swapLatch = true;
    });
  }

  /**
   * Point the sampler at a different bind map.
   *
   * Every held key is dropped on the way in: a key pressed under the old map means
   * something else under the new one, and carrying it over would spend the change on
   * whatever the player happened to be holding when the settings screen opened.
   */
  setBindings(table: BindTable): void {
    this.binds = table;
    this.releaseAll();
  }

  private on(type: string, listener: (e: InputEventLike) => void): void {
    this.host.addEventListener(type, listener);
    this.bound.push([type, listener]);
  }

  /**
   * Resolve one source to the action the table says it carries, and set that latch.
   *
   * Shared by the keyboard and the pointer because the table does not care which device a
   * source came from: `Mouse0` and `KeyJ` are the same kind of key to it, which is how fire
   * can be moved off the mouse without a second code path.
   */
  private press(source: string): void {
    const action = this.binds.actionOf(source);
    if (action === undefined) return;

    const flag = heldFlagOf(action);
    if (flag !== undefined) {
      this.held.add(flag);
      return;
    }

    switch (action) {
      case 'pause':
        this.commands.pause = true;
        break;
      case 'accept':
        this.commands.accept = true;
        break;
      case 'reroll':
        this.commands.reroll = true;
        break;
      case 'swap':
        this.swapLatch = true;
        break;
      default: {
        // A move key needs nothing here: `sample` reads it back out of `down`.
        const pick = pickSlotOf(action);
        if (pick > 0) this.pickLatch = pick;
      }
    }
  }

  /** Let one source go, and only let a held flag go once no other source still holds it. */
  private release(source: string): void {
    this.down.delete(source);

    const flag = heldFlagOf(this.binds.actionOf(source));
    if (flag === undefined || !this.held.has(flag)) return;
    for (const other of this.down) {
      if (heldFlagOf(this.binds.actionOf(other)) === flag) return;
    }
    this.held.delete(flag);
  }

  private handleKey(e: InputEventLike, pressed: boolean): void {
    const code = e.code;
    if (!code) return;

    if (!pressed) {
      this.release(code);
      return;
    }

    // Bound keys owe the page a `preventDefault` (scrolling, the caret, click-drag); see
    // `swallows` in `bindings.ts`, which also keeps the scroll keys swallowed when a player
    // has taken them off their action.
    if (this.binds.swallows(code)) e.preventDefault?.();
    // A held key repeats; only the first transition means anything.
    if (this.down.has(code)) return;
    this.down.add(code);
    this.press(code);
  }

  /** Losing the window loses the keys: nothing may stay held through a focus loss. */
  private releaseAll(): void {
    this.down.clear();
    this.held.clear();
  }

  /**
   * Fill one tick's frame from the devices, in place.
   *
   * Movement and aim are sampled from held state; the swap, pick and dash one-shots
   * are latches that clear as they are read, so one press is one tick of intent no
   * matter how long the key stays down.
   *
   * The keyboard and mouse are read first and the gamepad second, into the same frame, and the pad
   * only ever adds to what the keys already said — see the merge rules in `gamepad.ts`. That order
   * is also why a pad button cannot lose to a keyboard it is not fighting with: a resting stick
   * writes nothing. `layout` says what the face buttons mean this frame; the shell knows which
   * screen it is on and this file does not, so it is passed in rather than looked up.
   */
  sample(frame: InputFrame, layout: PadLayout = 'play'): void {
    resetFrame(frame);

    for (const source of this.down) {
      const move = moveVectorOf(this.binds.actionOf(source));
      if (move !== undefined) {
        frame.moveX += move[0];
        frame.moveY += move[1];
      }
    }

    frame.dash = this.held.has('dash');
    frame.fire = this.held.has('fire');
    frame.swap = this.swapLatch;
    this.swapLatch = false;
    frame.pick = this.pickLatch;
    this.pickLatch = 0;

    this.sampleAim(frame);
    this.pad.read(layout, frame, this.commands);
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
   *
   * A key press is already sitting here by the time it is called, because the browser delivers
   * events between frames. A pad press is written during `sample`, so it drains on the following
   * frame: one frame of lag, paid for a device that reports held state instead of transitions.
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
