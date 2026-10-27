/**
 * The three bodies that do not walk at you: the shard that crosses its approach in a tick,
 * the plough that crosses it under the floor and the carrier whose damage arrives as bodies.
 *
 * These are keyed by *archetype* rather than by silhouette, which is the one difference from
 * `shapes.ts` and the reason they are a file of their own. Every recipe there answers "what
 * does this kind of body look like" and is worn by whoever needs it (`mote` is a swarmling
 * cloud, a splinter and a spawnling); each recipe here answers "what does the player have to
 * be able to *see* about this behaviour", which is a question one row asks. So each is written
 * at the size its own body is, with no `fit`, and worn by exactly one body.
 *
 * The read each one carries, in the idiom of the rest of the folder (DESIGN.md "readable via
 * telegraphs": the shape says what the body is about to do):
 *
 * - **teleporter** — sheared. Its shell sits forward of its hull and its fins are swept back
 *   off a body that does not line up with itself, so the outline reads as one body that is
 *   partly elsewhere. Nothing else in the horde is drawn disassembled, and that is the point:
 *   a player counts bodies by their outlines, and this is the one outline that has to break
 *   the habit on purpose.
 * - **burrower** — low, plated and wider than it is tall, with a ploughshare where its legs
 *   would be. It travels *along* the floor rather than over it, so nothing about it may look
 *   like a body standing up; under half a metre tall, it reads as down in the floor, which is
 *   what it is doing for a third of the run.
 * - **spawner** — a carrier with its load still in it: a bulb, a chute cut open behind it and
 *   three lit young riding along the tear. The faucet is the archetype — its damage never
 *   arrives as itself — so the shape has to answer the question the player is actually asking,
 *   which is how many broods are left, rather than only saying "spawner".
 *
 * None of the three is scaled to its hit circle, which is the other difference from the rest of
 * the folder: the gap between a silhouette and a hit circle is what makes a shot look like it
 * passed through nothing, so a body that runs a locked bearing is allowed to be longer across
 * than round — the teleporter reads 1.06 m long for a 0.84 m circle the way the sniper's barrel
 * does, and the burrower is 0.77 m wide against a 1.0 m circle because it is down in the floor.
 */

import {
  ConeGeometry,
  IcosahedronGeometry,
  OctahedronGeometry,
  SphereGeometry,
} from 'three/webgpu';

import { boxSegment, build, leg, type HordeMesh } from './primitives';

/**
 * The three non-walkers, by mesh id.
 *
 * Spread into `SHAPES` in `shapes.ts`, which is where the cache and the chaser fallback live:
 * these are recipes, not a second lookup path.
 */
