import { describe, expect, it } from 'vitest';

import { Scene, Vector3, type BufferGeometry } from 'three/webgpu';

import { enemyIndex } from '../../src/content/enemies';
import { WEAPONS } from '../../src/content/weapons';
import { playerFacing, yawToFace, type Face } from '../../src/render/facing';
import { playerTrim, weaponKit } from '../../src/render/meshes';
import { createPlayerRig, type PlayerRig } from '../../src/render/playerRig';
import { profileFor } from '../../src/render/quality';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { createWorld, loadSlot, type World } from '../../src/sim/world';

/**
 * The two halves of one bug: the rig was turned from the wrong number *and* with the wrong
 * `atan2`.
 *
 * Both are checked the same way — stand a rig up, turn it, read the barrel back out of its
 * world matrix and compare it with the line the rounds actually take, which is read out of the
 * projectile pool rather than from the helper, so a helper that only agrees with itself proves
 * nothing. That pairing is what makes each half fail loudly on its own:
 *
 * - the source. Under auto-fire the weapon pass leads the nearest body instead of following
 *   the steer, so the shot line and `player.aimX/aimY` disagree by up to a right angle. The
 *   crowd here always sits somewhere the stick is not pointing, and one test holds the trigger
 *   so that the *same* crowd must be ignored: that is what stops this file passing while the
 *   rig merely tracks whichever body happens to be closest.
 * - the turn. The rig is built pointing along local +z (the muzzle cone and all three gun
 *   barrels lie forward — the first test pins that, because it is the fact `yawToFace` is
 *   written against) and the floor's north is render -z, so the turn is `atan2(x, -y)`. The
 *   shipped `atan2(aimY, aimX)` is a quarter turn off. Two tests also read the old way and
 *   require it to miss, and both halves were checked by reverting them one at a time: with
 *   only the turn wrong four of the six fail, with only the source wrong the auto-fire one
 *   does, so nothing here passes on the bug.
 */

/** How far off the shot line a barrel may lie, as |sin| of the angle between the two. */
const ON_LINE = 1e-4;

/** What is left of `BARREL` once a barrel is laid down a quarter turn the other way. */
const QUARTER_TURN = 0.99;

/** m — how far down the barrel the tip is read, for the four cardinal coordinates. */
const BARREL = 4;

/** A world at rest: no wave clock running, and a player who survives what we put in here. */
function worldWith(weaponId: string): World {
  const at = WEAPONS.findIndex((def) => def.id === weaponId);
  expect(at, weaponId).toBeGreaterThanOrEqual(0);
  const world = createWorld(4111, { arenaHalf: 40 });
  world.player.hp = 1000;
  loadSlot(world.slots[0], at);
  return world;
}

/**
 * A rig stood at the player, turned to `yaw`, with its matrices current.
 *
 * Turned by hand rather than through `createView`, which needs a canvas: what is under test is
 * the number handed to `place` and what the rig's own geometry then points at.
 */
function rigTurnedTo(world: World, yaw: number): PlayerRig {
  const scene = new Scene();
  const rig = createPlayerRig(scene, profileFor('high'));
  const p = world.player;
  rig.place(p.x, p.y, yaw, p.alive);
  scene.updateMatrixWorld(true);
  return rig;
}

/**
 * The barrel's direction, read back out of the rig and turned round into world space.
 *
 * Local +z is what the guns point along, so its image under the rig's world matrix is which
 * way the muzzle faces; the world's y arrives at the renderer as -z (`flipToRender`), which is
 * undone here for the same reason it is applied there.
 */
function barrelAxis(rig: PlayerRig): Face {
  const fwd = new Vector3(0, 0, 1).transformDirection(rig.group.matrixWorld);
  return { x: fwd.x, y: -fwd.z };
}

