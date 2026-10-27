/**
 * The post chain: what the frame looks like after the triangles are done.
 *
 * One `RenderPipeline` (renamed from `PostProcessing` in r183) wrapping one composite pass:
 * the scene pass, then bloom, then chromatic aberration, with tone mapping and the sRGB step
 * landing after both because `outputColorTransform` stays on. Not a stack of full-screen
 * passes: three `pass()`s would mean three render targets and three full-screen blits, and the
 * only thing that buys here is a blur that can read the bloom it is blurring.
 *
 * Two things live here besides the chain:
 *
 * - **The bloom threshold, at 1.0.** DESIGN.md puts it there and `meshes.ts` builds its glow
 *   materials above 1.0 on purpose, so the HDR values are the ones that glow. The previous
 *   0.72 caught the mid-value concrete as well, which is how a hundred dark bodies turn into
 *   one grey wash.
 * - **The punch.** Chromatic aberration is a *uniform*, so it can move: a big hit — a grenade
 *   going off, a bolt landing — kicks it up for 120 ms and it falls back to the tier's resting
 *   strength. DESIGN.md asks for "a little chromatic punch on big hits" and a constant cannot
 *   do that, however well chosen.
 *
 * Like the rest of `render`, this is cosmetic and read-only, and it is built inside a `try`:
 * a driver without what the bloom mips want loses the chain and keeps the game, and
 * `render()` reporting false is how the caller learns to stop using it.
 */

import {
  RenderPipeline,
  type Node,
  type PerspectiveCamera,
  type Scene,
  type UniformNode,
  type WebGPURenderer,
} from 'three/webgpu';
import { pass, add, float, uniform, vec2 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';

import type { TierProfile } from './quality';

/** How long a punch lasts, in seconds. 120 ms: long enough to notice, short enough to not blur. */
export const PUNCH_TIME = 0.12;

/** How much of the screen the aberration reaches at the corners, at full punch. */
const CHROMA_SCALE = 1.1;

export interface PostChain {
  /** False when the chain was never built (Low tier) or threw once (a driver that cannot). */
  readonly active: boolean;
  /** What the chain is made of, for the debug overlay and the tests. */
  readonly label: string;
  /** Kick the chromatic strength up by `amount`, for `PUNCH_TIME`. */
  punch(amount: number): void;
  /** Let the punch fall back down. Called once per rendered frame. */
  update(dt: number): void;
  /**
   * Draw the frame through the chain. False means it threw, the chain is now off, and the
   * caller should draw the scene plain.
   */
  render(): boolean;
  /**
   * Take the chain out for good.
   *
   * `render()` already turns itself off after one throw; this is for the caller that learned
   * about it from somewhere else — a plain render after a chain failure, which is the same bad
   * driver with one fewer pass in front of it.
   */
  disable(): void;
}

/**
 * Build the chain for one tier's profile.
 *
 * An inactive chain is a normal outcome, not a failure: `profile.bloom || profile.chroma`
 * being false is Low tier doing its job. Only a `RenderPipeline` that *threw* on the way up
 * counts against the run, and the caller decides that from `label`.
 */
export function createPost(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  profile: TierProfile,
): PostChain {
  let pipeline: RenderPipeline | null = null;
  let strength: UniformNode<'float', number> | null = null;
  let label = 'none';
  /** How much punch is left, in strength units, and how long it has been falling. */
  let punch = 0;
  let left = 0;
  const base = profile.chromaBase;

  if (profile.bloom || profile.chroma) {
    try {
      const scenePass = pass(scene, camera);
      const colour = scenePass.getTextureNode();

      let node: Node = colour;
      if (profile.bloom) {
        // `bloom()`'s own output is the bloom and nothing else — the high-pass extract, blurred —
        // so it goes *on top of* the scene, which is what three's own usage does
        // (`scenePassColor.add( bloomPass )`). Swapped in for it, the frame would be a glow with
        // nothing under it: no floor, no horde, no player.
        const lights = bloom(colour, profile.bloomStrength, profile.bloomRadius, profile.bloomThreshold);
        node = add(colour, lights);
      }
      if (profile.chroma) {
        // The punch goes in as a uniform rather than a literal: the strength has to be able to
        // change mid-run, and that is how `chromaticAberration` is meant to be driven. The
        // scale is a `float()` node for the opposite reason — it never changes, and the
        // function's own signature takes a node there rather than a number.
        strength = uniform(base);
        // The center must be a node: three's shader takes it as a vec2 input, and `null` (the
        // factory's own default) fails to compile, which blacked out the whole frame on a real GPU.
        node = chromaticAberration(node, strength, vec2(0.5, 0.5), float(CHROMA_SCALE));
      }

      pipeline = new RenderPipeline(renderer, node);
      label = profile.bloom ? (profile.chroma ? 'bloom+chroma' : 'bloom') : 'chroma';
    } catch {
      pipeline = null;
      strength = null;
      label = 'failed';
    }
  }

  return {
    get active() {
      return pipeline !== null;
    },

    label,

    punch(amount: number) {
      if (pipeline === null || !(amount > 0)) return;
      // A bigger hit wins rather than the newest one, and a punch still falling is topped up
      // rather than restarted: two grenades a frame apart are one bigger jolt, not two.
      if (amount > punch || left <= 0) punch = amount;
      left = PUNCH_TIME;
      if (strength !== null) strength.value = base + punch;
    },

    update(dt: number) {
      if (left <= 0) return;
      left -= dt;
      if (left > 0) return;
      left = 0;
      punch = 0;
      if (strength !== null) strength.value = base;
    },

    render() {
      if (pipeline === null) return false;
      try {
        pipeline.render();
        return true;
      } catch {
        // One throw is enough: a chain that failed once has told us what it is.
        pipeline = null;
        return false;
      }
    },

    disable() {
      pipeline = null;
      strength = null;
    },
  };
}
