import { describe, expect, it } from 'vitest';

import { Scene, type BufferGeometry, type InstancedMesh } from 'three/webgpu';

import { ENEMIES, enemyIndex } from '../../src/content/enemies';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { DT, createWorld } from '../../src/sim/world';
import { createBatches } from '../../src/render/instancing';
import { hordeMesh, triangleCount } from '../../src/render/meshes';

/**
 * The three silhouettes that replace a borrowed one, checked as data and as a draw.
 *
 * The teleporter, the burrower and the spawner each used to wear a shape another archetype
 * already had: the cloud a swarmling arrives in, the splitter's shell and the broodmother's
 * sac. Those three are also the archetypes that break the "walks at you" default — one crosses
 * its approach in a tick, one crosses it under the floor and one does all its damage through
 * bodies it adds — and a borrowed silhouette cannot carry that: it tells the player "another of
 * the thing you already know", which is the opposite of what a new behaviour needs. So they
 * have shapes of their own now, keyed by archetype in `shapesC.ts`, and what this file pins is
 * the two ways the change could quietly not have happened:
 *
 * - the recipe is missing, so `hordeMesh` hands out the chaser and the archetype is drawn as a
 *   runner it is not;
 * - the recipe is there but nothing points at it, so the batch list builds a pair for the
 *   archetype and fills it with the old shape — invisible in a screenshot, because both shapes
 *   draw and neither of them errors.
 *
 * The budget itself is pinned in `meshes.test.ts`, by triangle count and per shape id, so this
 * file does not restate those numbers. What it adds is the checks a recipe written as
 * hand-placed coordinates needs (nothing merged to nothing, nothing degenerate, nothing sunk
 * through the floor) and the one round trip that proves a shape reaches the screen: three
 * bodies in a world, packed into instanced batches, read back out of the matrix buffer.
 */

/** One archetype, the silhouette it used to borrow and the one it now wears by its own name. */
const NON_WALKERS = [
  { id: 'teleporter', borrowed: 'mote' },
  { id: 'burrower', borrowed: 'shell' },
  { id: 'spawner', borrowed: 'sac' },
] as const;

/** Triangle budget for one body, from the folder header (DESIGN.md "Horde"). */
const BODY_BUDGET = { min: 40, max: 300 };

/** How far below the floor a body may reach before it is buried rather than standing. */
const FLOOR_SLOP = -0.03;

/** How many instanced draws the rounds, the XP and the dash trail need. */
const PROP_BATCHES = 7;

/** Every instanced batch in a scene, in the order the batch list built them. */
function batchList(scene: Scene): InstancedMesh[] {
  return scene.children.filter(
    (o) => (o as { isInstancedMesh?: boolean }).isInstancedMesh === true
  ) as InstancedMesh[];
}

/**
 * The two batches that draw one archetype: its body and its core.
 *
 * `createBatches` builds the pairs in `ENEMIES` order, body first, which is what lets a test
 * ask *which shape* an archetype is drawn with instead of only that something was drawn; the
 * total is pinned by its own test so the day that order changes this says so out loud.
 */
function pairFor(list: readonly InstancedMesh[], index: number): readonly [InstancedMesh, InstancedMesh] {
  return [list[index * 2]!, list[index * 2 + 1]!];
}

/** Every triangle's area and every normal, counting the ones with neither: a flat triangle
 * draws nothing and a NaN normal shades a whole body black, and both leave the batch full. */
function deadTriangles(geometry: BufferGeometry): number {
  const p = geometry.getAttribute('position').array as Float32Array;
  const n = geometry.getAttribute('normal').array as Float32Array;
  let bad = 0;
  for (let i = 0; i < p.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(p[i + k * 3]) || !Number.isFinite(n[i + k * 3])) bad++;
    }
    const ux = p[i + 3] - p[i];
    const uy = p[i + 4] - p[i + 1];
    const uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i];
    const vy = p[i + 7] - p[i + 1];
    const vz = p[i + 8] - p[i + 2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-9) bad++;
  }
  return bad;
}

/** The width, height and depth of a body, and how far under the floor it reaches. */
function bounds(geometry: BufferGeometry): readonly [number, number, number, number] {
  const p = geometry.getAttribute('position').array as Float32Array;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]);
    maxX = Math.max(maxX, p[i]);
    minY = Math.min(minY, p[i + 1]);
    maxY = Math.max(maxY, p[i + 1]);
    minZ = Math.min(minZ, p[i + 2]);
    maxZ = Math.max(maxZ, p[i + 2]);
  }
  return [maxX - minX, maxY - minY, maxZ - minZ, minY];
}

