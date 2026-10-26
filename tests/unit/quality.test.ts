import { describe, expect, it } from 'vitest';

import { PerspectiveCamera, Scene, type BufferAttribute, type InstancedMesh } from 'three/webgpu';

import { createEffects } from '../../src/sim/fx';
import { Ev, createWorld, pushEvent } from '../../src/sim/world';
import {
  MERGE_RADIUS,
  NUMBER_BUDGET,
  NUMBER_CAP,
  NUMBER_LIFE,
  NUMBER_RISE,
  advanceNumbers,
  createNumberPool,
  createNumbers,
  pushNumber,
  readNumberEvents,
} from '../../src/render/damageNumbers';
import { createParticles } from '../../src/render/particles';
import { createPost, PUNCH_TIME } from '../../src/render/post';
import { pickTier, pixelRatioFor, profileFor } from '../../src/render/quality';
import { DECAY, DEFAULT_SCALE, MAX_TRAUMA, SHAKE_GAIN, createShake, shakeOffset } from '../../src/render/shake';

/**
 * The render layer's two numbers-and-tables files, driven in plain Node (TECH.md
 * "Simulation and rendering": nothing in here may need a canvas).
 *
 * Two of the five files in this step are tables and maths — the quality tier and the camera's
 * trauma — and they are the two whose mistakes are invisible in a screenshot: a tier that picks
 * High on a software rasteriser, or a shake whose decay is wrong, both look like a picture. The
 * other two are pools with a cap and a lifetime, and a cap that is not enforced is a stutter
 * three scenes from now. So all four get pinned here, plus the two engine-shaped guards that a
 * unit test can reach without a GPU: the post chain's "it threw, take it out" path and the
 * particle view's CPU fallback.
 *
 * `shakeOffset`'s expected values are worked out of the formula in `DESIGN.md` rather than from
 * what the code happens to produce, which is the only way a wrong constant in that formula is
 * caught rather than blessed.
 */

// ---------------------------------------------------------------------------
// tier choice
// ---------------------------------------------------------------------------

