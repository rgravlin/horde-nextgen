/**
 * The floor's marks: the two hazards that pulse.
 *
 * This matters more than it looks. The simulation charges you for standing in `world.zones`,
 * so if the picture is not built from those exact numbers the player is fighting a different
 * room than the one they can see — a pool you cannot see is a bug, and so is a ring that lies
 * about how big the blast will be. Every layer here is therefore built from the sim's own
 * arrays and drawn *inside* the zone's radius: nothing in this file may claim more floor than
 * the hazard under it.
 *
 * The cover used to be drawn here too, as a box per obstacle. It is drawn by `assets.ts` now,
 * from the Kenney kit listed in ASSETS.md and scaled to the same bounds; what stays is the
 * stuff that has no model — an acid pool and a crusher's warning — and it is all flat, because
 * flat is the shape that says "floor, not wall" at the camera's height.
 *
 * **Both hazards read as machinery, not as paint.** A zone wears a dark Gunmetal plate with
 * Hazard-amber stripes run across it at 45°, each bar shortened as it nears the plate's edge so
 * the plate keeps the hazard's own outline, and the plain band left outside the stripes is the
 * plate's border. That border is the point: what a player has to know about a hazard is where it
 * stops, and a plate with an edge says that where a filled disc cannot.
 *
 * What this file drew before was one flat amber disc at 0.42 for both kinds. It failed the way a
 * tan floor patch fails: Concrete (`#2A2E38`) and Hazard amber are one step apart in value,
 * additive blending lifted the pair toward cream, and the only thing left saying "not here" was a
 * hue — which DESIGN.md's "Avoid" rules out twice, once for reading by colour alone and once for
 * blooming the floor. The plate is drawn with normal blending instead, so it lies over the
 * concrete like something bolted down there, and it stays under the bloom threshold: the amber
 * here is a warning colour, not a light.
 *
 * **The red is a tell and nothing else.** Threat Red is reserved, so it appears only while a
 * crusher is arming: a ring starts a third of the way into the plate, grows to the plate's edge
 * as the warning runs out, and is gone once the plate has landed. Dry floor and a resting plate
 * are both red-free, which is what makes the ring worth reading.
 *
 * Three batches, repacked every frame a chapter is on the floor and written straight into
 * pre-allocated matrices: a pulsing hazard costs no allocation, and a chapter without hazards
 * pays nothing (AGENTS.md).
 */

import {
  DynamicDrawUsage,
  InstancedMesh,
  type BufferGeometry,
  MeshBasicNodeMaterial,
  type Object3D,
} from 'three/webgpu';

import { ZoneKind, type ZoneField } from '../sim/systems/obstacles';
import type { World } from '../sim/world';
import { discGeometry, glowMaterial, quadGeometry, ringGeometry } from './meshes';

/** How wide each hazard's mark reads relative to its damage radius. */
const RING_PAD = 1.0;

/**
 * Height of each layer above the floor.
 *
 * All three stay low enough to read as floor at the camera's 55°, stacked so the stripes lie over
 * their plate and the tell over both. None of them writes depth, so what keeps the stack in order
 * is this lift and the draw order under it rather than the depth buffer.
 */
const PLATE_LIFT = 0.03;
const STRIPE_LIFT = 0.038;
const TELL_LIFT = 0.05;

/** How far into a plate's radius the stripes run; the band left outside them is its border. */
const STRIPE_REACH = 0.78;

/**
 * The stripe run, per plate: a bar and the gap after it are never narrower than `STRIPE_PERIOD`
 * metres, and one plate never draws more than `STRIPE_BARS` of them.
 *
 * Both bounds are per plate, and together they bound the batch — the stripes' instance cap is
 * their product times the zone cap — so no layout can overflow it and no plate can thin out into
 * a smear. The 1 m floor is what keeps a small plate's stripes readable at 20 m; the ten-bar
 * ceiling is what keeps a 5 m pool from reading as a barcode.
 */
const STRIPE_PERIOD = 1.0;
const STRIPE_BARS = 10;

/** Where a crusher's tell starts, as a fraction of the plate it grows inside. */
const TELL_START = 0.35;

