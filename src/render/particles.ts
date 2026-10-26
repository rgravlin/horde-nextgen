/**
 * The sparks: the draw half of `src/sim/fx.ts`.
 *
 * The particle field is stepped in the simulation (fixed timestep, deterministic, the same run
 * headless or not) and this file only reads it, which is what lets a paused frame hold a burst
 * mid-flight and what keeps a decoration out of the game rules. It also means there is no
 * particle physics left for a compute kernel to do: a spark's position, drag and gravity are
 * already paid for by the time a frame starts, and the only thing left is turning one live slot
 * into one drawn blob. That is what is done here, and it is done twice, in two widths:
 *
 * - **gpu**: one 4-float record per particle — position and width — uploaded into a
 *   per-instance attribute, with the vertex program building the transform from it. 16 bytes a
 *   particle.
 * - **cpu**: the same maths on the CPU into a 16-float instance matrix. 64 bytes a particle.
 *
 * The cpu path is the one the WebGL2 backend gets (a storage-backed instance attribute needs the
 * compute-capable backend) and the one every tier falls back to, which is the requirement
 * ARCHITECTURE invariant 4 actually makes of a GPU path: it has to be a *downgrade* to the CPU
 * path rather than a second opinion about what a burst looks like. Both paths read the field the
 * same way and drop particles at the same place, so the path cannot change the picture.
 *
 * One batch per palette, and a batch's capacity is a slice of the field rather than the whole of
 * it (`profile.particles`, four palettes): eight thousand bodies of one colour is not a picture
 * anyone can read. A particle past a full batch is dropped, silently, because nothing downstream
 * depends on a spark existing.
 *
 * Height is the field's `z`, which becomes three's `y`: the world is a plane and a spark needs
 * to be above it, not beside it.
 */

import {
  AdditiveBlending,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  type Object3D,
} from 'three/webgpu';
import { attribute, positionLocal } from 'three/tsl';

import { FxKind, type EffectField } from '../sim/fx';
import type { TierProfile } from './quality';

/** Which way this view turns a particle into geometry: `gpu` uploads a record, `cpu` a matrix. */
export type ParticleMode = 'gpu' | 'cpu';

/** How many floats one particle's record carries in gpu mode: x, height, z, width. */
const RECORD = 4;

/** A particle's width falls with its age; this is how much of it is left at the end. */
const MIN_SHRINK = 0.35;

/** The four palettes' colours, in `FxKind` order. */
const PALETTE = [0xfff1c4, 0xff7a1a, 0x24262c, 0x9b5cff] as const;

/** One palette's instanced batch, and the buffer this file writes into it. */
interface ParticleBatch {
  mesh: InstancedMesh;
  /** gpu mode: the flat `RECORD`-wide records; cpu mode: the instance matrices. */
  data: Float32Array;
  /** Instances written so far this frame. */
  n: number;
}

