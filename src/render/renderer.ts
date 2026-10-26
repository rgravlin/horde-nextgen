/**
 * The renderer: what the sim looks like (ARCHITECTURE.md "Module map").
 *
 * One `WebGPURenderer` from `three/webgpu`, which is WebGPU first and picks its own WebGL2
 * backend when the browser has no `navigator.gpu` — or when `?gl=webgl2` forces it, which is how
 * both paths get exercised (TECH.md "Render backend"). The canvas is created by index.html and
 * handed in, so this file never touches the DOM beyond the canvas it was given.
 *
 * What it draws is assembled from the other files in this folder and nothing more: `assets.ts`
 * for the floor, the kit and the sky, `instancing.ts` for the horde and the rounds,
 * `telegraphs.ts` for what the horde announces before it hits, `lights.ts` for the lamps the
 * gunfire lights, `fxView.ts` for the sparks. This file owns the camera, the air, the player's
 * own body, and the order the rest is called in.
 *
 * Everything here is cosmetic and read-only: it takes the World's pools and draws them and never
 * writes a game value back (ARCHITECTURE.md "Data flow"). If the renderer cannot start, the game
 * still runs — the caller shows a panel instead.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  RenderPipeline,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { pass, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';

import { levelAt } from '../content/levels';
import { WEAPONS, type WeaponFamily } from '../content/weapons';
import type { World } from '../sim/world';
import { createPropView, loadAssets, type Assets, type PropView } from './assets';
import { createFxView, type FxView } from './fxView';
import { createBatches, flipToRender, type Batches } from './instancing';
import { createLightRig } from './lights';
import { glowMaterial, playerBody, playerTrim, weaponKit } from './meshes';
import { createSceneryView, type SceneryView } from './scenery';
import { createTelegraphView, type TelegraphView } from './telegraphs';

/** What `__forgeState().backend` reports; 'none' means neither backend came up. */
export type Backend = 'webgpu' | 'webgl2' | 'none';

/** Quality tiers from TECH.md, chosen once at boot by `detectQuality`. */
export type Quality = 'low' | 'medium' | 'high';

/** The slice of an adapter this file reads; the WebGPU types are not installed. */
interface AdapterInfoLike {
  readonly description?: string;
  readonly vendor?: string;
  readonly architecture?: string;
}

/**
 * The slice of `navigator.gpu` used here, declared locally because `@webgpu/types`
 * is not a dependency of this project and cannot be added (TECH.md pins them).
 */
interface GpuLike {
  requestAdapter(): Promise<{ info?: AdapterInfoLike } | null>;
  requestAdapterInfo?(): AdapterInfoLike;
}

/** The renderer's `backend` is typed as the abstract class, which hides the flag. */
interface BackendLike {
  readonly isWebGPUBackend?: boolean;
  getContext?(): unknown;
}

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

/** Camera distance from the player in metres, and its pitch below horizontal. */
const CAM_DISTANCE = 22;
const CAM_PITCH = (55 * Math.PI) / 180;

/** Vertical FOV in degrees, matching the 40° the design brief pins. */
const CAM_FOV = 40;

/** Seconds of camera smoothing; the follow is critically damped by construction. */
const CAM_TAU = 0.12;

/** Metres the camera leads the aim point, so the player is never dead centre. */
const CAM_LEAD = 2;

/** How much of the arena the floor covers; the world itself is 120x120 m. */
const FLOOR_SIZE = 170;

/** Colour roles from DESIGN.md. Void is also the fog and the sky, which is the point. */
const VOID = 0x0b0d14;
const GUNMETAL = 0x4a505c;
const GUN_ORANGE = 0xff7a1a;
const EMBER = 0xff4d2e;
const ALIEN_CYAN = 0x2ef2ff;

/**
 * How much of the HDRI the room gets.
 *
 * The autoshop is a daylight garage and this is a night factory floor: at full strength the
 * environment washes out every accent the palette is built on. What is left at this level is the
 * sheen on the wet concrete and a little rim light on the kit, which is what DESIGN.md means by
 * an environment map used "only for reflections and IBL", never as a backdrop.
 */
