/**
 * Instanced batches: one InstancedMesh per enemy archetype (body plus its accent
 * core), one for the player's projectiles and one for XP shards, written straight
 * out of the World's pools every rendered frame (ARCHITECTURE.md "Module map").
 *
 * Three rules shape this file:
 *
 * - The pools are the only source. A layer scans the pool it reads and packs the
 *   live slots into a contiguous run of instance matrices, because InstancedMesh
 *   draws its first `count` instances. Nothing is allocated per frame: the matrix
 *   array is written in place and each mesh is built once at the pool's hard cap,
 *   so a full arena costs no more allocation than an empty one.
 * - Size lives in the layer, not the instance. One layer is one geometry at one
 *   size, so a body only needs its position written — six floats including the
 *   scale slots, which stay at the identity values written when the mesh was built.
 * - Positions are read at the interpolation point. The sim is one to five ticks
 *   ahead of the frame that draws it, so a body is drawn at
 *   `pos + velocity * dt * (alpha - 1)`, which lands it between where it was and
 *   where it is. That is what the accumulator's `alpha` is for (TECH.md
 *   "Simulation and rendering") and it needs no second copy of the pools.
 *
 * The world is a flat plane (x, y) and three's floor is the XZ plane, so world y
 * maps to render -z: screen-up is world-north. `flipToRender` is that rule written
 * down once, and `groundToRender` is its inverse for the mouse aim.
 */

import {
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  OctahedronGeometry,
  SphereGeometry,
  type Object3D,
} from 'three/webgpu';

import { ENEMIES } from '../content/enemies';
import { DT, type Pool, type World } from '../sim/world';

/** World y to render z. Screen-up on the three-quarter camera is world +y. */
export function flipToRender(y: number): number {
  return -y;
}

/** Render z back to world y, for a point picked off the ground plane. */
export function groundToRender(z: number): number {
  return -z;
}

/**
 * One InstancedMesh, the pool its transforms come from and its fixed size.
 * `size` is the width across, `centre` the height of the shape's middle above the
 * floor, both in metres.
 */
export interface Layer {
  pool: Pool;
  /** Archetype index this layer draws, or -1 for every live slot in the pool. */
  kind: number;
  mesh: InstancedMesh;
  /** The mesh's own matrix storage, kept here so the loop skips the property lookup. */
  matrix: Float32Array;
  size: number;
  centre: number;
}

export interface Batches {
  layers: readonly Layer[];
  /** Repack every layer from the world's pools at the given interpolation alpha. */
  sync(alpha: number): void;
}

/**
 * A glowing bead rides a dark body, so a pack reads as silhouettes plus accent
 * dots instead of one glow smear (DESIGN.md "Horde"). Bodies stay dark matte.
 */
const COREAcross = 0.55;
const COREAbove = 1.1;

function makeLayer(
  scene: Object3D,
  pool: Pool,
  kind: number,
  geometry: IcosahedronGeometry | OctahedronGeometry | SphereGeometry,
  color: number,
  emissive: boolean,
  size: number,
  centre: number,
): Layer {
  // Unlit and saturated for the emissive layers so they still read as glow with
  // bloom off (DESIGN.md: emissives stay saturated on the lowest tier). Bodies are
  // lit so the moonlight gives the crowd some shape.
  const mesh = new InstancedMesh(
    geometry,
    emissive
      ? new MeshBasicNodeMaterial({ color })
      : new MeshStandardNodeMaterial({ color, roughness: 0.85 }),
    pool.cap,
  );
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // The crowd drifts around the arena and the mesh never moves, so the culling
  // sphere computed once from the geometry would either clip it or do nothing.
  mesh.frustumCulled = false;
  mesh.castShadow = !emissive;

  const matrix = mesh.instanceMatrix.array as Float32Array;
  // Seed the identity: the per-instance write only touches the translation after
  // this, and the three scale slots are set per instance for the few shapes whose
  // size varies. Everything left over stays at the seeded value.
  for (let i = 0; i < pool.cap; i++) {
    const o = i * 16;
    matrix[o] = 1;
    matrix[o + 5] = 1;
    matrix[o + 10] = 1;
    matrix[o + 15] = 1;
  }

  scene.add(mesh);
  return { pool, kind, mesh, matrix, size, centre };
}

/** Build every batch for the world that is about to be drawn. */
export function createBatches(scene: Object3D, world: World): Batches {
  const layers: Layer[] = [];

  for (let kind = 0; kind < ENEMIES.length; kind++) {
    const radius = ENEMIES[kind].radius;
    layers.push(
      makeLayer(scene, world.enemies, kind, new IcosahedronGeometry(0.5, 0), 0x1a1c24, false, radius * 2, radius),
      makeLayer(
        scene,
        world.enemies,
        kind,
        new OctahedronGeometry(0.5, 0),
        Number.parseInt(ENEMIES[kind].accent.slice(1), 16),
        true,
        radius * COREAcross,
        radius * 2 + radius * COREAbove,
      ),
    );
  }

  layers.push(
    makeLayer(scene, world.shots, -1, new SphereGeometry(0.5, 6, 4), 0xff7a1a, true, 0.2, 0.85),
    makeLayer(scene, world.shards, -1, new OctahedronGeometry(0.5, 0), 0x9b5cff, true, 0.26, 0.2),
  );

  return { layers, sync: (alpha: number) => syncBatches(layers, alpha) };
}

/**
 * Repack every layer from the pools.
 *
 * One pass per layer over the pool's slots, lowest slot first: iteration order
 * never depends on the pool's free-list shape, so two runs at the same alpha draw
 * the same picture.
 */
export function syncBatches(layers: readonly Layer[], alpha: number): void {
  const shift = (alpha - 1) * DT;

  for (let l = 0; l < layers.length; l++) {
    const layer = layers[l];
    const pool = layer.pool;
    const matrix = layer.matrix;
    const size = layer.size;
    const centre = layer.centre;
    const kind = layer.kind;
    let n = 0;

    for (let i = 0; i < pool.cap; i++) {
      if (pool.alive[i] === 0) continue;
      if (kind >= 0 && pool.kind[i] !== kind) continue;

      const o = n * 16;
      matrix[o] = size;
      matrix[o + 5] = size;
      matrix[o + 10] = size;
      matrix[o + 12] = pool.x[i] + pool.vx[i] * shift;
      matrix[o + 13] = centre;
      matrix[o + 14] = flipToRender(pool.y[i] + pool.vy[i] * shift);
      n++;
    }

    layer.mesh.count = n;
    layer.mesh.instanceMatrix.needsUpdate = true;
  }
}
