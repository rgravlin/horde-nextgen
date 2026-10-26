/**
 * The room: what the floor is made of, what the cover is made of, and what the sky reflects
 * off them.
 *
 * Three loaded things, all of them optional in the same way:
 *
 * - **The floor** is Poly Haven's wet concrete (albedo + normal + roughness, 1k, CC0) laid on a
 *   2 m tile. DESIGN.md wants the floor mid-value and wet so the neon has somewhere to land; a
 *   black floor eats the horde's silhouettes, which is why the map is used *as* the albedo
 *   instead of being multiplied by the brief's Concrete (that product is a black floor).
 * - **The cover** is the Kenney City Kit Industrial set (ASSETS.md), one module per prop kind,
 *   repeated across the obstacle the simulation collides against. Repeated rather than
 *   stretched: a 46 m wall run drawn as one stretched kit piece is one smeared texture and says
 *   nothing about where the wall ends, while a run of containers reads as distance. What stops
 *   you and what you see stay the same box (`sim/systems/obstacles.ts` is the source of truth)
 *   and a module never pokes outside it — a wall you can shoot through is the bug `scenery.ts`
 *   names, wearing a hat.
 * - **The environment** is the autoshop HDRI for reflections and IBL only. DESIGN.md is explicit
 *   that the HDRI is never the backdrop: the backdrop stays Void with height fog, because a sky
 *   visible through the whole arena is a horizon line drawn across the playfield.
 *
 * Everything here degrades: a missing texture leaves the flat Concrete material, a missing model
 * leaves the boxes this file took over from `scenery.ts`, and every failure is listed in
 * `Assets.missing` so the shell counts it instead of the frame quietly going flat (AGENTS.md: an
 * error is a value, not a silence).
 */

import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  EquirectangularReflectionMapping,
  InstancedMesh,
  MeshStandardNodeMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type BufferGeometry,
  type Object3D,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { PROP_KIND_COUNT, PropKind, type PropField } from '../sim/systems/obstacles';
import type { World } from '../sim/world';
import { flipToRender } from './instancing';

import type { Quality } from './renderer';

/** Where the CC0 files live. ASSETS.md lists them with their licences. */
const MODEL_ROOT = '/models/kenney-industrial/Models/GLB%20format/';
const COLOR_MAP = MODEL_ROOT + 'Textures/colormap.png';
const FLOOR_ROOT = '/textures/concrete_floor_02/';
const ENV_URL = '/hdri/autoshop_01_1k.hdr';

/**
 * Metres of floor per tile of the concrete map.
 *
 * Three, not two: the scan's mottling is about that wide in the real slab, and at a 2 m tile the
 * camera's 55° pitch packs it into a checkerboard that reads as grass. A wider tile also lands
 * closer to the "some puddle variation" DESIGN.md asks for instead of an even sprinkling.
 */
const FLOOR_TILE = 3;

/**
 * The module that stands in for each prop kind, in `PropKind` order.
 *
 * Chosen for silhouette and cost rather than for accuracy: a wall run wants something that
 * already reads as a long low industrial mass, the round props want the chimney (it is the same
 * shape as a column, which is the one case where the sim's circle and the drawn circle agree),
 * and 2 m of cover wants a container. Whole kit pieces of a few hundred triangles, repeated —
 * not one building pulled to 46 m.
 */
const PROP_MODEL: readonly string[] = [
  'building-r.glb',
  'shipping-container-b.glb',
  'detail-tank-large.glb',
  'chimney-large.glb',
];

/** How big a module of each kind reads, in metres along its own long axis. */
const MODULE_SIZE: readonly number[] = [5, 1.5, 3.4, 2.6];

/** The most height each kind may take. Cover stays under the 4 m DESIGN.md caps it all. */
const MODULE_HEIGHT: readonly number[] = [3.2, 1.3, 2.7, 3.4];

/** The heights of the fallback primitives, same order. */
const FALLBACK_HEIGHT: readonly number[] = [3.2, 1.1, 1.7, 2.8];

/** The fallbacks' colours: Gunmetal and Oak, so a box still reads as a thing (DESIGN.md). */
const FALLBACK_COLOR: readonly number[] = [0x2f3440, 0x4a3a28, 0x4a505c, 0x37424e];

/** How many modules one layer may draw. Past that the extras are dropped. */
const LAYER_CAP = 320;

