/**
 * Reading the picture back: the reads the state snapshot takes off what was drawn.
 *
 * `game/appState.ts` prints a *pair* wherever a fact has two homes — `shot`/`barrel` for the
 * player's gun and `orbit`/`drawn` for the companion — and the pair only says something while the
 * second half is read off the drawing. A `drawn` re-derived from `droneOrbit` beside `orbit`
 * agrees with itself on every frame, including the frame where nothing drew the drone: the two
 * have to be free to come apart or the check that puts them side by side is decoration.
 *
 * So these are reads rather than answers, and they are free functions rather than private lines
 * inside `renderer.ts` for one reason: the unit harness has no canvas and no backend (TECH.md
 * "Tests"), so a state test hands `buildState` a stand-in `View`. Written out by hand, that
 * stand-in is a second copy of whatever maths the shipped one holds, and the two drift quietly —
 * a dropped floor-to-world flip, say, would be copied rather than caught. Delegating keeps one
 * implementation standing between the rig's transform and the state's numbers.
 *
 * Read-only and cosmetic, like the rest of the folder: nothing here writes a game value back.
 */

import type { Object3D } from 'three/webgpu';

import { groundToRender } from './instancing';

/**
 * What a read of the companion's place writes back: plain JSON, because it travels out through
 * `__forgeState()`.
 *
 * `x`/`y` are world floor coordinates (render z is `-y`, undone here) and `h` is the height it
 * was drawn at — the height being the fact that says *above* the crowd rather than behind it.
 * `shown` is whether the body was in the frame at all, which is the one answer a run that never
 * bought the companion has to be able to give differently.
 */
export interface DronePoint {
  x: number;
  y: number;
  h: number;
  shown: boolean;
}

/**
 * Write the last place `group` stood into `out`, in world terms.
 *
 * The companion hangs straight off the scene, so its own transform is its place in the world:
 * there is no parent matrix to compose with, which is what lets this read `position` and allocate
 * nothing on the way out. A rig that was never stood anywhere reads as no place and hidden — it
 * is built invisible, and `droneRig.ts` takes it out of the draw for a run that owns no
 * companion — so "nothing was drawn" answers differently from "drawn at the origin".
 */
export function droneSnapshot(group: Object3D, out: DronePoint): DronePoint {
  const at = group.position;
  out.x = at.x;
  out.y = groundToRender(at.z);
  out.h = at.y;
  out.shown = group.visible;
  return out;
}