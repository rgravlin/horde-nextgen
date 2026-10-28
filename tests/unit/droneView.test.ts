/**
 * The drone's wiring: how the companion gets into the drawn frame, and what a restart does to it.
 *
 * `drone-geometry.test.ts` pins where the rig stands the drone — on `droneOrbit`'s answer, turned
 * the way it travels. This file pins the other half, which is not about the maths at all: the
 * companion is one pair of meshes that lives as long as the page, mounted beside the player's rig
 * and outside the per-World kit, and drawn by the same pass that repacks the horde.
 *
 * That shape has three consequences worth a check each, and each is written so the wiring it
 * protects is the thing that fails.
 *
 * **Nothing is rebuilt per World, so nothing may be disposed with the kit.** `disposeKit` walks
 * the kit's group and hands back every geometry and material it finds, because twenty restarts
 * must not buy twenty arenas. A companion is the obvious thing to sweep up with them: it is drawn
 * out of the World too. So the checks below count the kit's own disposals — all of them, not
 * "some" — to prove the walk really happened, and require the drone's two shapes and their two
 * looks to come out of it untouched and unshared. A rig that borrowed a cached batch geometry
 * would pass "a drone was drawn" for exactly one run.
 *
 * **One rig across restarts.** A restart builds a new World, and a new World means a new kit; the
 * rig is not part of that set, so the same two meshes have to serve the next run, at the next
 * run's orbit point. Three runs walked three ways, so "the same rig still works" cannot pass on a
 * transform nobody moved, and a mesh count that stays at two, which is what "no per-World rebuild"
 * has to mean or the scene grows by a pair of draws every restart.
 *
 * **Read rather than packed, so gated apart.** The kit's layers come out of pools and go empty
 * when the pools do; the companion comes off one stat and keeps flying over a clear room — which
 * is precisely when the player looks around for it. Copying `updateDrone`'s `enemies.count === 0`
 * skip into the view would wink the drone out between waves, so one check draws an arena with
 * nobody in it.
 *
 * Plain Node throughout, as the other render files are: a bare `Scene`, a real `World` stepped
 * through `step`, the kit and rig factories (TECH.md "Tests"). No renderer and no canvas, which
 * also means the one thing this file cannot see is whether `renderer.ts` calls the pass it builds;
 * the pass is a two-line copy of the assembly's order for that reason, and no more.
 */

import { describe, expect, it } from 'vitest';
import { Mesh, Scene, MeshStandardNodeMaterial, Vector3, type Object3D } from 'three/webgpu';

import { enemyIndex } from '../../src/content/enemies';
import { POWERUPS } from '../../src/content/powerups';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { grantPowerup } from '../../src/sim/systems/pickups';
import { ORBIT_R, droneOrbit } from '../../src/sim/systems/drone';
import { PROP_KIND_COUNT } from '../../src/sim/systems/obstacles';
import { createWorld, type World } from '../../src/sim/world';
import { createDroneRig, type DroneRig } from '../../src/render/droneRig';
import { buildKit, disposeKit, syncKit, type Kit } from '../../src/render/kit';
import { profileFor } from '../../src/render/quality';
import type { Assets, PropLook } from '../../src/render/assets';

/** The tier the rig is built against; the shapes are the same at every tier, the shadow is not. */
const PROFILE = profileFor('high');

/** One frame's worth of wall time, handed to the two layers that animate themselves. */
const FRAME = 1 / 60;

/**
 * A geometry or a look, which is what `disposeKit` hands back.
 *
 * Spelled as the two members this file uses rather than as `BufferGeometry`/`Material` because a
 * batch can hold an array of looks and the file wants one shape for "something that was disposed".
 */
interface Disposable {
  dispose(): void;
  addEventListener(type: string, fn: () => void): void;
}

/** Every mesh under `root`, the drone's two included, and so are the instanced batches. */
function meshesUnder(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) found.push(o);
  });
  return found;
}

/**
 * Every geometry and material under `root`.
 *
 * This is the list `disposeKit`'s traverse walks, so the same list can be watched from both sides
 * of the seam: everything under the kit must be given back, and nothing under the companion may
 * be. A shape shared between the two would appear in both lists and trip the second half.
 */
function disposablesUnder(root: Object3D): Disposable[] {
  const found: Disposable[] = [];
  for (const mesh of meshesUnder(root)) {
    const geometry = mesh.geometry as Disposable | undefined;
    if (geometry !== undefined) found.push(geometry);
    const material = mesh.material as Disposable | Disposable[] | undefined;
    if (Array.isArray(material)) found.push(...material);
    else if (material !== undefined) found.push(material);
  }
  return found;
}

/**
 * A kit's cover with no loaded models, which is the shipped fallback rather than a cheat.
 *
 * `buildKit` wants an `Assets` to read `props` and `kit` off; a run whose files did not arrive
 * draws the fallback primitives (see `assets.ts`), and that is what this hands over. Built fresh
 * per kit because one kit's disposed material must not be the next kit's.
 */
