import { describe, expect, it } from 'vitest';

import { pickTier, pixelRatioFor, profileFor } from '../../src/render/quality';

/**
 * The quality tier: which one a machine gets, and what it buys.
 *
 * The three files this one was cut in two with — `feel.test.ts` for the shake and the post chain,
 * `particles.test.ts` for the spark field, `damageNumbers.test.ts` and `numberPool.test.ts` for the
 * floating numbers — hold the layers the tier spends its budget on. What is left here is the table
 * and the picker, whose mistakes are invisible in a screenshot: a tier that picks High on a software
 * rasteriser draws one frame every second, and nothing in the picture says why.
 *
 * The expected values come out of TECH.md's `pickTier` rules and DESIGN.md's three tiers rather than
 * from what the code happens to produce, which is the only way a wrong constant is caught rather than
 * blessed.
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

