/**
 * The renderer: what the sim looks like (ARCHITECTURE.md "Module map").
 *
 * One `WebGPURenderer` from `three/webgpu`, which is WebGPU first and picks its own WebGL2
 * backend when the browser has no `navigator.gpu` — or when `?gl=webgl2` forces it, which is how
 * both paths get exercised (TECH.md "Render backend"). The canvas is created by index.html and
 * handed in, so this file never touches the DOM beyond the canvas it was given.
 *
 * This file is the assembly, and the parts it assembles are each somebody else's subject:
 * `machine.ts` (which backend and which tier this machine gets), `stage.ts` (the air, the floor
 * and the one light that casts shadows), `kit.ts` (everything drawn out of one World's pools,
 * which is a set with a lifetime because a restart builds a new World), `playerRig.ts` (the
 * player's body and the gun in its hand) and `facing.ts` (the line that gun points along, and
 * the yaw that turns the rig round), `cameraRig.ts` (the camera, the shake and what the
 * pointer means), `feel.ts` (this frame's events into shove and colour), and the layers that
 * were always their own files — `assets.ts`, `instancing.ts`, `meshes/`, `telegraphs.ts`,
 * `lights.ts`, `particles.ts`, `damageNumbers.ts`, `post.ts`, `quality.ts`.
 *
 * What is left here is the sequence and the two things with no other home: how the tier's numbers
 * get onto the renderer, and the one guard around the draw. Everything is cosmetic and read-only:
 * it takes the World's pools and draws them and never writes a game value back (ARCHITECTURE.md
 * "Data flow"). If the renderer cannot start, the game still runs — the caller shows a panel
 * instead.
 */

import { ACESFilmicToneMapping, PCFShadowMap } from 'three/webgpu';

import type { World } from '../sim/world';

import { loadAssets } from './assets';
import { createCameraRig } from './cameraRig';
import { createNumbers } from './damageNumbers';
import { playerFacing, yawToFace, type Face } from './facing';
import { createFeel } from './feel';
import { buildKit, disposeKit, syncKit, type Kit } from './kit';
import { createLightRig } from './lights';
import { bootRenderer, readMachine } from './machine';
import { createPost } from './post';
import type { ParticleMode } from './particles';
import { pickTier, pixelRatioFor, profileFor, type Backend, type Quality } from './quality';
import { createPlayerRig } from './playerRig';
import { createShake, DEFAULT_SCALE } from './shake';
import { createStage, FLOOR_SIZE } from './stage';

/** What `__forgeState().backend` reports; 'none' means neither backend came up. */
export type { Backend, Quality } from './quality';

export interface View {
  readonly backend: Backend;
  readonly quality: Quality;
  /**
   * Frames whose GPU work threw, counted rather than swallowed (AGENTS.md), and added
   * to `__forgeState().errors` by the shell. A renderer that cannot draw keeps playing:
   * the count is how a scenario tells "quiet" from "silent because it broke".
   */
  readonly errors: number;
  /**
   * Draw one frame. `alpha` is the interpolation point inside the last fixed step
   * and `dt` the real seconds since the previous frame, used only for camera
   * smoothing — never for gameplay. `orbit` is the title screen's camera.
   */
  draw(world: World, alpha: number, dt: number, orbit: boolean): void;
  /**
   * Cast a pointer position onto the ground plane and write the world point into
   * `out` (x, y). False when the ray misses the arena, e.g. the pointer is over
   * the sky beyond the floor.
   */
  aim(clientX: number, clientY: number, out: { x: number; y: number }): boolean;
  /** Re-read the canvas size: the window resizes, and the canvas starts at 0x0. */
  resize(): void;
}

export interface ViewOptions {
  /** `?gl=webgl2` in the URL, or the settings toggle. */
  forceWebGL?: boolean;
  /** Pin the tier instead of auto-detecting it (settings menu, tests). */
  quality?: Quality;
  /** The settings' resolution scale, 0.5..1; multiplies under the tier's own ceiling. */
  resolutionScale?: number;
  /** Take shadows away from whatever the tier picked. */
  shadows?: boolean;
  /** Take the bloom and chromatic passes away from whatever the tier picked. */
  bloom?: boolean;
  /** Fraction of the tier's particle budget; 0 leaves the spark field unbuilt. */
  particles?: number;
  /** Whether hits throw floating numbers. False skips the DOM layer entirely. */
  damageNumbers?: boolean;
  /** The settings' shake amount, 0..1. DESIGN.md's default is 70%. */
  shake?: number;
  /** The DOM overlay the damage numbers draw into, or null for a canvas-only page. */
  overlay?: HTMLElement | null;
}

