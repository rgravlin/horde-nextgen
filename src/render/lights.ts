/**
 * The light the gunfire makes.
 *
 * The arena is lit by what happens in it (DESIGN.md "Lighting mood"): one cool moonlight keeps
 * the floor readable and everything else is a flash. So this file is a pool of point lights —
 * sixteen on High, eight on Medium, none on Low — that gets refilled every frame from the
 * particle field's emitter slots, which the simulation already curates: a muzzle, a burst and
 * the glowing rounds are recorded as lights *in the sim*, with a kind and a power, so the
 * renderer never has to work out what just exploded.
 *
 * Two things the pool is doing besides lighting:
 *
 * - It is the quality knob. A point light costs per *lit* fragment rather than per light, so
 *   sixteen lamps over a thousand instanced bodies is the most expensive thing on the frame
 *   after the shadows; the tiers spend them rather than always using them.
 * - It picks rather than spawns. Adding or removing a light rebuilds the scene's lighting
 *   layout, which is a pipeline change and not a per-frame edit, so the lamps are switched
 *   rather than created, and the ones not earning their keep this frame are set to zero
 *   intensity instead of being taken out.
 *
 * The pick itself is the same score the particle field used to keep its candidates — power over
 * squared distance to the player — applied again, because a tier may afford fewer lamps than the
 * field holds. Distance is measured to the camera's subject, which at this camera height is the
 * same thing as "nearest what the player can see".
 */

import { PointLight, type Object3D } from 'three/webgpu';

import type { EffectField } from '../sim/fx';

import type { Quality } from './renderer';

/** How many lamps each tier is allowed to spend (TECH.md "Quality tiers"). */
const LAMPS_BY_QUALITY: Record<Quality, number> = { low: 0, medium: 8, high: 16 };

/** Colour roles from DESIGN.md, keyed off the field's `lightKind`. */
const MUZZLE_LIGHT = 0xbfefff;
const BLAST_LIGHT = 0xff7a2a;
const OTHER_LIGHT = 0x6ce0ff;

export interface LightRig {
  /** Move the pool to wherever this frame's flashes are, given the player to judge by. */
  sync(fx: EffectField, px: number, py: number): void;
}

/**
 * Bring up the lamp pool for one scene.
 *
 * The lamps are added once, and only ever moved and re-dimmed after that.
 */
export function createLightRig(scene: Object3D, quality: Quality): LightRig {
  const lampCount = LAMPS_BY_QUALITY[quality];
  const lamps: PointLight[] = [];
  for (let i = 0; i < lampCount; i++) {
    const light = new PointLight(OTHER_LIGHT, 0, 9, 2);
    // None of them cast: a muzzle flash that also threw shadows would cost the shadow pass
    // sixteen more draws of the whole horde, for a light that lasts three frames.
    light.castShadow = false;
    scene.add(light);
    lamps.push(light);
  }

  // Scratch for the per-frame pick, allocated with the view. Nothing in the draw path
  // allocates, and this file is no exception: two flat arrays and a hand-written insertion beat
  // a sorted map copy sixty times a second.
  const bestSlot = new Int32Array(lampCount);
  const bestScore = new Float32Array(lampCount);

  return {
    sync(fx: EffectField, px: number, py: number): void {
      if (lampCount === 0) return;

      let n = 0;
      const slots = fx.lightCount < fx.lightX.length ? fx.lightCount : fx.lightX.length;

      for (let i = 0; i < slots; i++) {
        if (fx.lightLife[i] <= 0 || fx.lightPower[i] <= 0) continue;
        const dx = fx.lightX[i] - px;
        const dy = fx.lightY[i] - py;
        const score = fx.lightPower[i] / (1 + dx * dx + dy * dy);

        if (n >= lampCount) {
          if (score <= bestScore[n - 1]) continue;
          n = lampCount - 1;
        }
        let at = n;
        while (at > 0 && bestScore[at - 1] < score) {
          bestSlot[at] = bestSlot[at - 1];
          bestScore[at] = bestScore[at - 1];
          at--;
        }
        bestSlot[at] = i;
        bestScore[at] = score;
        n++;
      }

      for (let l = 0; l < lampCount; l++) {
        const light = lamps[l];
        if (l >= n) {
          if (light.intensity !== 0) light.intensity = 0;
          continue;
        }
        const i = bestSlot[l];
        const kind = fx.lightKind[i];
        const fade = fx.lightSpan[i] > 0 ? fx.lightLife[i] / fx.lightSpan[i] : 0;
        const power = fx.lightPower[i] * (fade < 0 ? 0 : fade > 1 ? 1 : fade);

        light.color.setHex(kind === 2 ? BLAST_LIGHT : kind === 1 ? MUZZLE_LIGHT : OTHER_LIGHT);
        light.distance = kind === 2 ? 15 : 7;
        light.intensity = power * (kind === 2 ? 40 : 14);
        // The field stores (x, y, height); the scene's floor is XZ, so world y is up.
        light.position.set(fx.lightX[i], fx.lightZ[i], -fx.lightY[i]);
      }
    },
  };
}
