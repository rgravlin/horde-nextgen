/**
 * Instanced batches: the horde, the rounds and the XP, packed straight out of the World's
 * pools every rendered frame (ARCHITECTURE.md "Module map").
 *
 * Four rules shape this file:
 *
 * - The pools are the only source. A batch scans the pool it reads and packs the live slots
 *   into a contiguous run of instance matrices, because `InstancedMesh` draws its first
 *   `count` instances. Nothing is allocated per frame: the matrix array is written in place
 *   and every batch is built once at its pool's hard cap, so a full arena costs no more
 *   allocation than an empty one.
 * - One batch per *look*, chosen from the content tables. Nineteen archetypes need
 *   thirty-eight draws (a matte body and the accents that ride on it) and the rounds, the
 *   shards and the dash trail need seven, so the whole crowd costs forty-five draws — which is
 *   what keeps the frame inside its budget (TECH.md "Draw calls"). A pair is built per
 *   archetype, so two archetypes that wear the same shape still cost two draws each: the shape
 *   a body wears changes what one draw looks like, not how many there are.
 * - Positions are read at the interpolation point. The sim is one to five ticks ahead of the
 *   frame that draws it, so a body is drawn at `pos + velocity * dt * (alpha - 1)`, which lands
 *   it between where it was and where it is. That is what the accumulator's `alpha` is for
 *   (TECH.md "Simulation and rendering") and it needs no second copy of the pools.
 * - Size comes from the data. A shape is authored at the size of the archetype that uses it
 *   (see `meshes/`), so an instance only needs the collision radius folded in, and two
 *   archetypes that share a shape can still be told apart.
 *
 * Flash and dissolve come from the tick's event ring: `Hit` lights a body white for 60 ms and
 * `Kill` starts the dissolve, which then runs on the render clock. A frame whose tick did not
 * advance — a pause — decays nothing, so the frozen frame really is frozen.
 *
 * The world is a flat plane (x, y) and three's floor is the XZ plane, so world y maps to
 * render -z: screen-up is world-north. `flipToRender` is that rule written down once, and
 * `groundToRender` is its inverse for the mouse aim.
 */

import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three/webgpu';

import { ENEMIES, type Faction } from '../content/enemies';
import { WEAPONS, type WeaponFamily } from '../content/weapons';
import { DT, Ev, eventAt, type Pool, type World } from '../sim/world';
import { ShotKind } from '../sim/systems/enemyProjectiles';
import {
  accentMaterial,
  arrowGeometry,
  attachFx,
  ghostGeometry,
  glowMaterial,
  grenadeGeometry,
  hordeBodyMaterial,
  hordeMesh,
  orbGeometry,
  shardGeometry,
  tracerGeometry,
} from './meshes';
import type { Quality } from './renderer';

/** World y to render z. Screen-up on the three-quarter camera is world +y. */
export function flipToRender(y: number): number {
  return -y;
}

/** Render z back to world y, for a point picked off the ground plane. */
export function groundToRender(z: number): number {
  return -z;
}

/** How long a white hit flash lasts, in seconds (DESIGN.md "Motion"). */
const FLASH = 0.06;

/** How long a body takes to come apart after the kill that ended it. */
const DIE = 0.34;

/** How long after a dash the trail keeps dropping afterimages, and how many it may hold. */
const TRAIL = 0.24;
const TRAIL_CAP = 24;

/** Below this speed a body's heading comes from its facing rather than from its motion. */
const EPS = 0.01;

/**
 * The horde's body tints, one per faction.
 *
 * DESIGN.md keeps bodies inside `#1A1C24`–`#3A2F3F` and puts the faction's identity in the
 * accent instead, so these four differ by temperature rather than by brightness: the foundry
 * pack is a warm dark, the reactor a violet dark, and both stay well under the floor's own
 * mid-value so a crowd never out-brightens the ground it stands on.
 */
const BODY_BY_FACTION: Record<Faction, number> = {
  swarm: 0x1f1c26,
  foundry: 0x2b2a26,
  reactor: 0x2a2333,
  cult: 0x1d2a25,
};