function fallbackAssets(): Assets {
  return {
    ground: new MeshStandardNodeMaterial(),
    props: new Array<PropLook | null>(PROP_KIND_COUNT).fill(null),
    kit: null,
    env: null,
    missing: [],
  };
}

/**
 * A run that owns the companion, on its way somewhere.
 *
 * Card granted through `grantPowerup` rather than by writing the stat, so the fixture goes through
 * the door a player uses; the bodies exist so the kit has something to pack and the drone has
 * something to spend a volley on, and the HP is silly on purpose — which side of the ring the
 * drone is drawn at is the variable here, not whether the run survived it.
 */
function flight(seed: number, ticks: number, dx: number, dy: number): World {
  const world = createWorld(seed);
  const drone = POWERUPS.findIndex((p) => p.id === 'drone');
  expect(drone, 'the ward drone card is what buys the companion').toBeGreaterThanOrEqual(0);
  expect(grantPowerup(world, drone), 'the card grants').toBe(true);
  expect(world.stats.drone, '`drone` is the stat the rig draws on').toBe(1);

  world.player.hp = 100_000;
  for (let i = 0; i < 6; i++) {
    const at = spawnEnemy(world, enemyIndex('chaser'), Math.cos(i) * 7, Math.sin(i) * 7);
    expect(at, `a body at bearing ${i}`).toBeGreaterThanOrEqual(0);
    world.enemies.hp[at] = 400;
  }

  const frame = createInputFrame();
  for (let t = 0; t < ticks; t++) {
    resetFrame(frame);
    frame.moveX = dx;
    frame.moveY = dy;
    step(world, frame);
  }
  expect(world.player.alive, 'and the run was still running').toBe(true);
  return world;
}

/**
 * One drawn frame, in the order `renderer.ts` draws it: every kit layer repacked, then the rig.
 *
 * A copy rather than a call into `renderer.ts` because that file needs a canvas and a backend,
 * and the unit harness has neither (TECH.md "Tests"). It covers the lifetime of the pieces — what
 * is in the scene, what gets disposed, what a restart leaves standing — which is what this file is
 * about; it cannot cover the assembly's own line for the rig, and does not claim to.
 */
function drawFrame(kit: Kit, rig: DroneRig, world: World, alpha = 1): void {
  syncKit(kit, world, alpha, FRAME);
  rig.sync(world, alpha);
}

/** Where the rig stands, in world terms: render z flipped back to world y. */
function stoodAt(rig: DroneRig, out: Vector3): Vector3 {
  rig.group.getWorldPosition(out);
  return out;
}

