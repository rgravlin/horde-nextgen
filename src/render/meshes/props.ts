/**
 * Everything the horde does not wear: the projectiles, the player's kit-bash and the flat
 * shapes a telegraph is drawn with.
 *
 * These are built once per page too, but they need no cache — one batch each, made in
 * `instancing.ts` and `telegraphs.ts`, so a builder here just returns a fresh geometry.
 */

import {
  CapsuleGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  OctahedronGeometry,
  PlaneGeometry,
  type BufferGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three/webgpu';

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { WeaponFamily } from '../../content/weapons';
import { boxSegment, flat } from './primitives';

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