/** Result of a boot attempt: a View, or why there is not one. */
export type ViewResult = { ok: true; view: View } | { ok: false; message: string };

/**
 * Bring the renderer up, or say why it cannot.
 *
 * The order is a dependency chain rather than a style: the backend has to resolve before a tier
 * can be picked, the tier before the room is built (it decides the shadow map, the lamps and
 * whether there is a post chain at all), and the camera before the chain, because a `RenderPipeline`
 * is built around one camera.
 */
export async function createView(
  canvas: HTMLCanvasElement,
  opts: ViewOptions = {},
): Promise<ViewResult> {
  const booted = await bootRenderer(canvas, opts.forceWebGL === true);
  if (!booted.ok) return booted;
  const renderer = booted.renderer;

  const machine = await readMachine(renderer);
  const backend: Backend = machine.backend;
  // The settings' pinned tier has to travel with the probe: a named tier is an instruction, and
  // `pickTier` lets it win over everything the machine reports (TECH.md "Render backend").
  const quality = pickTier({ ...machine, setting: opts.quality });
  const profile = profileFor(quality, {
    // The player's subtractions, applied under the tier rather than instead of it: the tier is
    // what the machine can do, these are what the player asked for.
    shadows: opts.shadows,
    bloom: opts.bloom,
    particles: opts.particles,
  });

  // Resolution scale from TECH.md's tiers: 0.75x on Low, capped at 1x everywhere, and the
  // settings' own dial under that.
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  renderer.setPixelRatio(pixelRatioFor(profile, ratio, opts.resolutionScale ?? 1));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = profile.shadows;
  renderer.shadowMap.type = PCFShadowMap;

  /**
   * The room's pieces, loaded once before anything is drawn.
   *
   * Awaited rather than swapped in mid-run because a flat grey arena that turns concrete a second
   * later is a visible pop, and every one of these files is small. A file that does not arrive
   * leaves its fallback in place (see `assets.ts`) and is counted, which is what keeps that
   * downgrade loud instead of silent (AGENTS.md: an error is a value).
   */
  const assets = await loadAssets(renderer, quality, FLOOR_SIZE);
  const stage = createStage(assets, profile);
  const scene = stage.scene;
  const player = createPlayerRig(scene, profile);

  /**
   * The lamps the gunfire lights (TECH.md: up to 16 pooled point lights, which do not cast
   * shadows).
   *
   * Built once, against the tier rather than the World: the pool's size is a quality decision
   * (16 at High, 8 at Medium, none at Low), and adding or removing a light rebuilds the scene's
   * lighting layout, so it is not something a restart gets to do.
   */
  const lamps = createLightRig(scene, profile);

  const shake = createShake(opts.shake ?? DEFAULT_SCALE);
  const rig = createCameraRig(renderer, canvas, shake, FLOOR_SIZE / 2);
  const camera = rig.camera;
  const post = createPost(renderer, scene, camera, profile);
  const feel = createFeel(shake, post, profile.chromaPunch);

  // A chain that threw on the way up is a counted problem, not a quiet downgrade: it says this
  // machine could not do what the tier asked for, and `errors` is the only channel that reaches
  // a check. A tier that asked for no chain at all reports 'none', which is not a problem.
  let errorCount = assets.missing.length + stage.faults;
  if (post.label === 'failed') {
    errorCount++;
    console.error(`post chain unavailable on the ${profile.tier} tier: drawing plain`);
  }

  /**
   * The floating numbers, in the overlay over the canvas.
   *
   * They are a DOM layer, so the one thing this file does with the page besides draw is hand
   * them the canvas's size each frame; they still read the World directly, and they still go
   * through the same step/hold rule as everything else here, which is what makes a pause hold
   * the numbers where they were.
   */
  // Off means the layer is never built, not that it draws nothing: the pool is a hundred and
  // twenty-eight DOM nodes and a per-frame write sweep, and a player who turned the numbers away
  // should not pay for either. The host is the other half of the pair — with `damageNumbers` on
  // and no overlay to draw into there is nothing to draw, which is not the same thing as off.
  const numbers = createNumbers(opts.damageNumbers === false ? null : opts.overlay ?? null);

  /**
   * Everything drawn out of one World's pools, rebuilt when the World changes; the layers
   * themselves are `kit.ts`'s business, including what they hold.
   */
  let kit: Kit | null = null;
  /** False once even a plain render has thrown: the sim runs, nothing is drawn. */
  let drawing = true;

  /**
   * Which way the sparks get their geometry.
   *
   * The instance-record path needs the compute-capable backend (TECH.md "Compute"); WebGL2 does
   * not have one, so the fallback there is not a fallback at all but the only path. The tier
   * decides how many particles that is worth drawing.
   */
  const particleMode: ParticleMode = backend === 'webgpu' ? 'gpu' : 'cpu';

  /**
   * The line the player's gun shoots along, rewritten once a frame (see `facing.ts`). One
   * pair for the view's life rather than one per frame, like the camera rig's scratch.
   */
  const face: Face = { x: 1, y: 0 };

  const view: View = {
    backend,
    quality,

    get errors() {
      return errorCount;
    },

    draw(world, alpha, dt, orbit) {
      if (!drawing) return;

      // Built once against the pools of the World first drawn; a restart builds a
      // new World, so the layers have to be rebuilt against its pools. A fresh World
      // means a fresh event ring, so the feel feed rewinds with them rather than
      // resuming wherever the last run's cursor had got to.
      let k = kit;
      if (k === null || k.world !== world) {
        if (k !== null) disposeKit(scene, k);
        feel.reset(world);
        k = buildKit(scene, assets, quality, profile, particleMode, world);
        kit = k;
      }

      // The room's air follows the chapter, and only when the chapter changes: three colour
      // writes at a chapter boundary rather than three every frame.
      stage.tint(world.chapter);

      // A frame that drew the same tick it drew last time is a held frame — the pause, the
      // level-up freeze, the summary — and a held frame decays nothing: no shake, no spark, no
      // number. That is DESIGN.md's "the game freezes", written once here rather than
      // negotiated between five layers.
      const stepping = world.tick !== k.lastTick;
      k.lastTick = world.tick;
      const step = stepping ? dt : 0;

      const p = world.player;

      // Each layer reads the pools at `alpha`, so the whole crowd lands between the last two
      // ticks instead of one frame behind them (TECH.md "Simulation and rendering").
      syncKit(k, world, alpha, dt);
      lamps.sync(world.fx, p.x, p.y);
      if (stepping) feel.feed(world);

      // The rig turns along the line the gun shoots, not along the raw aim: under auto-fire
      // those disagree (the shot leads a body), and `yawToFace` knows the rig's forward is
      // local +z on a floor whose north is -z, which `atan2(aimY, aimX)` does not.
      playerFacing(world, face);
      player.place(p.x, p.y, yawToFace(face.x, face.y), p.alive);
      player.hold(world.slots[world.activeSlot]?.weapon ?? -1);

      rig.frame(world, dt, step, orbit);
      stage.follow(p.x, p.y);

      // `aim()` reads the camera's matrices, which `render` would only refresh
      // later; updating here keeps the pointer's ground point current for the tick.
      camera.updateMatrixWorld();
      numbers.tick(world, step, camera, canvas.clientWidth, canvas.clientHeight);

      // One guard for the frame, with a same-frame demotion rather than a dropped one:
      // a chain that throws loses the chain and the frame is drawn plain, and a plain
      // render that throws stops the drawing. Either way the error is counted and the
      // simulation keeps stepping, so a bad GPU day costs picture, not the run.
      try {
        if (!post.render()) renderer.render(scene, camera);
      } catch (error) {
        errorCount++;
        if (errorCount === 1 || errorCount % 300 === 0) console.error('render failed:', error);
        if (post.active) {
          post.disable();
          try {
            renderer.render(scene, camera);
          } catch {
            drawing = false;
          }
        } else {
          drawing = false;
        }
      }
    },

    aim(clientX, clientY, out) {
      return rig.aim(clientX, clientY, out);
    },

    resize() {
      rig.resize();
    },
  };

  view.resize();
  return { ok: true, view };
}