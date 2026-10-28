/**
 * The supply crates: an amber crate, and the column of light standing over it.
 *
 * A crate is the only thing on the floor the player is *asked to walk to* — `TUNE.chestMinDist`
 * puts the nearest one 6 m away and `updateChests` opens it on a walk-over — and before this
 * file existed it was drawn twice: as an amber dot on the radar and as an arrow on the edge
 * marker. Both of those live at the edge of the screen, which is where a crate is *not*. The
 * whole point of a crate is that you have to leave the ring you are standing in to get it, so
 * the read that has to work is the one at arm's length across the arena, and a dot on a map
 * cannot carry it. Hence a shape, in the amber those two already use, with a pillar of light
 * over it: DESIGN.md wants readable shapes lit from within and bloom kept off the enemy bodies,
 * which leaves the pickups to be the bright things on the floor.
 *
 * Two batches, and one instanced draw each. They are sized to the crate pool rather than to the
 * crowd because a crate is a *somewhere* rather than a *somebody*: the cap is 24, the spawner
 * only drops one into a pack of fourteen or more bodies, and `TUNE.chestLife` retires it after
 * thirty seconds, so a full arena holds a handful. Packing 24 slots a frame is cheaper than
 * working out which of them moved.
 *
 * Both halves read the crate's own clock. A crate spends the last `ROT` seconds of its thirty
 * shrinking toward the floor, and its pillar breathes at a rate set by how long it has been on
 * the ground, both derived from the pool's `life` rather than from a wall clock — so a frame
 * that did not step repacks exactly the numbers it repacked last frame and the picture holds
 * (TECH.md "Simulation and rendering"). Nothing here decays anything or writes a game value
 * back: the layer only reads, which is the rule every part of `render` lives by.
 */

import {
  DynamicDrawUsage,
  InstancedMesh,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three/webgpu';

import type { World } from '../sim/world';
import { flipToRender } from './instancing';
import { beaconGeometry, chestGeometry, glowMaterial } from './meshes';

/** Hazard amber (`#F2B233`): the crate and its beacon, and the radar dot beside them. */
const AMBER = 0xf2b233;

/**
 * Seconds of rot over which a crate and its pillar shrink away.
 *
 * A presentation window, not the sim's: `TUNE.chestLife` says a crate lasts thirty seconds and
 * this says the last six of them are spent telling you so. Six is roughly the time it takes to
 * decide to go somewhere and to commit to it, which is the decision a crate asks for.
 */
const ROT = 6;

/** How fast a pillar breathes, in radians per second of the crate's own countdown. */
const BEAT_RATE = 4.2;

/** How much of a pillar's radius the breath takes, either side of its rest width. */
const BEAT = 0.15;

/**
 * Draw order.
 *
 * The crate is opaque and belongs with the bodies and the cover; the pillar is additive, draws
 * no depth and belongs with the other things that add light to the picture, above the telegraph
 * shapes (a warning keeps its place) and above the dash trail. Depth *test* stays on, so the
 * bottom of the pillar is hidden by the crate it rises out of rather than smeared over it.
 */
const CRATE_ORDER = 0;
const BEACON_ORDER = 5;

/** One instanced batch of uprights, and the buffer this file writes into it. */
interface Column {
  mesh: InstancedMesh;
  /** `mesh.instanceMatrix.array`, so the repack skips the property lookup. */
  matrix: Float32Array;
  /** Instances packed so far this frame. */
  n: number;
  /** The batch's instance limit; a full batch drops what will not fit. */
  cap: number;
}

export interface ChestView {
  /** Repack the crate and the beacon from this World's crate pool. */
  sync(world: World): void;
}

/**
 * Build one instanced batch of crates' worth of uprights.
 *
 * The matrix buffer is seeded with identity because the repack writes six slots per instance
 * and the other ten have to keep their identity values for the six to make a transform.
 */
function makeColumn(
  scene: Object3D,
  geometry: BufferGeometry,
  material: Material,
  cap: number,
  order: number,
): Column {
  const mesh = new InstancedMesh(geometry, material, cap);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // Same reason the horde gives for it: the crates are spread over an arena the size of the
  // view and the batch itself never moves, so a culling sphere built from one crate at the
  // origin would either clip the crates on screen or do nothing at all.
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = order;
  scene.add(mesh);

  const matrix = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < cap; i++) {
    const o = i * 16;
    matrix[o] = 1;
    matrix[o + 5] = 1;
    matrix[o + 10] = 1;
    matrix[o + 15] = 1;
  }

  return { mesh, matrix, n: 0, cap };
}

/**
 * Write one upright: `r` across both ground axes, `h` up, standing on the floor at (`x`, `z`).
 *
 * The height is its own number rather than tied to the width the way `instancing.ts`'s `put`
 * ties them, because the two halves of this read thin independently: a crate shrinks the way a
 * crate shrinks and a beam thins the way a beam does. Neither is turned, so the four slots that
 * would carry a heading keep their identity values.
 */
function writeColumn(column: Column, x: number, z: number, r: number, h: number): void {
  if (column.n >= column.cap) return;
  const o = column.n * 16;
  const m = column.matrix;
  m[o] = r;
  m[o + 5] = h;
  m[o + 10] = r;
  m[o + 12] = x;
  m[o + 14] = z;
  column.n++;
}

/** Show a batch only while it has crates in it, and hand the frame's repack to the GPU. */
function finish(column: Column): void {
  const n = column.n;
  column.mesh.count = n;
  column.mesh.visible = n > 0;
  if (n > 0) column.mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Bring the crate layers up for one scene.
 *
 * Both batches are built at the pool's cap, so a full arena of twenty-four crates costs two
 * draws and no allocation, and an arena with none costs two invisible meshes that draw nothing.
 *
 * The pillar's gain sits under the projectiles' (2.2 to 2.6) on purpose. It is additive *and*
 * it stands in front of the crowd for the whole thirty seconds of its life: at a tracer's gain
 * a pillar reads as a white slab that hides what is behind it, and a marker that hides a
 * charger is worse than no marker.
 */
export function createChestView(scene: Object3D, world: World): ChestView {
  const cap = world.chests.cap;
  const crates = makeColumn(scene, chestGeometry(), glowMaterial(AMBER, 0.85), cap, CRATE_ORDER);
  const beacons = makeColumn(scene, beaconGeometry(), glowMaterial(AMBER, 1.6, true), cap, BEACON_ORDER);

  return {
    sync(world: World): void {
      const chests = world.chests;
      crates.n = 0;
      beacons.n = 0;

      // The pool keeps its own live tally, so an arena with no crates on it reads three array
      // lengths and writes nothing at all (AGENTS.md: no work for an empty pool).
      if (chests.count > 0) {
        for (let i = 0; i < chests.cap; i++) {
          if (chests.alive[i] === 0) continue;

          const life = chests.life[i];
          // Spent rather than counted down: a crate with four seconds left is a third the size
          // it was, which is the difference the player has to be able to see to route around it.
          const size = life < ROT ? life / ROT : 1;
          // The breath comes off the crate's own clock, offset per slot so a row of crates is
          // not one beat. Motion is what makes a thing findable at arm's length; a static
          // pillar is scenery inside a second.
          const pulse = 1 - BEAT + BEAT * (1 + Math.sin(life * BEAT_RATE + i * 0.7));

          const x = chests.x[i];
          const z = flipToRender(chests.y[i]);
          writeColumn(crates, x, z, size, size);
          writeColumn(beacons, x, z, size * pulse, size);
        }
      }

      finish(crates);
      finish(beacons);
    },
  };
}