/**
 * The three tints, each one DESIGN.md's.
 *
 * `#2F3440` is Gunmetal at the dark end of the prop family: `#4A505C` is what a wall gets
 * standing in the moonlight, and a plate lying flat in shadow has to sit a step under the floor
 * to read as metal rather than as a stain. Hazard amber is the stripe, Threat Red the tell, and
 * the red is spelled the way the palette spells it — the literal here used to read `0xff2a3c`.
 */
const PLATE_TINT = 0x2f3440;
const HAZARD_TINT = 0xf2b233;
const THREAT_TINT = 0xff2a3d;

/**
 * The stripe run's direction, at 45° and unit length, so a bar's two matrix columns are this
 * scaled by its length and its mirror scaled by its width. One direction for every plate in the
 * arena, because hazard tape is laid and not scattered.
 */
const DIAG = 0.7071067811865476;

/** One instanced flat batch: the mesh, its matrix bytes, and how many marks it may hold. */
interface FlatLayer {
  mesh: InstancedMesh;
  matrix: Float32Array;
  cap: number;
}

export interface SceneryView {
  /** Re-pulse the hazard tells, and re-lay them if the floor changed. */
  sync(world: World): void;
}

/**
 * Build one flat batch.
 *
 * `order` decides who paints over whom where two marks overlap: the plate is scenery, its
 * stripes lie on top of it, and a tell belongs above whatever it is armed inside — including the
 * telegraph shapes, which is why a crusher's ring floats higher than the plate it grows on.
 */
function makeLayer(
  scene: Object3D,
  geometry: BufferGeometry,
  material: MeshBasicNodeMaterial,
  cap: number,
  order: number,
): FlatLayer {
  const mesh = new InstancedMesh(geometry, material, cap);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = order;

  const matrix = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < cap; i++) matrix[i * 16 + 15] = 1;

  scene.add(mesh);
  return { mesh, matrix, cap };
}

/** A plate material: flat colour, translucent enough that the wet concrete reads through it. */
function plateMaterial(color: number, opacity: number): MeshBasicNodeMaterial {
  return new MeshBasicNodeMaterial({ color, transparent: true, opacity, depthWrite: false });
}

/** Show a batch only when it has marks in it, and hand the frame's repack to the GPU. */
function finish(layer: FlatLayer): void {
  layer.mesh.visible = layer.mesh.count > 0;
  if (layer.mesh.count > 0) layer.mesh.instanceMatrix.needsUpdate = true;
}

/** Write one flat disc of radius `r` at floor point (`rx`, `rz`), lifted `lift` off the floor. */
function writeDisc(layer: FlatLayer, rx: number, rz: number, r: number, lift: number): void {
  const n = layer.mesh.count;
  if (n >= layer.cap) return;
  const o = n * 16;
  if (o + 16 > layer.matrix.length) return;

  const m = layer.matrix;
  m[o] = r;
  m[o + 5] = 1;
  m[o + 10] = r;
  m[o + 12] = rx;
  m[o + 13] = lift;
  m[o + 14] = rz;
  layer.mesh.count++;
}

/**
 * Write one stripe: a bar whose centre sits `off` metres across the run, cut short at both ends
 * so its four corners land on the plate's circle.
 *
 * The shortening is the honesty of the layer. A stripe run at full chord would poke past the
 * circle at each end, and the mark would then be claiming floor the hazard does not cover — the
 * plate's edge has to be the true edge, so the bars are cut to fit inside it.
 */
function writeStripe(layer: FlatLayer, rx: number, rz: number, reach: number, off: number): void {
  const side = off > 0 ? off : -off;
  const bar = STRIPE_PERIOD * 0.5;
  const edge = side + bar * 0.5;
  if (edge >= reach) return;
  const room = reach * reach - edge * edge;
  if (room <= 0) return;

  const n = layer.mesh.count;
  if (n >= layer.cap) return;
  const o = n * 16;

  const long = Math.sqrt(room) * 2;
  const m = layer.matrix;
  // Columns 0 and 2 are the bar's across and along axes; the geometry is a 1x1 quad centred on
  // the origin, so these two pairs are its full width and length.
  m[o] = DIAG * bar;
  m[o + 2] = -DIAG * bar;
  m[o + 5] = 1;
  m[o + 8] = DIAG * long;
  m[o + 10] = DIAG * long;
  m[o + 12] = rx + DIAG * off;
  m[o + 13] = STRIPE_LIFT;
  m[o + 14] = rz - DIAG * off;
  layer.mesh.count++;
}