/** Where a point 4 m down the barrel lands, in render space, on a rig stood at the origin. */
function barrelTip(yaw: number): Vector3 {
  const scene = new Scene();
  const rig = createPlayerRig(scene, profileFor('high'));
  rig.place(0, 0, yaw, true);
  scene.updateMatrixWorld(true);
  return rig.group.localToWorld(new Vector3(0, 0, BARREL));
}

/** How far off a line a direction points: 0 along it, 1 a quarter turn off it. */
function miss(line: Face, axis: Face): number {
  return Math.abs(line.x * axis.y - line.y * axis.x);
}

/**
 * How much a direction agrees with the line: 1 along it, 0 sideways, -1 straight back.
 *
 * The two measures are both needed. A bare `miss` reads 0 for a barrel pointing *away* from
 * its own shot, which is a way to be wrong a fix could plausibly ship — drop the -z flip and
 * that is exactly what happens, and it happened to an earlier draft of this file.
 */
function agree(line: Face, axis: Face): number {
  return line.x * axis.x + line.y * axis.y;
}

/**
 * Whether a rig's barrel lies along a line: not sideways and not reversed.
 *
 * Asked of the good rig expecting true and of the old one expecting false, so the same
 * predicate is what catches the turn being wrong either way.
 */
function onLine(line: Face, axis: Face): boolean {
  return miss(line, axis) < ON_LINE && agree(line, axis) > 0.999;
}

/** How far off a shot line the player is standing on a floor point lands, in metres. */
function distanceFromLine(line: Face, point: Vector3): number {
  return Math.abs(point.x * -line.y - point.z * line.x);
}

/** The first live round on the floor, as a unit direction, or null while nothing is flying. */
function firstRound(world: World): Face | null {
  const shots = world.shots;
  for (let i = 0; i < shots.cap; i++) {
    if (shots.alive[i] !== 1) continue;
    const len = Math.hypot(shots.vx[i], shots.vy[i]);
    if (len === 0) continue;
    return { x: shots.vx[i] / len, y: shots.vy[i] / len };
  }
  return null;
}

/**
 * Run the world until a round exists and return its direction, or null after `ticks`.
 *
 * The answer is read on the tick the round appears, which is the tick whose aim the weapon
 * pass resolved, so the line in the pool and the line the picture would draw are the same
 * tick's answer rather than two neighbouring ones.
 */
function firstShotLine(world: World, ticks: number, aim: Face, held: boolean): Face | null {
  const frame = createInputFrame();
  for (let t = 0; t < ticks; t++) {
    resetFrame(frame);
    frame.aimX = aim.x;
    frame.aimY = aim.y;
    frame.fire = held;
    step(world, frame);
    const fired = firstRound(world);
    if (fired !== null) return fired;
  }
  return null;
}

/** One tick of a hand-built frame, aimed and triggered however the test wants it. */
function stepOnce(world: World, aim: Face, held: boolean): void {
  const frame = resetFrame(createInputFrame());
  frame.aimX = aim.x;
  frame.aimY = aim.y;
  frame.fire = held;
  step(world, frame);
}

/** `playerFacing`, asked the way `renderer.ts` asks it. */
function facingOf(world: World): Face {
  return { ...playerFacing(world, { x: 0, y: 0 }) };
}

/** A chaser due north, and the stick due east, so the two sources cannot agree. */
function crowdNorth(world: World, at: number): void {
  world.autoFire = true;
  expect(spawnEnemy(world, enemyIndex('chaser'), 0, at), 'the crowd is where the test put it').toBeGreaterThanOrEqual(
    0,
  );
}

