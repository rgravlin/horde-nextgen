/**
 * The three materials the horde and its props are drawn with, and the two per-instance
 * attributes the horde's two read.
 *
 * Bodies are dark matte and the accent pieces are unlit and saturated, so a faction reads
 * by its accent while the bodies stay out of the bloom (DESIGN.md "Palette": no bloom on
 * enemy bodies).
 *
 * ## The two per-instance attributes
 *
 * A body carries two numbers per instance: `aHit` (1 the tick a round lands, gone 60 ms
 * later) and `aDie` (0 alive, 1 gone), written by `instancing.ts` from the tick's hit and
 * kill events. This file only says what they do:
 *
 * - `aHit` mixes the diffuse toward white — the 60 ms pop DESIGN.md asks for;
 * - `aDie` punches holes that grow until the body is gone, so a death reads as a body coming
 *   apart rather than as a light switching off. The ember burst that fires with it lives in
 *   `sim/fx.ts` and is the other half of the effect.
 *
 * The dissolve runs through `alphaTest`, not blending, on purpose: the horde stays in the
 * opaque pass with depth writes, so two thousand bodies never have to be sorted against each
 * other, and the same node graph compiles to WGSL and to GLSL (TECH.md "Render backend").
 */

import {
  AdditiveBlending,
  type BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu';

import { attribute, materialColor, mix, mul, mx_cell_noise_float, positionLocal, step, vec3 } from 'three/tsl';

/** How many dissolve cells one metre of body gets. */
const DISSOLVE_SCALE = 13;

/**
 * Give a material the horde's two per-instance attributes.
 *
 * `flash` is false for the emissive pieces: they are already at full brightness, so the
 * only thing a flash would buy is a second attribute to upload.
 *
 * Both attributes are plain floats rather than one `vec2` because that is what the type
 * declarations allow without a cast, and it costs one extra 8 KB upload per batch.
 */
function withFx(material: MeshStandardNodeMaterial | MeshBasicNodeMaterial, flash: boolean): void {
  const die = attribute('aDie', 'float');
  // `step(edge, x)` is 0 while x < edge, so a rising `aDie` eats the body from the cells
  // whose noise is lowest; `alphaTest` then cuts them out of an otherwise opaque pass.
  material.opacityNode = step(die, mx_cell_noise_float(mul(positionLocal, DISSOLVE_SCALE)));
  material.alphaTest = 0.5;
  if (flash) {
    material.colorNode = mix(materialColor, vec3(1, 1, 1), attribute('aHit', 'float'));
  }
}

/** The horde's body material: dark matte, white on a hit, coming apart on death. */
export function hordeBodyMaterial(color: number): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ color, roughness: 0.85, metalness: 0.04 });
  withFx(material, true);
  return material;
}

/**
 * The plain glow: unlit, and pushed past 1.0 so the bloom pass finds it.
 *
 * A `MeshBasicNodeMaterial`'s colour is a *linear* value that goes straight to the tone
 * mapper, so a hue at its sRGB hex value would sit under the bloom threshold (DESIGN.md puts
 * it at about 1.0) and not glow at all. `gain` is what makes "emissive above 1" true rather
 * than decorative; the threshold is what keeps it off the floor and the bodies.
 *
 * No per-instance attributes here: a round is not a body that can be hit, and a material that
 * reads `aDie` needs every batch that uses it to supply the attribute.
 *
 * `additive` is for the things drawn *on* the floor — a telegraph, a trail — which have to add
 * light to the picture rather than cover it, and so must not write depth either.
 */
export function glowMaterial(color: number, gain = 2.4, additive = false): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    color,
    transparent: additive,
    depthWrite: !additive,
  });
  // Assigned rather than passed: three warns once for every material built with a key whose
  // value is undefined, and there are twenty of these.
  if (additive) material.blending = AdditiveBlending;
  material.color.multiplyScalar(gain);
  return material;
}

/**
 * The accent material for a horde body: the glow above, plus the two instance attributes,
 * so a core flashes with its body and comes apart with it.
 *
 * The gain is deliberately under the projectiles' (2.2–2.6). DESIGN.md keeps enemy bodies out
 * of the bloom and wants a crowd read as *silhouettes plus accent dots*: at 2.4 a hundred dots
 * at once lift the whole pack into one pink haze and the shapes the eye was supposed to learn
 * disappear into their own halos. At this level a dot still reads against a mid-value floor and
 * a lone enemy still announces its faction, which is the whole job.
 */
export function accentMaterial(color: number, gain = 1.35): MeshBasicNodeMaterial {
  const material = glowMaterial(color, gain);
  withFx(material, false);
  return material;
}

/**
 * Attach the per-instance flash and dissolve buffers to one geometry.
 *
 * Two item-size-1 attributes over one geometry, written by the batch that draws it; the
 * material reads them through `withFx`.
 */
export function attachFx(
  geometry: BufferGeometry,
  hit: Float32Array | null,
  die: Float32Array,
): void {
  const dieAttribute = new InstancedBufferAttribute(die, 1);
  dieAttribute.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aDie', dieAttribute);
  if (hit !== null) {
    const hitAttribute = new InstancedBufferAttribute(hit, 1);
    hitAttribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aHit', hitAttribute);
  }
}
