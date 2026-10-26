/**
 * The sparks: the draw half of `src/sim/fx.ts`.
 *
 * The particle field is stepped in the simulation (fixed timestep, deterministic, the same run
 * headless or not) and this file only reads it, which is what lets a paused frame hold a burst
 * mid-flight and what keeps a decoration out of the game rules.
 *
 * One instanced batch per palette, packed straight out of the ring. A batch's capacity is a
 * slice of the field rather than the whole of it, and a particle whose batch is already full is
 * dropped: eight thousand bodies of one colour is not a picture anyone can read, and the drop is
 * silent because nothing downstream depends on a spark existing.
 *
 * The lamps those sparks cast used to live here too and now live in `lights.ts`, which is where
 * the argument about how many a tier can afford belongs; this file stops at drawing.
 *
 * Height is the field's `z`, which becomes three's `y`: the world is a plane and a spark needs
 * to be above it, not beside it.
 */

import {
  AdditiveBlending,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  MeshBasicNodeMaterial,
  type Object3D,
} from 'three/webgpu';

import type { EffectField } from '../sim/fx';

/** How many instances one palette may hold. See the header for what happens past it. */
const BATCH_CAP = 2048;

/** A particle's brightness falls with its age; its size falls a little less. */
const MIN_SHRINK = 0.35;

/** One palette's instanced batch. */
interface ParticleBatch {
  mesh: InstancedMesh;
  matrix: Float32Array;
  /** Instances written so far this frame. */
  n: number;
}

export interface FxView {
  /** Repack the four particle palettes out of the field. */
  sync(fx: EffectField): void;
}

/**
 * One batch per palette, built once.
 *
 * Small solid shapes rather than camera-facing quads: a quad has to be turned to the eye every
 * frame to read as a dot, which is a per-instance rotation for every particle, and a 4-faced
 * blob at 0.1–0.4 m reads the same from the game's camera height at any angle. Unlit and
 * additive for the bright palettes, so a spark is a light in the picture whether or not bloom
 * is on.
 */
function makeBatch(
  scene: Object3D,
  geometry: IcosahedronGeometry,
  color: number,
  additive: boolean,
  cap: number,
): ParticleBatch {
  const mesh = new InstancedMesh(
    geometry,
    new MeshBasicNodeMaterial({
      color,
      transparent: additive,
      blending: additive ? AdditiveBlending : undefined,
      depthWrite: !additive,
    }),
    cap,
  );
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = additive ? 4 : 3;

  const matrix = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < cap; i++) {
    const o = i * 16;
    matrix[o + 15] = 1;
  }

  scene.add(mesh);
  return { mesh, matrix, n: 0 };
}

/** Bring up the particle batches for one scene. */
export function createFxView(scene: Object3D): FxView {
  const gem = new IcosahedronGeometry(0.5, 0);
  const batches: ParticleBatch[] = [
    makeBatch(scene, gem, 0xfff1c4, true, BATCH_CAP), // Spark
    makeBatch(scene, gem, 0xff7a1a, true, BATCH_CAP), // Ember
    // Smoke is a hole in the picture rather than a light, so it keeps normal
    // blending: added, dark grey would just be a dim glow.
    makeBatch(scene, gem, 0x24262c, false, BATCH_CAP), // Smoke
    makeBatch(scene, gem, 0x9b5cff, true, BATCH_CAP), // Trail
  ];

  return {
    sync(fx: EffectField): void {
      for (let b = 0; b < batches.length; b++) batches[b].n = 0;

      for (let i = 0; i < fx.cap; i++) {
        const life = fx.life[i];
        if (life <= 0) continue;
        const batch = batches[fx.kind[i] & 3];
        if (batch.n >= BATCH_CAP) continue;

        const span = fx.span[i];
        const age = span > 0 ? life / span : 0;
        const size = fx.size[i] * (MIN_SHRINK + (1 - MIN_SHRINK) * (age > 1 ? 1 : age < 0 ? 0 : age));

        // One particle's wake is drawn where it *is*, not where it was a tick ago: the
        // field is already integrated at the fixed step, and a spark's whole life is a
        // couple of ticks, so interpolating it would smear the one thing that reads as
        // instantaneous.
        const o = batch.n * 16;
        batch.matrix[o] = size;
        batch.matrix[o + 5] = size;
        batch.matrix[o + 10] = size;
        batch.matrix[o + 12] = fx.x[i];
        batch.matrix[o + 13] = fx.z[i];
        batch.matrix[o + 14] = -fx.y[i];
        batch.n++;
      }

      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        batch.mesh.count = batch.n;
        batch.mesh.visible = batch.n > 0;
        if (batch.n > 0) batch.mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
