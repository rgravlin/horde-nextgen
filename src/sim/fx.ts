/**
 * The presentation half of the simulation: sparks, embers, smoke and the lights they
 * cast (ARCHITECTURE.md "The sim may keep state purely for presentation").
 *
 * Two fields live here, both plain fixed-size arrays of numbers:
 *
 * - a particle field, written by the effects a tick produces and integrated once a
 *   tick like everything else in `src/sim`;
 * - a light field, the handful of emitters the renderer is allowed to spend a real
 *   point light on this frame.
 *
 * Why the sim owns them rather than the renderer: the brief asks for a fixed-timestep
 * deterministic simulation the engine only draws, and a spark that moves on the render
 * clock is neither. Pausing has to freeze a burst mid-flight (DESIGN.md "the game
 * freezes"), a paused-and-resumed run has to look the same as one that never stopped,
 * and a headless run has to be able to say what a burst costs. None of that works if
 * the particles live in the renderer, and all of it works if they are numbers in arrays
 * the renderer reads.
 *
 * Why a ring rather than a free list: a particle is decoration. Overwriting the oldest
 * spark when the field is full is the right failure — the new one is the one a player is
 * looking at — and it keeps the write path a cursor bump instead of an allocation hunt.
 * Overflow is counted rather than hidden.
 *
 * Why the event ring is read through a cursor rather than drained: the ring is a
 * broadcast channel (audio and the HUD are expected to read it too), and a consumer that
 * emptied it would silence the others. `read` is this consumer's own place in the
 * stream, and events it skipped because the ring wrapped are counted, not guessed at.
 *
 * Nothing in this file is read by gameplay. A burst is a thing that already happened and
 * was already paid for by the rules that caused it; empty the field and the fight is
 * unchanged, which is what lets the bench treat 8,000 particles as load rather than as
 * behaviour.
 */

import { DT, Ev, type World } from './world';

/** Sparks, embers and smoke at once. Sized from the bench's headline load. */
export const PARTICLE_CAP = 8192;

/**
 * Point lights the renderer may show at once — TECH.md pins sixteen. Every emitter a
 * tick produces is scored against these sixteen (`offerLight`) and only displaces the
 * weakest, so the pick is a choice between what is actually happening rather than
 * whichever burst happened to be written first.
 */
export const LIGHT_CAP = 16;

/** How many particles one tick may spawn, whatever the event ring says. */
const SPAWN_BUDGET = 320;

/** The particle palettes. One instanced batch is built per entry, so this is a draw-call count. */
export const FxKind = {
  /** Bright, fast, gone in an eighth of a second: a round landing. */
  Spark: 0,
  /** Orange, slower, thrown in an arc by a body coming apart. */
  Ember: 1,
  /** Dark, big, rises: the column over a blast. */
  Smoke: 2,
  /** The thin bright line a round leaves behind, and a healer's pulse. */
  Trail: 3,
} as const;

export type FxKindId = (typeof FxKind)[keyof typeof FxKind];

/**
 * The particle and light fields.
 *
 * `z` is height above the floor, not a third ground axis: the world is a plane and the
 * renderer maps its y to three's -z. A spark needs a height to look like a spark; a
 * fourth ground coordinate would be a world the simulation does not have.
 */
export interface EffectField {
  readonly cap: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  /** Seconds of life left. At or below zero the slot is open. */
  readonly life: Float32Array;
  /** The life it started with, so the draw can fade by age without a second array. */
  readonly span: Float32Array;
  /** Width across, in metres. */
  readonly size: Float32Array;
  readonly kind: Uint8Array;
  /** Where the next particle lands. */
  head: number;
  /** Live slots, counted as they are written and spent. */
  count: number;
  /** Absolute position in the event stream; this consumer's own cursor. */
  read: number;
  /** Events this consumer never saw because the ring wrapped past them. */
  dropped: number;
  /** Bursts turned down because the tick's spawn budget ran out. */
  starved: number;