const ENV_INTENSITY = 0.4;

/** The three gun shapes the player can be holding, in `weaponKit`'s order. */
const FAMILIES: readonly WeaponFamily[] = ['guns', 'medieval', 'alien'];

/** Scratch, reused every call: the aim ray-cast must not allocate per tick. */
const _ndc = new Vector2();
const _hit = new Vector3();
const _focus = new Vector3();
const _ground = new Plane(new Vector3(0, 1, 0), 0);
const _ray = new Raycaster();

/**
 * Paint one chapter's air: its fog, its sky and the colour of its one key light.
 *
 * DESIGN.md asks each chapter to tint the fog and key light while the palette *roles* never
 * change, so this moves three colours and nothing else — no geometry, no material, no light
 * added or removed. The sky takes the fog's value rather than keeping Void because the brief's
 * own reason for a Void fog is that the two never fight; splitting them at a chapter boundary
 * would put a hard seam where the arena's edge already is.
 *
 * Driven off `world.chapter` rather than off the scene rebuild because a run changes rooms
 * without changing scenes: one scene, ten rooms, and the chapter says which.
 */
function applyTint(scene: Scene, key: DirectionalLight, chapter: number): void {
  const palette = levelAt(chapter).palette;
  if (scene.fog instanceof FogExp2) scene.fog.color.set(palette.fog);
  if (scene.background instanceof Color) scene.background.set(palette.fog);
  key.color.set(palette.key);
}

export interface ViewOptions {
  /** `?gl=webgl2` in the URL, or the settings toggle. */
  forceWebGL?: boolean;
  /** Pin the tier instead of auto-detecting it (settings menu, tests). */
  quality?: Quality;
}

/** Result of a boot attempt: a View, or why there is not one. */
export type ViewResult = { ok: true; view: View } | { ok: false; message: string };

function isSoftware(name: string): boolean {
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}

/**
 * Guess the tier from what the GPU actually reports: Med when unsure and Low on
 * software rasterisation (TECH.md "Render backend").
 *
 * The names come from the adapter info on WebGPU and from
 * `WEBGL_debug_renderer_info` on WebGL2. A scene drawn by SwiftShader does not get
 * to spend its frame budget on shadows nobody can see through the bloom.
 */
async function detectQuality(renderer: WebGPURenderer): Promise<Quality> {
  try {
    const backend = renderer.backend as BackendLike;
    if (backend.isWebGPUBackend === true) {
      const gpu = (globalThis as { navigator?: { gpu?: GpuLike } }).navigator?.gpu;
      if (!gpu) return 'medium';
      const adapter = await gpu.requestAdapter();
      const info = adapter?.info ?? gpu.requestAdapterInfo?.();
      const name = [info?.description, info?.vendor, info?.architecture].filter(Boolean).join(' ');
      if (name) return isSoftware(name) ? 'low' : 'high';
      return 'medium';
    }

    const gl = renderer.getContext() as WebGL2RenderingContext | null;
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = debug && gl ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : '';
    if (name) return isSoftware(name) ? 'low' : 'medium';
  } catch {
    // A missing or unexpected probe says nothing about the hardware.
  }
  return 'medium';
}

/**
 * Bring the renderer up, or say why it cannot.
 *
 * `await renderer.init()` is what resolves the backend: WebGPU when the browser has
 * it, WebGL2 when it does not (three falls back through the renderer's
 * `getFallback`), and nothing when neither works — the one case that earns the
 * "needs WebGL2" panel instead of a black canvas.
 */
