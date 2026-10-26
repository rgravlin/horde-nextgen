/**
 * The telegraphs: what the horde announces before it hits.
 *
 * DESIGN.md asks for at least 400 ms of wind-up before every charge, shot or lob, with the
 * warning drawn *on the floor* — a charge line, a filling landing ring — and a thin laser sight
 * for the bodies that shoot. It also asks that those shapes be readable by *shape*, not by
 * colour alone, so a charge is a strip, a lob is a circle and a sniper line is a tube, and all
 * three are Threat Red, the one colour nothing else in the game may wear.
 *
 * Where the numbers come from matters more than the shapes. A telegraph is created from the
 * tick's `Telegraph` events, which name the body that started it, and the shape then tracks
 * that body every frame: a charge line that swings with the charger is telling you where it is
 * about to go, which is the information, and one frozen where the wind-up began is a decal. The
 * length, the radius and the fill time all come out of the enemy's own data entry, so the ring
 * on the floor is the same circle the burst will be — the dodge is the difference between them.
 *
 * The lob is the one that does not follow its caster: the grenade is already in the air by the
 * time the ring appears, so its warning is drawn at the landing point and keeps going even if
 * the thrower dies mid-flight.
 *
 * Like every other part of the render layer this file only reads. It never writes a game value
 * back, and a telegraph that outlives the body that raised it is dropped rather than guessed
 * about.
 */

import { DynamicDrawUsage, InstancedMesh, type BufferGeometry, type Object3D } from 'three/webgpu';

import { ENEMIES } from '../content/enemies';
import { Ev, Tele, eventAt, type World } from '../sim/world';
import { discGeometry, glowMaterial, laserGeometry, quadGeometry, ringGeometry } from './meshes';

/** Threat Red, reserved (DESIGN.md "Palette"). */
const THREAT = 0xff2a3d;

/** How many warnings one frame may draw, per shape. */
const MAX_TEL = 128;
const LINE_CAP = 96;
const RING_CAP = 96;
const LASER_CAP = 32;

/** How high each shape floats: enough to clear the floor's depth, low enough to read as floor. */
const LINE_LIFT = 0.05;
const RING_LIFT = 0.04;
const FILL_LIFT = 0.03;
const LASER_HEIGHT = 1.05;

/** Width of a charge strip, in metres. */
const LINE_WIDTH = 0.55;

/** How far a laser starts out from the body that is aiming it. */
const MUZZLE_GAP = 0.9;

/** The four shapes. A filling circle is two batches: the outline it grows inside and the fill. */
const KIND_LINE = 0;
const KIND_RING = 1;
const KIND_LASER = 2;
const KIND_FALL = 3;

/** Below this speed a body's heading comes from its facing rather than from its motion. */
const EPS = 0.01;

export interface TelegraphView {
  /** Refresh the warnings from the tick's events and repack the shapes. */
  sync(world: World, dt: number): void;
}

/** One instanced batch of threat shapes. */
interface Shape {
  mesh: InstancedMesh;
  matrix: Float32Array;
  /** Instances written so far this frame. */
  n: number;
  /** How many it may hold; one that is full drops the rest. */
  cap: number;
}

function makeShape(scene: Object3D, geometry: BufferGeometry, cap: number, gain: number): Shape {
  const mesh = new InstancedMesh(geometry, glowMaterial(THREAT, gain, true), cap);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 2;
  scene.add(mesh);

  const matrix = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < cap; i++) matrix[i * 16 + 15] = 1;
  return { mesh, matrix, n: 0, cap };
}

/** Write one shape drawn along a heading: `w` across it, `l` along it, at height `y`. */
function putDir(shape: Shape, x: number, y: number, z: number, w: number, l: number, nx: number, nz: number): void {
  if (shape.n >= shape.cap) return;
  const o = shape.n * 16;
  const m = shape.matrix;
  m[o] = w * nz;
  m[o + 2] = -w * nx;
  m[o + 5] = w;
  m[o + 8] = l * nx;
  m[o + 10] = l * nz;
  m[o + 12] = x;
  m[o + 13] = y;
  m[o + 14] = z;
  shape.n++;
}

