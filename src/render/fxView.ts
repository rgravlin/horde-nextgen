/**
 * The sparks and the light they cast: the draw half of `src/sim/fx.ts`.
 *
 * The particle field is stepped in the simulation (fixed timestep, deterministic, the
 * same run headless or not) and this file only reads it, which is what lets a paused
 * frame hold a burst mid-flight and what keeps a decoration out of the game rules. Two
 * things are drawn from those arrays:
 *
 * - one instanced batch per palette, packed straight out of the ring. A batch's
 *   capacity is a slice of the field rather than the whole of it, and a particle whose
 *   batch is already full is dropped: eight thousand bodies of one colour is not a
 *   picture anyone can read, and the drop is silent because nothing downstream depends
 *   on a spark existing.
 * - a pool of point lights, refilled from the field's emitter slots every frame. A
 *   point light is expensive per *lit* fragment, so the pool is the quality knob:
 *   sixteen on High, eight on Medium, none on Low, and the lamps that are not earning
 *   their keep this frame are switched off rather than left glowing.
 *
 * Height is the field's `z`, which becomes three's `y`: the world is a plane and a
 * spark needs to be above it, not beside it.
 */

import {
  AdditiveBlending,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  MeshBasicNodeMaterial,
  PointLight,
  type Object3D,
} from 'three/webgpu';

import type { EffectField } from '../sim/fx';
import type { World } from '../sim/world';

import type { Quality } from './renderer';

/** How many instances one palette may hold. See the header for what happens past it. */
const BATCH_CAP = 2048;

/** How many lamps each tier is allowed to spend. */
const LAMPS_BY_QUALITY: Record<Quality, number> = { low: 0, medium: 8, high: 16 };

/** A particle's brightness falls with its age; its size falls a little less. */
const MIN_SHRINK = 0.35;

/** Colour roles from DESIGN.md, keyed off the field's `lightKind`. */
const MUZZLE_LIGHT = 0xbfefff;
const BLAST_LIGHT = 0xff7a2a;
const OTHER_LIGHT = 0x6ce0ff;

/** One palette's instanced batch. */
interface ParticleBatch {
  mesh: InstancedMesh;
  matrix: Float32Array;
  /** Instances written so far this frame. */
  n: number;
}

export interface FxView {
  /** Repack the particle batches and move the lamps to where the field says they go. */
  sync(world: World): void;
}

/**
 * One batch per palette, built once.
 *
 * Small solid shapes rather than camera-facing quads: a quad has to be turned to the
 * eye every frame to read as a dot, which is a per-instance rotation for every
 * particle, and a 4-faced blob at 0.1–0.4 m reads the same from the game's camera
 * height at any angle. Unlit and additive for the bright palettes, so a spark is a
 * light in the picture whether or not bloom is on.
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

/**
 * Bring up the particle batches and the lamp pool for one scene.
 *
 * The lamps are added once and then only ever moved and re-dimmed. Adding and removing
 * lights would rebuild the scene's lighting layout, which is a pipeline change, not a
 * per-frame edit — hence a fixed pool switched rather than spawned.
 */
export function createFxView(scene: Object3D, quality: Quality): FxView {
  const gem = new IcosahedronGeometry(0.5, 0);
  const batches: ParticleBatch[] = [
    makeBatch(scene, gem, 0xfff1c4, true, BATCH_CAP), // Spark
    makeBatch(scene, gem, 0xff7a1a, true, BATCH_CAP), // Ember
    // Smoke is a hole in the picture rather than a light, so it keeps normal
    // blending: added, dark grey would just be a dim glow.
    makeBatch(scene, gem, 0x24262c, false, BATCH_CAP), // Smoke
    makeBatch(scene, gem, 0x9b5cff, true, BATCH_CAP), // Trail
  ];

  const lampCount = LAMPS_BY_QUALITY[quality];
  const lamps: PointLight[] = [];
  for (let i = 0; i < lampCount; i++) {
    const light = new PointLight(OTHER_LIGHT, 0, 9, 2);
    light.castShadow = false;
    scene.add(light);
    lamps.push(light);
  }

  // Scratch for the per-frame pick, allocated with the view. Nothing in the draw path
  // allocates, and this file is no exception: two flat arrays and a hand-written
  // insertion beat a sorted map copy sixty times a second.
  const bestSlot = new Int32Array(lampCount);
  const bestScore = new Float32Array(lampCount);

  /**
   * Light the strongest emitters nearest the player.
   *
   * `power / (1 + d²)` is the same score the field used to keep sixteen candidates;
   * here it is applied again because the tier may afford fewer lamps than the field
   * holds. Distance is to the *camera's* subject (the player), which at this camera
   * height is the same thing as "nearest what the player can see".
   */
  function syncLamps(fx: EffectField, px: number, py: number): void {
    let n = 0;
    const slots = fx.lightCount < fx.lightX.length ? fx.lightCount : fx.lightX.length;

    for (let i = 0; i < slots; i++) {
      if (fx.lightLife[i] <= 0 || fx.lightPower[i] <= 0) continue;
      const dx = fx.lightX[i] - px;
      const dy = fx.lightY[i] - py;
      const score = fx.lightPower[i] / (1 + dx * dx + dy * dy);

      if (n >= lampCount) {
        if (score <= bestScore[n - 1]) continue;
        n = lampCount - 1;
      }
      let at = n;
      while (at > 0 && bestScore[at - 1] < score) {
        bestSlot[at] = bestSlot[at - 1];
        bestScore[at] = bestScore[at - 1];
        at--;
      }
      bestSlot[at] = i;
      bestScore[at] = score;
      n++;
    }

    for (let l = 0; l < lampCount; l++) {
      const light = lamps[l];
      if (l >= n) {
        if (light.intensity !== 0) light.intensity = 0;
        continue;
      }
      const i = bestSlot[l];
      const kind = fx.lightKind[i];
      const fade = fx.lightSpan[i] > 0 ? fx.lightLife[i] / fx.lightSpan[i] : 0;
      const power = fx.lightPower[i] * (fade < 0 ? 0 : fade > 1 ? 1 : fade);

      light.color.setHex(kind === 2 ? BLAST_LIGHT : kind === 1 ? MUZZLE_LIGHT : OTHER_LIGHT);
      light.distance = kind === 2 ? 15 : 7;
      light.intensity = power * (kind === 2 ? 40 : 14);
      // The field stores (x, y, height); the scene's floor is XZ, so world y is up.
      light.position.set(fx.lightX[i], fx.lightZ[i], -fx.lightY[i]);
    }
  }

  function syncParticles(fx: EffectField): void {
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
  }

  return {
    sync(world: World): void {
      const fx = world.fx;
      syncParticles(fx);
      if (lampCount > 0) syncLamps(fx, world.player.x, world.player.y);
    },
  };
}