/**
 * A shape's cost and a checksum of its vertices, as one comparable string.
 *
 * A batch does not hold the geometry its archetype's shape was built with, it holds a
 * `clone()` of it, so identity proves nothing; and a bare triangle count can be shared by two
 * different recipes. The vertex checksum makes the comparison a shape comparison.
 */
function signature(geometry: BufferGeometry): string {
  const p = geometry.getAttribute('position').array as Float32Array;
  let sum = p.length;
  for (let i = 0; i < p.length; i += 3) {
    sum += Math.abs(p[i]) * 31 + Math.abs(p[i + 1]) * 17 + Math.abs(p[i + 2]) * 7;
  }
  return `${triangleCount(geometry)}:${sum.toFixed(2)}`;
}

/** Whether one of a batch's instances is drawn at the world point (x, y). */
function drawnAt(batch: InstancedMesh, x: number, y: number): boolean {
  const m = batch.instanceMatrix.array as Float32Array;
  for (let i = 0; i < batch.count; i++) {
    // Render z is the world's y turned over (`flipToRender`), so a body at world y reads from
    // matrix slot 14 negated.
    if (Math.abs(m[i * 16 + 12] - x) < 1e-3 && Math.abs(m[i * 16 + 14] + y) < 1e-3) return true;
  }
  return false;
}

/** Put the three down a few metres apart, run them for half a second and draw the result. */
function drawTheThree() {
  const world = createWorld(1301, { arenaHalf: 40 });
  world.player.hp = 1000;
  const placed = NON_WALKERS.map((one, i) => ({
    ...one,
    slot: spawnEnemy(world, enemyIndex(one.id), 5 - i * 2.5, 7),
  }));
  const frame = createInputFrame();

  // Thirty ticks: long enough that all three are moving and pointing somewhere, short enough
  // that none has spent its trick yet. The burrower's trench is a second long and the
  // spawner's first brood lands after two and a bit, and both would put other bodies in the
  // room and make "which batch is this body in" a weaker question than it is here.
  for (let t = 0; t < 30; t++) {
    resetFrame(frame);
    step(world, frame);
  }

  const scene = new Scene();
  const batches = createBatches(scene, world, 'high');
  // `alpha` 1 means no interpolation, so a batch's translation is the body's own position and
  // the round trip has an exact answer rather than a tolerance.
  batches.sync(world, 1, DT);
  return { world, list: batchList(scene), placed };
}

describe('the three shapes that break the walking default', () => {
  it('gives each of the three a shape of its own instead of the one it borrowed', () => {
    for (const { id, borrowed } of NON_WALKERS) {
      const def = ENEMIES[enemyIndex(id)];

      // A shape that carries a behaviour is keyed by the archetype that has it, so the mesh id
      // is the archetype's own name, and it is authored to the size that body is drawn at: no
      // `fit`, which is the only way the three stay out of each other's way.
      expect(def.mesh, id).toBe(id);
      expect(def.fit, `${id}: a shape authored to size needs no scale`).toBeUndefined();

      // The two ways to have a shape and not use it. The first is the fallback — an id the
      // render layer does not know draws the chaser, so the archetype would wear a runner's
      // silhouette. The second is an alias, which draws the borrowed shape at full price and
      // buys nothing.
      expect(hordeMesh(def.mesh), `${id}: falls back to the chaser`).not.toBe(hordeMesh('chaser'));
      expect(hordeMesh(def.mesh), `${id}: is still ${borrowed}`).not.toBe(hordeMesh(borrowed));
    }
  });

  it('builds each of them inside the budget, with no dead geometry', () => {
    for (const { id } of NON_WALKERS) {
      const shape = hordeMesh(ENEMIES[enemyIndex(id)].mesh);
      const body = triangleCount(shape.body);
      expect(body, `${id}: body triangles`).toBeGreaterThanOrEqual(BODY_BUDGET.min);
      expect(body, `${id}: body triangles`).toBeLessThanOrEqual(BODY_BUDGET.max);
      expect(triangleCount(shape.core), `${id}: core triangles`).toBeGreaterThan(0);

      // Hand-placed coordinates fail quietly: a piece that merges to nothing, a triangle with
      // no area or a normal that came out NaN all draw as a hole in the body, and the batch
      // still packs an instance for the body, so nothing downstream ever notices.
      expect(deadTriangles(shape.body), `${id}: dead triangles in the body`).toBe(0);
      expect(deadTriangles(shape.core), `${id}: dead triangles in the core`).toBe(0);

      // Feet on the floor. The kit's own struts dip under it at the rim (the burrower's reach
      // -0.02, and no body written before it goes below -0.005), which is what `FLOOR_SLOP`
      // is: the kit's own amount of nothing, not a guessed number.
      const [, , , lowest] = bounds(shape.body);
      expect(lowest, `${id}: sunk through the floor`).toBeGreaterThan(FLOOR_SLOP);
    }
  });

  it('keeps the burrower low, which is the whole reason it has a shape', () => {
    // It spends a third of the run under the floor and the rest of it coming along the top of
    // it, and the shell it used to wear was a metre tall at three quarters scale — the same
    // silhouette as the splitter's, one metre shorter, which reads as "two of the thing that
    // walks at you". Lower than it is wide is the read, so that is what is pinned.
    const [w, h] = bounds(hordeMesh('burrower').body);
    expect(h, 'burrower: height').toBeLessThan(0.5);
    expect(w, 'burrower: wider than it is tall').toBeGreaterThan(h);
  });
});