/** One instanced draw, and the buffers this file writes into it. */
interface Batch {
  mesh: InstancedMesh;
  /** `mesh.instanceMatrix.array`, kept so the frame loop skips the property lookup. */
  matrix: Float32Array;
  /** Per-instance flash and dissolve, or null when the shape has no such attribute. */
  hit: Float32Array | null;
  die: Float32Array | null;
  /** The same buffers as the renderer sees them, for the `needsUpdate` flag. */
  hitAttr: InstancedBufferAttribute | null;
  dieAttr: InstancedBufferAttribute | null;
  /** Instances packed so far this frame. */
  n: number;
  /** The batch's instance limit; a full batch drops what will not fit. */
  cap: number;
}

/** A body and the accents that ride on it, drawn from one instance stream. */
interface HordePair {
  body: Batch;
  core: Batch;
}

/** How one archetype is drawn: which pair of batches, and how big. */
interface HordeDraw {
  pair: HordePair;
  scale: number;
}

/** How one projectile shape is drawn. */
interface ShotDraw {
  batch: Batch;
  /** Thickness across the direction of travel, in metres. */
  cross: number;
  /** Length along it at rest, plus the stretch per m/s of travel. */
  length: number;
  stretch: number;
  /** Height above the floor. */
  height: number;
  /** True for a lob, whose height comes from the arc instead. */
  arc: boolean;
}

export interface Batches {
  /** Repack every batch from the world's pools at the given interpolation point. */
  sync(world: World, alpha: number, dt: number): void;
}

/**
 * Build one instanced draw.
 *
 * The matrix array is seeded with identity because the per-instance write only touches the
 * eight slots a turned, sized body needs; the rest has to keep its identity value for the
 * matrix to stay a matrix.
 */
function makeBatch(
  scene: Object3D,
  geometry: BufferGeometry,
  material: Material,
  cap: number,
  fx: { hit: Float32Array | null; die: Float32Array } | null,
  shadows: boolean,
): Batch {
  if (fx !== null) attachFx(geometry, fx.hit, fx.die);

  const mesh = new InstancedMesh(geometry, material, cap);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // The crowd walks around the arena and the batch never moves, so a culling sphere computed
  // once from one shape would either clip it or do nothing.
  mesh.frustumCulled = false;
  mesh.castShadow = shadows;
  scene.add(mesh);

  const matrix = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < cap; i++) {
    const o = i * 16;
    matrix[o] = 1;
    matrix[o + 5] = 1;
    matrix[o + 10] = 1;
    matrix[o + 15] = 1;
  }

  return {
    mesh,
    matrix,
    cap,
    n: 0,
    hit: fx === null ? null : fx.hit,
    die: fx === null ? null : fx.die,
    hitAttr: fx !== null && fx.hit !== null ? (geometry.getAttribute('aHit') as InstancedBufferAttribute) : null,
    dieAttr: fx !== null ? (geometry.getAttribute('aDie') as InstancedBufferAttribute) : null,
  };
}

/**
 * Write one instance: a turn about Y, a size and a position.
 *
 * `cross` and `len` are the two sizes a shape needs — a round is drawn stretched along the way
 * it is going, which is what turns a stream of them into the lanes DESIGN.md asks for, and a
 * body uses one number for both. `nx` and `nz` are the unit direction in *render* space, where
 * the world's y has become -z; the four matrix slots that carry a turn are written
 * pre-multiplied by the size, which is why `cross` appears twice below and not once.
 */
function put(batch: Batch, x: number, y: number, z: number, cross: number, len: number, nx: number, nz: number): void {
  if (batch.n >= batch.cap) return;
  const o = batch.n * 16;
  const m = batch.matrix;
  m[o] = cross * nz;
  m[o + 2] = -cross * nx;
  m[o + 5] = cross;
  m[o + 8] = len * nx;
  m[o + 10] = len * nz;
  m[o + 12] = x;
  m[o + 13] = y;
  m[o + 14] = z;
  batch.n++;
}

/** Publish one batch: its count, its matrices and its two attribute buffers. */
function flush(batch: Batch): void {
  const n = batch.n;
  batch.mesh.count = n;
  batch.mesh.visible = n > 0;
  if (n === 0) return;
  batch.mesh.instanceMatrix.needsUpdate = true;
  if (batch.hitAttr !== null) batch.hitAttr.needsUpdate = true;
  if (batch.dieAttr !== null) batch.dieAttr.needsUpdate = true;
}

