/**
 * The shapes: one procedural low-poly geometry per enemy mesh id, the player's kit-bash,
 * the projectile shapes and the materials the horde is drawn with.
 *
 * Why procedural (DESIGN.md "Horde"): 1,000 bodies cannot be authored one at a time, and a
 * horde only reads as *silhouettes plus accent dots* — rather than as one glow smear — if
 * each archetype has a shape the eye can learn. So every body here is a handful of
 * primitives merged into one geometry of 40 to 300 triangles, and one instanced batch draws
 * every body of that shape (TECH.md "one `InstancedMesh` per enemy archetype mesh").
 *
 * Nothing in this file reads the World: it hands out geometry and materials and knows
 * nothing about who uses them.
 *
 * Bodies are dark matte and the accent pieces are unlit and saturated, so a faction reads
 * by its accent while the bodies stay out of the bloom (DESIGN.md "Palette": no bloom on
 * enemy bodies).
 *
 * ## Merging
 *
 * `mergeGeometries` refuses a mix of indexed and non-indexed inputs, and the polyhedra
 * (`Octahedron`, `Icosahedron`) are non-indexed while the lathes and spheres are not, so
 * every piece is flattened to non-indexed first. That is also what makes the bodies read as
 * faceted low-poly rather than as smooth blobs: normals recomputed over a non-indexed mesh
 * are per-triangle.
 *
 * ## The two per-instance attributes
 *
 * A body carries two numbers per instance: `aHit` (1 the tick a round lands, gone 60 ms
 * later) and `aDie` (0 alive, 1 gone), written by `instancing.ts` from the tick's hit and
 * kill events. This file only says what they do:
 *
 * - `aHit` mixes the diffuse toward white — the 60 ms pop DESIGN.md asks for;
 * - `aDie` punches holes that grow until the body is gone, so a death reads as a body coming
 *   apart rather than as a light switching off. The ember burst that fires with it lives in
 *   `sim/fx.ts` and is the other half of the effect.
 *
 * The dissolve runs through `alphaTest`, not blending, on purpose: the horde stays in the
 * opaque pass with depth writes, so two thousand bodies never have to be sorted against each
 * other, and the same node graph compiles to WGSL and to GLSL (TECH.md "Render backend").
 */

import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three/webgpu';
import { attribute, materialColor, mix, mul, mx_cell_noise_float, positionLocal, step, vec3 } from 'three/tsl';

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { WeaponFamily } from '../content/weapons';

/** One geometry pair: the dark body and the emissive pieces that sit on it. */
export interface HordeMesh {
  /** The matte body, with its feet at y = 0. */
  body: BufferGeometry;
  /** The glowing accents, in the same space, drawn with the glow material. */
  core: BufferGeometry;
}

/** A piece of a mesh: its geometry and where it sits. */
type Piece = readonly [BufferGeometry, number, number, number];

/** Drop the index so a whole mesh merges, and stays mergeable. */
function flat(geometry: BufferGeometry): BufferGeometry {
  return geometry.index === null ? geometry : geometry.toNonIndexed();
}

/**
 * Merge pieces into one faceted geometry, translated so the feet land at y = 0.
 *
 * Each recipe is authored at the size of the archetype that uses it — a swarmling cloud stays
 * a cloud and a boss stays a boss — so a batch only has to scale its instances uniformly by
 * the collision radius and the proportions come from the recipe.
 */