  /** Lights lit right now, at or below `LIGHT_CAP`. */
  lightCount: number;
  readonly lightX: Float32Array;
  readonly lightY: Float32Array;
  /** Height of a light above the floor, in metres. */
  readonly lightZ: Float32Array;
  /** Relative brightness, 0..1, already faded by age. */
  readonly lightPower: Float32Array;
  readonly lightLife: Float32Array;
  readonly lightSpan: Float32Array;
  /** What kind of light it is, for the colour: 1 muzzle, 2 blast, 3 other. */
  readonly lightKind: Uint8Array;
}

/**
 * Deterministic scatter from one integer, good enough to make a burst look scattered.
 *
 * Deliberately not `world.rng`: the random stream belongs to gameplay — weapons, waves
 * and the chapter arc draw from it — so a decorative burst taking numbers would shift
 * every one of those draws, which is how a cosmetics change breaks a determinism test.
 * A hash of the slot and the tick scatters the same way to the eye and cannot touch the
 * stream.
 */
function spread(n: number): number {
  let h = (n * 374761393) | 0;
  h = (h + (h >> 13)) | 0;
  h = (h * 1274126177) | 0;
  h = (h + (h >> 16)) | 0;
  return (h & 0xffff) / 0xffff;
}

export function createEffects(): EffectField {
  return {
    cap: PARTICLE_CAP,
    x: new Float32Array(PARTICLE_CAP),
    y: new Float32Array(PARTICLE_CAP),
    z: new Float32Array(PARTICLE_CAP),
    vx: new Float32Array(PARTICLE_CAP),
    vy: new Float32Array(PARTICLE_CAP),
    vz: new Float32Array(PARTICLE_CAP),
    life: new Float32Array(PARTICLE_CAP),
    span: new Float32Array(PARTICLE_CAP),
    size: new Float32Array(PARTICLE_CAP),
    kind: new Uint8Array(PARTICLE_CAP),
    head: 0,
    count: 0,
    read: 0,
    dropped: 0,
    starved: 0,
    lightCount: 0,
    lightX: new Float32Array(LIGHT_CAP),
    lightY: new Float32Array(LIGHT_CAP),
    lightZ: new Float32Array(LIGHT_CAP),
    lightPower: new Float32Array(LIGHT_CAP),
    lightLife: new Float32Array(LIGHT_CAP),
    lightSpan: new Float32Array(LIGHT_CAP),
    lightKind: new Uint8Array(LIGHT_CAP),
  };
}

/** Put one particle in the ring, overwriting the oldest when the field is full. */
function emit(
  f: EffectField,
  kind: number,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  life: number,
  size: number,
): void {
  const i = f.head;
  // Overwriting a live slot leaves `count` where it was; opening a dead one raises it.
  if (f.life[i] <= 0) f.count++;
  f.kind[i] = kind;
  f.x[i] = x;
  f.y[i] = y;
  f.z[i] = z;
  f.vx[i] = vx;
  f.vy[i] = vy;
  f.vz[i] = vz;
  f.life[i] = life;
  f.span[i] = life;
  f.size[i] = size;
  f.head = (i + 1) % f.cap;
}

/** A radial burst of `n` particles at one point, scattered by `spread`. */
function burst(
  w: World,
  kind: number,
  n: number,
  x: number,
  y: number,
  z: number,
  speed: number,
  life: number,
  size: number,
  up: number,
): void {
  const f = w.fx;
  const seed = w.tick * 7 + (((x * 131) | 0) ^ ((y * 977) | 0));
  for (let k = 0; k < n; k++) {
    const a = spread(seed + k * 131) * Math.PI * 2;
    const s = speed * (0.35 + spread(seed + k * 131 + 1) * 0.65);
    emit(
      f,
      kind,
      x,
      y,
      z,
      Math.cos(a) * s,
      Math.sin(a) * s,
      spread(seed + k * 131 + 2) * up,
      life,
      size,
    );
  }
}

/**
 * A hit's fan: sparks thrown back along the path the round came from.
 *
 * The direction comes from the shot still in the pool this tick, so a hit reads as
 * coming from the gun that made it; a hit with no round behind it (a beam, a chain
 * arc) has no path and gets a ring instead of a fan.
 */
