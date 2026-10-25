/**
 * Seeded random numbers: xoshiro128** (Blackman/Vigna) over four 32-bit words.
 *
 * The state lives in a Uint32Array held inside the World, so it is part of what
 * hashWorld and (later) serialize cover. Every draw goes through one of the
 * functions here; the simulation never calls Math.random, which keeps a run
 * reproducible from its seed (TECH.md "Determinism").
 */

/** Random generator state: four 32-bit words. */
export interface Rng {
  s: Uint32Array;
}

export function createRng(seed: number): Rng {
  const rng: Rng = { s: new Uint32Array(4) };
  seedRng(rng, seed);
  return rng;
}

/**
 * Refill the state with a splitmix32-style avalanche of `seed`.
 *
 * Re-seeding mid-run is allowed (a debug seed change, a save restore); it is not
 * something gameplay does, because it would break a replay.
 */
export function seedRng(rng: Rng, seed: number): void {
  const s = rng.s;
  let z = seed >>> 0;
  if (z === 0) z = 0x9e37_79b9;
  for (let i = 0; i < 4; i++) {
    z = (z + 0x9e37_79b9) >>> 0;
    let t = z;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    s[i] = (t ^ (t >>> 14)) >>> 0;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Raw 32-bit draw, and the only place the state is advanced. */
export function nextU32(rng: Rng): number {
  const s = rng.s;
  const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
  const t = (s[1] << 9) >>> 0;

  s[2] = (s[2] ^ s[0]) >>> 0;
  s[3] = (s[3] ^ s[1]) >>> 0;
  s[1] = (s[1] ^ s[2]) >>> 0;
  s[0] = (s[0] ^ s[3]) >>> 0;
  s[2] = (s[2] ^ t) >>> 0;
  s[3] = rotl(s[3], 11);
  return result;
}

/** Uniform draw in [0, 1). */
export function next(rng: Rng): number {
  return nextU32(rng) * 2.328_306_436_538_696_3e-10;
}

/** Uniform draw in [min, max). */
export function range(rng: Rng, min: number, max: number): number {
  return min + next(rng) * (max - min);
}

/** Uniform integer draw in [0, n); returns 0 when n is not positive. */
export function nextInt(rng: Rng, n: number): number {
  if (!(n > 0)) return 0;
  const v = Math.trunc(next(rng) * n);
  return v >= n ? n - 1 : v;
}