/** How many modules along one axis. Fourteen is a wall; thirty would be noise. */
const RUN_CAP = 14;

/**
 * One module in one orientation, ready to be repeated.
 *
 * The geometry is authored so its bounding box is centred on the origin in x and z and its feet
 * are at y = 0, which is what lets an instance get away with a scale and a position: nothing has
 * to undo a pivot every frame.
 */
interface PropRun {
  geometry: BufferGeometry;
  /** Footprint along the obstacle's long axis, across it, and the height, in metres. */
  along: number;
  across: number;
  height: number;
}

/** One prop kind's look: the same module turned to lie along either axis. */
export interface PropLook {
  /** Module with its long side along render x, for an obstacle that runs east-west. */
  x: PropRun;
  /** The same module turned 90°, for one that runs north-south. */
  z: PropRun;
}

/** One instanced layer, the module it repeats, and which obstacles it takes. */
interface PropLayer {
  mesh: InstancedMesh;
  matrix: Float32Array;
  run: PropRun;
  /** True when the module's long axis runs along world y instead of world x. */
  alongZ: boolean;
  /** True for a fallback primitive: one instance fills the whole obstacle. */
  stretch: boolean;
  /** Instances written so far this rebuild. */
  n: number;
}

export interface PropView {
  /** Re-lay the cover when the floor under the player changed. */
  sync(world: World): void;
}

export interface Assets {
  /** The floor's material: wet concrete, or flat Concrete when the textures did not come. */
  ground: MeshStandardNodeMaterial;
  /** One entry per `PropKind`, or null where the model did not load. */
  props: (PropLook | null)[];
  /** The kit's shared colormap, for the props. Null when it or every model failed. */
  kit: Texture | null;
  /** The environment for reflections, or null. Never the background. */
  env: Texture | null;
  /** What could not be loaded. The shell counts these as errors. */
  missing: string[];
}

/** The one thing a probe of an optional capability must not be able to throw on. */
interface CapabilitiesLike {
  getMaxAnisotropy?(): number;
}

/**
 * The floor's anisotropic filtering.
 *
 * The camera looks down the floor at 55°, so a plain sampler turns the far half of the arena to
 * mush. Both backends can report what the device will do and both want the value clamped to it;
 * the shape of that report differs between them and neither is in the types, so it is read behind
 * a `try` and a plain sampler is the answer to a probe that is not there.
 */
function anisotropy(renderer: WebGPURenderer, quality: Quality): number {
  const want = quality === 'low' ? 2 : 4;
  try {
    const caps = (renderer as unknown as { capabilities?: CapabilitiesLike }).capabilities;
    const max = typeof caps?.getMaxAnisotropy === 'function' ? caps.getMaxAnisotropy() : want;
    return Math.max(1, Math.min(want, max));
  } catch {
    return 1;
  }
}

/**
 * Load one tiled map.
 *
 * The albedo is sRGB and its two helpers are not: a normal or roughness map put through the
 * sRGB decode bends the vectors and the gloss it was supposed to leave alone.
 */
function loadMap(
  loader: TextureLoader,
  file: string,
  missing: string[],
  srgb: boolean,
  tiles: number,
  aniso: number,
): Promise<Texture | null> {
  return loader.loadAsync(FLOOR_ROOT + file).then(
    (texture) => {
      if (srgb) texture.colorSpace = SRGBColorSpace;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.repeat.set(tiles, tiles);
      texture.anisotropy = aniso;
      return texture as Texture;
    },
    () => {
      missing.push(FLOOR_ROOT + file);
      return null;
    },
  );
}

/** The kit's atlas, which every kept model references by name. */
function loadKitMap(loader: TextureLoader, missing: string[], aniso: number): Promise<Texture | null> {
  return loader.loadAsync(COLOR_MAP).then(
    (texture) => {
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = aniso;
      return texture as Texture;
    },
    () => {
      missing.push(COLOR_MAP);
      return null;
    },
  );
}

/**
 * Flatten a loaded glTF into one drawable module.
 *
 * Two things force the shape of this. A kit piece is several meshes under a node tree, and the
 * node carries the kit's own scale (on `detail-tank`, a mirror), so the node's world matrix has
 * to be baked into the vertices before anything is measured. And `mergeGeometries` refuses
 * inputs whose attribute sets differ, so anything the primitives disagree about is dropped first,
 * and everything is flattened to non-indexed — which is also what makes the kit read faceted
 * instead of like smooth blobs.
 */
