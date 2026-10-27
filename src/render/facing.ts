/**
 * Which way the player's gun is pointing, and how that becomes a rig's yaw.
 *
 * Two separate mistakes used to sit in the two lines that replaced this file, and they stay
 * separate because only the second one is about maths:
 *
 * - The aim the sampler steers is not always the line the gun shoots. Auto-fire leads the
 *   nearest body instead of following the steer (see `wantsFire` and `aimMuzzle` in
 *   `systems/weapons.ts`), so a rig turned from `player.aimX/aimY` draws its barrel off to
 *   one side of its own tracers for as long as the setting is on — which is how it ships.
 * - The sim's world is a flat (x, y) plane whose +y is north, and the floor is three's XZ
 *   plane with north at -z (`flipToRender`). A yaw taken straight from `atan2(y, x)` is a
 *   quarter turn off for that reason: it put a barrel 4 m out along local +z at render
 *   (0, +4) for an aim of (0, 1), which is 4 m *south* of the player, and the tracers of a
 *   shot fired along that same aim at render (4, 0). Reading the two against each other is
 *   how the error shows up; `tests/unit/facing.test.ts` does exactly that.
 *
 * The first is answered by reading the line the weapon pass published for the tick instead of
 * deriving a second one, so the round and the picture take one answer and cannot drift apart.
 * The second is `yawToFace`, which is `atan2` with the flip applied and the axis the rig is
 * actually built on: the kit's guns and the muzzle marker both lie along local +z, at +z
 * 0.5 to 1.15 (`meshes/props.ts`), so +z is the rig's forward.
 *
 * Cosmetic and read-only, like the rest of `render`: it reads state and turns a number. The
 * camera's 2 m lead stays on the steered aim, because that one is a framing choice rather
 * than a shot line, and it wants a target that does not hop between bodies as the crowd
 * shuffles.
 *
 * `drawnFace` is the third thing here because a check needs to be able to ask what was actually
 * drawn: it turns a rig's live yaw back into the world line its barrel lies along, which is what
 * lets a scenario compare the picture with the shot instead of with the maths that made it.
 */

import type { World } from '../sim/world';

/** A scratch direction, written once a frame. One per view, not one per frame. */
export interface Face {
  x: number;
  y: number;
}

/** Below this length a pair carries no direction — the same floor the weapon pass uses. */
const EPS = 1e-6;

/** Whether a pair is too short to turn anything round. */
function noDirection(x: number, y: number): boolean {
  return !Number.isFinite(x) || !Number.isFinite(y) || x * x + y * y < EPS * EPS;
}

/**
 * Read the line this tick's shot takes into `out`, and return it.
 *
 * That line is `world.muzzle`, written once a tick by the weapon pass and used by the round
 * that follows, so a rig turned from it is drawn along its own fire. Both sources are unit
 * length — the weapon pass normalises what it writes — so the pair comes back unit too.
 *
 * The two fallbacks are for a World that never ran the weapon pass: a hand-built fixture, or
 * a save restored from before the line existed. Either way the answer stays a unit pair, since
 * a NaN yaw would go into the rig's matrix and take the scene down with it.
 */
export function playerFacing(world: World, out: Face): Face {
  let x = world.muzzle.x;
  let y = world.muzzle.y;

  if (noDirection(x, y)) {
    x = world.player.aimX;
    y = world.player.aimY;
    if (noDirection(x, y)) {
      x = 1;
      y = 0;
    }
  }

  out.x = x;
  out.y = y;
  return out;
}

/**
 * The `rotation.y` that lays a rig's local +z down along the world line (x, y).
 *
 * A turn about Y sends local +z to (sin θ, cos θ) in render space, and the world's y arrives
 * as -z, so the line (x, y) is the render pair (x, -y): θ = atan2(x, -y). East then puts the
 * barrel at +x and north puts it at -z, which is the same two places `syncShots` stretches a
 * tracer to — the rigs and the tracers read one convention.
 */
export function yawToFace(x: number, y: number): number {
  return Math.atan2(x, -y);
}

/**
 * Read a drawn yaw back as the world line the rig's barrel lies along.
 *
 * The inverse of `yawToFace`, and deliberately written from the geometry rather than by undoing
 * that formula: a turn about Y lays local +z on (sin θ, cos θ) in render space, and the world's
 * y arrives as -z. That difference is the whole point of reading it back this way — a check that
 * compared the rig against the *number* that turned it would pass while the barrel pointed a
 * quarter turn off its own fire, which is the bug this pair of functions was written for.
 *
 * Read-only, like the two above: it says what a rig is drawn doing and writes nothing.
 */
export function drawnFace(yaw: number, out: Face): Face {
  out.x = Math.sin(yaw);
  out.y = -Math.cos(yaw);
  return out;
}