/**
 * Lay one plate: the dark disc, then the stripes that run inside it.
 *
 * Stripes go out from the middle in pairs so the pattern is symmetric about the plate's centre,
 * and the loop stops at the plate's edge — the cap inside `writeStripe` is belt-braces, not the
 * thing that decides how many bars there are.
 */
function writePlate(layer: FlatLayer, stripes: FlatLayer, rx: number, rz: number, r: number): void {
  writeDisc(layer, rx, rz, r, PLATE_LIFT);

  const reach = r * STRIPE_REACH;
  const period = Math.max(STRIPE_PERIOD, (reach * 2) / STRIPE_BARS);
  const bar = period * 0.5;
  for (let off = bar; off < reach; off += period) {
    writeStripe(stripes, rx, rz, reach, off);
    writeStripe(stripes, rx, rz, reach, -off);
  }
}

/**
 * Build the hazard layers for one scene.
 *
 * Three batches: the plates, which are always there, the stripes laid on them, and the warnings,
 * which only exist while a crusher is telling you it is about to hit.
 */
export function createSceneryView(scene: Object3D, world: World): SceneryView {
  const zoneCap = world.zones.kind.length;
  // The pool wears Hazard amber rather than acid green: DESIGN.md gives green to Heal Green — the
  // healer's aura, HP pickups and life steal — and a pool that costs you HP in the colour of the
  // thing that gives it back is two opposite meanings in one hue. The crusher's tell keeps Threat
  // Red, which is the reserved colour and the right one for a warning.
  const plate = makeLayer(scene, discGeometry(22), plateMaterial(PLATE_TINT, 0.86), zoneCap, 2);
  const stripes = makeLayer(
    scene,
    quadGeometry(),
    plateMaterial(HAZARD_TINT, 0.72),
    zoneCap * STRIPE_BARS,
    3,
  );
  // The tell reuses the telegraph band: a crusher's warning and a grenadier's landing ring are
  // the same fact on the floor — a circle that fills, then is not — and `telegraphs.ts` skips a
  // hazard's `RingAt` event on the understanding that this file draws it.
  const tell = makeLayer(scene, ringGeometry(22), glowMaterial(THREAT_TINT, 1.25, true), zoneCap, 4);

  let lastChapter = -1;
  let lastZones = -1;

  /** Repack the hazard rings, including how far into its warning each crusher is. */
  function rebuildZones(z: ZoneField): void {
    plate.mesh.count = 0;
    stripes.mesh.count = 0;
    tell.mesh.count = 0;

    for (let i = 0; i < z.n; i++) {
      const r = z.r[i] * RING_PAD;
      // The sim's y runs away from the camera, three's z runs toward it.
      const rx = z.x[i];
      const rz = -z.y[i];
      writePlate(plate, stripes, rx, rz, r);

      if (z.kind[i] === ZoneKind.Crusher && z.gap[i] > 0 && z.t[i] <= z.warn[i]) {
        // The ring grows into the plate instead of fading in: a hazard you are asked to answer
        // has to be readable at the camera height, and growth reads at a distance that opacity
        // does not. It starts a third in so the warning's first frame is already a shape.
        const span = z.warn[i] > 0 ? z.warn[i] : 1;
        const grow = 1 - (z.t[i] > 0 ? z.t[i] : 0) / span;
        const k = TELL_START + (1 - TELL_START) * (grow < 0 ? 0 : grow > 1 ? 1 : grow);
        writeDisc(tell, rx, rz, r * k, TELL_LIFT);
      }
    }

    // Three separate calls rather than a loop over a literal: this runs every frame a chapter
    // has hazards on its floor, and a per-frame array is an allocation the repack does not need.
    finish(plate);
    finish(stripes);
    finish(tell);
  }

  return {
    sync(world: World): void {
      const z = world.zones;

      // A chapter swap replaces the room; nothing else does. Crushers pulse inside a room, so a
      // chapter with hazards has its plates and tells rewritten every frame and one without
      // hazards pays nothing.
      if (world.chapter !== lastChapter || z.n !== lastZones) {
        lastChapter = world.chapter;
        lastZones = z.n;
      } else if (z.n === 0) {
        return;
      }
      rebuildZones(z);
    },
  };
}
