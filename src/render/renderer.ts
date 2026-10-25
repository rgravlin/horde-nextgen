/**
 * The renderer: what the sim looks like (ARCHITECTURE.md "Module map").
 *
 * One `WebGPURenderer` from `three/webgpu`, which is WebGPU first and picks its own
 * WebGL2 backend when the browser has no `navigator.gpu` — or when `?gl=webgl2`
 * forces it, which is how both paths get exercised (TECH.md "Render backend"). The
 * canvas is created by index.html and handed in, so this file never touches the DOM
 * beyond the canvas it was given.
 *
 * Everything here is cosmetic and read-only: it takes the World's pools and draws
 * them and never writes a game value back (ARCHITECTURE.md "Data flow"). If the
 * renderer cannot start, the game still runs — the caller shows a panel instead.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  FogExp2,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';

import type { World } from '../sim/world';
import { createBatches, flipToRender, type Batches } from './instancing';

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

/** Colour roles from DESIGN.md, which are also the fog and sky colour. */
const VOID = 0x0b0d14;
const CONCRETE = 0x2a2e38;
const GUNMETAL = 0x4a505c;
const ALIEN_CYAN = 0x2ef2ff;

/** Scratch, reused every call: the aim ray-cast must not allocate per tick. */
const _ndc = new Vector2();
const _hit = new Vector3();
const _focus = new Vector3();
const _ground = new Plane(new Vector3(0, 1, 0), 0);
const _ray = new Raycaster();

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

  const scene = new Scene();
  scene.background = new Color(VOID);
  // Height fog over a dark floor: the arena fades into the sky colour instead of
  // ending in a hard edge, and the fog colour is the Void so the two never fight.
  scene.fog = new FogExp2(VOID, quality === 'low' ? 0.02 : 0.016);

  // The camera height and setback come out of the 55° pitch and the 22 m distance,
  // so the rig is the composition the brief asked for rather than an approximation.
  const camera = new PerspectiveCamera(CAM_FOV, 16 / 9, 0.5, 220);
  const camHeight = CAM_DISTANCE * Math.sin(CAM_PITCH);
  const camBack = CAM_DISTANCE * Math.cos(CAM_PITCH);

  const floor = new Mesh(
    new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE, 1, 1).rotateX(-Math.PI / 2),
    new MeshStandardNodeMaterial({ color: CONCRETE, roughness: 0.35, metalness: 0.05 }),
  );
  floor.receiveShadow = shadows;
  scene.add(floor);

  // One cool key light for the shadows and a low ambient fill: the arena is lit by
  // its own gunfire, so the moon only has to keep the floor readable (DESIGN.md).
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
  scene.add(new AmbientLight(0x2b3a52, 0.55));

  // The player: a capsule for the body and a short cyan wedge at the muzzle, so
  // aim reads at the camera height without needing a shadow to read it.
  const playerRig = new Group();
  const body = new Mesh(
    new CapsuleGeometry(0.4, 1.0, 6, 12),
    new MeshStandardNodeMaterial({ color: GUNMETAL, roughness: 0.45, metalness: 0.2 }),
  );
  body.position.y = 0.9;
  body.castShadow = shadows;
  const marker = new Mesh(
    new ConeGeometry(0.16, 0.5, 5).rotateZ(-Math.PI / 2).translate(0.75, 0, 0),
    new MeshBasicNodeMaterial({ color: ALIEN_CYAN }),
  );
  marker.position.y = 1.15;
  playerRig.add(body, marker);
  scene.add(playerRig);

  /**
   * Camera and batch state, one set per view: which pools the layers were built
   * against, the point the follow chases and how far the title orbit has travelled.
   */
  let batches: Batches | null = null;
  let following = false;
  let orbitAngle = 0;

  const view: View = {
    backend,
    quality,

    draw(world, alpha, dt, orbit) {
      // Built once against the pools of the World first drawn; a restart builds a
      // new World, so the layers have to be rebuilt against its pools.
      if (batches === null || batches.layers[0].pool !== world.enemies) {
        batches = createBatches(scene, world);
      }
      batches.sync(alpha);

      const p = world.player;
      playerRig.position.set(p.x, 0, flipToRender(p.y));
      playerRig.rotation.y = Math.atan2(p.aimY, p.aimX);
      playerRig.visible = p.alive;

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
      renderer.render(scene, camera);
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