export interface ParticleView {
  /** Which path this view ended up on. */
  readonly mode: ParticleMode;
  /** The batch limit each palette was given, for the debug overlay and the tests. */
  readonly cap: number;
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
 *
 * In gpu mode the record replaces the transform. `NodeMaterial` folds the instance matrix into
 * `positionLocal` *before* it applies `positionNode`, so the matrices have to be identity for
 * the record to place anything: `InstancedMesh` hands back a zeroed buffer, and a zero matrix
 * multiplies the whole blob (and the record's offset with it) into the origin. Hence the seeding
 * below, which the cpu path wants too — it writes the eight slots a sized, moved blob needs and
 * needs the other eight to keep their identity values.
 *
 * The geometry belongs to this batch alone. The record buffer hangs off it, so four batches over
 * one geometry would be four batches drawing out of whichever record buffer was set last.
 */
function makeBatch(
  scene: Object3D,
  geometry: IcosahedronGeometry,
  color: number,
  additive: boolean,
  cap: number,
  mode: ParticleMode,
): ParticleBatch {
  // `NormalBlending` rather than a key holding `undefined`: three warns on a material parameter
  // that is present and undefined, once per batch, on every page load.
  const material = new MeshBasicNodeMaterial({
    color,
    transparent: additive,
    blending: additive ? AdditiveBlending : NormalBlending,
    depthWrite: !additive,
  });

  const mesh = new InstancedMesh(geometry, material, cap);
  const matrix = mesh.instanceMatrix.array as Float32Array;

  for (let i = 0; i < cap; i++) {
    const o = i * 16;
    matrix[o] = 1;
    matrix[o + 5] = 1;
    matrix[o + 10] = 1;
    matrix[o + 15] = 1;
  }

  let data: Float32Array;

  if (mode === 'gpu') {
    data = new Float32Array(cap * RECORD);
    const records = new InstancedBufferAttribute(data, RECORD);
    records.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aPart', records);
    const part = attribute('aPart', 'vec4');
    // The shape's own vertex, shrunk to the particle's width, then moved to where the particle
    // is: the same two operations the cpu path does with matrix slots 0, 5, 10 and 12-14.
    material.positionNode = positionLocal.mul(part.w).add(part.xyz);
    // Upload the seeded identities with the rest of the batch. The matrices are never written
    // again: the record carries the placement.
    mesh.instanceMatrix.needsUpdate = true;
  } else {
    // Written in place, every frame, into the buffer `InstancedMesh` already owns.
    data = matrix;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  }

  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = additive ? 4 : 3;
  scene.add(mesh);

  return { mesh, data, n: 0 };
}

/** Bring the spark batches up for one tier. */
export function createParticles(
  scene: Object3D,
  profile: TierProfile,
  mode: ParticleMode = 'gpu',
): ParticleView {
  const cap = profile.particles;
  // Twelve triangles, but a separate one each: see `makeBatch`.
  const blob = () => new IcosahedronGeometry(0.5, 0);
  const batches: ParticleBatch[] = [
    makeBatch(scene, blob(), PALETTE[FxKind.Spark], true, cap, mode),
    makeBatch(scene, blob(), PALETTE[FxKind.Ember], true, cap, mode),
    // Smoke is a hole in the picture rather than a light, so it keeps normal blending: added,
    // dark grey would just be a dim glow.
    makeBatch(scene, blob(), PALETTE[FxKind.Smoke], false, cap, mode),
    makeBatch(scene, blob(), PALETTE[FxKind.Trail], true, cap, mode),
  ];

  /** How many floats one particle takes in this mode: a record, or a whole matrix. */
  const stride = mode === 'gpu' ? RECORD : 16;

  return {
    mode,
    cap,

    sync(fx: EffectField): void {
      for (let b = 0; b < batches.length; b++) batches[b].n = 0;
      if (cap === 0) return;

      for (let i = 0; i < fx.cap; i++) {
        const life = fx.life[i];
        if (life <= 0) continue;
        const batch = batches[fx.kind[i] & 3];
        if (batch.n >= cap) continue;

        const span = fx.span[i];
        const age = span > 0 ? life / span : 0;
        const size = fx.size[i] * (MIN_SHRINK + (1 - MIN_SHRINK) * (age > 1 ? 1 : age < 0 ? 0 : age));

        // One particle's wake is drawn where it *is*, not where it was a tick ago: the field is
        // already integrated at the fixed step, and a spark's whole life is a couple of ticks,
        // so interpolating it would smear the one thing that reads as instantaneous.
        const at = batch.n * stride;
        const d = batch.data;
        if (mode === 'gpu') {
          d[at] = fx.x[i];
          d[at + 1] = fx.z[i];
          d[at + 2] = -fx.y[i];
          d[at + 3] = size;
        } else {
          d[at] = size;
          d[at + 5] = size;
          d[at + 10] = size;
          d[at + 12] = fx.x[i];
          d[at + 13] = fx.z[i];
          d[at + 14] = -fx.y[i];
        }
        batch.n++;
      }

      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const n = batch.n;
        batch.mesh.count = n;
        batch.mesh.visible = n > 0;
        if (n === 0) continue;
        if (mode === 'cpu') batch.mesh.instanceMatrix.needsUpdate = true;
        else (batch.mesh.geometry.getAttribute('aPart') as InstancedBufferAttribute).needsUpdate = true;
      }
    },
  };
}