describe('the batch list', () => {
  it('keeps one pair of batches per archetype, and seven for the rounds', () => {
    // Twenty-six draws was the budget when the table had thirteen archetypes (TECH.md "one
    // `InstancedMesh` per enemy archetype mesh"), and the crowd is now nineteen wide. Pinned
    // because the pair lookup below reads the list by position, and because a shape that
    // quietly became two shapes would double the crowd's draws in one line.
    const { list } = drawTheThree();
    expect(list.length).toBe(2 * ENEMIES.length + PROP_BATCHES);
  });

  it('draws each of the three with its own shape, at the place its body is', () => {
    const { world, list, placed } = drawTheThree();

    for (const { id, borrowed, slot } of placed) {
      expect(world.enemies.alive[slot], `${id}: died before it was drawn`).toBe(1);

      const own = hordeMesh(id);
      const [body, core] = pairFor(list, enemyIndex(id));
      const x = world.enemies.x[slot];
      const y = world.enemies.y[slot];

      // A `mesh` id the render layer does not know still gets a pair of batches, so the
      // geometry is the part that can be wrong here — and it would be wrong as a slightly
      // different shape rather than as an error. Read against the archetype's *own* shape:
      // asking for whatever `def.mesh` currently says would follow a re-alias instead of
      // catching one, because the borrowed silhouette would match itself.
      expect([signature(body.geometry), signature(core.geometry)], `${id}: drawn shape`).toEqual([
        signature(own.body),
        signature(own.core),
      ]);
      // And the borrowed one must be excluded by name, not only by the match above: 'mote' is
      // still worn by three bodies, so a shape that reads as the cloud is a real outcome here.
      expect(signature(body.geometry), `${id}: still drawn as ${borrowed}`).not.toBe(
        signature(hordeMesh(borrowed).body)
      );

      // That it is drawn *once*, in the batch its archetype owns: the pair lookup below reads
      // the list by position, so a body that also turned up in a second batch would be counted
      // twice and drawn twice.
      expect(drawnAt(body, x, y), `${id}: nothing drawn where the body is`).toBe(true);
      expect(drawnAt(core, x, y), `${id}: no accent at the body`).toBe(true);

      // The same question asked of the batches that still draw the borrowed silhouette — the
      // shell is still the splitter's, the sac is still the broodmother's and the mote is still
      // three bodies'. It only bites if something else is standing where this body is, which
      // nothing here puts there, so read it as the guard on the pair lookup rather than as a
      // re-alias detector: the signature comparison above is what catches that.
      const wearers = ENEMIES.filter((def) => def.mesh === borrowed && def.id !== id).map((def) => def.id);
      expect(wearers.length, `${borrowed}: the borrowed shape is still worn by someone`).toBeGreaterThan(0);

      for (const [i, def] of ENEMIES.entries()) {
        if (def.mesh !== borrowed || def.id === id) continue;
        const [oldBody, oldCore] = pairFor(list, i);
        expect(drawnAt(oldBody, x, y), `${id}: drawn as ${borrowed} by ${def.id}`).toBe(false);
        expect(drawnAt(oldCore, x, y), `${id}: accent drawn as ${borrowed}`).toBe(false);
      }
    }
  });
});