function build(pieces: readonly Piece[]): BufferGeometry {
  const merged = mergeGeometries(pieces.map((p) => flat(p[0]).translate(p[1], p[2], p[3])), false);
  if (merged === null) throw new Error('meshes: merge failed');
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/** A box, named so the recipes read as parts and not as primitive calls. */
function boxSegment(w: number, h: number, d: number): BufferGeometry {
  return new BoxGeometry(w, h, d);
}

/** A leg: a tapered strut, tilted outward so a quadruped does not look like a table. */
function leg(radius: number, length: number, tilt: number, x: number, z: number): Piece {
  return [new CylinderGeometry(radius, radius * 0.6, length, 4).rotateZ(tilt), x, length / 2, z];
}

/**
 * The archetypes, by mesh id.
 *
 * Every entry names a *shape*, not an archetype: two archetypes may share one (a swarmling
 * and what a splitter leaves behind are the same animal at two sizes), so a new archetype
 * that reuses a shape costs one data line. Sizes are authored in metres with the feet at
 * y = 0.
 */
const SHAPES: Record<string, () => HordeMesh> = {
  /**
   * A shard with spurs: three beads and two spines, so a cloud of forty reads as broken
   * glass rather than as dots.
   */
  mote: () => ({
    body: build(
      [
        [new OctahedronGeometry(0.2, 0), 0, 0.26, 0],
        [new OctahedronGeometry(0.13, 0), 0.14, 0.42, 0.05],
        [new OctahedronGeometry(0.12, 0), -0.13, 0.4, -0.08],
        [new ConeGeometry(0.06, 0.3, 4).rotateX(Math.PI / 2), 0, 0.28, -0.18],
        [new ConeGeometry(0.05, 0.24, 4).rotateZ(-Math.PI / 2), 0.22, 0.3, 0],
      ]
    ),
    core: build(
      [
        [new OctahedronGeometry(0.062, 0), 0, 0.3, 0.05],
        [new OctahedronGeometry(0.042, 0), -0.1, 0.36, 0.02],
      ]
    ),
  }),

  /**
   * Chaser: a low carapace on three legs, leaning forward. The silhouette is all forward
   * lean — a body that reads as "coming at you" saves the player a glance.
   */
  chaser: () => {
    const legs: Piece[] = [0, 1, 2].map((i) => {
      const a = (i * Math.PI * 2) / 3 + 0.4;
      return leg(0.055, 0.5, i === 2 ? -0.45 : 0.45, Math.cos(a) * 0.28, Math.sin(a) * 0.28);
    });
    return {
      body: build(
        [
          [new IcosahedronGeometry(0.32, 0).scale(1.15, 0.72, 1), 0, 0.66, 0],
          [new IcosahedronGeometry(0.17, 0).scale(1.3, 0.9, 1), 0.16, 0.58, 0],
          ...legs,
          [new ConeGeometry(0.09, 0.34, 4).rotateX(-Math.PI / 2), 0, 0.62, 0.36],
        ]
      ),
      // Two eyes and a back slit: the faction accent is where the light comes from, never
      // all over the body (DESIGN.md). Kept to a fifth of the carapace's width so the
      // silhouette is the first thing read and the dot is the second.
      core: build(
        [
          [new OctahedronGeometry(0.05, 0), 0.1, 0.68, 0.28],
          [new OctahedronGeometry(0.05, 0), -0.04, 0.68, 0.29],
          [new OctahedronGeometry(0.07, 0), 0, 0.84, -0.04],
        ]
      ),
    };
  },

  /**
   * Charger: a wedge with a lance. The spike is half of its telegraph — a body already
   * pointed at you says which way it is about to go.
   */
  lancer: () => ({
    body: build(
      [
        [new ConeGeometry(0.34, 0.9, 6).rotateX(Math.PI / 2), 0, 0.78, 0.22],
        [new IcosahedronGeometry(0.26, 0).scale(1, 1.2, 0.9), 0, 0.72, -0.16],
        leg(0.07, 0.6, 0.3, 0.2, 0),
        leg(0.07, 0.6, -0.3, -0.2, 0),
        [new ConeGeometry(0.07, 0.62, 4).rotateX(Math.PI / 2), 0, 1.0, 0.72],
      ]
    ),
    core: build(
      [
        [new OctahedronGeometry(0.11, 0), 0, 0.9, 0.2],
        [new OctahedronGeometry(0.07, 0), 0.16, 0.66, 0.1],
        [new OctahedronGeometry(0.07, 0), -0.16, 0.66, 0.1],
      ]
    ),
  }),

  /**
   * Exploder: a blister with vents. Round and slow-looking, because it is a bomb and the
   * player should want to shoot it early.
   */
  blister: () => ({
    body: build(
      [
        [new SphereGeometry(0.42, 6, 4).scale(1, 0.86, 1), 0, 0.5, 0],
        [new SphereGeometry(0.22, 5, 3), 0, 0.9, 0],
        leg(0.06, 0.36, 0.2, 0.26, 0.1),
        leg(0.06, 0.36, -0.2, -0.24, -0.12),
        leg(0.06, 0.36, 0.1, 0.02, -0.28),
      ]
    ),
    core: build(
      [
        [new OctahedronGeometry(0.115, 0), 0, 0.56, 0.02],
        [new OctahedronGeometry(0.05, 0), 0.22, 0.72, 0.08],
        [new OctahedronGeometry(0.05, 0), -0.2, 0.7, -0.1],
      ]
    ),
  }),

  /** Splitter: four segments with a seam, so the split it does on death is legible. */
  shell: () => ({
    body: build(
      [
        [new IcosahedronGeometry(0.34, 0).scale(1, 0.8, 1), 0, 0.36, 0],
        [new IcosahedronGeometry(0.28, 0).scale(1, 0.8, 1), 0, 0.72, -0.04],
        [new IcosahedronGeometry(0.2, 0).scale(1, 0.8, 1), 0, 1.0, -0.12],
        [boxSegment(0.1, 0.34, 0.1), 0, 0.55, 0.26],
        [boxSegment(0.1, 0.34, 0.1), 0, 0.55, -0.32],
      ]
    ),
    core: build(
      [
        [new OctahedronGeometry(0.12, 0), 0, 0.56, 0.02],
        [new OctahedronGeometry(0.08, 0), 0, 0.9, -0.06],
      ]
    ),
  }),

  /**
   * Armored: a plated hull with two slabs in front of it. The plate is the archetype's
   * whole answer (flank it), so the silhouette has to say "not from here" from across the
   * room.
   */
  plate: () => ({
    body: build(
      [
        [new CylinderGeometry(0.34, 0.42, 0.9, 7), 0, 0.72, -0.06],
        [new SphereGeometry(0.2, 5, 3), 0, 1.28, 0],
        [boxSegment(0.92, 1.06, 0.14).rotateY(0.16), 0.28, 0.78, 0.36],
        [boxSegment(0.9, 1.0, 0.14).rotateY(-0.16), -0.28, 0.76, 0.34],
        leg(0.08, 0.5, 0.12, 0.22, 0),
        leg(0.08, 0.5, -0.12, -0.22, 0),
      ]
    ),
    // The slit reads as a firing port: this thing shoots through its own shield.
    core: build(
      [
        [boxSegment(0.5, 0.08, 0.06).rotateY(0.16), 0.28, 1.02, 0.44],
        [new OctahedronGeometry(0.1, 0), 0, 0.86, -0.2],
      ]
    ),
  }),

  /** Shooter: thin, tall, with a long barrel held out in front. */
  stalk: () => ({
    body: build(
      [
        [new CapsuleGeometry(0.19, 0.62, 4, 7), 0, 0.86, 0],
        [new SphereGeometry(0.15, 5, 3), 0, 1.32, 0.02],
        [new CylinderGeometry(0.06, 0.05, 0.74, 4).rotateX(Math.PI / 2), 0.06, 1.02, 0.4],
        leg(0.055, 0.44, 0.4, 0.24, 0),
        leg(0.055, 0.44, -0.4, -0.24, 0),
      ]
    ),
    core: build(
      [
        [new OctahedronGeometry(0.08, 0), 0.06, 1.02, 0.78],
        [new OctahedronGeometry(0.06, 0), 0, 1.36, 0.12],
      ]
    ),
  }),

  /** Grenadier: a squat body with a sling arm and a pouch of something. */
  hopper: () => ({
    body: build(
      [
        [new SphereGeometry(0.38, 6, 4).scale(1, 0.9, 1.05), 0, 0.5, 0],
        [new IcosahedronGeometry(0.16, 0), 0.02, 0.98, 0.06],
        [boxSegment(0.12, 0.52, 0.12).rotateZ(-0.7), 0.34, 0.66, 0.08],
        leg(0.07, 0.4, 0.14, 0.18, 0),
        leg(0.07, 0.4, -0.14, -0.18, 0),
      ]
    ),
    core: build(
      [
        [new SphereGeometry(0.13, 5, 3), 0.44, 0.5, 0.16],
        [new OctahedronGeometry(0.07, 0), 0, 1.06, 0.04],
      ]
    ),
  }),

  /**
   * Healer: a censer that floats, with a lens underneath. It carries no weapon, so the
   * shape has to carry "support" on its own — hanging rather than standing.
   */
  censer: () => ({
    body: build(
      [
        [new SphereGeometry(0.26, 6, 4).scale(1, 1.25, 1), 0, 1.02, 0],
        [new ConeGeometry(0.22, 0.4, 6), 0, 0.66, 0],
        [new CylinderGeometry(0.03, 0.03, 0.5, 4), 0.16, 1.5, 0],
        [new CylinderGeometry(0.03, 0.03, 0.5, 4), -0.16, 1.48, 0.04],
        [new TorusGeometry(0.3, 0.045, 4, 9).rotateX(Math.PI / 2), 0, 1.34, 0],
      ]
    ),
    core: build(
      [
        [new OctahedronGeometry(0.14, 0), 0, 0.56, 0],
        [new OctahedronGeometry(0.07, 0), 0.22, 1.1, 0],
        [new OctahedronGeometry(0.07, 0), -0.22, 1.1, 0],
      ]
    ),
  }),

  /** Broodmother: a sac on eight legs with the young inside it. */
  sac: () => {
    const legs: Piece[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      legs.push(leg(0.07, 0.9, i < 4 ? 0.55 : -0.55, Math.cos(a) * 0.72, Math.sin(a) * 0.72));
    }
    return {
      body: build(
        [
          [new IcosahedronGeometry(0.78, 0).scale(1.15, 0.9, 1), 0, 1.3, -0.1],
          [new IcosahedronGeometry(0.3, 0).scale(1.2, 0.9, 1), 0.32, 0.96, 0.6],
          [new ConeGeometry(0.2, 0.5, 5).rotateX(-Math.PI / 2), 0.1, 1.1, 0.86],
          ...legs,
        ]
      ),
      // The embryos glow through the sac, which is the tell that it is still making young.
      core: build(
        [
          [new SphereGeometry(0.15, 5, 3), 0.2, 1.6, 0.24],
          [new SphereGeometry(0.12, 5, 3), -0.28, 1.44, -0.1],
          [new SphereGeometry(0.11, 5, 3), 0.02, 1.78, -0.3],
          [new OctahedronGeometry(0.1, 0), 0.34, 1.0, 0.7],
        ]
      ),
    };
  },

  /** Matron: tall, thin, with a halo. The halo is the tell for "she is aiming". */
  matron: () => ({
    body: build(
      [
        [new CapsuleGeometry(0.22, 1.0, 4, 7).scale(1, 1, 0.75), 0, 1.05, 0],
        [new SphereGeometry(0.18, 5, 3), 0, 1.78, 0.02],
        [boxSegment(0.1, 0.9, 0.1).rotateZ(0.25), 0.3, 1.1, 0.16],
        [new CylinderGeometry(0.05, 0.04, 0.6, 4).rotateX(Math.PI / 2), 0.26, 1.42, 0.42],
        leg(0.07, 0.52, 0.1, 0.16, 0),
        leg(0.07, 0.52, -0.1, -0.16, 0),
      ]
    ),
    core: build(
      [
        [new TorusGeometry(0.42, 0.05, 3, 9).rotateX(Math.PI / 2), 0, 1.92, 0],
        [new OctahedronGeometry(0.1, 0), 0.28, 1.44, 0.7],
        [new OctahedronGeometry(0.08, 0), 0, 1.82, 0.14],
      ]
    ),
  }),

  /** Atlas: a plated hulk. Taller than everything else and square where it is not round. */
  atlas: () => ({
    body: build(
      [
        [boxSegment(0.98, 1.16, 0.7).rotateY(0.1), 0, 1.32, 0],
        [boxSegment(1.5, 0.9, 0.2).rotateY(0.2), 0.42, 1.42, 0.5],
        [boxSegment(1.5, 0.9, 0.2).rotateY(-0.2), -0.42, 1.4, 0.48],
        [new SphereGeometry(0.24, 5, 3).scale(1, 0.85, 1), 0, 2.06, 0.02],
        [boxSegment(0.34, 0.34, 0.34), 0.62, 1.66, 0],
        [boxSegment(0.34, 0.34, 0.34), -0.62, 1.66, 0],
        leg(0.12, 0.66, 0.08, 0.3, 0),
        leg(0.12, 0.66, -0.08, -0.3, 0),
      ]
    ),
    core: build(
      [
        [boxSegment(0.34, 0.07, 0.05), 0.08, 2.08, 0.22],
        [boxSegment(0.34, 0.07, 0.05), -0.28, 2.08, 0.22],
        [new OctahedronGeometry(0.16, 0), 0, 1.36, -0.38],
      ]
    ),
  }),
};

/**
 * Meshes the horde can be drawn with, built once per page and cached.
 *
 * The cache matters twice: a restart rebuilds the batches, and twenty restarts should not
 * mean twenty copies of the same geometry in GPU memory.
 */
const cache = new Map<string, HordeMesh>();

/** The shape for a mesh id; an unknown id gets the chaser, which never looks wrong. */
export function hordeMesh(meshId: string): HordeMesh {
  const key = meshId in SHAPES ? meshId : 'chaser';
  let mesh = cache.get(key);
  if (mesh === undefined) {
    mesh = SHAPES[key]!();
    cache.set(key, mesh);
  }
  return mesh;
}

/** How many triangles one geometry costs a draw. */
export function triangleCount(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  return index !== null ? index.count / 3 : Math.floor((position?.count ?? 0) / 3);
}

/* ── Projectiles ───────────────────────────────────────────────────────────────── */

/**
 * A gun round: a bead stretched along its travel.
 *
 * Projectiles are drawn stretched along the direction they are going (see `instancing.ts`),
 * which is what turns a stream of rounds into the orange lanes DESIGN.md wants; a sphere at
 * 40 m/s reads as fog.
 */
export function tracerGeometry(): BufferGeometry {
  const geometry = new SphereGeometry(0.5, 5, 3).scale(0.34, 0.34, 1);
  geometry.computeBoundingSphere();
  return geometry;
}

/** An arrow: a shaft with a head, drawn stretched like a tracer. */
export function arrowGeometry(): BufferGeometry {
  const geometry = mergeGeometries(
    [
      flat(new CylinderGeometry(0.14, 0.14, 1.6, 4).rotateX(Math.PI / 2)),
      flat(new ConeGeometry(0.28, 0.5, 5).rotateX(-Math.PI / 2).translate(0, 0, 1.0)),
    ],
    false,
  );
  if (geometry === null) throw new Error('meshes: arrow merge failed');
  geometry.computeBoundingSphere();
  return geometry;
}

/** An orb: a faceted sphere, for plasma, bolts and a singularity's core. */
export function orbGeometry(): BufferGeometry {
  const geometry = new IcosahedronGeometry(0.5, 1);
  geometry.computeBoundingSphere();
  return geometry;
}

/** A grenade: a ball with a fin, so it reads as lobbed rather than as shot. */
export function grenadeGeometry(): BufferGeometry {
  const geometry = mergeGeometries(
    [
      flat(new SphereGeometry(0.5, 5, 3)),
      flat(new ConeGeometry(0.26, 0.4, 5).rotateX(Math.PI / 2).translate(0, 0, -0.55)),
    ],
    false,
  );
  if (geometry === null) throw new Error('meshes: grenade merge failed');
  geometry.computeBoundingSphere();
  return geometry;
}

/** An XP shard: a faceted crystal, flat-shaded and violet (DESIGN.md "Palette"). */
export function shardGeometry(): BufferGeometry {
  const geometry = new OctahedronGeometry(0.5, 0).scale(0.7, 1.3, 0.7);
  geometry.computeBoundingSphere();
  return geometry;
}

/* ── The player and the weapon kit ─────────────────────────────────────────────── */

/**
 * The player's body: torso, head, legs, in the same part-based idiom as the horde, so a run
 * of them reads as one art direction (DESIGN.md "Asset style").
 *
 * The player is *not* instanced — one of each, three draws — because they are the one body
 * on screen whose silhouette has to read at a glance, and a kit-bash costs nothing at one
 * instance.
 */
export function playerBody(): BufferGeometry {
  const geometry = mergeGeometries(
    [
      flat(new CapsuleGeometry(0.28, 0.56, 4, 8).scale(1.1, 1, 0.82).translate(0, 1.02, 0)),
      flat(new SphereGeometry(0.19, 6, 4).translate(0, 1.52, 0.02)),
      flat(boxSegment(0.16, 0.52, 0.16).translate(0.15, 0.28, 0)),
      flat(boxSegment(0.16, 0.52, 0.16).translate(-0.15, 0.28, 0)),
      flat(boxSegment(0.5, 0.16, 0.22).translate(0, 1.24, 0.16)),
    ],
    false,
  );
  if (geometry === null) throw new Error('meshes: player merge failed');
  geometry.computeBoundingSphere();
  return geometry;
}

/** The player's emissive trim: visor, shoulder lights, muzzle marker. */
export function playerTrim(): BufferGeometry {
  const geometry = mergeGeometries(
    [
      flat(boxSegment(0.26, 0.08, 0.06).translate(0, 1.56, 0.18)),
      flat(new OctahedronGeometry(0.07).translate(0.28, 1.26, 0.04)),
      flat(new OctahedronGeometry(0.07).translate(-0.28, 1.26, 0.04)),
      flat(new ConeGeometry(0.11, 0.34, 5).rotateX(-Math.PI / 2).translate(0.1, 1.18, 0.5)),
    ],
    false,
  );
  if (geometry === null) throw new Error('meshes: trim merge failed');
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * One kit-bash gun per family, held forward and to the right of the body.
 *
 * Three shapes rather than twenty-two because the families are what the player has to read
 * at a glance (DESIGN.md: procedural kit-bash in the family materials) and the HUD already
 * carries the exact gun name.
 */
export function weaponKit(): Record<WeaponFamily, BufferGeometry> {
  const guns = mergeGeometries(
    [
      flat(boxSegment(0.16, 0.2, 0.86).translate(0.3, 1.16, 0.4)),
      flat(new CylinderGeometry(0.05, 0.05, 0.5, 6).rotateX(Math.PI / 2).translate(0.3, 1.2, 0.9)),
      flat(boxSegment(0.1, 0.24, 0.14).translate(0.3, 1.0, 0.34)),
    ],
    false,
  );
  const medieval = mergeGeometries(
    [
      flat(new TorusGeometry(0.34, 0.045, 4, 10).rotateY(Math.PI / 2).translate(0.32, 1.2, 0.42)),
      flat(new CylinderGeometry(0.04, 0.04, 0.9, 4).rotateX(Math.PI / 2).translate(0.32, 1.2, 0.5)),
      flat(new CylinderGeometry(0.09, 0.09, 0.62, 6).rotateX(Math.PI / 2).translate(0.3, 1.14, 0.4)),
    ],
    false,
  );
  const alien = mergeGeometries(
    [
      flat(new IcosahedronGeometry(0.2, 0).translate(0.32, 1.2, 0.56)),
      flat(new CylinderGeometry(0.09, 0.14, 0.56, 6).rotateX(Math.PI / 2).translate(0.3, 1.18, 0.28)),
      flat(new TorusGeometry(0.2, 0.04, 4, 8).rotateY(Math.PI / 2).translate(0.3, 1.18, 0.62)),
    ],
    false,
  );
  const kit = [guns, medieval, alien];
  for (const one of kit) if (one === null) throw new Error('meshes: kit merge failed');
  return { guns: kit[0]!, medieval: kit[1]!, alien: kit[2]! };
}

/* ── Telegraph geometry ────────────────────────────────────────────────────────── */

/** The charge line and the filling disc: a unit quad facing up, stretched by the batch. */
export function quadGeometry(): BufferGeometry {
  return new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
}

/**
 * A flat disc of radius 1, for the area a telegraph warns about.
 *
 * A circle rather than a quad because the shape has to say "this much floor" on its own:
 * DESIGN.md asks that a telegraph be readable by shape and not by colour alone, and a square
 * read as an area is a square.
 */
export function discGeometry(segments = 20): BufferGeometry {
  return new CircleGeometry(1, segments).rotateX(-Math.PI / 2);
}

/** A ring band: the outline a filling telegraph grows inside. */
export function ringGeometry(segments = 20): BufferGeometry {
  return new TorusGeometry(1, 0.06, 3, segments).rotateX(Math.PI / 2);
}

/**
 * The laser sight: a thin tube along the aim line.
 *
 * A tube rather than a quad because the sniper's tell has to read edge-on, at the 55° camera
 * pitch and from 20 m away (DESIGN.md "Telegraphs").
 */
export function laserGeometry(): BufferGeometry {
  return new CylinderGeometry(0.035, 0.035, 1, 4).rotateX(Math.PI / 2);
}

/**
 * A dash afterimage: a flat capsule, deliberately squashed — the trail is meant to read as a
 * smear of the player's silhouette rather than as bubbles.
 */
export function ghostGeometry(): BufferGeometry {
  const geometry = flat(new CapsuleGeometry(0.32, 0.8, 3, 6).scale(0.9, 1, 0.6));
  geometry.computeBoundingSphere();
  return geometry;
}

/* ── Materials ─────────────────────────────────────────────────────────────────── */

/** How many dissolve cells one metre of body gets. */
const DISSOLVE_SCALE = 13;

/**
 * Give a material the horde's two per-instance attributes.
 *
 * `flash` is false for the emissive pieces: they are already at full brightness, so the
 * only thing a flash would buy is a second attribute to upload.
 *
 * Both attributes are plain floats rather than one `vec2` because that is what the type
 * declarations allow without a cast, and it costs one extra 8 KB upload per batch.
 */
function withFx(material: MeshStandardNodeMaterial | MeshBasicNodeMaterial, flash: boolean): void {
  const die = attribute('aDie', 'float');
  // `step(edge, x)` is 0 while x < edge, so a rising `aDie` eats the body from the cells
  // whose noise is lowest; `alphaTest` then cuts them out of an otherwise opaque pass.
  material.opacityNode = step(die, mx_cell_noise_float(mul(positionLocal, DISSOLVE_SCALE)));
  material.alphaTest = 0.5;
  if (flash) {
    material.colorNode = mix(materialColor, vec3(1, 1, 1), attribute('aHit', 'float'));
  }
}

/** The horde's body material: dark matte, white on a hit, coming apart on death. */
export function hordeBodyMaterial(color: number): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ color, roughness: 0.85, metalness: 0.04 });
  withFx(material, true);
  return material;
}