function toModule(root: Object3D, name: string): PropLook | null {
  root.updateMatrixWorld(true);

  const parts: BufferGeometry[] = [];
  root.traverse((object) => {
    const holder = object as unknown as { isMesh?: boolean; geometry?: BufferGeometry };
    const source = holder.isMesh === true ? holder.geometry : undefined;
    if (source === undefined || source.getAttribute('position') === undefined) return;

    const part = source.index !== null ? source.toNonIndexed() : source.clone();
    part.applyMatrix4(object.matrixWorld);
    // Anything the primitives disagree about is dropped before the merge, which refuses a mix.
    for (const key of Object.keys(part.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') part.deleteAttribute(key);
    }
    if (part.getAttribute('normal') === undefined) part.computeVertexNormals();
    parts.push(part);
  });

  if (parts.length === 0) {
    console.warn('props: nothing to draw in', name);
    return null;
  }
  const merged = mergeGeometries(parts, false);
  if (merged === null) {
    console.warn('props: could not merge', name);
    return null;
  }

  merged.computeBoundingBox();
  const box = merged.boundingBox;
  if (box === null) return null;
  const size = box.getSize(new Vector3());
  if (size.x < 0.1 || size.z < 0.1 || size.y < 0.1) return null;

  const centre = box.getCenter(new Vector3());
  merged.translate(-centre.x, -box.min.y, -centre.z);

  const longIsX = size.x >= size.z;
  const along = longIsX ? size.x : size.z;
  const across = longIsX ? size.z : size.x;

  // The two runs are one module turned: `x` for an obstacle that runs east-west and `z` for one
  // that runs north-south. A turn rather than a rotation per instance because the matrices this
  // file writes stay diagonal, which is what keeps them six numbers.
  const flat = longIsX ? merged : merged.clone().rotateY(Math.PI / 2);
  return {
    x: { geometry: flat, along, across, height: size.y },
    z: { geometry: flat.clone().rotateY(Math.PI / 2), along, across, height: size.y },
  };
}

/** One model, or nothing, with the reason recorded. */
function loadModel(name: string, missing: string[]): Promise<PropLook | null> {
  return new GLTFLoader().loadAsync(MODEL_ROOT + name).then(
    (gltf) => {
      const look = toModule(gltf.scene, name);
      if (look === null) missing.push(MODEL_ROOT + name);
      return look;
    },
    () => {
      missing.push(MODEL_ROOT + name);
      return null;
    },
  );
}

/** The night-sky environment, or nothing. Reflections only; never the backdrop. */
function loadEnvironment(missing: string[]): Promise<Texture | null> {
  return new HDRLoader().loadAsync(ENV_URL).then(
    (texture) => {
      const env = texture as Texture;
      env.mapping = EquirectangularReflectionMapping;
      return env;
    },
    () => {
      missing.push(ENV_URL);
      return null;
    },
  );
}

/**
 * Bring the room's loaded pieces in.
 *
 * Called once, before the first frame, and it never rejects: a failed fetch is a `missing` entry
 * and a fallback, because the alternative is a black canvas over a texture server having a bad
 * day. `floorSize` is the arena's edge-to-edge metres and comes in as an argument rather than a
 * copy so the floor's tiling has one number to divide (AGENTS.md: one source of truth).
 */
export async function loadAssets(
  renderer: WebGPURenderer,
  quality: Quality,
  floorSize: number,
): Promise<Assets> {
  const missing: string[] = [];
  const aniso = anisotropy(renderer, quality);
  const tiles = Math.max(1, Math.round(floorSize / FLOOR_TILE));
  const loader = new TextureLoader();

  // All six files at once: the wait is one round trip, and the whole room costs about 250 KB.
  const [diff, normal, rough, kit, env, ...models] = await Promise.all([
    loadMap(loader, 'concrete_floor_02_diff_1k.jpg', missing, true, tiles, aniso),
    loadMap(loader, 'concrete_floor_02_nor_gl_1k.jpg', missing, false, tiles, aniso),
    loadMap(loader, 'concrete_floor_02_rough_1k.jpg', missing, false, tiles, aniso),
    loadKitMap(loader, missing, aniso),
    loadEnvironment(missing),
    ...PROP_MODEL.map((name) => loadModel(name, missing)),
  ]);

  // The floor. `roughness` is the number DESIGN.md asks for and the roughness map is what spends
  // it unevenly: the product averages about 0.35 with the puddles under it, which is the wet
  // concrete the brief describes. `color` is a multiplier, not an albedo: the scan is a sunlit
  // garage floor and this is a night one, so the map is spent at about two-thirds and cooled —
  // the same reason the HDRI comes in at ENV_INTENSITY. Dark enough that the emissives are the
  // bright things in the frame, light enough that a dark body is still darker than its shadow.
  const ground =
    diff !== null
      ? new MeshStandardNodeMaterial({
          map: diff,
          normalMap: normal ?? undefined,
          roughnessMap: rough ?? undefined,
          color: 0x9a9ea8,
          roughness: 0.5,
          metalness: 0.02,
        })
      : new MeshStandardNodeMaterial({ color: 0x2a2e38, roughness: 0.35, metalness: 0.05 });

  if (missing.length > 0) console.warn('assets not loaded:', missing.join(', '));

  return { ground, props: models, kit, env, missing };
}

/** One instanced layer of `LAYER_CAP` modules, drawn without culling for the horde's reason. */
function makeLayer(
  scene: Object3D,
  run: PropRun,
  stretch: boolean,
  alongZ: boolean,
  material: MeshStandardNodeMaterial,
  shadows: boolean,
): PropLayer {
  const mesh = new InstancedMesh(run.geometry, material, LAYER_CAP);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // The arena is bigger than the view and one layer covers all of it: a culling sphere built
  // from one module at the origin would hide the cover that is actually on screen.
  mesh.frustumCulled = false;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  mesh.visible = false;
  scene.add(mesh);

  const matrix = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < LAYER_CAP; i++) matrix[i * 16 + 15] = 1;

  return { mesh, matrix, run, alongZ, stretch, n: 0 };
}