/** Write one shape with no heading: a circle of radius `r`. */
function putRound(shape: Shape, x: number, y: number, z: number, r: number): void {
  putDir(shape, x, y, z, r, r, 0, 1);
}

/**
 * Bring up the telegraph shapes for one scene.
 *
 * The warnings live in four instanced batches rather than in a mesh per warning: a late wave has
 * forty chargers winding up at once and a pool of ninety-six costs one draw.
 *
 * The gain sits under the projectiles' on purpose, twice over. These shapes are additive *and*
 * they lie flat on the floor, so a gain that reads as "bright" on a round in the air reads as a
 * white slab here: the red sums away into cream and the warning loses the one thing that makes it
 * legible in a crowd, which is that it is the same red as the flash that started it. At this level
 * a strip, a ring and a sight line all stay Threat Red against a mid-value floor.
 */
export function createTelegraphView(scene: Object3D): TelegraphView {
  const lines = makeShape(scene, quadGeometry(), LINE_CAP, 1.25);
  const bands = makeShape(scene, ringGeometry(22), RING_CAP, 1.25);
  const fills = makeShape(scene, discGeometry(22), RING_CAP, 0.5);
  const lasers = makeShape(scene, laserGeometry(), LASER_CAP, 1.25);

  /**
   * The live warnings, struct-of-arrays and compaction-ordered.
   *
   * `left` counts down on the render clock and `span` is what the enemy's own data says the
   * wind-up lasts, so `1 - left/span` is how far into its tell a body is — which is what decides
   * how far a strip has reached or how full a circle is.
   */
  const kind = new Uint8Array(MAX_TEL);
  const from = new Int32Array(MAX_TEL);
  const px = new Float32Array(MAX_TEL);
  const py = new Float32Array(MAX_TEL);
  const size = new Float32Array(MAX_TEL);
  const left = new Float32Array(MAX_TEL);
  const span = new Float32Array(MAX_TEL);
  let count = 0;

  /** Where this file has read up to in the event ring (see `EventRing`). */
  let cursor = 0;
  let lastTick = -1;

  /** Take a slot for a new warning, or none when the frame is already full of them. */
  function add(type: number, slot: number, x: number, y: number, sizeOf: number, seconds: number): void {
    if (count >= MAX_TEL || seconds <= 0) return;
    const at = count++;
    kind[at] = type;
    from[at] = slot;
    px[at] = x;
    py[at] = y;
    size[at] = sizeOf;
    left[at] = seconds;
    span[at] = seconds;
  }

  /**
   * Turn this frame's `Telegraph` events into warnings.
   *
   * A frame covers up to five ticks, so this can open several at once, and it reads the event's
   * own numbers rather than watching the pools for phase changes: the event says which body
   * started the tell and where, and the rest comes from the archetype's data.
   */
  function readEvents(world: World): void {
    const ring = world.events;
    const enemies = world.enemies;
    let at = cursor;
    const oldest = ring.written - ring.count;
    if (at < oldest) at = oldest;

    for (; at < ring.written; at++) {
      const i = eventAt(world, at);
      if (i < 0) continue;
      if (ring.type[i] !== Ev.Telegraph) continue;

      const body = ring.a[i];
      // A floor hazard's warning (a crusher's `RingAt` arrives with no body behind it) is drawn
      // by `scenery.ts` from the zone itself, so this skips it rather than drawing the same
      // circle twice in two different reds.
      if (body < 0 || enemies.alive[body] === 0) continue;

      const def = ENEMIES[enemies.kind[body]];
      const x = ring.x[i];
      const y = ring.y[i];
      const code = ring.b[i];

      if (code === Tele.RingAt) {
        // A lob: the ring is the burst the grenade will make, at the point it was aimed at, for
        // exactly as long as the throw takes to get there.
        const dx = x - enemies.x[body];
        const dy = y - enemies.y[body];
        const speed = def.params.arcSpeed ?? 10;
        const flight = Math.sqrt(dx * dx + dy * dy) / speed;
        add(KIND_FALL, body, x, y, def.params.blastRadius ?? 2.5, flight);
      } else if (code === Tele.Ring) {
        // A burst centred on the body itself: the exploder's fuse and the atlas's slam, both
        // counted down by the same wind-up clock.
        const seconds = def.params.fuseTime ?? def.params.slamWindup ?? 0.45;
        add(KIND_RING, body, x, y, def.params.blastRadius ?? 2.5, seconds);
      } else if (def.ai === 'shooter' || def.ai === 'matron') {
        // The ones that shoot draw a sight line rather than a strip: it has to read edge-on,
        // which is why it is a tube (see `laserGeometry`).
        add(KIND_LASER, body, x, y, 18, def.params.windup ?? 0.4);
      } else {
        // Everything else is about to *move*: a strip along the way it is facing, as long as the
        // dash it is winding up.
        const reach = (def.params.dashSpeed ?? 0) * (def.params.dashTime ?? 0);
        if (reach > 0) add(KIND_LINE, body, x, y, reach, def.params.windup ?? 0.4);
      }
    }
    cursor = ring.written;
  }

  /**
   * Repack the warnings, dropping the ones that have told you what they came to tell.
   *
   * A strip or a sight line follows its body: once that body is gone the warning is a lie about a
   * charge that will never land, so it goes with it. A lob's circle stays, because the grenade it
   * warned about is still on its way.
   */
  function pack(world: World, dt: number): void {
    const enemies = world.enemies;
    const player = world.player;
    let live = 0;

    for (let i = 0; i < count; i++) {
      const t = left[i] - dt;
      if (t <= 0) continue;

      const body = from[i];
      const type = kind[i];
      const follows = type !== KIND_FALL;
      if (follows && (body < 0 || enemies.alive[body] === 0)) continue;

      // Where it is and which way it points, both read fresh: a warning that tracks its source
      // is the one that still carries information.
      let x: number;
      let y: number;
      let dx = 0;
      let dy = 0;

      if (type === KIND_FALL) {
        x = px[i];
        y = py[i];
      } else {
        x = enemies.x[body];
        y = enemies.y[body];
        if (type === KIND_LASER) {
          dx = player.x - x;
          dy = player.y - y;
        } else {
          dx = enemies.vx[body];
          dy = enemies.vy[body];
          if (dx * dx + dy * dy < EPS * EPS) {
            dx = enemies.fx[body];
            dy = enemies.fy[body];
          }
        }
      }

      const length = Math.sqrt(dx * dx + dy * dy);
      let nx = 0;
      let nz = 1;
      if (length > EPS) {
        nx = dx / length;
        nz = -dy / length;
      }

      const fill = 1 - t / span[i];
      const at = live++;

      if (type === KIND_LINE) {
        // The strip grows out from the body instead of fading in, so a charger that has committed
        // is showing you all of the line it means to run.
        const reach = size[i] * fill;
        putDir(lines, x + nx * (reach / 2), LINE_LIFT, -(y + nz * (reach / 2)), LINE_WIDTH, reach, nx, nz);
      } else if (type === KIND_LASER) {
        const reach = length - MUZZLE_GAP;
        if (reach > 0.5) {
          putDir(lasers, x + nx * (MUZZLE_GAP + reach / 2), LASER_HEIGHT, -(y + nz * (MUZZLE_GAP + reach / 2)), 1, reach, nx, nz);
        }
      } else {
        const r = size[i];
        putRound(bands, x, RING_LIFT, -y, r);
        putRound(fills, x, FILL_LIFT, -y, r * (0.35 + 0.65 * fill));
      }

      kind[at] = type;
      from[at] = body;
      px[at] = x;
      py[at] = y;
      size[at] = size[i];
      left[at] = t;
      span[at] = span[i];
    }

    count = live;
  }

  return {
    sync(world: World, dt: number): void {
      // Same rule as the horde: a paused frame keeps its picture, so nothing decays and no
      // event is spent while the tick counter stands still.
      const stepping = world.tick !== lastTick;
      lastTick = world.tick;

      lines.n = 0;
      bands.n = 0;
      fills.n = 0;
      lasers.n = 0;

      if (stepping) readEvents(world);
      pack(world, stepping ? dt : 0);

      for (const shape of [lines, bands, fills, lasers]) {
        shape.mesh.count = shape.n;
        shape.mesh.visible = shape.n > 0;
        if (shape.n > 0) shape.mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
