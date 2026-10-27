import { describe, expect, it } from 'vitest';

import { Scene, type BufferAttribute, type InstancedMesh } from 'three/webgpu';

import { createEffects } from '../../src/sim/fx';
import { createParticles } from '../../src/render/particles';
import { profileFor } from '../../src/render/quality';

/**
 * The spark field: four instanced batches, and the two ways they get filled.
 *
 * Cut out of `quality.test.ts` with the file too big to read at once; nothing changed but where
 * these live. What they are worth is the parity between the paths — TECH.md's "the GPU path is a
 * cosmetic upgrade, not a different game" — so the axis-flip and the same-place-either-way checks
 * are the ones to keep, and each cap check is a stutter that never happens.
 */

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
