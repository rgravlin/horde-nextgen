/**
 * The floor's marks: the two hazards that pulse.
 *
 * This matters more than it looks. The simulation charges you for standing in `world.zones`,
 * so if the picture is not built from those exact numbers the player is fighting a different
 * room than the one they can see — a pool you cannot see is a bug, and so is a ring that lies
 * about how big the blast will be. Both layers read the sim's own arrays.
 *
 * The cover used to be drawn here too, as a box per obstacle. It is drawn by `assets.ts` now,
 * from the Kenney kit listed in ASSETS.md and scaled to the same bounds; what stays is the
 * stuff that has no model — an acid pool and a crusher's warning — drawn as flat discs, which
 * is the shape that says "floor, not wall" at the camera's height.
 *
 * Hazards pulse, so the discs are rewritten every frame while a chapter is on the floor: a
 * telegraph that does not move is scenery.
 */

import {
  AdditiveBlending,
  CircleGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicNodeMaterial,
  type Object3D,
} from 'three/webgpu';

import { ZoneKind, type ZoneField } from '../sim/systems/obstacles';
import type { World } from '../sim/world';

/** How wide each hazard's ring reads relative to its damage radius. */
const RING_PAD = 1.0;

/** Height of a hazard disc above the floor, enough to clear the floor's own depth. */
const DISC_LIFT = 0.03;

interface DiscLayer {
  mesh: InstancedMesh;
  matrix: Float32Array;
  cap: number;
}

export interface SceneryView {
  /** Re-pulse the hazard tells, and re-lay them if the floor changed. */
  sync(world: World): void;
}

function makeDisc(scene: Object3D, color: number, opacity: number, cap: number): DiscLayer {
  const mesh = new InstancedMesh(
    new CircleGeometry(1, 22).rotateX(-Math.PI / 2),
    new MeshBasicNodeMaterial({
      color,
      transparent: true,
      opacity,
      blending: opacity < 1 ? AdditiveBlending : undefined,
      depthWrite: false,
    }),
    cap,
  );
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 2;

  const matrix = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < cap; i++) matrix[i * 16 + 15] = 1;

  scene.add(mesh);
  return { mesh, matrix, cap };
}

/** Write a flat disc instance of radius `r` at (x, y), lifted `lift` above the floor. */
function writeDisc(layer: DiscLayer, x: number, y: number, r: number, lift: number): void {
  const o = layer.mesh.count * 16;
  if (o + 16 > layer.matrix.length) return;
  layer.matrix[o] = r;
  layer.matrix[o + 5] = 1;
  layer.matrix[o + 10] = r;
  layer.matrix[o + 12] = x;
  layer.matrix[o + 13] = lift;
  layer.matrix[o + 14] = -y;
  layer.mesh.count++;
}

/**
 * Build the hazard layers for one scene.
 *
 * Two batches: the pools, which are always there, and the warnings, which only exist while a
 * crusher is telling you it is about to hit.
 */
export function createSceneryView(scene: Object3D, world: World): SceneryView {
  const zoneCap = world.zones.kind.length;
  // The pool wears Hazard amber rather than acid green: DESIGN.md gives green to Heal Green — the
  // healer's aura, HP pickups and life steal — and a pool that costs you HP in the colour of the
  // thing that gives it back is two opposite meanings in one hue. The crusher's tell keeps Threat
  // Red, which is the reserved colour and the right one for a warning.
  const acid = makeDisc(scene, 0xf2b233, 0.42, zoneCap);
  const tell = makeDisc(scene, 0xff2a3c, 0.75, zoneCap);

  let lastChapter = -1;
  let lastZones = -1;

  /** Repack the hazard rings, including how far into its warning each crusher is. */
  function rebuildZones(z: ZoneField): void {
    acid.mesh.count = 0;
    tell.mesh.count = 0;

    for (let i = 0; i < z.n; i++) {
      const r = z.r[i] * RING_PAD;
      if (z.kind[i] === ZoneKind.Acid) {
        writeDisc(acid, z.x[i], z.y[i], r, DISC_LIFT);
      } else if (z.gap[i] > 0 && z.t[i] <= z.warn[i]) {
        // The ring grows into the plate instead of fading in: a hazard you are asked to answer
        // has to be readable at the camera height, and growth reads at a distance that opacity
        // does not.
        const span = z.warn[i] > 0 ? z.warn[i] : 1;
        const grow = 1 - (z.t[i] > 0 ? z.t[i] : 0) / span;
        writeDisc(tell, z.x[i], z.y[i], r * (0.35 + 0.65 * (grow < 0 ? 0 : grow > 1 ? 1 : grow)), DISC_LIFT);
      }
    }

    acid.mesh.visible = acid.mesh.count > 0;
    tell.mesh.visible = tell.mesh.count > 0;
    if (acid.mesh.count > 0) acid.mesh.instanceMatrix.needsUpdate = true;
    if (tell.mesh.count > 0) tell.mesh.instanceMatrix.needsUpdate = true;
  }

  return {
    sync(world: World): void {
      const z = world.zones;

      // A chapter swap replaces the room; nothing else does. Crushers pulse inside a room, so a
      // chapter with hazards has its discs rewritten every frame and one without pays nothing.
      if (world.chapter !== lastChapter || z.n !== lastZones) {
        lastChapter = world.chapter;
        lastZones = z.n;
      } else if (z.n === 0) {
        return;
      }
      rebuildZones(z);
    },
  };
}