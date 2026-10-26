/**
 * The archetype bodies: every recipe, plus the cache that hands them out.
 *
 * A recipe is a list of parts in the toolkit's idiom (see `primitives.ts`), authored at the
 * size of the archetype that uses it, and built once per page: a restart rebuilds the batches
 * and twenty restarts should not mean twenty copies of the same geometry in GPU memory.
 */

import {
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three/webgpu';

import { boxSegment, build, leg, type HordeMesh, type Piece } from './primitives';

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
   * Sniper: a tripod gun with one long barrel. The barrel is the silhouette and it points
   * where the body is aiming — the shape and its sight line say the same line, which is the
   * read the archetype asks for. It stops to fire, so the facing it holds does reach the
   * mesh rather than only the telegraph.
   */
  sniper: () => ({
    body: build(
      [
        [new OctahedronGeometry(0.26, 0).scale(1.5, 0.75, 1), 0, 0.62, -0.04],
        [new CylinderGeometry(0.05, 0.045, 0.95, 5).rotateX(Math.PI / 2), 0, 0.66, 0.46],
        [new CylinderGeometry(0.03, 0.03, 0.42, 4).rotateX(Math.PI / 2), 0.11, 0.84, 0.28],
        leg(0.05, 0.42, 0.34, 0.2, -0.04),
        leg(0.05, 0.42, -0.34, -0.2, -0.04),
        leg(0.045, 0.34, 0.1, 0, -0.3),
      ]
    ),
    // The muzzle and the lens: the two places the shot is promised from.
    core: build(
      [
        [new OctahedronGeometry(0.07, 0), 0, 0.66, 0.96],
        [new OctahedronGeometry(0.05, 0), 0, 0.79, 0.04],
      ]
    ),
  }),

  /**
   * Orbiter: a flat lens under a ring. The ring is what makes it readable from above and it
   * turns with the strafe, so the whole shape says "going round" even when the bolt line
   * does not — the one silhouette the player has to be able to pick out of a crowd at speed.
   */
  orbiter: () => ({
    body: build(
      [
        [new SphereGeometry(0.3, 6, 4).scale(1, 0.62, 1), 0, 0.64, 0],
        [new TorusGeometry(0.38, 0.05, 4, 12).rotateX(Math.PI / 2), 0, 0.62, 0],
        [new ConeGeometry(0.12, 0.26, 5), 0, 0.3, 0],
        [new CylinderGeometry(0.05, 0.05, 0.3, 4).rotateX(Math.PI / 2), 0, 0.66, 0.3],
      ]
    ),
    core: build(
      [
        [new OctahedronGeometry(0.09, 0), 0, 0.34, 0],
        [new TorusGeometry(0.3, 0.03, 3, 10).rotateX(Math.PI / 2), 0, 0.7, 0],
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