/** An accent hex like `#FF2E97` as the number a material wants. */
function hex(value: string): number {
  return Number.parseInt(value.slice(1), 16);
}

/**
 * Bring up every batch for one World.
 *
 * A restart builds a new World with new pools, so the whole set is rebuilt against it and the
 * old one disposed (see `renderer.ts`). The *shapes* come out of `meshes.ts`'s cache as clones
 * because a per-instance attribute belongs to one instance stream: two batches cannot share one
 * buffer of them.
 */
export function createBatches(scene: Object3D, world: World, quality: Quality): Batches {
  const cap = world.enemies.cap;
  const shadows = quality !== 'low';

  /** One pair per archetype, indexed by the enemy pool's `kind`. */
  const draws: HordeDraw[] = ENEMIES.map((def) => {
    const shape = hordeMesh(def.mesh);
    // One dissolve buffer serves a body and its accents: both are packed in the same order from
    // the same slots, so one array of numbers describes both.
    const hit = new Float32Array(cap);
    const die = new Float32Array(cap);
    return {
      pair: {
        body: makeBatch(
          scene,
          shape.body.clone(),
          hordeBodyMaterial(BODY_BY_FACTION[def.faction]),
          cap,
          { hit, die },
          shadows,
        ),
        core: makeBatch(
          scene,
          shape.core.clone(),
          accentMaterial(hex(def.accent)),
          cap,
          { hit: null, die },
          false,
        ),
      },
      scale: def.fit ?? 1,
    };
  });

  /**
   * The player's rounds, one shape per weapon family.
   *
   * Family rather than weapon because that is what the eye has time for with a hundred bodies on
   * screen, and because the HUD already names the gun (DESIGN.md "3D and scenes"). Each emissive
   * is pushed past 1.0 by `glowMaterial`'s gain so the bloom pass finds it.
   */
  const shotDraws: ShotDraw[] = [
    {
      batch: makeBatch(scene, tracerGeometry(), glowMaterial(0xff7a1a, 2.6), world.shots.cap, null, false),
      cross: 0.55,
      length: 1,
      stretch: 0.026,
      height: 1.05,
      arc: false,
    },
    {
      batch: makeBatch(scene, arrowGeometry(), glowMaterial(0xff4d2e, 2.4), world.shots.cap, null, false),
      cross: 0.62,
      length: 0.62,
      stretch: 0,
      height: 1.05,
      arc: false,
    },
    {
      batch: makeBatch(scene, orbGeometry(), glowMaterial(0x2ef2ff, 2.6), world.shots.cap, null, false),
      cross: 0.36,
      length: 0.36,
      stretch: 0,
      height: 1.05,
      arc: false,
    },
  ];

  /** Which of those three draws a weapon's rounds, by `WEAPONS` index. */
  const familyOf = new Int8Array(WEAPONS.length);
  const FAMILY_BATCH: Record<WeaponFamily, number> = { guns: 0, medieval: 1, alien: 2 };
  for (let i = 0; i < WEAPONS.length; i++) familyOf[i] = FAMILY_BATCH[WEAPONS[i].family];

  /**
   * What the horde fires back.
   *
   * A bolt is a slow round, so it is drawn as a ball rather than a streak: the difference in
   * *shape* is what tells an incoming round from one of yours at a glance, and the line that
   * precedes it belongs to `telegraphs.ts`.
   */
  const boltDraw: ShotDraw = {
    batch: makeBatch(scene, orbGeometry(), glowMaterial(0xff4d2e, 2.2), world.enemyShots.cap, null, false),
    cross: 0.26,
    length: 0.26,
    stretch: 0,
    height: 1.05,
    arc: false,
  };
  const grenadeDraw: ShotDraw = {
    batch: makeBatch(scene, grenadeGeometry(), glowMaterial(0xf2b233, 2.2), world.enemyShots.cap, null, false),
    cross: 0.42,
    length: 0.42,
    stretch: 0,
    height: 0.9,
    arc: true,
  };

  /** XP in Alien Violet, riding just above the floor on its way to the magnet. */
  const shardDraw: ShotDraw = {
    batch: makeBatch(scene, shardGeometry(), glowMaterial(0x9b5cff, 2.2), world.shards.cap, null, false),
    cross: 0.3,
    length: 0.3,
    stretch: 0,
    height: 0.18,
    arc: false,
  };

  /** The dash trail: a smear of the player's own silhouette in Alien Cyan. */
  const trailBatch = makeBatch(scene, ghostGeometry(), glowMaterial(0x2ef2ff, 1.6), TRAIL_CAP, null, false);
  trailBatch.mesh.renderOrder = 4;
  const trailX = new Float32Array(TRAIL_CAP);
  const trailZ = new Float32Array(TRAIL_CAP);
  const trailL = new Float32Array(TRAIL_CAP);
  let trailAt = 0;

  /** Per-body clocks, by pool slot: a flash and a dissolve, both counting down. */
  const hitT = new Float32Array(cap);
  const dieT = new Float32Array(cap);

  /**
   * Where this file has read up to in the event ring.
   *
   * The ring is a broadcast that nothing drains, so each reader keeps its own cursor into
   * `written` (see `EventRing`). A frame that covers three ticks picks up three ticks of events
   * at once, which is the point; a frame that covers none spends none.
   */
  let cursor = 0;
  let lastTick = -1;

  function readEvents(world: World): void {
    const ring = world.events;
    let at = cursor;
    const oldest = ring.written - ring.count;
    if (at < oldest) at = oldest;
    for (; at < ring.written; at++) {
      const i = eventAt(world, at);
      if (i < 0) continue;
      const type = ring.type[i];
      if (type === Ev.Hit) {
        const slot = ring.b[i];
        if (slot >= 0 && slot < cap) hitT[slot] = FLASH;
      } else if (type === Ev.Kill) {
        const slot = ring.a[i];
        if (slot >= 0 && slot < cap) {
          dieT[slot] = DIE;
          hitT[slot] = FLASH;
        }
      }
    }
    cursor = ring.written;
  }

  /**
   * Pack the horde.
   *
   * One pass over the enemy pool writes both batches of every body, and it also carries the
   * dead: a body whose dissolve is still running is drawn again from the slot it left behind,
   * which still holds where it died. A slot a fresh body has taken in the meantime is skipped,
   * so a body and its ghost are never drawn in the same place.
   */
  function syncHorde(world: World, shift: number, fade: number): void {
    const enemies = world.enemies;
    for (let i = 0; i < enemies.cap; i++) {
      const draw = draws[enemies.kind[i]];
      if (draw === undefined) continue;

      let flash = hitT[i];
      if (flash > 0) {
        flash -= fade;
        if (flash < 0) flash = 0;
        hitT[i] = flash;
      }

      const alive = enemies.alive[i] !== 0;
      let scale: number;
      let die = 0;
      let x: number;
      let z: number;

      if (alive) {
        scale = draw.scale;
        x = enemies.x[i] + enemies.vx[i] * shift;
        z = flipToRender(enemies.y[i] + enemies.vy[i] * shift);
      } else {
        let left = dieT[i];
        if (left <= 0) continue;
        left -= fade;
        if (left <= 0) {
          dieT[i] = 0;
          continue;
        }
        dieT[i] = left;
        const gone = 1 - left / DIE;
        die = gone;
        // A body coming apart loses a fifth of its height, so the last fragments read as
        // something leaving the floor rather than as a texture fading.
        scale = draw.scale * (1 - 0.2 * gone);
        x = enemies.x[i];
        z = flipToRender(enemies.y[i]);
      }

      // The turn faces the shape where it is going; a body standing still is still drawn facing
      // its front, which the sim keeps for the sake of its armour (see `fx`/`fy`).
      let dx = enemies.vx[i];
      let dy = enemies.vy[i];
      if (!alive || dx * dx + dy * dy < EPS * EPS) {
        dx = enemies.fx[i];
        dy = enemies.fy[i];
      }
      const speed = Math.sqrt(dx * dx + dy * dy);
      let nx = 0;
      let nz = 1;
      if (speed > EPS) {
        const inv = scale / speed;
        nx = dx * inv;
        nz = -dy * inv;
      }

      const pair = draw.pair;
      if (pair.body.n >= cap) continue;

      const at = pair.body.n;
      put(pair.body, x, 0, z, scale, scale, nx, nz);
      put(pair.core, x, 0, z, scale, scale, nx, nz);
      pair.body.hit![at] = flash;
      pair.body.die![at] = die;
      pair.core.die![at] = die;
    }

    for (let k = 0; k < draws.length; k++) {
      flush(draws[k].pair.body);
      flush(draws[k].pair.core);
    }
  }

  /**
   * Pack one projectile pool.
   *
   * A round is drawn where it *is* rather than where the interpolation puts it: back-dating a
   * stretched tracer by a tick puts the streak behind the hole it is digging.
   */
  function syncShots(pool: Pool, pick: (kind: number) => ShotDraw | undefined): void {
    for (let i = 0; i < pool.cap; i++) {
      if (pool.alive[i] === 0) continue;
      const draw = pick(pool.kind[i]);
      if (draw === undefined) continue;

      const vx = pool.vx[i];
      const vy = pool.vy[i];
      const speed = Math.sqrt(vx * vx + vy * vy);
      let nx = 0;
      let nz = 1;
      let len = draw.length;
      if (speed > EPS) {
        const inv = 1 / speed;
        nx = vx * inv;
        nz = -vy * inv;
        if (draw.stretch > 0) {
          len = draw.length + speed * draw.stretch;
          if (len > 3) len = 3;
        }
      }

      let y = draw.height;
      if (draw.arc) {
        // A lob is drawn along the arc the sim gave it: `age` and `life` rise and fall
        // together, so their sum is the flight the throw was given and the ratio says how far
        // along it the grenade has got.
        const span = pool.age[i] + pool.life[i];
        const p = span > 0 ? pool.age[i] / span : 0;
        y = 0.7 + 2.6 * 4 * p * (1 - p);
      }

      put(draw.batch, pool.x[i], y, flipToRender(pool.y[i]), draw.cross, len, nx, nz);
    }
  }

  /** Pack the dash trail, dropping a fresh afterimage while a dash is still running. */
  function syncTrail(world: World, alpha: number, fade: number): void {
    const player = world.player;
    if (player.dashTime > 0 && trailBatch.n < TRAIL_CAP) {
      const shift = (alpha - 1) * DT;
      const at = trailAt;
      trailAt = (trailAt + 1) % TRAIL_CAP;
      trailX[at] = player.x + player.vx * shift;
      trailZ[at] = flipToRender(player.y + player.vy * shift);
      trailL[at] = TRAIL;
    }

    let dx = player.vx;
    let dy = player.vy;
    const speed = Math.sqrt(dx * dx + dy * dy);
    if (speed > EPS) {
      dx /= speed;
      dy /= speed;
    } else {
      dx = player.aimX;
      dy = player.aimY;
    }

    for (let i = 0; i < TRAIL_CAP; i++) {
      let life = trailL[i];
      if (life <= 0) continue;
      life -= fade;
      if (life <= 0) {
        trailL[i] = 0;
        continue;
      }
      trailL[i] = life;
      const size = 0.42 * (life / TRAIL);
      put(trailBatch, trailX[i], 0.75, trailZ[i], size, size * 1.6, dx, -dy);
    }
    flush(trailBatch);
  }

  return {
    sync(world: World, alpha: number, dt: number): void {
      // A paused frame keeps its picture: nothing decays and no event is spent while the tick
      // counter stands still (TECH.md: "Pause stops calling `step()`").
      const stepping = world.tick !== lastTick;
      lastTick = world.tick;
      const fade = stepping ? dt : 0;
      if (stepping) readEvents(world);

      for (let k = 0; k < draws.length; k++) {
        draws[k].pair.body.n = 0;
        draws[k].pair.core.n = 0;
      }
      for (let i = 0; i < shotDraws.length; i++) shotDraws[i].batch.n = 0;
      boltDraw.batch.n = 0;
      grenadeDraw.batch.n = 0;
      shardDraw.batch.n = 0;
      trailBatch.n = 0;

      const shift = (alpha - 1) * DT;
      syncHorde(world, shift, fade);
      syncShots(world.shots, (kind) => (kind < familyOf.length ? shotDraws[familyOf[kind]] : undefined));
      syncShots(world.enemyShots, (kind) => (kind === ShotKind.Grenade ? grenadeDraw : boltDraw));
      syncShots(world.shards, () => shardDraw);
      syncTrail(world, alpha, fade);

      for (let i = 0; i < shotDraws.length; i++) flush(shotDraws[i].batch);
      flush(boltDraw.batch);
      flush(grenadeDraw.batch);
      flush(shardDraw.batch);
    },
  };
}