export const SHAPES_C: Record<string, () => HordeMesh> = {
  /**
   * Teleporter: a body drawn half a metre out of step with itself.
   *
   * Hull and shell are the same squash, the shell slid forward and up so the outline leans the
   * way the charger's does — but where the charger leans *at* you, this one has come apart on
   * the way. The fins are swept back off the join rather than grafted on, and the seam of
   * light sits in the join itself: the crack is what says "not entirely here", and it is one
   * long mark rather than two dots so it does not read as a face. The two chips out behind are
   * its own wake, low enough to read as light rather than as more bodies.
   */
  teleporter: () => ({
    body: build(
      [
        [new IcosahedronGeometry(0.24, 0).scale(1.2, 0.8, 1.15), 0, 0.26, -0.1],
        [new IcosahedronGeometry(0.2, 0).scale(1.05, 0.78, 1.2), 0, 0.58, 0.16],
        [new ConeGeometry(0.1, 0.3, 5).rotateX(Math.PI / 2), 0, 0.42, 0.42],
        [new ConeGeometry(0.055, 0.18, 4).rotateZ(-Math.PI / 2).rotateY(0.6), 0.22, 0.44, -0.02],
        [new ConeGeometry(0.055, 0.18, 4).rotateZ(Math.PI / 2).rotateY(-0.6), -0.22, 0.44, -0.02],
        [new ConeGeometry(0.07, 0.22, 4).rotateX(-Math.PI / 2), 0, 0.24, -0.38],
      ]
    ),
    core: build(
      [
        [boxSegment(0.52, 0.05, 0.36), 0, 0.5, 0],
        [new OctahedronGeometry(0.05, 0), 0.08, 0.6, 0.34],
        [new OctahedronGeometry(0.045, 0), -0.06, 0.58, 0.32],
        [new OctahedronGeometry(0.05, 0), 0.02, 0.3, -0.46],
        [new OctahedronGeometry(0.04, 0), -0.05, 0.42, -0.56],
      ]
    ),
  }),

  /**
   * Burrower: a ploughshare, three plates stepping down and a rudder, none of it over half a
   * metre off the floor.
   *
   * The share throws the floor forward rather than parting it, the plates drop towards the
   * back so the whole thing reads as trailing into the ground, and the four struts are all
   * that holds it up: it has no legs because it does not stand to travel. The rudder spines
   * keep the outline pointed at both ends, which is what a body that crosses 5.2 m underground
   * down one locked bearing needs — the player reads the line it is running, not the side it
   * is facing.
   */
  burrower: () => ({
    body: build(
      [
        [new ConeGeometry(0.24, 0.34, 5).rotateX(Math.PI / 2), 0, 0.22, 0.36],
        [new IcosahedronGeometry(0.27, 0).scale(1.5, 0.5, 0.95), 0, 0.34, 0],
        [new IcosahedronGeometry(0.22, 0).scale(1.5, 0.44, 0.9), 0, 0.28, -0.22],
        [new IcosahedronGeometry(0.17, 0).scale(1.45, 0.38, 0.85), 0, 0.23, -0.4],
        [new ConeGeometry(0.05, 0.2, 4).rotateX(-Math.PI / 2), 0.2, 0.26, -0.44],
        [new ConeGeometry(0.05, 0.2, 4).rotateX(-Math.PI / 2), -0.2, 0.26, -0.44],
        leg(0.05, 0.22, 0.55, 0.3, 0.14),
        leg(0.05, 0.22, -0.55, -0.3, 0.14),
        leg(0.045, 0.2, 0.5, 0.28, -0.26),
        leg(0.045, 0.2, -0.5, -0.28, -0.26),
      ]
    ),
    // The seam runs along the back rather than sitting on the nose: the nose and the burst are
    // the same half second and the ring on the floor already says where they are, so the light
    // on the body is for reading *where it has come from* — the trench, and the line it will
    // run again.
    core: build(
      [
        [boxSegment(0.3, 0.05, 0.72), 0, 0.42, -0.14],
        [new OctahedronGeometry(0.055, 0), 0.11, 0.34, 0.26],
        [new OctahedronGeometry(0.055, 0), -0.11, 0.34, 0.26],
        [new OctahedronGeometry(0.06, 0), 0, 0.3, -0.5],
      ]
    ),
  }),

  /**
   * Spawner: a bulb carrying three young it would rather not still be carrying.
   *
   * The bulb leans back and the chute behind it is cut open, so the mass of the outline sits
   * behind the body that is running and the eye reads "leaving things" before it reads "coming
   * at you". The head is low and forward so it still looks like a runner: this body kites at
   * five metres and only turns into a walker once it is dry, and a shape that looked rooted
   * would invite the player to stand in front of it. The young ride outside the shell because
   * the count is the information — one light per brood left, in the one place the player is
   * already looking.
   */
  spawner: () => ({
    body: build(
      [
        [new IcosahedronGeometry(0.3, 0).scale(1.05, 1, 1.15), 0, 0.66, 0.02],
        [new IcosahedronGeometry(0.2, 0).scale(1, 0.85, 1.05), 0, 0.48, -0.38],
        [new SphereGeometry(0.14, 5, 3).scale(1, 0.9, 1.1), 0, 0.5, 0.3],
        [boxSegment(0.13, 0.3, 0.13).rotateZ(0.22), 0.22, 0.62, -0.16],
        [boxSegment(0.13, 0.3, 0.13).rotateZ(-0.22), -0.22, 0.62, -0.16],
        leg(0.06, 0.5, 0.42, 0.26, 0.14),
        leg(0.06, 0.5, -0.42, -0.26, 0.14),
        leg(0.055, 0.46, 0.36, 0.24, -0.18),
        leg(0.055, 0.46, -0.36, -0.24, -0.18),
        leg(0.05, 0.42, 0.3, 0.2, -0.46),
        leg(0.05, 0.42, -0.3, -0.2, -0.46),
      ]
    ),
    core: build(
      [
        [new OctahedronGeometry(0.085, 0), 0.16, 0.62, -0.16],
        [new OctahedronGeometry(0.075, 0), 0.05, 0.52, -0.42],
        [new OctahedronGeometry(0.065, 0), -0.09, 0.44, -0.6],
        [boxSegment(0.26, 0.04, 0.34), 0, 0.16, -0.36],
        [new OctahedronGeometry(0.05, 0), 0, 0.56, 0.36],
      ]
    ),
  }),
};
