/**
 * The floor you can see: cover, walls and hazards, drawn from the same fields the
 * simulation collides against.
 *
 * This matters more than it looks. The simulation refuses a move by testing the swept
 * segment against `world.props` and charges you for standing in `world.zones`; if the
 * picture is not built from those exact numbers, the player is fighting a different
 * room than the one they can see — a wall you can walk through is a bug, and a wall you
 * cannot shoot over that the sim lets your rounds through is the same bug wearing a hat.
 * So both layers read the sim's own arrays, and the heights below are the only
 * invention in the file.
 *
 * Props are static: a chapter installs its layout once and the instanced matrices are
 * rewritten when that happens, not every frame. Hazards pulse, so the crusher's warning
 * disc is rewritten every frame — that is the telegraph, and a telegraph that does not
 * move is scenery.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  type Object3D,
} from 'three/webgpu';

import { PROP_KIND_COUNT, PropKind, ZoneKind, type PropField, type ZoneField } from '../sim/systems/obstacles';
import type { World } from '../sim/world';

import type { Quality } from './renderer';

/**
 * How high each prop reads, in metres. Collision is identical; only the silhouette differs.
 * One entry per `PropKind`, which is also how many instanced batches the room costs.
 */
const HEIGHTS: readonly number[] = [3.2, 1.1, 1.7, 2.8];

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
  /** Rebuild the static layers if the floor changed and re-pulse the hazard tells. */
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

/** Write an axis-aligned box instance from the prop field's corners. */
function writeBox(layer: DiscLayer, x: number, y: number, w: number, h: number, height: number): void {
  const o = layer.mesh.count * 16;
  if (o + 16 > layer.matrix.length) return;
  layer.matrix[o] = w;
  layer.matrix[o + 5] = height;
  layer.matrix[o + 10] = h;
  layer.matrix[o + 12] = x + w / 2;
  layer.matrix[o + 13] = height / 2;
  layer.matrix[o + 14] = -(y + h / 2);
  layer.mesh.count++;
}

/**
 * Build the cover and hazard layers for one scene.
 *
 * The three prop materials exist because the three prop kinds answer differently to the
 * eye — a crate is something you shoot over and a wall is not — and one instanced batch
 * per material is what keeps that to three draw calls for a whole arena.
 */
export function createSceneryView(scene: Object3D, world: World, quality: Quality): SceneryView {
  const propCap = world.props.kind.length;
  const zoneCap = world.zones.kind.length;

  /** One batch per prop kind, so a chapter's whole room costs one draw per look. */
  const propLayers: DiscLayer[] = [];
  for (let kind = 0; kind < PROP_KIND_COUNT; kind++) {
    // A pillar is the one round prop, and it is drawn as the shape that stops you: the
    // cylinder's unit diameter matches the scale `writeBox` writes from the prop's own
    // bounding box, so the sim's circle and the drawn column are the same circle.
    const mesh = new InstancedMesh(
      kind === PropKind.Pillar ? new CylinderGeometry(0.5, 0.5, 1, 14) : new BoxGeometry(1, 1, 1),
      new MeshStandardNodeMaterial({
        color:
          kind === PropKind.Wall
            ? 0x2f3440
            : kind === PropKind.Crate
              ? 0x4a3a28
              : kind === PropKind.Pillar
                ? 0x4a505c
                : 0x37424e,
        roughness: 0.75,
        metalness: kind === PropKind.Tank ? 0.35 : 0.05,
      }),
      propCap,
    );
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = quality !== 'low';
    mesh.receiveShadow = quality !== 'low';
    mesh.visible = false;
    scene.add(mesh);
    propLayers.push({ mesh, matrix: mesh.instanceMatrix.array as Float32Array, cap: propCap });
  }

  const acid = makeDisc(scene, 0x35e08a, 0.5, zoneCap);
  const tell = makeDisc(scene, 0xff2a3c, 0.75, zoneCap);

  let lastChapter = -1;
  let lastProps = -1;
  let lastZones = -1;

  /** Repack the cover from `props`. Only runs when the floor under the player changed. */
  function rebuildProps(f: PropField): void {
    for (let l = 0; l < propLayers.length; l++) propLayers[l].mesh.count = 0;

    for (let i = 0; i < f.n; i++) {
      const kind = f.kind[i] < PROP_KIND_COUNT ? f.kind[i] : 0;
      const layer = propLayers[kind];
      const x = f.x0[i];
      const y = f.y0[i];
      const w = f.x1[i] - x;
      const h = f.y1[i] - y;
      writeBox(layer, x, y, w, h, HEIGHTS[kind] ?? 2);
    }

    for (let l = 0; l < propLayers.length; l++) {
      const layer = propLayers[l];
      layer.mesh.visible = layer.mesh.count > 0;
      if (layer.mesh.count > 0) layer.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Repack the hazard rings, including how far into its warning each crusher is. */
  function rebuildZones(z: ZoneField): void {
    acid.mesh.count = 0;
    tell.mesh.count = 0;

    for (let i = 0; i < z.n; i++) {
      const r = z.r[i] * RING_PAD;
      if (z.kind[i] === ZoneKind.Acid) {
        writeDisc(acid, z.x[i], z.y[i], r, DISC_LIFT);
      } else if (z.gap[i] > 0 && z.t[i] <= z.warn[i]) {
        // The ring grows into the plate instead of fading in: a hazard you are asked to
        // answer has to be readable at the camera height, and growth reads at a distance
        // that opacity does not.
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
      const f = world.props;
      const z = world.zones;

      // A chapter swap replaces the room; nothing else does, and the compare that says
      // "nothing else" is three numbers rather than a walk over the floor.
      if (world.chapter !== lastChapter || f.n !== lastProps) {
        lastChapter = world.chapter;
        lastProps = f.n;
        rebuildProps(f);
        lastZones = -1;
      }
      if (z.n !== lastZones) {
        lastZones = z.n;
        rebuildZones(z);
        return;
      }
      // Crushers pulse, so their discs are rewritten while a chapter is on the floor.
      if (z.n > 0) rebuildZones(z);
    },
  };
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