function fan(
  w: World,
  n: number,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  life: number,
  size: number,
): void {
  const f = w.fx;
  const seed = w.tick * 7 + (((x * 131) | 0) ^ ((y * 977) | 0));
  const len = Math.sqrt(dx * dx + dy * dy);
  const bx = len > 1e-4 ? -dx / len : 0;
  const by = len > 1e-4 ? -dy / len : 0;
  for (let k = 0; k < n; k++) {
    const fan2 = (spread(seed + k * 71) - 0.5) * 1.4;
    const s = 3 + spread(seed + k * 71 + 1) * 5;
    const cos = Math.cos(fan2);
    const sin = Math.sin(fan2);
    const vx = len > 1e-4 ? (bx * cos - by * sin) * s : (spread(seed + k * 71) - 0.5) * 2 * s;
    const vy = len > 1e-4 ? (bx * sin + by * cos) * s : (spread(seed + k * 71 + 3) - 0.5) * 2 * s;
    emit(f, FxKind.Spark, x, y, z, vx, vy, 0.4 + spread(seed + k * 71 + 2) * 1.6, life, size);
  }
}

/**
 * Queue an emitter for this tick's pick.
 *
 * A light is born with its brightness and its lifetime, and the pick decides whether it
 * gets a slot at all. `kind` is the colour role: a muzzle is a hard white-cyan point, a
 * blast is a wide orange one.
 */
function offerLight(w: World, x: number, y: number, z: number, power: number, life: number, kind: number): void {
  const f = w.fx;
  // Score a candidate the way the pick will: brighter and closer wins, distance squared
  // because a light's reach falls off roughly that fast.
  const dx = x - w.player.x;
  const dy = y - w.player.y;
  const score = power / (1 + dx * dx + dy * dy);

  // Find the slot to spend: the first faded one, else the weakest.
  let slot = -1;
  let worst = Infinity;
  let weakest = -1;
  for (let i = 0; i < LIGHT_CAP; i++) {
    if (f.lightLife[i] <= 0) {
      slot = i;
      break;
    }
    const lx = f.lightX[i] - w.player.x;
    const ly = f.lightY[i] - w.player.y;
    const s = (f.lightPower[i] * (f.lightLife[i] / f.lightSpan[i])) / (1 + lx * lx + ly * ly);
    if (s < worst) {
      worst = s;
      weakest = i;
    }
  }
  if (slot < 0) {
    // All sixteen are lit. A burst across the arena does not deserve to kill the flash
    // three metres from the player, which is the whole reason there is a pick.
    if (!(score > worst) || weakest < 0) return;
    slot = weakest;
  } else {
    // Re-counting a slot that already holds a light would drift `lightCount` upward;
    // only opening a dead slot changes it, exactly as `emit` does for a particle.
    f.lightCount++;
  }

  f.lightX[slot] = x;
  f.lightY[slot] = y;
  f.lightZ[slot] = z;
  f.lightPower[slot] = power;
  f.lightLife[slot] = life;
  f.lightSpan[slot] = life;
  f.lightKind[slot] = kind;
}

/**
 * Turn this tick's events into particles and lights, then move what is already flying.
 *
 * Three passes, and the order is the point:
 *
 * 1. The event stream since the last tick becomes bursts. `read` is the field's own
 *    cursor into the ring, so a burst is emitted once even though the ring is a
 *    broadcast, and events lost to a wrap are counted rather than silently skipped.
 * 2. Every light still alive gives up a tick of life, so a light that is not refreshed
 *    goes out on its own and its slot becomes available to whatever happens next.
 * 3. Everything still in the air is moved and aged. Ageing last means a particle
 *    spawned this tick shows a frame of travel instead of sitting still for one.
 *
 * The spawn budget is what keeps the cost bounded: a tick that resolves sixty explosions
 * would otherwise ask for eight hundred particles, and a field that spends its whole
 * capacity on one frame shows the player nothing new on the next four.
 */