/**
 * The plain glow: unlit, and pushed past 1.0 so the bloom pass finds it.
 *
 * A `MeshBasicNodeMaterial`'s colour is a *linear* value that goes straight to the tone
 * mapper, so a hue at its sRGB hex value would sit under the bloom threshold (DESIGN.md puts
 * it at about 1.0) and not glow at all. `gain` is what makes "emissive above 1" true rather
 * than decorative; the threshold is what keeps it off the floor and the bodies.
 *
 * No per-instance attributes here: a round is not a body that can be hit, and a material that
 * reads `aDie` needs every batch that uses it to supply the attribute.
 *
 * `additive` is for the things drawn *on* the floor — a telegraph, a trail — which have to add
 * light to the picture rather than cover it, and so must not write depth either.
 */
export function glowMaterial(color: number, gain = 2.4, additive = false): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    color,
    transparent: additive,
    depthWrite: !additive,
  });
  // Assigned rather than passed: three warns once for every material built with a key whose
  // value is undefined, and there are twenty of these.
  if (additive) material.blending = AdditiveBlending;
  material.color.multiplyScalar(gain);
  return material;
}

/**
 * The accent material for a horde body: the glow above, plus the two instance attributes,
 * so a core flashes with its body and comes apart with it.
 *
 * The gain is deliberately under the projectiles' (2.2–2.6). DESIGN.md keeps enemy bodies out
 * of the bloom and wants a crowd read as *silhouettes plus accent dots*: at 2.4 a hundred dots
 * at once lift the whole pack into one pink haze and the shapes the eye was supposed to learn
 * disappear into their own halos. At this level a dot still reads against a mid-value floor and
 * a lone enemy still announces its faction, which is the whole job.
 */
export function accentMaterial(color: number, gain = 1.35): MeshBasicNodeMaterial {
  const material = glowMaterial(color, gain);
  withFx(material, false);
  return material;
}

/**
 * Attach the per-instance flash and dissolve buffers to one geometry.
 *
 * Two item-size-1 attributes over one geometry, written by the batch that draws it; the
 * material reads them through `withFx`.
 */
export function attachFx(
  geometry: BufferGeometry,
  hit: Float32Array | null,
  die: Float32Array,
): void {
  const dieAttribute = new InstancedBufferAttribute(die, 1);
  dieAttribute.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aDie', dieAttribute);
  if (hit !== null) {
    const hitAttribute = new InstancedBufferAttribute(hit, 1);
    hitAttribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aHit', hitAttribute);
  }
}