export async function createView(
  canvas: HTMLCanvasElement,
  opts: ViewOptions = {},
): Promise<ViewResult> {
  let renderer: WebGPURenderer;

  try {
    renderer = new WebGPURenderer({
      canvas,
      antialias: false,
      forceWebGL: opts.forceWebGL === true,
      alpha: false,
    });
    await renderer.init();
  } catch (error) {
    return { ok: false, message: `no WebGL2 or WebGPU context: ${String(error)}` };
  }

  const backend: Backend = (renderer.backend as BackendLike).isWebGPUBackend === true ? 'webgpu' : 'webgl2';
  // A WebGL2 backend with no context back means the browser cannot draw this at
  // all; say so rather than render an empty arena forever.
  if (backend === 'webgl2' && !(renderer.getContext() as WebGL2RenderingContext | null)) {
    return { ok: false, message: 'getContext("webgl2") returned no context' };
  }

  const quality = opts.quality ?? (await detectQuality(renderer));
  const shadows = quality !== 'low';

  // Resolution scale from TECH.md's tiers: 0.75x on Low, capped at 1x everywhere.
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  renderer.setPixelRatio(Math.min(1, quality === 'low' ? ratio * 0.75 : ratio));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = PCFShadowMap;

  /**
   * The room's pieces, loaded once before anything is drawn.
   *
   * Awaited rather than swapped in mid-run because a flat grey arena that turns concrete a second
   * later is a visible pop, and every one of these files is small. A file that does not arrive
   * leaves its fallback in place (see `assets.ts`) and is counted, which is what keeps that
   * downgrade loud instead of silent (AGENTS.md: an error is a value).
   */
  const assets: Assets = await loadAssets(renderer, quality, FLOOR_SIZE);

  const scene = new Scene();
  scene.background = new Color(VOID);
  // Height fog over a dark floor: the arena fades into the sky colour instead of ending in a
  // hard edge, and the fog colour is the Void so the two never fight. The HDRI never becomes the
  // background, which is why `background` is a colour and `assets.env` goes on `environment`.
  scene.fog = new FogExp2(VOID, quality === 'low' ? 0.02 : 0.016);
  let errorCount = assets.missing.length;
  if (assets.env !== null) {
    try {
      scene.environment = assets.env;
      scene.environmentIntensity = ENV_INTENSITY;
    } catch (error) {
      errorCount++;
      console.error('environment unavailable:', error);
    }
  }

  const floor = new Mesh(new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE, 1, 1).rotateX(-Math.PI / 2), assets.ground);
  floor.receiveShadow = shadows;
  scene.add(floor);

  // One cool key light for the shadows and a low ambient fill: the arena is lit by its own
  // gunfire, so the moon only has to keep the floor readable (DESIGN.md). The fill is dimmer
  // than it used to be because the environment map now lights the diffuse too.
  const key = new DirectionalLight(0xbfd7ff, 1.6);
  key.castShadow = shadows;
  const mapSize = quality === 'high' ? 2048 : 1024;
  key.shadow.mapSize.set(mapSize, mapSize);
  key.shadow.camera.near = 2;
  key.shadow.camera.far = 120;
  key.shadow.camera.left = -34;
  key.shadow.camera.right = 34;
  key.shadow.camera.top = 34;
  key.shadow.camera.bottom = -34;
  key.shadow.bias = -0.0008;
  scene.add(key);
  scene.add(key.target);
  scene.add(new AmbientLight(0x2b3a52, 0.4));

  /**
   * The player: a kit-bashed body, its emissive trim, and one gun shape per weapon family.
   *
   * Kit-bash rather than a capsule so the player is built from the same part-based idiom as the
   * horde (DESIGN.md "Player and weapons"), and three guns exist so the family reads from the
   * camera without checking the HUD. Only the one being held is drawn.
   */
  const playerRig = new Group();
  const body = new Mesh(
    playerBody(),
    new MeshStandardNodeMaterial({ color: GUNMETAL, roughness: 0.45, metalness: 0.2 }),
  );
  body.castShadow = shadows;
  const trim = new Mesh(playerTrim(), glowMaterial(ALIEN_CYAN, 2.2));
  const kits = weaponKit();
  const gunMeshes = [
    new Mesh(kits.guns, glowMaterial(GUN_ORANGE, 2.2)),
    new Mesh(kits.medieval, glowMaterial(EMBER, 2.2)),
    new Mesh(kits.alien, glowMaterial(ALIEN_CYAN, 2.2)),
  ];
  playerRig.add(body, trim, ...gunMeshes);
  scene.add(playerRig);

  /** Which gun is on show; -1 until the first frame picks one. */
  let shownGun = -1;

  /**
   * The lamps the gunfire lights (TECH.md: up to 16 pooled point lights, which do not cast
   * shadows).
   *
   * Built once, against the tier rather than the World: the pool's size is a quality decision
   * (16 at High, 8 at Medium, none at Low), and adding or removing a light rebuilds the scene's
   * lighting layout, so it is not something a restart gets to do.
   */
  const lights = createLightRig(scene, quality);

  // The camera height and setback come out of the 55° pitch and the 22 m distance,
  // so the rig is the composition the brief asked for rather than an approximation.
  const camera = new PerspectiveCamera(CAM_FOV, 16 / 9, 0.5, 220);
  const camHeight = CAM_DISTANCE * Math.sin(CAM_PITCH);
  const camBack = CAM_DISTANCE * Math.cos(CAM_PITCH);

  /**
   * The post chain: bloom, then the chromatic punch, then tone mapping, in one
   * composite pass rather than a stack of full-screen passes.
   *
   * `outputColorTransform` stays at its default, which makes the pipeline wrap the
   * chain in its own output node: the bloom reads the scene's HDR values, the aberration
   * offsets them, and tone mapping and the sRGB step land after both — the order the
   * design brief asks for and the order that keeps big hits glowing instead of clipping.
   *
   * Built inside a `try` because this is the one part of the frame that can fail for
   * reasons nobody here can test: a driver without the float-blend extension, a WebGL2
   * context that came up without what the bloom mips want. A chain that will not build
   * leaves `pipeline` null and the frame goes through the plain path in `draw`, so the
   * player loses the grade and keeps the game.
   */
  let pipeline: RenderPipeline | null = null;
  if (quality !== 'low') {
    try {
      const scenePass = pass(scene, camera);
      const bloomPass = bloom(scenePass.getTextureNode(), quality === 'high' ? 0.62 : 0.4, 0.6, 0.72);
      // Strength goes in as a uniform rather than a literal: the punch DESIGN.md asks for on
      // a big hit has to be able to change it mid-run, and that is how the node is meant to
      // be driven (`chromaticAberration(node, strength, center, scale)`).
      const chroma = uniform(quality === 'high' ? 0.004 : 0.0025);
      pipeline = new RenderPipeline(renderer, chromaticAberration(bloomPass, chroma));
    } catch (error) {
      pipeline = null;
      errorCount++;
      console.error('post chain unavailable:', error);
    }
  }

  /**
   * Everything drawn out of one World's pools, rebuilt when the World changes.
   *
   * A restart builds a new World with new pools, so the layers are rebuilt against it — and the
   * old set is taken out of the scene and disposed rather than left under the new one, because a
   * run restarted twenty times should not pay for twenty arenas.
   */
  interface Kit {
    /** The World these layers read; changing it is what a restart looks like from here. */
    world: World;
    batches: Batches;
    fx: FxView;
    props: PropView;
    hazards: SceneryView;
    telegraphs: TelegraphView;
    group: Group;
  }
  let kit: Kit | null = null;
  /** False once even a plain render has thrown: the sim runs, nothing is drawn. */
  let drawing = true;
  /** Which chapter's tint the scene is currently wearing; -1 until the first draw. */
  let tintChapter = -1;

  function buildKit(world: World): Kit {
    if (kit !== null) {
      scene.remove(kit.group);
      kit.group.traverse((o) => {
        const holder = o as unknown as {
          geometry?: { dispose(): void };
          material?: { dispose(): void } | Array<{ dispose(): void }>;
        };
        holder.geometry?.dispose();
        const material = holder.material;
        if (Array.isArray(material)) for (const one of material) one.dispose();
        else material?.dispose();
      });
    }

    const group = new Group();
    scene.add(group);
    return {
      world,
      // Cover before the horde so the crowd reads against it, and the two flat layers last: a
      // warning drawn under a body is a warning nobody sees.
      props: createPropView(group, assets, quality),
      hazards: createSceneryView(group, world),
      batches: createBatches(group, world, quality),
      telegraphs: createTelegraphView(group),
      fx: createFxView(group),
      group,
    };
  }

  /**
   * Camera and layer state, one set per view: which pools the layers were built
   * against, the point the follow chases and how far the title orbit has travelled.
   */
  let following = false;
  let orbitAngle = 0;

  const view: View = {
    backend,
    quality,

    get errors() {
      return errorCount;
    },

    draw(world, alpha, dt, orbit) {
      if (!drawing) return;

      // Built once against the pools of the World first drawn; a restart builds a
      // new World, so the layers have to be rebuilt against its pools.
      if (kit === null || kit.world !== world) {
        kit = buildKit(world);
      }

      // The room's air follows the chapter, and only when the chapter changes: three colour
      // writes at a chapter boundary rather than three every frame.
      if (world.chapter !== tintChapter) {
        tintChapter = world.chapter;
        applyTint(scene, key, world.chapter);
      }

      const p = world.player;

      // Each layer reads the pools at `alpha`, so the whole crowd lands between the last two
      // ticks instead of one frame behind them (TECH.md "Simulation and rendering").
      kit.props.sync(world);
      kit.hazards.sync(world);
      kit.batches.sync(world, alpha, dt);
      kit.telegraphs.sync(world, dt);
      kit.fx.sync(world.fx);
      lights.sync(world.fx, p.x, p.y);

      playerRig.position.set(p.x, 0, flipToRender(p.y));
      playerRig.rotation.y = Math.atan2(p.aimY, p.aimX);
      playerRig.visible = p.alive;

      // The gun follows the hand rather than the frame: the shape only changes when a weapon is
      // picked up, so this is one comparison and, on the rare frame that differs, two writes.
      const hand = world.slots[world.activeSlot];
      const held = hand === undefined ? -1 : hand.weapon;
      const gun = held >= 0 && held < WEAPONS.length ? WEAPONS[held].family : 'guns';
      const gunAt = FAMILIES.indexOf(gun);
      if (gunAt !== shownGun) {
        for (let i = 0; i < gunMeshes.length; i++) gunMeshes[i].visible = i === gunAt;
        shownGun = gunAt;
      }

      if (orbit) {
        // Title screen: a slow drift around the arena, which is the only reason a
        // menu has a 3D scene behind it (DESIGN.md "Menus").
        orbitAngle += dt * 0.08;
        const r = 30;
        camera.position.set(Math.sin(orbitAngle) * r, camHeight * 0.8, Math.cos(orbitAngle) * r);
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

      // The light rig travels with the player, so the shadow camera always covers
      // the part of the arena in view instead of one fixed 68 m square.
      key.position.set(p.x + 12, 24, flipToRender(p.y) + 8);
      key.target.position.set(p.x, 0, flipToRender(p.y));

      // `aim()` reads the camera's matrices, which `render` would only refresh
      // later; updating here keeps the pointer's ground point current for the tick.
      camera.updateMatrixWorld();

      // One guard for the frame, with a same-frame demotion rather than a dropped one:
      // a chain that throws loses the chain and the frame is drawn plain, and a plain
      // render that throws stops the drawing. Either way the error is counted and the
      // simulation keeps stepping, so a bad GPU day costs picture, not the run.
      try {
        if (pipeline !== null) pipeline.render();
        else renderer.render(scene, camera);
      } catch (error) {
        errorCount++;
        if (errorCount === 1 || errorCount % 300 === 0) console.error('render failed:', error);
        if (pipeline !== null) {
          pipeline = null;
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
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      _ndc.set((clientX / w) * 2 - 1, -(clientY / h) * 2 + 1);
      // The camera matrices are refreshed for the next draw; the aim ray is cast
      // before that happens, so update them here to keep the ground point current.
      camera.updateMatrixWorld();
      _ray.setFromCamera(_ndc, camera);
      if (!_ray.ray.intersectPlane(_ground, _hit)) return false;
      out.x = _hit.x;
      out.y = flipToRender(_hit.z);
      return Math.abs(out.x) <= FLOOR_SIZE / 2 && Math.abs(out.y) <= FLOOR_SIZE / 2;
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

  view.resize();
  return { ok: true, view };
}
