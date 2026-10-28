/**
 * Everything the horde does not wear: the projectiles, the supply crate and its beacon, the
 * ward drone's two halves, the player's kit-bash and the flat shapes a telegraph is drawn with.
 *
 * These are built once per page too, but they need no cache — one batch each, made in
 * `instancing.ts`, `chests.ts`, `droneRig.ts` and `telegraphs.ts`, so a builder here just returns
 * a fresh geometry.
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

/* ── The supply crate ──────────────────────────────────────────────────────────── */

/**
 * A supply crate: a hooped box with strapped corners and a beacon nub on the lid.
 *
 * The crate is the one thing on the floor the player is *asked to walk to*, so it is drawn in
 * Hazard amber — the hue the radar dot and the edge marker already spend on a crate — and as a
 * solid rather than a glow: a reward has to look like a thing sitting in the room, and the
 * pillar over it (`beaconGeometry`) is where the light goes. Amber at a gain under the bloom
 * threshold for the same reason `scenery.ts` keeps its hazard tape under it: this is a warning
 * colour worn by a pickup, not a lamp.
 *
 * Authored at the size one is drawn (0.62 m across, 0.7 m to the top of the nub) with its feet
 * at y = 0, so the batch only has to scale its instances.
 */
export function chestGeometry(): BufferGeometry {
  // Four corner straps, one per quarter: they stand 0.02 m proud of the box, which is what
  // gives the silhouette notches at the corners — a plain cube at 20 m reads as a puddle.
  const straps: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      straps.push(flat(boxSegment(0.1, 0.5, 0.1).translate(sx * 0.26, 0.25, sz * 0.26)));
    }
  }

  const geometry = mergeGeometries(
    [
      flat(boxSegment(0.58, 0.44, 0.58).translate(0, 0.22, 0)),
      flat(boxSegment(0.64, 0.1, 0.64).translate(0, 0.2, 0)),
      flat(boxSegment(0.62, 0.09, 0.62).translate(0, 0.475, 0)),
      ...straps,
      flat(new OctahedronGeometry(0.11).translate(0, 0.6, 0)),
    ],
    false,
  );
  if (geometry === null) throw new Error('meshes: chest merge failed');
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The beacon: the column of light standing over a crate, drawn additively.
 *
 * Three parts, one geometry, because it is one draw: a wide thin disc lying on the floor so
 * the crate reads from directly above, a tapered outer column and a narrower core inside it.
 * The core is what makes it read as light rather than as a glass post — where the two shells
 * overlap the additive blend sums twice, which is the hot centre.
 *
 * A column rather than a camera-facing quad for the reason `particles.ts` gives for its blobs:
 * a quad has to be turned to the eye every frame to read as anything, and at the camera's 55°
 * pitch a quad laid over the crate is seen almost edge-on. A solid column says the same thing
 * from every angle for no per-instance rotation.
 *
 * Its lowest vertices are at y = 0 too, so both halves of the read stand on the floor.
 */
export function beaconGeometry(): BufferGeometry {
  const geometry = mergeGeometries(
    [
      flat(new CircleGeometry(0.55, 10).rotateX(-Math.PI / 2).translate(0, 0.015, 0)),
      flat(new CylinderGeometry(0.15, 0.34, 2.5, 8).translate(0, 1.25, 0)),
      flat(new CylinderGeometry(0.06, 0.13, 2.9, 6).translate(0, 1.45, 0)),
    ],
    false,
  );
  if (geometry === null) throw new Error('meshes: beacon merge failed');
  geometry.computeBoundingSphere();
  return geometry;
}

/* ── The ward drone ────────────────────────────────────────────────────────────── */

/** m — how far out each rotor sits, measured along a diagonal, which is how a quadrotor is laid out. */
const ARM_OUT = 0.155;

/** m — one rotor disc's radius and thickness. */
const ROTOR_R = 0.075;
const ROTOR_T = 0.016;

