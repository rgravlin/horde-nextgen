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
 * gunfire lights, `particles.ts` for the sparks, `damageNumbers.ts` for the numbers they throw
 * up. This file owns the camera, the air, the player's own body, the shake the hits put in it,
 * and the order the rest is called in.
 *
 * The numbers that used to be scattered through here — how big a tier's shadow map is, how many
 * lamps it may light, whether it gets bloom — now live in `quality.ts`, one table with four
 * rows, and the chain those numbers describe is built in `post.ts`. What is left here is the
 * part with no knob: the camera rig and the draw order.
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
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';

import { levelAt } from '../content/levels';
import { WEAPONS, type WeaponFamily } from '../content/weapons';
import { Ev, type World } from '../sim/world';
import { createPropView, loadAssets, type Assets, type PropView } from './assets';
import { createNumbers, type NumberLayer } from './damageNumbers';
import { createParticles, type ParticleMode, type ParticleView } from './particles';
import { createBatches, flipToRender, type Batches } from './instancing';
import { createLightRig } from './lights';
import { glowMaterial, playerBody, playerTrim, weaponKit } from './meshes';
import { createPost } from './post';
import { pickTier, pixelRatioFor, profileFor, type Backend, type DeviceKind, type Quality } from './quality';
import { createSceneryView, type SceneryView } from './scenery';
import { createShake, DEFAULT_SCALE } from './shake';
import { createTelegraphView, type TelegraphView } from './telegraphs';

/** What `__forgeState().backend` reports; 'none' means neither backend came up. */
export type { Backend, Quality } from './quality';

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

/**
 * How far from the player a blast still moves the camera, in metres, and how much trauma one
 * lands at the player's feet with (DESIGN.md: "large for explosions and boss slams").
 *
 * A blast across the arena is not felt, and a screen that shakes for every grenade the sniper
 * throws two screens away is a screen nobody can read. Both halves matter: the radius decides
 * whether a jolt happens at all, and the falloff decides how big the ones that do are.
 */
const BLAST_FEEL = 14;
const BLAST_TRAUMA = 0.22;

/** The three gun shapes the player can be holding, in `weaponKit`'s order. */
const FAMILIES: readonly WeaponFamily[] = ['guns', 'medieval', 'alien'];

/** Scratch, reused every call: the aim ray-cast must not allocate per tick. */
const _ndc = new Vector2();
const _hit = new Vector3();
const _focus = new Vector3();
const _ground = new Plane(new Vector3(0, 1, 0), 0);
const _ray = new Raycaster();
const _shake = { x: 0, z: 0 };
const _clean = new Vector3();

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

/**
 * What the machine calls its own GPU, or '' when it says nothing.
 *
 * The adapter's own words on WebGPU, and `WEBGL_debug_renderer_info`'s on WebGL2. That is the
 * whole input to the tier choice, and the two are deliberately the same type: a name is either
 * recognisable as a software rasteriser or it is not, and a probe that says nothing should not
 * buy the top tier (see `pickTier`).
 */
async function gpuName(renderer: WebGPURenderer): Promise<string> {
  try {
    const backend = renderer.backend as { isWebGPUBackend?: boolean };
    if (backend.isWebGPUBackend === true) {
      const gpu = (globalThis as { navigator?: { gpu?: GpuLike } }).navigator?.gpu;
      if (!gpu) return '';
      const adapter = await gpu.requestAdapter();
      const info = adapter?.info ?? gpu.requestAdapterInfo?.();
      return [info?.description, info?.vendor, info?.architecture].filter(Boolean).join(' ');
    }
    const gl = renderer.getContext() as WebGL2RenderingContext | null;
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return debug && gl ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : '';
  } catch {
    return '';
  }
}

/**
 * The two other things the tier wants, read off `navigator`.
 *
 * Both are honest about not existing: `deviceMemory` is Chromium-only and
 * `userAgentData` is gone in Firefox, and a browser that answers neither gets `unknown`, which
 * `pickTier` reads as "a desktop we cannot prove", not as a phone. A phone that lies about
 * being a phone is the case the memory cut catches.
 */
function machineInfo(): { memory: number; deviceKind: DeviceKind } {
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator;
  if (!nav) return { memory: 0, deviceKind: 'unknown' };
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0;
  if (typeof nav.userAgentData?.mobile === 'boolean') {
    return { memory, deviceKind: nav.userAgentData.mobile ? 'mobile' : 'desktop' };
  }
  const agent = typeof nav.userAgent === 'string' ? nav.userAgent : '';
  const handheld = /Android|iPhone|iPad|iPod|Mobile/i.test(agent);
  return { memory, deviceKind: agent === '' ? 'unknown' : handheld ? 'mobile' : 'desktop' };
}

