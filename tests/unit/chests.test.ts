/**
 * The supply crate's 3D body: its two shapes, and the two batches that draw them.
 *
 * A crate is the one thing on the floor the player is asked to walk to, and it used to be
 * drawn only as a radar dot and an edge arrow — both at the edge of the screen, which is where
 * a crate is not. So the bar these tests hold is not "something was drawn" but "the picture
 * changed where the crate is": a dropped crate has to land in a batch as a non-identity
 * transform at its own position, a crate the player never reached has to leave the batch empty,
 * and both halves have to change as the crate's clock runs out.
 *
 * Plain Node throughout (TECH.md "Tests"): a bare `Scene`, a real `World`, the view factories.
 * No renderer, no canvas.
 */

import { describe, expect, it } from 'vitest';
import { Scene, type BufferGeometry, type InstancedMesh } from 'three/webgpu';

import { createChestView } from '../../src/render/chests';
import { beaconGeometry, chestGeometry, triangleCount } from '../../src/render/meshes';
import { IDLE_FRAME } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { dropChest } from '../../src/sim/systems/pickups';
import { alloc, createWorld, type World } from '../../src/sim/world';

/** Column-major identity: what a batch's untouched slots hold, and what "nothing here" is. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** One crate's sixteen matrix floats, straight out of the batch's buffer. */
function mat(mesh: InstancedMesh, i: number): number[] {
  const array = mesh.instanceMatrix.array as Float32Array;
  return Array.from(array.slice(i * 16, i * 16 + 16)).map((v) => Number(v.toFixed(6)));
}

/** Scale across the floor, scale up, and where it stands: the six floats this layer writes. */
function upright(
  mesh: InstancedMesh,
  i: number,
): { r: number; h: number; x: number; y: number; z: number } {
  const m = mat(mesh, i);
  return { r: m[0]!, h: m[5]!, x: m[12]!, y: m[13]!, z: m[14]! };
}

/**
 * The crate batches, crate first then pillar.
 *
 * Read off the scene rather than handed back by the factory, because what the kit cares about
 * is that the layers *are* in the scene — that is the traverse `disposeKit` walks.
 */
function columns(scene: Scene): InstancedMesh[] {
  const out: InstancedMesh[] = [];
  for (const child of scene.children) {
    const maybe = child as Partial<InstancedMesh>;
    if (maybe.instanceMatrix) out.push(maybe as InstancedMesh);
  }
  return out.sort((a, b) => a.renderOrder - b.renderOrder);
}

/** A crate written straight into the pool: the same three slots `dropChest` fills. */
function stuffChest(world: World, x: number, y: number, life = 30): void {
  const i = alloc(world.chests);
  if (i < 0) throw new Error('test: the crate pool is full');
  world.chests.x[i] = x;
  world.chests.y[i] = y;
  world.chests.life[i] = life;
}

describe('the crate shapes', () => {
  it('keeps both shapes inside the 40 to 300 triangle budget', () => {
    for (const [name, geometry] of [
      ['crate', chestGeometry()],
      ['pillar', beaconGeometry()],
    ] as [string, BufferGeometry][]) {
      const tris = triangleCount(geometry);
      expect(tris, `${name}: ${tris} triangles`).toBeGreaterThanOrEqual(40);
      expect(tris, `${name}: ${tris} triangles`).toBeLessThanOrEqual(300);
    }
  });

  it('stands both halves on the floor', () => {
    for (const [name, geometry] of [
      ['crate', chestGeometry()],
      ['pillar', beaconGeometry()],
    ] as [string, BufferGeometry][]) {
      const position = geometry.getAttribute('position');
      let lowest = Infinity;
      for (let i = 0; i < position.count; i++) {
        const y = position.getY(i);
        expect(Number.isFinite(y), `${name}: a vertex with no height`).toBe(true);
        if (y < lowest) lowest = y;
      }
      // Feet at zero, not the shard's 0.18: a crate sits in the room and a pillar rises out of
      // it, and either one floating reads as a decal pasted over the view.
      expect(lowest, `${name}: lowest vertex at ${lowest}`).toBeGreaterThanOrEqual(-1e-6);
      expect(lowest, `${name}: lowest vertex at ${lowest}`).toBeLessThan(0.05);
    }
  });

  it('carries no dead triangles', () => {
    for (const geometry of [chestGeometry(), beaconGeometry()]) {
      const position = geometry.getAttribute('position');
      // Merged flat parts are non-indexed, so every three vertices are three real corners.
      expect(position.count % 3).toBe(0);
      for (let i = 0; i < position.array.length; i++) {
        expect(Number.isFinite(position.array[i]!)).toBe(true);
      }
    }
  });

  it('makes the pillar taller than it is wide, and the crate a body rather than a slab', () => {
    const crate = chestGeometry();
    const pillar = beaconGeometry();
    crate.computeBoundingBox();
    pillar.computeBoundingBox();
    const size = (geometry: BufferGeometry) => {
      const box = geometry.boundingBox!;
      return { wide: box.max.x - box.min.x, high: box.max.y - box.min.y };
    };
    const crateBox = size(crate);
    const pillarBox = size(pillar);
    // A column, not a slab: at the camera's 55° pitch the height is the whole read.
    expect(pillarBox.high).toBeGreaterThan(pillarBox.wide * 2);
    // And the crate stays under a metre, so the 2.9 m pillar over it is the bright half.
    expect(crateBox.high).toBeLessThan(1);
    expect(crateBox.wide).toBeGreaterThan(crateBox.high * 0.5);
  });
});