describe('what the rig is built pointing along', () => {
  it('keeps the muzzle forward, which is what makes local +z the forward', () => {
    // The whole yaw rests on this: `yawToFace` turns a rig whose guns point along local +z.
    // Were the kit ever mirrored — a barrel authored to -z, or the rig re-parented under a
    // turn — the helper would go a quarter turn wrong with nothing in the sim to notice, so
    // the shape is pinned before the maths that reads it.
    const shapes: ReadonlyArray<readonly [string, BufferGeometry]> = [
      ['trim', playerTrim()],
      ...Object.entries(weaponKit()),
    ];
    for (const [name, geometry] of shapes) {
      const p = geometry.getAttribute('position').array as Float32Array;
      let forward = -Infinity;
      let back = Infinity;
      for (let i = 0; i < p.length; i += 3) {
        forward = Math.max(forward, p[i + 2]);
        back = Math.min(back, p[i + 2]);
      }
      // The shortest reach is the trim's muzzle marker, at 0.67 m, and nothing reaches behind
      // the body. Both numbers are the kit's own, not a tolerance chosen to fit.
      expect(forward, `${name}: reaches forward`).toBeGreaterThan(0.6);
      expect(back, `${name}: reaches behind`).toBeLessThan(0.06);
    }
  });
});

describe('the turn', () => {
  /**
   * The four cardinals, read as coordinates rather than as an angle, because both halves of
   * the bug are only visible against the floor: north is render -z, and a barrel laid down
   * with `atan2(aimY, aimX)` lands a quarter turn the other way.
   */
  it('lays a 4 m barrel on the shot line for each cardinal aim', () => {
    const cardinals = [
      { aim: { x: 1, y: 0 }, tip: [BARREL, 0, 0] },
      { aim: { x: 0, y: 1 }, tip: [0, 0, -BARREL] },
      { aim: { x: -1, y: 0 }, tip: [-BARREL, 0, 0] },
      { aim: { x: 0, y: -1 }, tip: [0, 0, BARREL] },
    ];

    for (const { aim, tip } of cardinals) {
      const world = worldWith('pistol');
      const fired = firstShotLine(world, 1, aim, true);
      expect(fired, 'a held trigger fires').not.toBeNull();

      const line = facingOf(world);
      expect(Math.hypot(line.x, line.y), 'the line stays a direction').toBeCloseTo(1, 6);
      expect(line.x, 'a held trigger shoots the steer').toBeCloseTo(aim.x, 6);
      expect(line.y, 'a held trigger shoots the steer').toBeCloseTo(aim.y, 6);
      expect(miss(line, fired!), 'and the round takes it').toBeLessThan(0.04);

      const drawn = barrelTip(yawToFace(line.x, line.y));
      expect(drawn.x, `${aim.x},${aim.y}: render x`).toBeCloseTo(tip[0], 4);
      expect(drawn.y, `${aim.x},${aim.y}: height`).toBeCloseTo(0, 4);
      expect(drawn.z, `${aim.x},${aim.y}: render z`).toBeCloseTo(tip[2], 4);

      // And the shipped yaw must fail here, in the same breath: a quarter turn puts a barrel
      // aimed north along render +x, which is east.
      const old = barrelTip(Math.atan2(aim.y, aim.x));
      expect(
        distanceFromLine(line, old),
        `${aim.x},${aim.y}: the old yaw was a quarter turn off`,
      ).toBeGreaterThan(BARREL * QUARTER_TURN);
    }
  });

  it('turns the barrel onto the body auto-fire leads, not onto the stick', () => {
    // Catapult, because its cone is empty: the round keeps the line it was handed, so the
    // pool says exactly where the gun pointed. The crowd is due north and the stick is due
    // east, and the whole point of the test is that the barrel follows the round.
    const world = worldWith('catapult');
    crowdNorth(world, 8);

    const fired = firstShotLine(world, 10, { x: 1, y: 0 }, false);
    expect(fired, 'a body 8 m away inside an 18 m auto-fire range gets shot at').not.toBeNull();

    const line = facingOf(world);
    const rig = rigTurnedTo(world, yawToFace(line.x, line.y));
    expect(onLine(fired!, barrelAxis(rig)), 'the barrel lies along its own round').toBe(true);

    // The two ways this could still be drawn wrong, each excluded on its own: the line is not
    // the steer, and the old source and old yaw together do not land on the round either. Here
    // the shipped turn laid the barrel due south while the shell flew due north.
    const steer: Face = { x: 1, y: 0 };
    expect(miss(steer, line), 'the shot line is not the steer here').toBeGreaterThan(0.5);
    const old = rigTurnedTo(world, Math.atan2(steer.y, steer.x));
    expect(onLine(fired!, barrelAxis(old)), 'the old source and the old yaw together').toBe(false);
  });

  it('leaves the barrel on the stick once the trigger is held, crowd and all', () => {
    // The other half of the source: with the trigger down the gun shoots the steer even under
    // auto-fire, so a helper that merely tracked the nearest body would put the barrel on the
    // crowd here and fail. Same room, same crowd, same setting as the test above — only the
    // finger differs.
    const world = worldWith('catapult');
    crowdNorth(world, 8);

    const fired = firstShotLine(world, 10, { x: 1, y: 0 }, true);
    expect(fired, 'a held trigger fires into empty floor too').not.toBeNull();

    const line = facingOf(world);
    expect(line.x, 'steered east').toBeCloseTo(1, 6);
    expect(line.y, 'steered east').toBeCloseTo(0, 6);

    const rig = rigTurnedTo(world, yawToFace(line.x, line.y));
    expect(onLine(fired!, barrelAxis(rig)), 'the barrel lies along its own round').toBe(true);

    const atCrowd: Face = { x: 0, y: 1 };
    expect(miss(atCrowd, line), 'and not at the body it could have led').toBeGreaterThan(0.5);
  });

  it('falls back to the steer when there is nothing in reach to lead', () => {
    // 30 m out, past both the catapult's 18 m and the auto-fire setting's own 18 m, so the gun
    // never wakes and there is no round to agree with — the one case where the line and the
    // steer are the same number, worth pinning because it is the case a fix that always leads
    // would get wrong.
    const world = worldWith('catapult');
    crowdNorth(world, 30);

    stepOnce(world, { x: 0.6, y: 0.8 }, false);
    const line = facingOf(world);
    expect(line.x, 'the steer, normalised').toBeCloseTo(0.6, 6);
    expect(line.y, 'the steer, normalised').toBeCloseTo(0.8, 6);
    expect(firstRound(world), 'nothing fired').toBeNull();

    const rig = rigTurnedTo(world, yawToFace(line.x, line.y));
    expect(onLine(line, barrelAxis(rig)), 'and the barrel along it').toBe(true);
  });
});