/** The slice of `navigator` the tier choice reads; the DOM types are not installed here. */
interface NavigatorLike {
  readonly deviceMemory?: number;
  readonly userAgent?: string;
  readonly userAgentData?: { readonly mobile?: boolean };
}

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

  const machine = machineInfo();
  const quality = pickTier({
    backend,
    gpuName: await gpuName(renderer),
    memory: machine.memory,
    deviceKind: machine.deviceKind,
    setting: opts.quality,
  });
  const profile = profileFor(quality, {
    // The player's subtractions, applied under the tier rather than instead of it: the tier is
    // what the machine can do, these are what the player asked for.
    shadows: opts.shadows,
    bloom: opts.bloom,
    particles: opts.particles,
  });
  const scale = opts.resolutionScale ?? 1;

  // Resolution scale from TECH.md's tiers: 0.75x on Low, capped at 1x everywhere, and the
  // settings' own dial under that.
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  renderer.setPixelRatio(pixelRatioFor(profile, ratio, scale));
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
  const assets: Assets = await loadAssets(renderer, quality, FLOOR_SIZE);

  const scene = new Scene();
  scene.background = new Color(VOID);
  // Height fog over a dark floor: the arena fades into the sky colour instead of ending in a
  // hard edge, and the fog colour is the Void so the two never fight. The HDRI never becomes the
  // background, which is why `background` is a colour and `assets.env` goes on `environment`.
  scene.fog = new FogExp2(VOID, profile.fogDensity);
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
  floor.receiveShadow = profile.shadows;
  scene.add(floor);

  // One cool key light for the shadows and a low ambient fill: the arena is lit by its own
  // gunfire, so the moon only has to keep the floor readable (DESIGN.md). The fill is dimmer
  // than it used to be because the environment map now lights the diffuse too.
  const key = new DirectionalLight(0xbfd7ff, 1.6);
  key.castShadow = profile.shadows;
  key.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
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
  body.castShadow = profile.shadows;
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
  const lights = createLightRig(scene, profile);

  // The camera height and setback come out of the 55° pitch and the 22 m distance,
  // so the rig is the composition the brief asked for rather than an approximation.
  const camera = new PerspectiveCamera(CAM_FOV, 16 / 9, 0.5, 220);
  const camHeight = CAM_DISTANCE * Math.sin(CAM_PITCH);
  const camBack = CAM_DISTANCE * Math.cos(CAM_PITCH);

  const post = createPost(renderer, scene, camera, profile);

  // A chain that threw on the way up is a counted problem, not a quiet downgrade: it says this
  // machine could not do what the tier asked for, and `errors` is the only channel that reaches
  // a check. A tier that asked for no chain at all reports 'none', which is not a problem.
  if (post.label === 'failed') {
    errorCount++;
    console.error(`post chain unavailable on the ${profile.tier} tier: drawing plain`);
  }

  /**
   * The camera's shake, and how far into this World's event ring the frame has read.
   *
   * Two feeds, both read once per rendered frame: whatever a body's death blast pays out
   * (`Ev.Explosion`, felt within `BLAST_FEEL` metres and fading with the distance) and whatever
   * the player was hit by (`Ev.Shake`, which carries its trauma times ten). Everything it adds
   * goes through `Shake.addTrauma`, which caps at 1, so a frame of eight detonations and two
   * bolts is one big jolt rather than eight small ones.
   */
  const shake = createShake(opts.shake ?? DEFAULT_SCALE);

  /**
   * The floating numbers, in the overlay over the canvas.
   *
   * They are a DOM layer, so the one thing this file does with the page besides draw is hand
   * them the canvas's size each frame; they still read the World directly, and they still go
   * through the same step/hold rule as everything else here, which is what makes a pause hold
   * the numbers where they were.
   */
  // Off means the layer is never built, not that it draws nothing: the pool is sixty-four DOM
  // nodes and a per-frame write sweep, and a player who turned the numbers away should not pay
  // for either.
  const numbers: NumberLayer = createNumbers(
    opts.damageNumbers === false ? null : opts.overlay ?? null,
  );

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
    /** Null when the budget is nil, which is a setting rather than a tier. */
    particles: ParticleView | null;
    props: PropView;
    hazards: SceneryView;
    telegraphs: TelegraphView;
    group: Group;
    /** How far into the event ring the shake and the punch have read. */
    eventAt: number;
    /** The tick the last frame drew, which is how a held frame is spotted. */
    lastTick: number;
  }
  let kit: Kit | null = null;
  /** False once even a plain render has thrown: the sim runs, nothing is drawn. */
  let drawing = true;
  /** Which chapter's tint the scene is currently wearing; -1 until the first draw. */
  let tintChapter = -1;

  /**
   * Which way the sparks get their geometry.
   *
   * The instance-record path needs the compute-capable backend (TECH.md "Compute"); WebGL2 does
   * not have one, so the fallback there is not a fallback at all but the only path. The tier
   * decides how many particles that is worth drawing.
   */
  const particleMode: ParticleMode = backend === 'webgpu' ? 'gpu' : 'cpu';

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
      // A nil budget leaves the field unbuilt rather than built empty: four batches of zero
      // instances are four buffers and four draw calls paid for nothing.
      particles: profile.particles > 0 ? createParticles(group, profile, particleMode) : null,
      group,
      // A fresh World means a fresh event ring, so the reader starts at its beginning rather
      // than resuming wherever the last run's cursor had got to.
      eventAt: world.events.written,
      lastTick: -1,
    };
  }

  /**
   * Turn this frame's events into shake and punch.
   *
   * Read once per frame through the kit's own cursor — the ring is a broadcast that nothing
   * drains (see `EventRing`) — and skipped whole on a held frame, which is what keeps a paused
   * screen still instead of quietly settling its own camera.
   */
  function feedFeel(kit: Kit, world: World): void {
    const ring = world.events;
    let at = kit.eventAt;
    const oldest = ring.written - ring.count;
    if (at < oldest) at = oldest;
    if (at >= ring.written) {
      kit.eventAt = ring.written;
      return;
    }

    const px = world.player.x;
    const py = world.player.y;
    for (; at < ring.written; at++) {
      const i = at % ring.cap;
      const type = ring.type[i];
      if (type === Ev.Shake) {
        // `a` is trauma x 10, which is how the sim writes a hit that was big enough to shake
        // the camera (see `hurtPlayer`).
        shake.addTrauma(ring.a[i] / 10);
        post.punch(profile.chromaPunch * 0.7);
      } else if (type === Ev.Explosion) {
        const dx = ring.x[i] - px;
        const dy = ring.y[i] - py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= BLAST_FEEL) continue;
        // Linear on the distance rather than squared: a blast's *sound* falls off with the area,
        // but what a jolt is worth is how near it felt, and squared would have a grenade at four
        // metres already down to nothing.
        const feel = 1 - d / BLAST_FEEL;
        shake.addTrauma(BLAST_TRAUMA * feel);
        post.punch(profile.chromaPunch * feel);
      }
    }
    kit.eventAt = ring.written;
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

      // A frame that drew the same tick it drew last time is a held frame — the pause, the
      // level-up freeze, the summary — and a held frame decays nothing: no shake, no spark, no
      // number. That is DESIGN.md's "the game freezes", written once here rather than
      // negotiated between five layers.
      const stepping = world.tick !== kit.lastTick;
      kit.lastTick = world.tick;
      const step = stepping ? dt : 0;

      const p = world.player;

      // Each layer reads the pools at `alpha`, so the whole crowd lands between the last two
      // ticks instead of one frame behind them (TECH.md "Simulation and rendering").
      kit.props.sync(world);
      kit.hazards.sync(world);
      kit.batches.sync(world, alpha, dt);
      kit.telegraphs.sync(world, dt);
      kit.particles?.sync(world.fx);
      lights.sync(world.fx, p.x, p.y);
      if (stepping) feedFeel(kit, world);

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

      // The light rig travels with the player, so the shadow camera always covers
      // the part of the arena in view instead of one fixed 68 m square.
      key.position.set(p.x + 12, 24, flipToRender(p.y) + 8);
      key.target.position.set(p.x, 0, flipToRender(p.y));

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
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      _ndc.set((clientX / w) * 2 - 1, -(clientY / h) * 2 + 1);
      // The pointer is aimed at the picture the player was shown a moment ago, and the picture
      // is shaken while the aim is not: put the camera back where the follow had it before
      // casting, or every jolt would move the ground under the cursor and shake would be
      // gameplay. The next `draw` sets the position up again from scratch either way.
      camera.position.copy(_clean);
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
