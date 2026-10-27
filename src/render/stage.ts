/**
 * The stage: the room the horde arrives in (DESIGN.md "3D and scenes").
 *
 * Everything in here is scenery rather than a body: the air, the floor and the one light that
 * casts shadows. It is built once per view and then only ever *tuned* — three colours when the
 * chapter changes and a light position that follows the player — because adding or removing a
 * light rebuilds the scene's lighting layout, which is a pipeline change and not something a
 * restart gets to do sixty times a second.
 *
 * Two decisions worth keeping written down:
 *
 * - **The sky is the fog.** DESIGN.md wants a Void background with height fog; the two get the
 *   same value on purpose, so the arena fades into the sky instead of ending in a hard seam at
 *   the arena edge. The HDRI goes on `environment`, never on `background`: it is there to give
 *   the wet concrete a sheen, not to be a backdrop.
 * - **The key light travels.** The shadow camera is a 68 m box; parking it over the player keeps
 *   the part of the arena in view inside it instead of one fixed square in the middle of the map.
 *
 * Read-only and cosmetic, like the rest of `render`. The chapter's tint comes out of
 * `content/levels` — data the code reads, not a table copied per chapter (ARCHITECTURE.md).
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  FogExp2,
  Mesh,
  PlaneGeometry,
  Scene,
} from 'three/webgpu';

import { levelAt } from '../content/levels';

import type { Assets } from './assets';
import { flipToRender } from './instancing';
import type { TierProfile } from './quality';

/** How much of the arena the floor covers; the world itself is 120x120 m. */
export const FLOOR_SIZE = 170;

/** Colour roles from DESIGN.md. Void is also the fog and the sky, which is the point. */
const VOID = 0x0b0d14;

/** The moon, and the fill under it. Both dim: the arena is lit by its own gunfire. */
const MOON = 0xbfd7ff;
const FILL = 0x2b3a52;

/**
 * How much of the HDRI the room gets.
 *
 * The autoshop is a daylight garage and this is a night factory floor: at full strength the
 * environment washes out every accent the palette is built on. What is left at this level is the
 * sheen on the wet concrete and a little rim light on the kit, which is what DESIGN.md means by
 * an environment map used "only for reflections and IBL", never as a backdrop.
 */
const ENV_INTENSITY = 0.4;

/** How far the shadow box reaches either way, in metres; it travels, it does not grow. */
const SHADOW_BOX = 34;

export interface Stage {
  readonly scene: Scene;
  /**
   * How many of the room's optional pieces could not be put in.
   *
   * Counted rather than swallowed (AGENTS.md): an environment map that refuses to attach means
   * this machine is not drawing what the tier asked for, and `errors` is the only channel that
   * reaches a check.
   */
  readonly faults: number;
  /** Wear one chapter's air. Cheap when the chapter did not change. */
  tint(chapter: number): void;
  /** Move the key light and its shadow box with the player. */
  follow(px: number, py: number): void;
}

/**
 * Build the room.
 *
 * `assets` has already been awaited by the caller — see `createStage`'s only caller for why the
 * wait happens there — so nothing in here is unfinished: the floor is either wet concrete or the
 * flat Concrete fallback, and either way it is a floor before the first frame.
 */
export function createStage(assets: Assets, profile: TierProfile): Stage {
  const scene = new Scene();
  scene.background = new Color(VOID);
  // Height fog over a dark floor: the arena fades into the sky colour instead of ending in a
  // hard edge, and the fog colour is the Void so the two never fight. The HDRI never becomes the
  // background, which is why `background` is a colour and `assets.env` goes on `environment`.
  scene.fog = new FogExp2(VOID, profile.fogDensity);
  let faults = 0;
  if (assets.env !== null) {
    try {
      scene.environment = assets.env;
      scene.environmentIntensity = ENV_INTENSITY;
    } catch (error) {
      faults++;
      console.error('environment unavailable:', error);
    }
  }

  const floor = new Mesh(new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE, 1, 1).rotateX(-Math.PI / 2), assets.ground);
  floor.receiveShadow = profile.shadows;
  scene.add(floor);

  // One cool key light for the shadows and a low ambient fill: the arena is lit by its own
  // gunfire, so the moon only has to keep the floor readable (DESIGN.md). The fill is dimmer
  // than it used to be because the environment map now lights the diffuse too.
  const key = new DirectionalLight(MOON, 1.6);
  key.castShadow = profile.shadows;
  key.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
  key.shadow.camera.near = 2;
  key.shadow.camera.far = 120;
  key.shadow.camera.left = -SHADOW_BOX;
  key.shadow.camera.right = SHADOW_BOX;
  key.shadow.camera.top = SHADOW_BOX;
  key.shadow.camera.bottom = -SHADOW_BOX;
  key.shadow.bias = -0.0008;
  scene.add(key);
  scene.add(key.target);
  scene.add(new AmbientLight(FILL, 0.4));

  /** Which chapter's air the room is wearing; -1 until the first frame picks one. */
  let chapter = -1;

  return {
    scene,
    get faults() {
      return faults;
    },

    tint(next) {
      if (next === chapter) return;
      chapter = next;
      // DESIGN.md asks each chapter to tint the fog and key light while the palette *roles* never
      // change, so this moves three colours and nothing else — no geometry, no material, no
      // light added or removed. Driven off `world.chapter` rather than off the scene rebuild
      // because a run changes rooms without changing scenes: one scene, ten rooms, and the
      // chapter says which.
      const palette = levelAt(next).palette;
      if (scene.fog instanceof FogExp2) scene.fog.color.set(palette.fog);
      if (scene.background instanceof Color) scene.background.set(palette.fog);
      key.color.set(palette.key);
    },

    follow(px, py) {
      // The light travels with the player, so the shadow camera always covers the part of the
      // arena in view instead of one fixed 68 m square.
      key.position.set(px + 12, 24, flipToRender(py) + 8);
      key.target.position.set(px, 0, flipToRender(py));
    },
  };
}
