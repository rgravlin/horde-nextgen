/**
 * One tick's worth of player intent, plus the bit packing used by replay files
 * (TECH.md "Input": a `Uint32` bitmask + aim per tick).
 *
 * The sampler in src/input fills a scratch frame from DOM or gamepad state and
 * hands it to step(); handlers never touch game state. Tests and replays build
 * frames directly, which is why this lives in src/sim and imports nothing.
 */

/** Player intent for one 1/60 s tick. */
export interface InputFrame {
  /** -1 .. 1, left/right. Normalised against moveY before it is applied. */
  moveX: number;
  /** -1 .. 1, up/down. */
  moveY: number;
  /** -1 .. 1, aim direction on the ground plane. */
  aimX: number;
  aimY: number;
  fire: boolean;
  dash: boolean;
  swap: boolean;
  /** Level-up card index, 0 = none, 1..3 = the card chosen. */
  pick: number;
}

/**
 * The "no intent" frame: what the loop passes while paused or in a menu.
 * Frozen so nobody can quietly write game state through it; use
 * createInputFrame() for a scratch frame the sampler may overwrite.
 */
export const IDLE_FRAME: Readonly<InputFrame> = Object.freeze({
  moveX: 0,
  moveY: 0,
  aimX: 0,
  aimY: 0,
  fire: false,
  dash: false,
  swap: false,
  pick: 0,
});

/** A new scratch frame, cleared. The sampler keeps one per device, not one per tick. */
export function createInputFrame(): InputFrame {
  return { moveX: 0, moveY: 0, aimX: 0, aimY: 0, fire: false, dash: false, swap: false, pick: 0 };
}

/** Clear a scratch frame in place for reuse. */
export function resetFrame(f: InputFrame): InputFrame {
  f.moveX = 0;
  f.moveY = 0;
  f.aimX = 0;
  f.aimY = 0;
  f.fire = false;
  f.dash = false;
  f.swap = false;
  f.pick = 0;
  return f;
}

/** Bit positions inside a packed frame; bits 10..20 and 21..31 hold the aim pair. */
export const InputBit = {
  Fire: 1,
  Dash: 2,
  Swap: 4,
  Pick: 8,
  /** Bits 4..5 carry the card index, so the direction bits start above them. */
  PickIndexShift: 4,
  Left: 64,
  Right: 128,
  Down: 256,
  Up: 512,
  AimXShift: 10,
  AimYShift: 21,
} as const;

/** Movement below this magnitude counts as centred, matching the stick dead zone. */
export const MOVE_DEAD = 0.2;

/** Aim is stored in 1/1024ths of a unit per axis, biased by this much. */
const AIM_SCALE = 1023;
const AIM_MASK = 0x7ff;

function quantiseAim(v: number): number {
  if (v !== v) return 0;
  const q = Math.round(v * AIM_SCALE);
  return q < -AIM_SCALE ? -AIM_SCALE : q > AIM_SCALE ? AIM_SCALE : q;
}

/**
 * Pack a frame into one Uint32.
 *
 * Layout: bits 0..3 flags (fire, dash, swap, pick-used), bits 4..5 the card
 * index, bits 6..9 the move direction, bits 10..20 aim x, bits 21..31 aim y.
 *
 * Movement keeps only its sign and aim keeps 1/1023 of a unit, which is exact
 * for keyboard and mouse and costs under 2 cm of aim error at 20 m for analogue
 * sticks. Anything needing frame-exact analogue input records the floats
 * instead. unpackFrame is the exact inverse of packFrame.
 */
export function packFrame(f: InputFrame): number {
  let code = 0;
  if (f.fire) code |= InputBit.Fire;
  if (f.dash) code |= InputBit.Dash;
  if (f.swap) code |= InputBit.Swap;
  if (f.pick > 0) code |= InputBit.Pick | ((f.pick & 3) << InputBit.PickIndexShift);

  if (f.moveX < -MOVE_DEAD) code |= InputBit.Left;
  else if (f.moveX > MOVE_DEAD) code |= InputBit.Right;
  if (f.moveY < -MOVE_DEAD) code |= InputBit.Down;
  else if (f.moveY > MOVE_DEAD) code |= InputBit.Up;

  code |= (quantiseAim(f.aimX) + AIM_SCALE) << InputBit.AimXShift;
  code |= (quantiseAim(f.aimY) + AIM_SCALE) << InputBit.AimYShift;
  return code >>> 0;
}

/**
 * Decode a packed frame into `f` and return it.
 *
 * Aim round-trips through the same quantisation the encoder used, so a replay
 * run reproduces itself tick for tick even when the recorded aim was analogue.
 */
export function unpackFrame(code: number, f: InputFrame): InputFrame {
  f.fire = (code & InputBit.Fire) !== 0;
  f.dash = (code & InputBit.Dash) !== 0;
  f.swap = (code & InputBit.Swap) !== 0;
  f.pick = (code & InputBit.Pick) !== 0 ? (code >>> InputBit.PickIndexShift) & 3 : 0;

  f.moveX = (code & InputBit.Left) !== 0 ? -1 : (code & InputBit.Right) !== 0 ? 1 : 0;
  f.moveY = (code & InputBit.Down) !== 0 ? -1 : (code & InputBit.Up) !== 0 ? 1 : 0;

  f.aimX = (((code >>> InputBit.AimXShift) & AIM_MASK) - AIM_SCALE) / AIM_SCALE;
  f.aimY = (((code >>> InputBit.AimYShift) & AIM_MASK) - AIM_SCALE) / AIM_SCALE;
  return f;
}