/**
 * The geometry toolkit: how a recipe written as parts becomes one faceted buffer.
 *
 * ## Merging
 *
 * `mergeGeometries` refuses a mix of indexed and non-indexed inputs, and the polyhedra
 * (`Octahedron`, `Icosahedron`) are non-indexed while the lathes and spheres are not, so
 * every piece is flattened to non-indexed first. That is also what makes the bodies read as
 * faceted low-poly rather than as smooth blobs: normals recomputed over a non-indexed mesh
 * are per-triangle.
 */

import { BoxGeometry, type BufferGeometry, CylinderGeometry } from 'three/webgpu';

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** One geometry pair: the dark body and the emissive pieces that sit on it. */
export interface HordeMesh {
  /** The matte body, with its feet at y = 0. */
  body: BufferGeometry;
  /** The glowing accents, in the same space, drawn with the glow material. */
  core: BufferGeometry;
}

/** A piece of a mesh: its geometry and where it sits. */
export type Piece = readonly [BufferGeometry, number, number, number];

/** Drop the index so a whole mesh merges, and stays mergeable. */
export function flat(geometry: BufferGeometry): BufferGeometry {
  return geometry.index === null ? geometry : geometry.toNonIndexed();
}

/**
 * Merge pieces into one faceted geometry, translated so the feet land at y = 0.
 *
 * Each recipe is authored at the size of the archetype that uses it — a swarmling cloud stays
 * a cloud and a boss stays a boss — so a batch only has to scale its instances uniformly by
 * the collision radius and the proportions come from the recipe.
 */
export function build(pieces: readonly Piece[]): BufferGeometry {
  const merged = mergeGeometries(pieces.map((p) => flat(p[0]).translate(p[1], p[2], p[3])), false);
  if (merged === null) throw new Error('meshes: merge failed');
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/** A box, named so the recipes read as parts and not as primitive calls. */
export function boxSegment(w: number, h: number, d: number): BufferGeometry {
  return new BoxGeometry(w, h, d);
}

/** A leg: a tapered strut, tilted outward so a quadruped does not look like a table. */
export function leg(radius: number, length: number, tilt: number, x: number, z: number): Piece {
  return [new CylinderGeometry(radius, radius * 0.6, length, 4).rotateZ(tilt), x, length / 2, z];
}

/** How many triangles one geometry costs a draw. */
export function triangleCount(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  return index !== null ? index.count / 3 : Math.floor((position?.count ?? 0) / 3);
}