describe('the crate batches', () => {
  it('draws nothing over an arena that never had a crate', () => {
    const world = createWorld(7);
    const scene = new Scene();
    const view = createChestView(scene, world);
    view.sync(world);

    const list = columns(scene);
    expect(list).toHaveLength(2);
    for (const mesh of list) {
      expect(mesh.count).toBe(0);
      expect(mesh.visible).toBe(false);
    }
  });

  it('packs a crate the spawner drops, at its own place on the floor', () => {
    const world = createWorld(7);
    const scene = new Scene();
    const view = createChestView(scene, world);
    expect(dropChest(world, -6.5, 7.25)).toBe(true);

    view.sync(world);

    const [crate, pillar] = columns(scene) as [InstancedMesh, InstancedMesh];
    expect(crate.count).toBe(1);
    expect(pillar.count).toBe(1);
    expect(crate.visible).toBe(true);
    // The point of the whole file: a body on the floor, not another dot at the screen edge.
    expect(mat(crate, 0)).not.toEqual(IDENTITY);
    expect(mat(pillar, 0)).not.toEqual(IDENTITY);

    const c = upright(crate, 0)!;
    expect(c.x).toBeCloseTo(-6.5, 5);
    // World y is the render axis flipped (ARCHITECTURE.md "World to screen"), and the height
    // slot keeps what identity left in it: both halves stand on the floor.
    expect(c.z).toBeCloseTo(-7.25, 5);
    expect(c.y).toBe(0);
    const p = upright(pillar, 0)!;
    expect(p.x).toBeCloseTo(-6.5, 5);
    expect(p.z).toBeCloseTo(-7.25, 5);
    expect(p.y).toBe(0);
  });

  it('leaves a crate the player walked over out of the batch', () => {
    const world = createWorld(7);
    const scene = new Scene();
    const view = createChestView(scene, world);
    // On the player, so `updateChests` opens it on the first tick rather than leaving it.
    expect(dropChest(world, 0.4, 0.2)).toBe(true);
    view.sync(world);
    expect(columns(scene).every((mesh) => mesh.count === 1)).toBe(true);

    for (let i = 0; i < 4; i++) step(world, IDLE_FRAME);
    expect(world.chests.count).toBe(0);

    view.sync(world);
    for (const mesh of columns(scene)) {
      expect(mesh.count).toBe(0);
      expect(mesh.visible).toBe(false);
    }
  });

  it('shrinks both halves as the crate runs out of time', () => {
    const world = createWorld(7);
    const scene = new Scene();
    const view = createChestView(scene, world);
    expect(dropChest(world, -9, 0)).toBe(true);
    // A crate on its last two seconds, in the slot beside it.
    stuffChest(world, 9, 0, 2);

    view.sync(world);

    const [crate, pillar] = columns(scene) as [InstancedMesh, InstancedMesh];
    expect(crate.count).toBe(2);
    const fresh = upright(crate, 0)!;
    const spent = upright(crate, 1)!;
    // Two seconds of a six-second rot window left is a third of a crate, which is the
    // difference the player has to be able to see before deciding it is not worth a fight.
    expect(fresh.r).toBeCloseTo(1, 5);
    expect(fresh.h).toBeCloseTo(1, 5);
    expect(spent.r).toBeGreaterThan(0);
    expect(spent.r).toBeLessThan(0.4);
    expect(spent.h).toBeLessThan(fresh.h);

    const freshPillar = upright(pillar, 0)!;
    const spentPillar = upright(pillar, 1)!;
    expect(spentPillar.h).toBeCloseTo(2 / 6, 4);
    expect(spentPillar.h).toBeLessThan(freshPillar.h);
    // And the pillar stays a pillar: thinner than the crate it stands over.
    expect(spentPillar.r).toBeLessThan(1.15);
  });

  it('keeps the pillar breath inside a fifth of its width, and off beat between crates', () => {
    const world = createWorld(7);
    for (let i = 0; i < 24; i++) stuffChest(world, i - 12, 3);
    const scene = new Scene();
    const view = createChestView(scene, world);
    view.sync(world);

    const [, pillar] = columns(scene) as [InstancedMesh, InstancedMesh];
    expect(pillar.count).toBe(24);
    const radii: number[] = [];
    for (let i = 0; i < pillar.count; i++) {
      const one = upright(pillar, i)!;
      expect(one.r).toBeGreaterThanOrEqual(0.85 - 1e-6);
      expect(one.r).toBeLessThanOrEqual(1.15 + 1e-6);
      radii.push(Number(one.r.toFixed(6)));
    }
    // One beat for twenty-four crates is scenery inside a second; the per-slot offset is the
    // whole reason the breath is keyed off the slot as well as the clock.
    expect(new Set(radii).size).toBeGreaterThan(1);
  });

  it('sizes both batches to the crate pool instead of to the crowd', () => {
    const world = createWorld(7);
    for (let i = 0; i < 24; i++) stuffChest(world, i * 0.1, i * 0.1);
    expect(world.chests.count).toBe(24);

    const scene = new Scene();
    const view = createChestView(scene, world);
    view.sync(world);
    for (const mesh of columns(scene)) expect(mesh.count).toBe(24);

    // A small pool is a small batch: the batches are cut to the pool rather than to the crowd,
    // so a test (or a mod) that shrinks the crate pool shrinks the two buffers with it.
    const thin = createWorld(7, { chests: 3 });
    for (let i = 0; i < 5; i++) expect(dropChest(thin, i, i)).toBe(i < 3);
    expect(thin.chests.count).toBe(3);

    const other = new Scene();
    const thinView = createChestView(other, thin);
    thinView.sync(thin);
    for (const mesh of columns(other)) {
      expect(mesh.instanceMatrix.count).toBe(3);
      expect(mesh.count).toBe(3);
    }
  });

  it('hands a frame that did not step the same numbers as the frame before it', () => {
    const world = createWorld(7);
    expect(dropChest(world, -4, 6)).toBe(true);
    stuffChest(world, 5, -5, 3.5);
    const scene = new Scene();
    const view = createChestView(scene, world);

    view.sync(world);
    const first = columns(scene).map((mesh) => Array.from(mesh.instanceMatrix.array as Float32Array));

    view.sync(world);
    const second = columns(scene).map((mesh) => Array.from(mesh.instanceMatrix.array as Float32Array));

    // Everything is derived from the pool, so a paused (or double-drawn) frame holds its
    // picture instead of shimmering: TECH.md "the game freezes".
    expect(second).toEqual(first);
  });

  it('draws the pillar as light and the crate as a solid', () => {
    const world = createWorld(7);
    const scene = new Scene();
    createChestView(scene, world);
    const [crate, pillar] = columns(scene) as [InstancedMesh, InstancedMesh];

    const crateLook = crate.material as { transparent?: boolean; depthWrite?: boolean; blending?: number };
    const pillarLook = pillar.material as { transparent?: boolean; depthWrite?: boolean; blending?: number };
    expect(pillarLook.transparent).toBe(true);
    expect(pillarLook.depthWrite).toBe(false);
    // Depth *test* stays on, so the pillar's foot is hidden by the crate it rises out of.
    expect(crateLook.transparent).toBeFalsy();
    expect(crateLook.depthWrite).not.toBe(false);
    expect(pillarLook.blending).not.toBe(crateLook.blending);
    // And the crate is drawn with the bodies, the pillar above the flat warning layers.
    expect(crate.renderOrder).toBeLessThan(pillar.renderOrder);
  });
});
