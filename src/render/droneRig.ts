/**
 * The ward drone's body: one quadrotor, drawn where the simulation says the companion is.
 *
 * The drone has had a rule and a HUD pip since `systems/drone.ts` was written, and no picture:
 * its rounds came out of empty air, and a shot with no muzzle is not readable in either
 * direction — the player cannot see where the companion's fire starts, and a body walking in
 * from that side has no tell. This file exists to put a shape on the point the sim already
 * publishes, which is why it is a rig rather than another instanced batch: there is exactly one
 * of these, the run either owns it or does not, and one `Group` with two meshes costs two draws
 * and no per-frame allocation. `playerRig.ts` is the precedent for a one-off rig and for building
 * the shapes out of `meshes/` once, at boot, rather than per restart.
 *
 * ## Where it stands
 *
 * `droneOrbit(tick, playerX, playerY, out)` is the one answer to "where is the companion", and
 * the drone's own muzzle is loosed from it. A second `cos`/`sin` written here would be free to
 * pick another radius, another centre or another bearing, and the picture would then show a drone
 * its rounds did not come from — the seam `facing.ts` was written for, one layer over. So this
 * file calls the sim's helper and writes no orbit maths of its own, in either of its two reads:
 *
 * - the position is taken between the last two ticks, at `alpha`, exactly as `instancing.ts`
 *   places a body from its pool: at `alpha === 1` the drone is on the point, and short of that
 *   it is up to one tick's arc behind it, which is the price every interpolated layer pays.
 * - the yaw comes from the same helper at `tick` and at `tick - 1`, with the player's own stride
 *   added to it: the chord between two answers is the orbit's share of the travel and the stride
 *   is the rest, so the drone leans into its circle without this file knowing the orbit's angular
 *   speed, and keeps pointing down its track when the player it circles is running. It is turned
 *   with `yawToFace`, which owns the fact that a rig's forward is local +z on a floor whose north
 *   is render -z.
 *
 * Both reads are pure, so a frame whose tick did not advance writes the same numbers as the frame
 * before it: the pause freezes the drone where it was, like everything else in `render`.
 *
 * Read-only and cosmetic, like the rest of the folder: it takes what the World says and draws
 * that, and writes nothing back.
 */

import { Group, Mesh, MeshStandardNodeMaterial, type Scene } from 'three/webgpu';

import { DT, type World } from '../sim/world';
import { droneOrbit, type Point } from '../sim/systems/drone';
import { yawToFace } from './facing';
import { flipToRender } from './instancing';
import { droneBody, droneTrim, glowMaterial } from './meshes';
import type { TierProfile } from './quality';

/** Gunmetal (DESIGN.md "Palette": props, walls, cover) for the hull, Alien Cyan for the trim. */
const HULL = 0x4a505c;
const CYAN = 0x2ef2ff;

/**
 * How hard the trim glows.
 *
 * Under the player's own trim (2.2) and under the rounds (2.6): the companion has to read as
 * *his* machine, not as the brightest thing on the floor, and a glow that strong on a body that
 * never stops moving would bloom a permanent hole in the middle of the screen.
 */
const GLOW = 1.5;

/**
 * m — the height it flies at, and how far up and down it breathes about that height.
 *
 * 1.05 m puts the rotor cross at the player's chest, so the pair reads as one kit-bash rather
 * than as a man and a weather balloon. The breath is what keeps it read as *flying*: a vehicle
 * locked at an exact height reads as scenery within a second, and the one thing this shape has
 * to say over a crowd of dark bodies is that it is not one of them.
 */
const HOVER = 1.05;
const BOB = 0.06;

/** rad per tick of that breath: about 0.86 Hz, so four bobs a second. */
const BOB_W = 0.09;

export interface DroneRig {
  readonly group: Group;
  /**
   * Stand the drone on this tick's orbit point, turned the way it is going.
   *
   * `alpha` is the interpolation point inside the last fixed step, and a World with no drone —
   * or with its player dead, which is the same sight — takes the rig out of the draw instead of
   * moving it, so a run that never bought the companion pays nothing for the possibility.
   */
  sync(world: World, alpha: number): void;
}

/**
 * Bring the rig up and add it to the scene.
 *
 * One per view, beside the player's rig rather than in the per-World kit: it reads no pool, so
 * there is nothing a restart changes about it, and the two shapes are the same two buffers for
 * the life of the page.
 *
 * Neither half takes the horde's per-instance attributes: a companion is not a body a round can
 * hit, so it needs no flash, and nothing kills it, so it needs no dissolve. `attachFx` would ask
 * every batch drawn with that material to supply two buffers for one instance.
 */
export function createDroneRig(scene: Scene, profile: TierProfile): DroneRig {
  const group = new Group();

  const hull = new Mesh(
    droneBody(),
    new MeshStandardNodeMaterial({ color: HULL, roughness: 0.5, metalness: 0.3 }),
  );
  // The shadow is the other half of "flying": on the floor beneath it, at the camera's 55°
  // pitch, is what tells you the drone is above the crowd rather than behind it.
  hull.castShadow = profile.shadows;
  const trim = new Mesh(droneTrim(), glowMaterial(CYAN, GLOW));

  // No `frustumCulled = false`, unlike the crate batches: those spread twenty-four objects over
  // one batch whose culling sphere is built at the origin, and this is one object that never
  // leaves the middle of the view.
  group.add(hull, trim);
  group.visible = false;
  scene.add(group);

  /**
   * This tick's orbit point and the tick before it, written once a frame.
   *
   * Two scratch pairs for the reason `drone.ts` gives for its one: the alternative is a fresh
   * object per frame, and both halves are read out of a pure helper that hands back whatever it
   * was given.
   */
  const here: Point = { x: 0, y: 0 };
  const there: Point = { x: 0, y: 0 };

  return {
    group,

    sync(world, alpha) {
      if (world.stats.drone <= 0 || !world.player.alive) {
        group.visible = false;
        return;
      }

      const player = world.player;
      droneOrbit(world.tick, player.x, player.y, here);
      droneOrbit(world.tick - 1, player.x, player.y, there);

      const x = there.x + (here.x - there.x) * alpha;
      const y = there.y + (here.y - there.y) * alpha;

      // The ring rides with the man: `there` is struck about *this* tick's player, so the chord
      // between the two answers is only the orbit's share of the travel. Over one tick the drone's
      // ground track is that chord plus the stride the whole ring took with its player, and a nose
      // turned onto the chord alone crabs the machine sideways whenever its player runs.
      const dx = here.x - there.x + player.vx * DT;
      const dy = here.y - there.y + player.vy * DT;

      group.position.set(x, HOVER + Math.sin(world.tick * BOB_W) * BOB, flipToRender(y));
      group.rotation.y = yawToFace(dx, dy);
      group.visible = true;
    },
  };
}