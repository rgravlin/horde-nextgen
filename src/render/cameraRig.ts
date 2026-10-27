/**
 * The camera rig: where the picture is taken from, and what the pointer means (DESIGN.md "Camera").
 *
 * Three things live here because they are the same decision seen from three sides:
 *
 * - The rig itself — a 40° perspective, pitched 55° down, 22 m out, which is the composition the
 *   brief pins rather than an approximation of it. The height and the setback come out of the
 *   pitch and the distance instead of being typed in, so changing one cannot leave the other
 *   pointing at a different game.
 * - The follow. It chases the point the gun looks at, not the body, with a critically damped
 *   chase and a 2 m lead, so the crowd arriving on the aim side is already on screen. The title
 *   screen's slow orbit shares the same rig for the opposite reason: a menu with a live scene
 *   behind it needs a camera that moves without anybody driving it.
 * - The shake, which goes on *after* `lookAt` and only on the position, so a jolt slides the
 *   frame sideways instead of turning it. The unshaken position is kept so `aim` can undo it:
 *   the pointer is aimed at the picture the player was shown a moment ago, and if a jolt moved
 *   the ground under the cursor, screen shake would be gameplay.
 *
 * Nothing here is a game value. `aim` answers a question about the picture; the simulation decides
 * what a bullet does with the answer (ARCHITECTURE.md "Data flow").
 */

import { Plane, PerspectiveCamera, Raycaster, Vector2, Vector3, type WebGPURenderer } from 'three/webgpu';

import type { World } from '../sim/world';

import { flipToRender } from './instancing';
import type { Shake } from './shake';

/** Camera distance from the player in metres, and its pitch below horizontal. */
const CAM_DISTANCE = 22;
const CAM_PITCH = (55 * Math.PI) / 180;

/** Vertical FOV in degrees, matching the 40° the design brief pins. */
const CAM_FOV = 40;

/** Seconds of camera smoothing; the follow is critically damped by construction. */
const CAM_TAU = 0.12;

/** Metres the camera leads the aim point, so the player is never dead centre. */
const CAM_LEAD = 2;

/** How far out the title orbit drifts, in metres. */
const ORBIT_RADIUS = 30;

export interface CameraRig {
  readonly camera: PerspectiveCamera;
  /**
   * Put the camera where this frame wants it.
   *
   * `dt` is the real seconds since the previous frame and drives the chase; `step` is the same
   * number on a frame that stepped and 0 on a held one, and it is what the shake spends — a
   * paused screen has to stay still, not quietly settle its own camera.
   */
  frame(world: World, dt: number, step: number, orbit: boolean): void;
  /**
   * Cast a pointer position onto the ground plane and write the world point into `out` (x, y).
   * False when the ray misses the arena, e.g. the pointer is over the sky beyond the floor.
   */
  aim(clientX: number, clientY: number, out: { x: number; y: number }): boolean;
  /** Re-read the canvas size: the window resizes, and the canvas starts at 0x0. */
  resize(): void;
}

/**
 * Bring the rig up.
 *
 * `groundHalf` is how far the floor the pointer can be aimed at reaches — the same number that
 * sizes the floor mesh, so the aim stops where the concrete does instead of of the screen.
 * Scratch is allocated here rather than at module scope: one rig per view, and nothing allocated
 * per frame after that.
 */
export function createCameraRig(
  renderer: WebGPURenderer,
  canvas: HTMLCanvasElement,
  shake: Shake,
  groundHalf: number,
): CameraRig {
  const camera = new PerspectiveCamera(CAM_FOV, 16 / 9, 0.5, 220);
  const camHeight = CAM_DISTANCE * Math.sin(CAM_PITCH);
  const camBack = CAM_DISTANCE * Math.cos(CAM_PITCH);

  const _ndc = new Vector2();
  const _hit = new Vector3();
  const _focus = new Vector3();
  const _ground = new Plane(new Vector3(0, 1, 0), 0);
  const _ray = new Raycaster();
  const _shake = { x: 0, z: 0 };
  const _clean = new Vector3();

  /** Where the follow had got to; false until the first frame picks a point to chase. */
  let following = false;
  /** How far the title orbit has travelled, in radians. */
  let orbitAngle = 0;

  return {
    camera,

    frame(world, dt, step, orbit) {
      const p = world.player;

      if (orbit) {
        // Title screen: a slow drift around the arena, which is the only reason a
        // menu has a 3D scene behind it (DESIGN.md "Menus").
        orbitAngle += dt * 0.08;
        camera.position.set(
          Math.sin(orbitAngle) * ORBIT_RADIUS,
          camHeight * 0.8,
          Math.cos(orbitAngle) * ORBIT_RADIUS,
        );
        camera.lookAt(0, 1, 0);
        following = false;
      } else {
        // Damped follow with an aim lead: chase the point the gun looks at, not the
        // body, so the crowd arriving on that side is already on screen.
        const lead = p.alive ? CAM_LEAD : 0;
        const tx = p.x + p.aimX * lead;
        const tz = flipToRender(p.y + p.aimY * lead);
        if (!following) {
          _focus.set(tx, 0, tz);
          following = true;
        } else {
          const k = 1 - Math.exp(-Math.min(dt, 0.25) / CAM_TAU);
          _focus.x += (tx - _focus.x) * k;
          _focus.z += (tz - _focus.z) * k;
        }
        camera.position.set(_focus.x, camHeight, _focus.z + camBack);
        camera.lookAt(_focus.x, 0, _focus.z);
      }

      // The shake goes on last, and only on the position: the view direction was just fixed by
      // `lookAt`, so this slides the whole frame sideways without turning it, which is what
      // reads as a shove rather than as a camera that slipped.
      _clean.copy(camera.position);
      shake.peek(_shake);
      if (_shake.x !== 0 || _shake.z !== 0) {
        camera.position.x += _shake.x;
        camera.position.z += _shake.z;
      }
      shake.update(step);
    },

    aim(clientX, clientY, out) {
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      _ndc.set((clientX / w) * 2 - 1, -(clientY / h) * 2 + 1);
      // The pointer is aimed at the picture the player was shown a moment ago, and the picture
      // is shaken while the aim is not: put the camera back where the follow had it before
      // casting, or every jolt would move the ground under the cursor and shake would be
      // gameplay. The next `frame` sets the position up again from scratch either way.
      camera.position.copy(_clean);
      camera.updateMatrixWorld();
      _ray.setFromCamera(_ndc, camera);
      if (!_ray.ray.intersectPlane(_ground, _hit)) return false;
      out.x = _hit.x;
      out.y = flipToRender(_hit.z);
      return Math.abs(out.x) <= groundHalf && Math.abs(out.y) <= groundHalf;
    },

    resize() {
      const fallback = typeof window === 'undefined' ? 1 : window.innerWidth || window.innerHeight || 1;
      const w = canvas.clientWidth || fallback;
      const h = canvas.clientHeight || fallback;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    },
  };
}