describe('the companion in the assembled scene', () => {
  it('stands on the scene beside the player rig, not inside the kit', () => {
    const world = flight(7, 90, 1, 0);
    const scene = new Scene();
    const rig = createDroneRig(scene, PROFILE);

    // In the scene before the kit exists, which is how `renderer.ts` builds it: the rig is not
    // one of the per-World layers, so there is no order in which a kit could get ahead of it.
    expect(scene.children).toHaveLength(1);
    expect(scene.children[0], 'the companion is the only thing in the scene yet').toBe(rig.group);

    const kit = buildKit(scene, fallbackAssets(), 'high', PROFILE, 'cpu', world);

    // Two things in the scene: the kit's own group and the companion, each a direct child. Were
    // the drone inside `kit.group`, the next test's walk would find it — and the run after this
    // one would be drawn with buffers the first restart handed back.
    expect(scene.children).toHaveLength(2);
    expect(rig.group.parent, 'still on the scene after the kit went in').toBe(scene);
    expect(kit.group.getObjectByProperty('uuid', rig.group.uuid), 'not inside the kit').toBeUndefined();

    // And the cost is two draws rather than a batch: the hull and the trim, neither of them under
    // the kit, which is the whole difference between this and the horde's instanced layers.
    const own = meshesUnder(rig.group);
    expect(own).toHaveLength(2);
    const kitMeshes = meshesUnder(kit.group);
    for (const mesh of own) {
      expect(kitMeshes, `${mesh.name}: not a second copy under the kit`).not.toContain(mesh);
    }
    expect(meshesUnder(scene), 'the scene pays for the two of them').toHaveLength(
      kitMeshes.length + 2,
    );
  });

  it('is not disposed when the kit is disposed, and shares nothing with it', () => {
    const world = flight(7, 90, 1, 0);
    const scene = new Scene();
    const rig = createDroneRig(scene, PROFILE);
    const kit = buildKit(scene, fallbackAssets(), 'high', PROFILE, 'cpu', world);
    drawFrame(kit, rig, world);

    const given: string[] = [];
    const watch = (thing: Disposable, side: string): void => {
      thing.addEventListener('dispose', () => given.push(side));
    };

    // Both sides watched before the walk, from the same list. A drone shape that borrowed a kit
    // geometry would be registered twice and land in the second count as well, which is the case
    // worth catching: the drone would still *draw* for one run, then not after it.
    const kitOwned = disposablesUnder(kit.group);
    const droneOwned = disposablesUnder(rig.group);
    expect(kitOwned.length, 'the kit has plenty to give back').toBeGreaterThan(20);
    for (const thing of kitOwned) watch(thing, 'kit');
    for (const thing of droneOwned) watch(thing, 'drone');

    disposeKit(scene, kit);

    expect(
      given.filter((side) => side === 'kit').length,
      'every kit geometry and look was given back',
    ).toBe(kitOwned.length);
    expect(
      given.filter((side) => side === 'drone'),
      'and not one of them the companion\'s',
    ).toEqual([]);

    // The group is still in the scene, which is the other half: `disposeKit` removes the kit's
    // group, and the companion was never in it.
    expect(scene.children, 'the kit left the scene, the companion did not').toHaveLength(1);
    expect(scene.children[0]).toBe(rig.group);
  });

  it('draws the next run after a restart, on the next run\'s ring, with the same rig', () => {
    const scene = new Scene();
    const rig = createDroneRig(scene, PROFILE);
    const place = new Vector3();
    const want = { x: 0, y: 0 };
    const stands: string[] = [];

    // Three runs, each walked a different way. A rig that kept its last transform — the failure
    // `drone.test.ts` calls a stale read — would stand in the same place three times, and so
    // would one that copied an orbit this file could not tell from the sim's.
    for (const leg of [
      { seed: 7, ticks: 90, x: 1, y: 0 },
      { seed: 8, ticks: 110, x: 0, y: 1 },
      { seed: 9, ticks: 130, x: -1, y: -1 },
    ]) {
      const world = flight(leg.seed, leg.ticks, leg.x, leg.y);
      const kit = buildKit(scene, fallbackAssets(), 'high', PROFILE, 'cpu', world);

      drawFrame(kit, rig, world);
      expect(rig.group.visible, `seed ${leg.seed}: the companion is drawn`).toBe(true);

      const at = stoodAt(rig, place);
      droneOrbit(world.tick, world.player.x, world.player.y, want);
      expect(at.x, `seed ${leg.seed}: on this run's orbit point`).toBeCloseTo(want.x, 4);
      expect(-at.z, `seed ${leg.seed}: with the floor's z flipped`).toBeCloseTo(want.y, 4);
      stands.push(`${at.x.toFixed(4)},${at.z.toFixed(4)}`);

      // The restart: a new World, so the kit is taken out and its buffers handed back, and the
      // rig stays exactly where it is.
      disposeKit(scene, kit);
      expect(scene.children, 'only the kit left the scene').toHaveLength(1);
      expect(scene.children[0], 'and what stayed is the companion').toBe(rig.group);
    }

    expect(new Set(stands).size, 'three runs, three places on the ring').toBe(3);
    expect(
      meshesUnder(scene),
      'one hull and one trim after three rebuilds, not six',
    ).toHaveLength(2);
  });

  it('flies over an arena with nobody in it, and not over a run that has no companion', () => {
    const place = new Vector3();

    // The kit's layers are packed out of pools and there is nothing in them to pack: nobody on
    // the floor and nothing in the air. The drone is not packed out of a pool, and a view that
    // copied the sim's `enemies.count === 0` skip here would take the companion out between
    // waves — which is when the player is looking for him.
    const alone = createWorld(7);
    expect(alone.enemies.count, 'nobody on the floor').toBe(0);
    expect(alone.shots.count, 'and nothing in the air').toBe(0);
    expect(grantPowerup(alone, POWERUPS.findIndex((p) => p.id === 'drone')), 'the card grants').toBe(
      true,
    );

    const scene = new Scene();
    const rig = createDroneRig(scene, PROFILE);
    const kit = buildKit(scene, fallbackAssets(), 'high', PROFILE, 'cpu', alone);

    drawFrame(kit, rig, alone);
    expect(rig.group.visible, 'drawn anyway').toBe(true);

    const at = stoodAt(rig, place);
    expect(Number.isFinite(at.x) && Number.isFinite(at.y) && Number.isFinite(at.z), 'a place').toBe(
      true,
    );
    // Out on the ring rather than on his own feet, and off the origin the rig was built at: the
    // two ways a first-drawn companion could still be nowhere.
    const out = Math.hypot(at.x - alone.player.x, -at.z - alone.player.y);
    expect(out, 'one ring out').toBeCloseTo(ORBIT_R, 4);

    // The same rig and the same scene, over a run that never bought the card. Without this half
    // the assertion above only shows that something was drawn somewhere. The kit is rebuilt for
    // the new World the way a restart rebuilds it, so the only thing shared across the two runs
    // is the rig — which is the point.
    disposeKit(scene, kit);
    const quiet = createWorld(8);
    expect(quiet.stats.drone, 'a default run has no companion').toBe(0);
    const quietKit = buildKit(scene, fallbackAssets(), 'high', PROFILE, 'cpu', quiet);

    drawFrame(quietKit, rig, quiet);
    expect(rig.group.visible, 'and a run with nothing to draw pays nothing for it').toBe(false);
  });
});