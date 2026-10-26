/**
 * Screen shake: trauma in, a camera offset out (DESIGN.md "Motion").
 *
 * The model is the standard two-step one, and the two steps are separate for a reason:
 *
 * 1. Something *happens* — a bolt lands, a bomber goes off — and adds trauma, capped at 1.
 * 2. The rig spends that trauma at 1.5 per second, and the visible shake is the square of
 *    what is left: `trauma² · 0.35 · scale` metres.
 *
 * Squared, because a jolt should hit hard and settle fast rather than fade like a dimmer: at
 * half trauma the shake is already a quarter as big. Linear would either be invisible at the
 * top or last three seconds, and three seconds of camera drift reads as a broken camera, not
 * as a hit.
 *
 * The offset is interpolated value noise rather than a random number per frame. Per-frame
 * noise at 60 Hz is white noise, which the eye reads as vibration and the inner ear as
 * nausea; sampled at 30 Hz and smoothed between samples, the same amplitude reads as a shove.
 *
 * Determinism: the noise comes from a hash of a step counter, not `Math.random`, so two runs
 * of the same replay shake the same way. It is still presentation — the rig is never read by
 * the simulation, and it changes no game value (ARCHITECTURE.md "Data flow").
 *
 * No engine import: the rig produces two numbers, and `renderer.ts` decides what a camera does
 * with them. That is what lets the decay and the amplitude be tested in plain Node.
 */

/** Trauma shed per second, whatever is left. A full jolt is gone in 0.67 s. */
export const DECAY = 1.5;

/** The most trauma the rig holds. Three bolts in one tick do not stack past a full shake. */
export const MAX_TRAUMA = 1;

/** Metres of camera travel at full trauma and full scale. */
export const SHAKE_GAIN = 0.35;

/** How many noise samples a second the shake walks through. */
const NOISE_RATE = 30;

/** DESIGN.md's default: shake is on, but a quarter of the way off the ceiling. */
export const DEFAULT_SCALE = 0.7;

export interface Shake {
  /** Trauma right now, 0..1, before the scale. */
  readonly trauma: number;
  /** Add a jolt. The total is capped at `MAX_TRAUMA`. */
  addTrauma(amount: number): void;
  /**
   * Write this frame's camera offset into `out`, in world metres.
   *
   * Read before `update`, so a frame that ran three ticks still shakes as one frame: the
   * decay is per rendered frame, not per step, which keeps the shake the same at 30 fps and
   * at 144.
   */
  peek(out: { x: number; z: number }): void;
  /** Spend a frame's worth of trauma and move the noise along. */
  update(dt: number): void;
  /** The settings' shake amount, 0..1. 0 means the player asked for no shake. */
  setScale(scale: number): void;
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * How far the camera moves, before the noise picks a direction: `trauma² · 0.35 · scale`.
 *
 * Exported as a plain function because it is the one number worth pinning in a test, and the
 * rig's `peek` is only this times a noise pair.
 */
export function shakeOffset(trauma: number, scale: number): number {
  const t = clamp01(trauma);
  return t * t * SHAKE_GAIN * clamp01(scale);
}

/** Deterministic scatter in -1..1, same trick as `spread` in `sim/fx.ts`. */
function scatter(n: number): number {
  let h = (n * 374761393) | 0;
  h = (h + (h >> 13)) | 0;
  h = (h * 1274126177) | 0;
  h = (h + (h >> 16)) | 0;
  return ((h & 0xffff) / 0xffff) * 2 - 1;
}

/** Smoothed noise: `scatter` walked between its samples, so the shake is a shove, not a buzz. */
function wave(step: number, salt: number): number {
  const i = Math.floor(step);
  const f = step - i;
  const a = scatter(i + salt);
  const b = scatter(i + salt + 1);
  const k = f * f * (3 - 2 * f);
  return a + (b - a) * k;
}

/**
 * Bring a shake rig up.
 *
 * One rig per view. It holds eight numbers and nothing else, so a restart does not have to
 * rebuild it — `setScale` is the only setter and the shell calls it when the settings change.
 */
export function createShake(scale: number = DEFAULT_SCALE): Shake {
  let trauma = 0;
  let step = 0;
  let scaleNow = clamp01(scale);

  return {
    get trauma() {
      return trauma;
    },

    addTrauma(amount: number) {
      if (!(amount > 0)) return;
      const next = trauma + amount;
      trauma = next > MAX_TRAUMA ? MAX_TRAUMA : next;
    },

    peek(out) {
      const k = shakeOffset(trauma, scaleNow);
      if (k <= 0) {
        out.x = 0;
        out.z = 0;
        return;
      }
      out.x = k * wave(step, 0);
      out.z = k * wave(step, 7919);
    },

    update(dt) {
      if (trauma > 0) {
        trauma -= DECAY * dt;
        if (trauma < 0) trauma = 0;
      }
      step += dt * NOISE_RATE;
      // The step is only ever an index into a two-sample window, so letting it grow would
      // just run the hash out into the integers where it stops scattering well.
      if (step > 1e6) step -= 1e6;
    },

    setScale(next) {
      scaleNow = clamp01(next);
    },
  };
}