/**
 * Write one module: a diagonal scale and a move, and nothing else.
 *
 * The turn a module needs is baked into its geometry (see `toModule`), so the four slots that
 * would carry a rotation keep their identity values.
 */
function put(layer: PropLayer, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
  if (layer.n >= LAYER_CAP) return;
  const o = layer.n * 16;
  const m = layer.matrix;
  m[o] = sx;
  m[o + 5] = sy;
  m[o + 10] = sz;
  m[o + 12] = x;
  m[o + 13] = y;
  m[o + 14] = z;
  layer.n++;
}

/**
 * Fill one obstacle with modules.
 *
 * One scale for all three axes, chosen so the module keeps its proportions and stays inside the
 * collider — the cross axis is what usually says no (a wall is 2 m through and a building module
 * is 1.27 m through at rest, so it gets 1.57× of that). The modules are then spaced to *cover*
 * the obstacle and pulled back inside it at the far edge, so a run ends flush with the box the
 * player bounces off. The overlap that buys is deliberate and cheap; a gap in a wall is neither.
 */
function layModules(layer: PropLayer, kind: number, x: number, y: number, w: number, h: number): void {
  const run = layer.run;
  const alongZ = layer.alongZ;
  const longSpan = alongZ ? h : w;
  const crossSpan = alongZ ? w : h;
  if (longSpan <= 0 || crossSpan <= 0) return;

  let scale = Math.min(MODULE_SIZE[kind] / run.along, MODULE_HEIGHT[kind] / run.height);
  scale = Math.min(scale, longSpan / run.along, crossSpan / run.across);
  if (scale < 0.15) scale = 0.15;
  else if (scale > 6) scale = 6;

  const stepLong = run.along * scale;
  const stepCross = run.across * scale;
  const nLong = Math.max(1, Math.min(RUN_CAP, Math.round(longSpan / stepLong)));
  const nCross = Math.max(1, Math.min(RUN_CAP, Math.round(crossSpan / stepCross)));
  const gapLong = longSpan / nLong;
  const gapCross = crossSpan / nCross;
  const halfLong = stepLong / 2;
  const halfCross = stepCross / 2;

  for (let i = 0; i < nLong; i++) {
    for (let j = 0; j < nCross; j++) {
      let a = (i + 0.5) * gapLong;
      if (a + halfLong > longSpan) a = longSpan - halfLong;
      let b = (j + 0.5) * gapCross;
      if (b + halfCross > crossSpan) b = crossSpan - halfCross;

      const px = alongZ ? x + b : x + a;
      const py = alongZ ? y + a : y + b;
      put(layer, px, 0, flipToRender(py), scale, scale, scale);
    }
  }
}