describe('a line that is not a direction', () => {
  it('still hands back a unit pair, so no yaw arrives as NaN', () => {
    // A hand-built World, or a save restored from before the line existed: either way the rig
    // must not be handed a NaN, which would go into its matrix and take the scene with it. Two
    // fixtures, because the helper has two things to fall back through.
    const quiet = worldWith('pistol');
    quiet.muzzle.x = 0;
    quiet.muzzle.y = 0;
    quiet.player.aimX = 0;
    quiet.player.aimY = 1;
    const fromAim = facingOf(quiet);
    expect(fromAim.x, 'no line: fall back to the aim').toBeCloseTo(0, 6);
    expect(fromAim.y, 'no line: fall back to the aim').toBeCloseTo(1, 6);

    const aimless = worldWith('pistol');
    aimless.muzzle.x = Number.NaN;
    aimless.muzzle.y = Number.NaN;
    aimless.player.aimX = 0;
    aimless.player.aimY = 0;
    const lastResort = facingOf(aimless);
    expect(Math.hypot(lastResort.x, lastResort.y), 'neither: a flat east').toBeCloseTo(1, 6);

    const rig = rigTurnedTo(aimless, yawToFace(lastResort.x, lastResort.y));
    const axis = barrelAxis(rig);
    expect(axis.x, 'and a finite barrel off it').not.toBeNaN();
    expect(axis.y, 'and a finite barrel off it').not.toBeNaN();
    expect(Math.hypot(axis.x, axis.y), 'and still a unit one').toBeCloseTo(1, 6);
  });
});