describe('the tier the machine gets', () => {
  it('gives a software rasteriser Low, even one hiding behind the word Vulkan', () => {
    // This box, and every CI box without a GPU: SwiftShader reports itself through the Vulkan
    // entry point. TECH.md wants Low there, and the name check has to win over the backend.
    expect(pickTier({ backend: 'webgpu', gpuName: 'ANGLE (Vulkan, SwiftShader Device (LLVM 10.0.0), Vulkan 1.3)' })).toBe('low');
    expect(pickTier({ backend: 'webgpu', gpuName: 'llvmpipe (LLVM 17.0, 256 bits)' })).toBe('low');
    expect(pickTier({ backend: 'webgl2', gpuName: 'SwiftShader' })).toBe('low');
  });

  it('gives named hardware on WebGPU High, and Ultra only when the rest of the machine agrees', () => {
    // A named adapter is one piece of evidence, not the whole decision: on its own it buys
    // High, which is what a machine that cannot tell us anything else gets.
    expect(pickTier({ backend: 'webgpu', gpuName: 'NVIDIA RTX 3060' })).toBe('high');
    expect(pickTier({ backend: 'webgpu', gpuName: 'Apple M2' })).toBe('high');
    expect(pickTier({ backend: 'webgpu', gpuName: 'Adreno (TM) 750' })).toBe('high');
    // The top tier wants four: the top backend, a named adapter, a machine that is not a
    // handheld and at least 16 GiB of memory.
    expect(
      pickTier({ backend: 'webgpu', gpuName: 'NVIDIA RTX 4090', deviceKind: 'desktop', memory: 32 }),
    ).toBe('ultra');
    // And each piece is load-bearing: take any one away and it is back to High.
    expect(
      pickTier({ backend: 'webgpu', gpuName: '', deviceKind: 'desktop', memory: 32 }),
    ).toBe('medium');
    expect(
      pickTier({ backend: 'webgl2', gpuName: 'NVIDIA RTX 4090', deviceKind: 'desktop', memory: 32 }),
    ).toBe('medium');
    expect(
      pickTier({ backend: 'webgpu', gpuName: 'NVIDIA RTX 4090', deviceKind: 'mobile', memory: 32 }),
    ).toBe('medium');
    expect(
      pickTier({ backend: 'webgpu', gpuName: 'NVIDIA RTX 4090', deviceKind: 'desktop', memory: 8 }),
    ).toBe('medium');
    // A browser that will not say what kind of machine it is does not get the top tier either:
    // `unknown` is treated as a desktop for the clamps and as no evidence for the promotion.
    expect(pickTier({ backend: 'webgpu', gpuName: 'NVIDIA RTX 4090', memory: 32 })).toBe('high');
  });

  it('gives an adapter that will not identify itself Medium', () => {
    // "Med when unsure" (TECH.md). An empty or blank description is the unsure case, and the
    // one that catches a driver with `WEBGL_debug_renderer_info` blocked.
    expect(pickTier({ backend: 'webgpu', gpuName: '' })).toBe('medium');
    expect(pickTier({ backend: 'webgpu', gpuName: '   ' })).toBe('medium');
    // Memory and a desktop shape do not lift the unsure case: the adapter name is the gate.
    expect(pickTier({ backend: 'webgpu', gpuName: '', deviceKind: 'desktop', memory: 32 })).toBe('medium');
  });

  it('never starts the WebGL2 path above Medium', () => {
    // The fallback backend is where the older machines live, so it starts one notch down
    // whatever it reports — including a name that would otherwise earn High.
    expect(pickTier({ backend: 'webgl2', gpuName: 'NVIDIA RTX 3060' })).toBe('medium');
    expect(pickTier({ backend: 'webgl2', gpuName: 'ANGLE (AMD Radeon Graphics, Direct3D11 vs_5_0 ps_5_0)' })).toBe('medium');
    expect(
      pickTier({ backend: 'webgl2', gpuName: 'NVIDIA RTX 4090', deviceKind: 'desktop', memory: 32 }),
    ).toBe('medium');
  });

  it('gives a machine with neither backend Low', () => {
    expect(pickTier({ backend: 'none', gpuName: 'NVIDIA RTX 3060' })).toBe('low');
  });

  it('keeps a handheld under the desktop tiers', () => {
    // A phone's Adreno names itself, so the device kind is the only thing standing between it
    // and a 2048px shadow map, and a phone that runs hot is a phone that stops at ten frames.
    expect(pickTier({ backend: 'webgpu', gpuName: 'Adreno (TM) 750', deviceKind: 'mobile' })).toBe('medium');
    expect(pickTier({ backend: 'webgpu', gpuName: 'Apple A17 Pro', deviceKind: 'mobile', memory: 8 })).toBe('medium');
    expect(pickTier({ backend: 'webgl2', gpuName: 'Mali-G99', deviceKind: 'mobile' })).toBe('medium');
  });

  it('reads the memory the browser will say, and ignores a browser that says nothing', () => {
    expect(pickTier({ backend: 'webgpu', gpuName: 'Intel UHD 620', memory: 4 })).toBe('low');
    expect(pickTier({ backend: 'webgpu', gpuName: 'NVIDIA RTX 3060', memory: 8 })).toBe('medium');
    expect(pickTier({ backend: 'webgpu', gpuName: 'NVIDIA RTX 3060', memory: 16 })).toBe('high');
    // Junk is "nothing": 0 and a negative are both the case where `deviceMemory` is missing,
    // and a missing number must not read as a 4 GiB machine.
    expect(pickTier({ backend: 'webgpu', gpuName: 'NVIDIA RTX 3060', memory: 0 })).toBe('high');
    expect(pickTier({ backend: 'webgpu', gpuName: 'NVIDIA RTX 3060', memory: -2 })).toBe('high');
  });

  it('does not overrule the tier the player picked', () => {
    // A named tier is an instruction (`setting` in `MachineInfo`), so the rules above only run
    // for `auto`. Both directions: the weak machine asked to spend, and the strong one asked
    // to hold back.
    expect(pickTier({ backend: 'webgpu', gpuName: 'SwiftShader', setting: 'ultra' })).toBe('ultra');
    expect(
      pickTier({ backend: 'webgpu', gpuName: 'NVIDIA RTX 4090', deviceKind: 'desktop', memory: 32, setting: 'low' }),
    ).toBe('low');
    expect(pickTier({ backend: 'webgl2', gpuName: 'SwiftShader', setting: 'medium' })).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// tier profiles
// ---------------------------------------------------------------------------

describe('what each tier spends', () => {
  it('switches the expensive things off at Low', () => {
    const low = profileFor('low');
    expect(low.shadows).toBe(false);
    expect(low.shadowMapSize).toBe(0);
    expect(low.bloom).toBe(false);
    expect(low.chroma).toBe(false);
    expect(low.lamps).toBe(0);
    expect(low.pixelScale).toBeCloseTo(0.75, 6);
    expect(low.particles).toBe(512);
  });

  it('pays for shadows, bloom and lights above Low', () => {
    expect(profileFor('medium')).toMatchObject({
      shadows: true,
      shadowMapSize: 1024,
      bloom: true,
      chroma: true,
      lamps: 8,
    });
    expect(profileFor('high')).toMatchObject({
      shadows: true,
      shadowMapSize: 2048,
      bloom: true,
      chroma: true,
      lamps: 16,
      particles: 2048,
    });
    // Ultra is High's shape with bigger numbers, and the one thing it must not do is run out
    // of the field it is drawing: the sim's particle pool is 8,192 slots over four palettes.
    expect(profileFor('ultra')).toMatchObject({
      shadows: true,
      shadowMapSize: 4096,
      bloom: true,
      chroma: true,
      lamps: 16,
      particles: 4096,
    });
  });

  it('keeps the bloom threshold at 1.0 on every tier that blooms', () => {
    // DESIGN.md pins it there and `meshes.ts` builds its glow materials above 1.0 for exactly
    // that reason. The 0.72 this table used to carry caught the mid-value floor as well, which
    // is how a thousand dark bodies turn into one grey wash.
    for (const tier of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(profileFor(tier).bloomThreshold).toBe(1);
    }
  });

  it('hands out one shared table rather than a fresh copy per call', () => {
    // The draw path reads this every frame it builds a kit; a copy per call would be garbage the
    // frame has to collect, and nothing is allowed to edit a tier mid-run.
    expect(profileFor('high')).toBe(profileFor('high'));
    expect(Object.keys(profileFor('low')).sort()).toEqual(Object.keys(profileFor('high')).sort());
    // Every tier carries every key, so a knob cannot be missing on the one tier that reads it.
    for (const tier of ['medium', 'high', 'ultra'] as const) {
      expect(Object.keys(profileFor(tier)).sort()).toEqual(Object.keys(profileFor('low')).sort());
    }
  });

  it('tiers up, never sideways: every budget is at least the tier below it', () => {
    const [low, mid, high, ultra] = ['low', 'medium', 'high', 'ultra'].map((t) => profileFor(t as 'low'));
    const steps: Array<readonly [typeof low, typeof low]> = [
      [low, mid],
      [mid, high],
      [high, ultra],
    ];
    for (const [below, above] of steps) {
      for (const key of ['shadowMapSize', 'particles', 'lamps', 'chromaBase', 'chromaPunch'] as const) {
        expect(above[key]).toBeGreaterThanOrEqual(below[key]);
      }
    }
    expect(high.particles).toBeGreaterThan(low.particles);
    expect(high.lamps).toBeGreaterThan(low.lamps);
    expect(ultra.particles).toBeGreaterThan(high.particles);
    expect(ultra.shadowMapSize).toBeGreaterThan(high.shadowMapSize);
  });

  it('caps the render resolution at native and honours the settings dial', () => {
    const high = profileFor('high');
    const low = profileFor('low');
    // Low's own ceiling is 0.75 of native.
    expect(pixelRatioFor(low, 1, 1)).toBeCloseTo(0.75, 6);
    // And nothing ever renders above 1: on a 2x display the extra pixels are not on the screen,
    // they are only more of them to shade.
    expect(pixelRatioFor(high, 2, 1)).toBe(1);
    expect(pixelRatioFor(low, 2, 1)).toBe(1);
    expect(pixelRatioFor(high, 1, 2)).toBe(1);
    // The settings' scale multiplies under the tier's ceiling.
    expect(pixelRatioFor(high, 1, 0.6)).toBeCloseTo(0.6, 6);
    expect(pixelRatioFor(low, 1, 0.6)).toBeCloseTo(0.45, 6);
    // Junk in, sane out: a missing devicePixelRatio or a zero scale reads as 1, not as 0.
    expect(pixelRatioFor(high, 0, 0)).toBe(1);
  });
});

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
// damage numbers
// ---------------------------------------------------------------------------

describe('the damage-number pool', () => {
  it('is a pool of 64, fixed at build time', () => {
    // ARCHITECTURE.md's "damage numbers 64": a heavy horde spends numbers, never DOM nodes.
    const pool = createNumberPool();
    expect(pool.cap).toBe(NUMBER_CAP);
    expect(pool.count).toBe(0);
    expect(createNumberPool(4).x).toHaveLength(4);
  });

  it('refuses a number that is not damage', () => {
    const pool = createNumberPool();
    expect(pushNumber(pool, 0, 0, 0, false)).toBe(false);
    expect(pushNumber(pool, 0, 0, -5, false)).toBe(false);
    expect(pool.count).toBe(0);
  });

  it('caps at the pool and counts what it dropped', () => {
    const pool = createNumberPool(4);
    // Ten points spread far enough apart that none of them can merge.
    for (let i = 0; i < 10; i++) {
      pushNumber(pool, i * 20, 0, 10, false);
    }
    expect(pool.count).toBe(4);
    expect(pool.dropped).toBe(6);
    expect(pool.count).toBeLessThanOrEqual(pool.cap);
  });

  it('merges a hit that lands next to a number already on the way up', () => {
    // DESIGN.md: "numbers merge under a heavy horde so they never pile up into clutter". One
    // shotgun's eight pellets is one event on screen, so eight pushes must give one number.
    const pool = createNumberPool();
    for (let i = 0; i < 8; i++) {
      pushNumber(pool, 0, 0, 7, false);
    }
    expect(pool.count).toBe(1);
    expect(pool.amount[0]).toBe(56);
    expect(pool.dropped).toBe(0);
  });

  it('keeps two bodies two metres apart as two numbers', () => {
    const pool = createNumberPool();
    expect(pushNumber(pool, 0, 0, 7, false)).toBe(true);
    expect(pushNumber(pool, MERGE_RADIUS * 2, 0, 7, false)).toBe(true);
    expect(pool.count).toBe(2);
    expect(pool.amount[0]).toBe(7);
    expect(pool.amount[1]).toBe(7);
  });

  it('carries a crit into the number it merged into', () => {
    // The bigger yellow type is the whole point of merging: a crit inside a shotgun burst still
    // has to read as a crit.
    const pool = createNumberPool();
    pushNumber(pool, 0, 0, 7, false);
    pushNumber(pool, 0.2, 0.1, 40, true);
    expect(pool.count).toBe(1);
    expect(pool.crit[0]).toBe(1);
  });

  it('stops merging once the number would run past four digits', () => {
    const pool = createNumberPool();
    pushNumber(pool, 0, 0, 9_990, false);
    expect(pushNumber(pool, 0.1, 0, 20, false)).toBe(true);
    expect(pool.count).toBe(2);
    expect(pool.amount[0]).toBe(9_990);
  });

  it('rises 0.6 m over 0.6 s and then frees the slot', () => {
    const pool = createNumberPool();
    pushNumber(pool, 0, 0, 10, false);
    const start = pool.h[0];

    // Half its life: half the rise, and still alive.
    advanceNumbers(pool, NUMBER_LIFE / 2);
    expect(pool.life[0]).toBeCloseTo(NUMBER_LIFE / 2, 6);
    expect(pool.h[0]).toBeCloseTo(start + NUMBER_RISE / 2, 4);

    // All of it: the slot is free again, so a long run cannot leak numbers.
    advanceNumbers(pool, NUMBER_LIFE);
    expect(pool.life[0]).toBe(0);
    expect(pool.count).toBe(0);
  });

  it('spends nothing on a frame that ran no steps', () => {
    const pool = createNumberPool();
    pushNumber(pool, 0, 0, 10, false);
    advanceNumbers(pool, 0);
    // `life` lives in a Float32Array, so compare the value rather than its bits.
    expect(pool.life[0]).toBeCloseTo(NUMBER_LIFE, 6);
    expect(pool.h[0]).toBeCloseTo(1.05, 5);
  });

  it('drains the event ring once, and only the damage in it', () => {
    const world = createWorld(7, { eventCap: 64 });
    const pool = createNumberPool();
    pushEvent(world, Ev.Damage, 12, 0, 1, 1);
    pushEvent(world, Ev.Kill, 3, 0, 2, 2);
    pushEvent(world, Ev.Damage, 5, 1, 9, 9);

    readNumberEvents(pool, world);
    expect(pool.count).toBe(2);
    expect(pool.amount[0]).toBe(12);
    expect(pool.crit[0]).toBe(0);
    // The second event carries its crit flag in `b`.
    expect(pool.crit[1]).toBe(1);

    // The cursor moved, so a second read of a quiet ring adds nothing.
    readNumberEvents(pool, world);
    expect(pool.count).toBe(2);
  });

  it('counts what it never got, instead of guessing at it', () => {
    const world = createWorld(7, { eventCap: 8 });
    const pool = createNumberPool();
    // 40 damage events through a ring of 8, none of them read: 32 were overwritten before this
    // consumer ever looked, and that has to be a number, not a silence (AGENTS.md).
    for (let i = 0; i < 40; i++) pushEvent(world, Ev.Damage, 10, 0, i * 5, 0);
    readNumberEvents(pool, world);
    expect(pool.dropped).toBeGreaterThanOrEqual(32);

    // And past the per-frame budget the rest is dropped for the frame, not silently deferred.
    const world2 = createWorld(8, { eventCap: 64 });
    const pool2 = createNumberPool();
    for (let i = 0; i < NUMBER_BUDGET + 6; i++) pushEvent(world2, Ev.Damage, 4, 0, i * 20, 40);
    readNumberEvents(pool2, world2);
    expect(pool2.count).toBe(NUMBER_BUDGET);
    expect(pool2.dropped).toBe(6);
  });

  it('runs headless, and allocates nothing per frame', () => {
    // No host element: a unit test, a headless run. The maths still has to run — that is what
    // lets this file exist at all — and it must not grow a pool or a node as it goes.
    const layer = createNumbers(null);
    expect(layer.element).toBeNull();

    const world = createWorld(9);
    const pool = layer.pool;
    const before = { x: pool.x, y: pool.y, h: pool.h, life: pool.life, amount: pool.amount };
    const camera = new PerspectiveCamera(40, 16 / 9, 0.1, 200);
    camera.position.set(0, 15, 20);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    for (let i = 0; i < 120; i++) {
      // The ring's `b` is a number: the reader treats anything but 0 as a crit.
      pushEvent(world, Ev.Damage, 3 + (i % 7), i % 3 === 0 ? 1 : 0, (i % 11) * 1.7, (i % 5) * 2.3);
      expect(() => layer.tick(world, 1 / 30, camera, 1280, 720)).not.toThrow();
      expect(pool.count).toBeLessThanOrEqual(pool.cap);
    }

    // Same buffers, same objects, 120 frames later.
    expect(layer.pool).toBe(pool);
    expect(pool.x).toBe(before.x);
    expect(pool.y).toBe(before.y);
    expect(pool.h).toBe(before.h);
    expect(pool.life).toBe(before.life);
    expect(pool.amount).toBe(before.amount);
  });
});

// ---------------------------------------------------------------------------
// sparks
// ---------------------------------------------------------------------------

/** One live particle per slot for `n` slots, spread over the four palettes. */
function field(n: number): ReturnType<typeof createEffects> {
  const fx = createEffects();
  for (let i = 0; i < n; i++) {
    fx.kind[i] = i % 4;
    fx.life[i] = 0.2;
    fx.span[i] = 0.4;
    fx.size[i] = 0.2;
    fx.x[i] = i * 0.01;
    fx.y[i] = 0;
    fx.z[i] = 0.5;
  }
  fx.count = n;
  return fx;
}

/** The spark batches, in `createParticles`' palette order. */
function batches(scene: Scene): InstancedMesh[] {
  const out: InstancedMesh[] = [];
  scene.traverse((o) => {
    if ((o as InstancedMesh).isInstancedMesh) out.push(o as InstancedMesh);
  });
  return out;
}

describe('the spark batches', () => {
  it('draws one blob per live particle, on both paths', () => {
    for (const mode of ['gpu', 'cpu'] as const) {
      const scene = new Scene();
      const view = createParticles(scene, profileFor('high'), mode);
      view.sync(field(100));
      const drawn = batches(scene).reduce((n, mesh) => n + mesh.count, 0);
      expect({ mode, drawn }).toEqual({ mode, drawn: 100 });
    }
  });

  it('stops at the palette cap and drops the rest', () => {
    for (const mode of ['gpu', 'cpu'] as const) {
      const scene = new Scene();
      const view = createParticles(scene, profileFor('low'), mode);
      // A full field against a Low budget of 512 per palette.
      view.sync(field(8192));
      const meshes = batches(scene);
      expect(meshes).toHaveLength(4);
      for (const mesh of meshes) expect(mesh.count).toBe(512);
      expect(meshes.reduce((n, mesh) => n + mesh.count, 0)).toBe(4 * view.cap);
    }
  });

  it('ignores dead slots', () => {
    const scene = new Scene();
    const view = createParticles(scene, profileFor('high'), 'cpu');
    const fx = field(8192);
    // One live particle, everything else spent.
    for (let i = 1; i < 8192; i++) fx.life[i] = 0;
    view.sync(fx);
    const meshes = batches(scene);
    expect(meshes.reduce((n, mesh) => n + mesh.count, 0)).toBe(1);
    expect(meshes.filter((mesh) => mesh.visible)).toHaveLength(1);
  });

  it('draws nothing when the tier buys no particles', () => {
    const scene = new Scene();
    const view = createParticles(scene, { ...profileFor('low'), particles: 0 }, 'cpu');
    view.sync(field(500));
    for (const mesh of batches(scene)) {
      expect(mesh.count).toBe(0);
      expect(mesh.visible).toBe(false);
    }
  });

  it('puts one particle in the same place whichever path drew it', () => {
    // Invariant 4 (ARCHITECTURE.md): the CPU path has to be a downgrade, not a second opinion
    // about what a burst looks like. Same field in, same four numbers per particle out — the
    // gpu path keeps them as a record, the cpu path as a matrix.
    const fx = field(40);
    const gpu = new Scene();
    const cpu = new Scene();
    createParticles(gpu, profileFor('high'), 'gpu').sync(fx);
    createParticles(cpu, profileFor('high'), 'cpu').sync(fx);

    const gpuMeshes = batches(gpu);
    const cpuMeshes = batches(cpu);
    expect(gpuMeshes).toHaveLength(4);
    for (let b = 0; b < 4; b++) {
      const records = gpuMeshes[b].geometry.getAttribute('aPart');
      const matrices = cpuMeshes[b].instanceMatrix;
      expect(records).toBeTruthy();
      expect(cpuMeshes[b].count).toBe(gpuMeshes[b].count);

      for (let i = 0; i < gpuMeshes[b].count; i++) {
        const x = records.array[i * 4];
        const up = records.array[i * 4 + 1];
        const z = records.array[i * 4 + 2];
        const size = records.array[i * 4 + 3];
        // The height is the field's `z` and the second ground axis is its `y` negated: the same
        // two flips the cpu path applies to its matrix slots 13 and 14.
        expect(size).toBeGreaterThan(0);
        expect(matrices.array[i * 16 + 12]).toBeCloseTo(x, 5);
        expect(matrices.array[i * 16 + 13]).toBeCloseTo(up, 5);
        expect(matrices.array[i * 16 + 14]).toBeCloseTo(z, 5);
        expect(matrices.array[i * 16]).toBeCloseTo(size, 5);
      }
    }
  });

  it('places a known particle where the design says it is', () => {
    // One blob at x 3, 5 m above the floor, y 4: the exact four numbers of both paths, so a
    // dropped axis flip — which would bury every spark under the floor — fails here.
    const fx = createEffects();
    fx.kind[0] = 0;
    fx.life[0] = 0.3;
    fx.span[0] = 0.3;
    fx.size[0] = 0.2;
    fx.x[0] = 3;
    fx.y[0] = 4;
    fx.z[0] = 5;
    fx.count = 1;

    const scene = new Scene();
    createParticles(scene, profileFor('high'), 'cpu').sync(fx);
    const mesh = batches(scene)[0];
    expect(mesh.count).toBe(1);
    const m = mesh.instanceMatrix.array;
    expect(m[0]).toBeCloseTo(0.2, 5);
    expect(m[12]).toBeCloseTo(3, 5);
    expect(m[13]).toBeCloseTo(5, 5);
    expect(m[14]).toBeCloseTo(-4, 5);
    expect(m[15]).toBe(1);
  });

  it('gives each palette its own geometry and its own record buffer', () => {
    // The record buffer hangs off the geometry. Four batches over one geometry would be four
    // batches drawing out of whichever buffer was set last, which is one spark field of the
    // wrong colour instead of four.
    const scene = new Scene();
    createParticles(scene, profileFor('high'), 'gpu').sync(field(40));
    const meshes = batches(scene);
    const geometries = new Set(meshes.map((mesh) => mesh.geometry));
    const buffers = new Set(meshes.map((mesh) => mesh.geometry.getAttribute('aPart')?.array));
    expect(geometries.size).toBe(4);
    expect(buffers.size).toBe(4);
  });

  it('keeps smoke out of the additive batch', () => {
    // Smoke is a hole in the picture rather than a light: added, dark grey is just a dim glow.
    const scene = new Scene();
    createParticles(scene, profileFor('high'), 'gpu').sync(field(40));
    const [spark, ember, smoke, trail] = batches(scene);
    const material = (mesh: InstancedMesh) => mesh.material as { blending: number };
    expect(material(smoke!).blending).not.toBe(material(spark!).blending);
    expect(material(trail!).blending).toBe(material(ember!).blending);
  });

  it('writes to the buffer its own mesh reads', () => {
    // The parity checks above read back through the mesh, so this one pins the wiring: the
    // attribute that gets `needsUpdate` must be the one the batch wrote.
    const scene = new Scene();
    const view = createParticles(scene, profileFor('high'), 'gpu');
    view.sync(field(8));
    for (const mesh of batches(scene)) {
      const attr = mesh.geometry.getAttribute('aPart') as BufferAttribute | undefined;
      expect(attr?.version).toBe(1);
      expect(attr?.array.filter((v) => v !== 0).length).toBeGreaterThan(0);
    }
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