/** The four rotor bearings, as the sign pairs of the diagonals they lie on. */
const ARMS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * The drone's hull: a faceted pod, a mast over it and four arms, each ending in a rotor disc.
 *
 * The companion existed for two tasks as a rule with no body: its rounds came out of empty air,
 * which is the one thing a player cannot read — the shot line has nowhere to start and the
 * threat that walks in from that side has no tell. So this is a *filler* shape, and its bar is
 * "a shape the eye can learn", which is what DESIGN.md's asset rule asks for and its avoid-list
 * enforces (no reliance on colour alone). Four separated discs on a cross is the silhouette
 * chosen for that, and it says *machine that goes round*, which the player already reads off the
 * drone's own orbit.
 *
 * What it deliberately is not: the enemy `orbiter`, which also walks a circle about the player
 * and has to stay the thing the player flinches at. That body is one lens under one continuous
 * ring with an Ember accent, it is 0.45 m across and it hangs at 0.64 m; this is four
 * discontinuous discs on a cross with a cyan trim, at half the height. A ring reads as *aiming*
 * (its shape carries its bolt line), a cross reads as *flying*.
 *
 * Authored about its own centre rather than with its feet at y = 0, unlike the crate and the
 * horde: it flies, and the two prop shapes here that hover or travel are both centred (a tracer
 * is stretched along its travel for the same reason). `droneRig.ts` supplies the height, and the
 * size is what one is drawn at — 0.46 m across, 0.26 m through — because at 1.35 m out beside a
 * 1.8 m player a metre-wide drone would hide him and a 0.1 m one would be a mote.
 */
export function droneBody(): BufferGeometry {
  // The two crossing arms are two boxes rather than four: one long box through the centre,
  // turned ±45°, reaches two diagonals, and the pair reaches all four. Leaving the four gaps
  // between the rotor discs empty is what keeps this a cross instead of a plate.
  const arm = (turn: number): BufferGeometry =>
    flat(boxSegment(ARM_OUT * 2.2, 0.026, 0.045).translate(0, 0.012, 0).rotateY(turn));

  const geometry = mergeGeometries(
    [
      flat(new IcosahedronGeometry(0.13, 0).scale(1.15, 0.62, 1.15)),
      flat(boxSegment(0.14, 0.075, 0.17).translate(0, 0.1, 0)),
      flat(boxSegment(0.1, 0.055, 0.12).translate(0, -0.095, 0.015)),
      arm(Math.PI / 4),
      arm(-Math.PI / 4),
      ...ARMS.map(([sx, sz]) =>
        flat(
          new CylinderGeometry(ROTOR_R, ROTOR_R, ROTOR_T, 6).translate(
            sx * ARM_OUT,
            0.03,
            sz * ARM_OUT,
          ),
        ),
      ),
    ],
    false,
  );
  if (geometry === null) throw new Error('meshes: drone body merge failed');
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The drone's accents: four rotor hubs and a sensor looking forward.
 *
 * The hubs sit above the discs so the four lobes carry a dot each — the "silhouette plus accent
 * dots" read DESIGN.md wants, and the reason a drone is findable in a crowd of dark bodies at a
 * glance. The sensor is the second reason: it is the only part that sticks out at one end, so
 * the silhouette has a front, which is what the rig turns when the drone leans into its circle.
 *
 * Cyan at a gain under the player's own trim (2.2): Alien Cyan is the player's colour — shield,
 * hairlines, dash trail — and a companion has to read as *his* machine rather than as a sixth
 * faction, but not so bright that the drone out-lights the man it orbits. No enemy accent in the
 * tables is cyan, so nothing here borrows a hostile's hue.
 */
export function droneTrim(): BufferGeometry {
  const geometry = mergeGeometries(
    [
      ...ARMS.map(([sx, sz]) =>
        flat(new OctahedronGeometry(0.03, 0).translate(sx * ARM_OUT, 0.055, sz * ARM_OUT)),
      ),
      // Apex forward: `rotateX(+π/2)` is the way a cone's own +y axis lands on +z, which is the
      // rig's forward. The boom clears the rotor discs (their rims reach 0.23 m) out to 0.285 m,
      // which is what gives the silhouette a front — see `droneRig.ts` for what turns on that.
      flat(new ConeGeometry(0.048, 0.19, 5).rotateX(Math.PI / 2).translate(0, 0.005, ARM_OUT + 0.035)),
    ],
    false,
  );
  if (geometry === null) throw new Error('meshes: drone trim merge failed');
  geometry.computeVertexNormals();
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