/**
 * Fill one obstacle with the fallback primitive.
 *
 * This one is allowed to stretch: a box has no detail to smear, which is the whole reason it is
 * the fallback and not a shrunken model.
 */
function layStretch(layer: PropLayer, kind: number, x: number, y: number, w: number, h: number): void {
  const height = FALLBACK_HEIGHT[kind] ?? 2;
  put(layer, x + w / 2, height / 2, flipToRender(y + h / 2), w, height, h);
}

/**
 * Lay the chapter's cover out, one instanced layer per look.
 *
 * Props are static — a chapter installs its floor plan once — so the instance buffers are written
 * when that happens and not every frame. The two numbers that say "the floor changed" are the
 * chapter and how many props it installed: a chapter is the only thing that swaps a room, and
 * its prop count is that room's description.
 *
 * Four kinds, and two layers for a kind that has a model (one per running direction), so the
 * whole room's cover costs between four and eight draws (TECH.md's budget).
 */
export function createPropView(scene: Object3D, assets: Assets, quality: Quality): PropView {
  const shadows = quality !== 'low';

  /** Every layer exactly once, so the reset and the flush each walk one list. */
  const layers: PropLayer[] = [];
  /** Per kind: the layer for an obstacle running east-west, and the one for north-south. */
  const eastWest: PropLayer[] = [];
  const northSouth: PropLayer[] = [];

  const kitMaterial =
    assets.props.some((look) => look !== null)
      ? new MeshStandardNodeMaterial({
          // The whole kit shares one colormap (ASSETS.md), so one material draws every piece.
          // Double-sided because the kit is authored that way: its shells are thin, and a
          // single-sided render shows the inside of a container through the outside.
          map: assets.kit ?? undefined,
          // The atlas is a sunlit terracotta and the brief wants cover in Gunmetal; this is the
          // same night-shift multiplier the floor gets. Left at full white it makes every piece
          // the brightest thing in the frame, which is how a container ends up reading as hazard
          // paint.
          color: assets.kit === null ? 0x6c7482 : 0x8a929c,
          roughness: 0.68,
          metalness: 0.12,
          side: DoubleSide,
        })
      : null;

  for (let kind = 0; kind < PROP_KIND_COUNT; kind++) {
    const look = assets.props[kind];
    if (look !== null && kitMaterial !== null) {
      const x = makeLayer(scene, look.x, false, false, kitMaterial, shadows);
      const z = makeLayer(scene, look.z, false, true, kitMaterial, shadows);
      layers.push(x, z);
      eastWest.push(x);
      northSouth.push(z);
      continue;
    }

    // No model: the shape that stops you, drawn as the shape that stops you. One layer takes
    // both directions because a box does not care which way it runs.
    const geometry =
      kind === PropKind.Pillar ? new CylinderGeometry(0.5, 0.5, 1, 14) : new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial({
      color: FALLBACK_COLOR[kind] ?? 0x37424e,
      roughness: 0.75,
      metalness: kind === PropKind.Tank ? 0.35 : 0.05,
    });
    const layer = makeLayer(scene, { geometry, along: 1, across: 1, height: 1 }, true, false, material, shadows);
    layers.push(layer);
    eastWest.push(layer);
    northSouth.push(layer);
  }

  let lastChapter = -1;
  let lastProps = -1;

  function rebuild(f: PropField): void {
    for (let i = 0; i < layers.length; i++) layers[i].n = 0;

    for (let i = 0; i < f.n; i++) {
      const kind = f.kind[i] < PROP_KIND_COUNT ? f.kind[i] : 0;
      const x = f.x0[i];
      const y = f.y0[i];
      const w = f.x1[i] - x;
      const h = f.y1[i] - y;
      const layer = h > w ? northSouth[kind] : eastWest[kind];

      if (layer.stretch) layStretch(layer, kind, x, y, w, h);
      else layModules(layer, kind, x, y, w, h);
    }

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const n = layer.n;
      layer.mesh.count = n;
      layer.mesh.visible = n > 0;
      if (n > 0) layer.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    sync(world: World): void {
      const f = world.props;
      if (world.chapter === lastChapter && f.n === lastProps) return;
      lastChapter = world.chapter;
      lastProps = f.n;
      rebuild(f);
    },
  };
}