export function updateFx(w: World): void {
  const f = w.fx;
  const e = w.events;

  // Pass 1: the stream. `written` is the total number of events ever pushed, so the
  // unread window is [written - count, written) and a wrap that ate the front of it
  // shows up in `dropped` instead of as a quiet gap in the picture.
  const total = e.written;
  let from = f.read;
  const oldest = total - e.count;
  if (from < oldest) {
    f.dropped += oldest - from;
    from = oldest;
  }
  let budget = SPAWN_BUDGET;

  for (let at = from; at < total; at++) {
    const slot = at % e.cap;
    const type = e.type[slot];
    if (type === Ev.Hit) {
      if (budget < 5) {
        f.starved++;
        continue;
      }
      const shot = e.a[slot];
      let sx = 0;
      let sy = 0;
      if (shot >= 0 && shot < w.shots.cap && w.shots.alive[shot] !== 0) {
        sx = w.shots.vx[shot];
        sy = w.shots.vy[shot];
      }
      fan(w, 5, e.x[slot], e.y[slot], 0.55, sx, sy, 0.13, 0.1);
      budget -= 5;
    } else if (type === Ev.Kill) {
      if (budget < 9) {
        f.starved++;
        continue;
      }
      // Slower, orange and thrown upward than a hit: DESIGN.md's "bright pop", which
      // has to stay distinguishable from a hit across a crowd of both.
      burst(w, FxKind.Ember, 9, e.x[slot], e.y[slot], 0.4, 3.4, 0.55, 0.16, 4.5);
      budget -= 9;
    } else if (type === Ev.Explosion) {
      if (budget < 22) {
        f.starved++;
        continue;
      }
      const r = e.b[slot] / 10;
      burst(w, FxKind.Ember, 14, e.x[slot], e.y[slot], 0.3, 5 + r, 0.5, 0.34, 5);
      burst(w, FxKind.Smoke, 8, e.x[slot], e.y[slot], 0.9, 1.2, 1.4, 0.9, 1.4);
      budget -= 22;
      offerLight(w, e.x[slot], e.y[slot], 1.4, 1, 0.34, 2);
    } else if (type === Ev.Shot) {
      // One light per shot at the barrel. An SMG puts out twelve a second and the rig
      // holds sixteen, so the pick — not this loop — is what decides who is a light.
      offerLight(w, e.x[slot], e.y[slot], 1.15, 0.55, 0.08, 1);
    } else if (type === Ev.Heal) {
      if (budget < 6) {
        f.starved++;
        continue;
      }
      burst(w, FxKind.Trail, 6, e.x[slot], e.y[slot], 0.5, 1.1, 0.7, 0.22, 1.2);
      budget -= 6;
    }
  }
  f.read = total;

  // Pass 2: age the lights. Brightness the renderer reads is the slot's power times the
  // fraction of life left, so a flash fades on its own without a second clock.
  let live = 0;
  for (let i = 0; i < LIGHT_CAP; i++) {
    if (f.lightLife[i] <= 0) continue;
    f.lightLife[i] -= DT;
    if (f.lightLife[i] > 0) live++;
  }
  f.lightCount = live;

  // Pass 3: integrate. Drag on the ground axes and a light gravity on the height, so an
  // ember arcs and lands instead of drifting up forever. No per-kind branch is needed
  // to make the four kinds look different — the difference is in what each was born
  // doing, which is cheaper to write and cheaper to run.
  const cap = f.cap;
  const drag = 1 - 3.2 * DT;
  const gravity = -9.8 * DT;
  for (let i = 0; i < cap; i++) {
    const life = f.life[i];
    if (life <= 0) continue;
    const left = life - DT;
    if (left <= 0) {
      f.life[i] = 0;
      f.count--;
      continue;
    }
    f.life[i] = left;
    f.x[i] = f.x[i] + f.vx[i] * DT;
    f.y[i] = f.y[i] + f.vy[i] * DT;
    let vz = (f.vz[i] + gravity) * drag;
    let z = f.z[i] + vz * DT;
    if (z < 0.02) {
      // Sparks skid along the floor rather than sinking through it. The renderer could
      // clamp instead, but then every backend would need its own copy of the rule.
      z = 0.02;
      vz = 0;
    }
    f.z[i] = z;
    f.vx[i] *= drag;
    f.vy[i] *= drag;
    f.vz[i] = vz;
  }
}
