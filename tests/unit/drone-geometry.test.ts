/**
 * The ward drone's body, and the rig that puts it on the orbit.
 *
 * Two things are checked here, and only the first is about the shape.
 *
 * **The shape.** DESIGN.md's asset rule is that a body needs "a shape the eye can learn", and its
 * avoid-list bans relying on colour alone. So the cross checks are written to fail on the shapes
 * this one replaces: a blob and a ring of the same footprint are measured by the same code and
 * required to *fail* them, the way `facing.test.ts` requires the shipped `atan2` to miss. Four
 * rotor lobes on the diagonals with the four gaps between them empty is what makes this readable
 * as a machine rather than as another dot, and it is what keeps it apart from the enemy
 * `orbiter`, which also walks a circle about the player and is drawn as one lens under one ring.
 *
 * **The placement.** The rig takes the drone's position from `droneOrbit` rather than writing a
 * second orbit, and that is the fact the checks below pin, pairwise: the point the rig is drawn at
 * against the round origins a run really loosed (read out of the event ring, so the check cannot
 * agree with itself), against the player the ring is supposed to circle while that player is
 * walking, and against the drone's own travel measured off two consecutive drawn frames. A rig
 * that picked its own radius, its own centre, its own bearing or a stale point would pass "a drone
 * was drawn" and fail one of those.
 *
 * Plain Node throughout (TECH.md "Tests"): a bare `Scene`, a real `World`, the rig factory. No
 * renderer, no canvas — the same shape `chests.test.ts` is built in.
 */

import { describe, expect, it } from 'vitest';
import { Scene, SphereGeometry, TorusGeometry, type BufferGeometry, type Mesh } from 'three/webgpu';

import { enemyIndex } from '../../src/content/enemies';
import { POWERUPS } from '../../src/content/powerups';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { grantPowerup } from '../../src/sim/systems/pickups';
import { ORBIT_R, droneOrbit } from '../../src/sim/systems/drone';
import { Ev, createWorld, eventAt, type World } from '../../src/sim/world';
import { createDroneRig, type DroneRig } from '../../src/render/droneRig';
import { drawnFace } from '../../src/render/facing';
import { droneBody, droneTrim, triangleCount } from '../../src/render/meshes';
import { profileFor } from '../../src/render/quality';

/** The gun the drone copies, which is also how its `Ev.Shot` entries are marked. */
const DRONE_GUN = 0;

/** How far out a rotor has to reach, as a fraction of the shape's own plan reach, to count as a lobe. */
const LOBE = 0.8;

/** How narrow the gap between two rotors is, likewise: the cross's notches are this wide. */
const GAP = 0.25;

/** One frame's read of the rig, in the sim's own terms: render z flipped back to world y. */
interface Sighting {
  x: number;
  y: number;
  /** m — the height it is drawn at, which the rig owns and the shape does not. */
  h: number;
  yaw: number;
}

/** Where the rig is drawn this frame, as a world point plus the yaw it was turned to. */
function sight(rig: DroneRig): Sighting {
  const p = rig.group.position;
  return { x: p.x, y: -p.z, h: p.y, yaw: rig.group.rotation.y };
}

/** A run whose only gun is the companion, on enough HP that staying alive is not the test. */
function droneRun(seed: number, tier: number): World {
  const w = createWorld(seed);
  w.slots[0].weapon = -1;
  w.slots[1].weapon = -1;
  w.autoFire = false;
  w.player.hp = 100_000;

  const drone = POWERUPS.findIndex((p) => p.id === 'drone');
  expect(drone, 'the ward drone card is what buys the companion').toBeGreaterThanOrEqual(0);
  for (let t = 0; t < tier; t++) {
    expect(grantPowerup(w, drone), `the drone grants up to tier ${tier}`).toBe(true);
  }
  expect(w.stats.drone, '`drone` is the stat the pass reads and the rig draws on').toBe(tier);
  return w;
}

/** A ring of chasers for the companion to shoot at, on enough HP to still be there later. */
function pack(w: World, n: number): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const at = spawnEnemy(w, enemyIndex('chaser'), Math.cos(a) * 7, Math.sin(a) * 7);
    expect(at, `a body at bearing ${a.toFixed(2)}`).toBeGreaterThanOrEqual(0);
    w.enemies.hp[at] = 400;
  }
}

/** A shape's plan-view reach: how far out from its own centre any vertex gets. */
function reach(geometry: BufferGeometry): number {
  const p = geometry.getAttribute('position');
  let h = 0;
  for (let i = 0; i < p.count; i++) {
    h = Math.max(h, Math.abs(p.getX(i)), Math.abs(p.getZ(i)));
  }
  return h;
}

/**
 * How many of the four diagonals a shape reaches out along, and how many of the four axis gaps
 * between them it fills.
 *
 * A quadrotor is four lobes and four gaps; a blob, a disc or a single ring fills the gaps, and a
 * ring with nothing on the diagonals has no lobes. Read in plan view, which is the view the 55°
 * camera mostly gets.
 */
function cross(geometry: BufferGeometry): { lobes: number; gaps: number } {
  const p = geometry.getAttribute('position');
  const h = reach(geometry);
  const lobes = new Set<string>();
  const gaps = new Set<string>();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    if (Math.hypot(x, z) > LOBE * h && Math.abs(x) > GAP * h && Math.abs(z) > GAP * h) {
      lobes.add(`${Math.sign(x)}${Math.sign(z)}`);
    }
    if (Math.abs(z) > LOBE * h && Math.abs(x) < GAP * h) gaps.add(`z${Math.sign(z)}`);
    if (Math.abs(x) > LOBE * h && Math.abs(z) < GAP * h) gaps.add(`x${Math.sign(x)}`);
  }
  return { lobes: lobes.size, gaps: gaps.size };
}

/** How well a rig's drawn facing lines up with a direction it is supposed to be pointing in. */
function along(yaw: number, dx: number, dy: number): number {
  const f = drawnFace(yaw, { x: 0, y: 0 });
  const len = Math.hypot(dx, dy);
  return len === 0 ? 1 : (f.x * dx + f.y * dy) / len;
}

describe('the drone shapes', () => {
  it('keeps both halves inside the budget the folder draws to', () => {
    const hull = triangleCount(droneBody());
    const trim = triangleCount(droneTrim());

    // The 40-to-300 body budget from `meshes/index.ts`, and a companion is one instance rather
    // than a pack's worth, so it is well inside it. The trim stays under the heaviest horde core
    // (70): the accent is the smaller half of a body, which is what keeps a silhouette readable.
    expect(hull).toBeGreaterThanOrEqual(40);
    expect(hull).toBeLessThanOrEqual(300);
    expect(trim).toBeLessThan(70);
    expect(trim).toBeLessThan(hull);
  });

  it('carries no dead triangles', () => {
    for (const geometry of [droneBody(), droneTrim()]) {
      const position = geometry.getAttribute('position');
      expect(position.count % 3).toBe(0);
      for (let i = 0; i < position.array.length; i++) {
        expect(Number.isFinite(position.array[i]!)).toBe(true);
      }
    }
  });

  it('reads as a rotor cross, which is the read that replaces its colour', () => {
    const hull = cross(droneBody());
    expect(hull.lobes, 'four rotors, one per diagonal').toBe(4);
    expect(hull.gaps, 'and the four gaps between them empty').toBe(0);

    // The same measurement on two shapes that are not a cross, so the assertion above means
    // something: a blob reaches out in every direction and a lone ring reaches out in none of
    // the four it has to. Both are the same footprint, so this is about shape and not size.
    const blob = new SphereGeometry(0.23, 8, 4).toNonIndexed();
    const ring = new TorusGeometry(0.23, 0.05, 4, 12).toNonIndexed();
    expect(cross(blob).gaps, 'a blob fills the gaps').toBeGreaterThan(0);
    expect(cross(ring).lobes, 'a ring has no corners to reach').toBe(0);
  });

  it('is authored about its own centre, because it flies', () => {
    for (const [name, geometry] of [
      ['hull', droneBody()],
      ['trim', droneTrim()],
    ] as [string, BufferGeometry][]) {
      const p = geometry.getAttribute('position');
      let lowest = Infinity;
      let highest = -Infinity;
      for (let i = 0; i < p.count; i++) {
        lowest = Math.min(lowest, p.getY(i));
        highest = Math.max(highest, p.getY(i));
      }
      // The deliberate exception to the crate's feet-at-zero rule: a drone has no feet, and the
      // height is the rig's to give. A shape authored on its own floor would fly at y=0.
      expect(lowest, `${name}: sunk into the floor`).toBeLessThan(-0.01);
      expect(highest, `${name}: above its own centre`).toBeGreaterThan(0.01);
    }
  });

  it('stays smaller than the player it orbits, and wider than it is tall', () => {
    const hull = droneBody();
    hull.computeBoundingBox();
    const box = hull.boundingBox!;
    const wide = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    const high = box.max.y - box.min.y;

    // 1.35 m out, beside a 1.8 m man: big enough that it is a body and not a mote (DESIGN.md
    // bans tiny sprites on a dark screen), small enough that it never hides the player.
    expect(wide).toBeGreaterThan(0.3);
    expect(wide).toBeLessThan(0.7);
    // And the flat cross reads against the crowd; a shape as tall as it is wide is a balloon.
    expect(wide).toBeGreaterThan(high * 1.5);
  });

  it('gives the trim a front, so there is something for the yaw to point', () => {
    const hull = droneBody();
    const trim = droneTrim();
    hull.computeBoundingBox();
    trim.computeBoundingBox();

    // The sensor boom is the only part of the drone that gets past the rotor line, which is what
    // makes the silhouette asymmetric and so gives the eye (and `sight` below) a front to read.
    // Measured against the hull's own plan reach rather than a size I liked: the rotor discs reach
    // 0.23 m in both axes, so anything shorter than that hides inside the cross.
    expect(trim.boundingBox!.max.z, 'the boom clears the rotor line').toBeGreaterThan(reach(hull));

    // And at one end only: a marker at both ends is a symmetric shape with nothing to point.
    const nose = trim.boundingBox!.max.z;
    const tail = -trim.boundingBox!.min.z;
    expect(nose - tail, 'a nose, not a spine').toBeGreaterThan(0.06);
  });
});

describe('the drone rig', () => {
  it('draws nothing for a run that never bought the companion', () => {
    const w = createWorld(7);
    expect(w.stats.drone, 'a default run has no drone').toBe(0);
    const rig = createDroneRig(new Scene(), profileFor('high'));
    rig.sync(w, 1);

    // Out of the draw rather than parked at the origin: the pass that fires it is behind the same
    // comparison, so a run with no companion pays no draw and no maths for one.
    expect(rig.group.visible).toBe(false);
    expect(rig.group.position.x).toBe(0);
    expect(rig.group.position.z).toBe(0);

    // And it does come up when the card is taken, so the two assertions above are not one test.
    const owned = droneRun(7, 2);
    pack(owned, 6);
    const shown = createDroneRig(new Scene(), profileFor('high'));
    shown.sync(owned, 1);
    expect(shown.group.visible).toBe(true);
    expect(shown.group.position.length(), 'and put somewhere').toBeGreaterThan(0);
  });

  it('hides the drone when its player is dead, which is when the drone stops shooting', () => {
    const w = droneRun(7, 2);
    pack(w, 6);
    const rig = createDroneRig(new Scene(), profileFor('high'));
    rig.sync(w, 1);
    expect(rig.group.visible).toBe(true);

    w.player.alive = false;
    rig.sync(w, 1);
    expect(rig.group.visible, 'no companion over a run that is over').toBe(false);
  });

  it('stands on the point its own rounds come from', () => {
    const w = droneRun(7, 3);
    pack(w, 8);
    const rig = createDroneRig(new Scene(), profileFor('high'));
    const frame = createInputFrame();

    const seen: Array<{ tick: number; x: number; y: number }> = [];
    for (let t = 0; t < 400; t++) {
      resetFrame(frame);
      const before = w.events.written;
      step(w, frame);
      rig.sync(w, 1);
      const at = sight(rig);

      for (let e = before; e < w.events.written; e++) {
        const i = eventAt(w, e);
        if (i < 0 || w.events.type[i] !== Ev.Shot) continue;
        // The round is the companion's: it names the copied gun, it names a round rather than a
        // beam, and both hands stayed empty the whole way.
        expect(w.events.a[i], 'nothing but the drone fires here').toBe(DRONE_GUN);
        expect(w.events.b[i]).toBeGreaterThanOrEqual(0);
        seen.push({ tick: w.tick, x: w.events.x[i], y: w.events.y[i] });

        // The seam, in one line: the drone is drawn where its shot started. Read the other way,
        // a second orbit here would put the machine somewhere its fire did not come from, which
        // is the failure `drone.test.ts` was written to keep out of the sim.
        const off = Math.hypot(at.x - w.events.x[i], at.y - w.events.y[i]);
        expect(off, `tick ${w.tick}: drawn on its own muzzle`).toBeLessThan(0.001);
      }
    }

    expect(seen.length, 'and the run really loosed rounds to compare').toBeGreaterThan(20);
    expect(w.slots.every((hand) => hand.weapon < 0), 'and the hands stayed empty').toBe(true);
  });

  it('stays on the ring while the player walks, so the circle follows the man', () => {
    const w = droneRun(8, 2);
    pack(w, 6);
    const rig = createDroneRig(new Scene(), profileFor('high'));
    const frame = createInputFrame();
    const probe = { x: 0, y: 0 };

    for (let t = 0; t < 300; t++) {
      resetFrame(frame);
      frame.moveX = 1;
      if (t > 150) frame.moveY = 1;
      step(w, frame);
      rig.sync(w, 1);
      const at = sight(rig);

      const off = Math.hypot(at.x - w.player.x, at.y - w.player.y);
      expect(off, `tick ${t}: still ${ORBIT_R} m out`).toBeCloseTo(ORBIT_R, 4);
      expect(Number.isFinite(at.x) && Number.isFinite(at.y), `tick ${t}: a place`).toBe(true);

      // Independent of the rig: the answer the sim would give, asked by the test.
      droneOrbit(w.tick, w.player.x, w.player.y, probe);
      expect(Math.hypot(at.x - probe.x, at.y - probe.y), `tick ${t}: one answer`).toBeLessThan(0.001);
    }

    expect(Math.abs(w.player.x), 'a walk worth checking: the player left').toBeGreaterThan(10);
  });

  it('travels the ring instead of marking one spot', () => {
    const w = droneRun(9, 3);
    pack(w, 6);
    const rig = createDroneRig(new Scene(), profileFor('high'));
    const frame = createInputFrame();

    const quarters = new Set<string>();
    let furthest = 0;
    for (let t = 0; t < 400; t++) {
      resetFrame(frame);
      step(w, frame);
      rig.sync(w, 1);
      const at = sight(rig);
      quarters.add(`${at.x - w.player.x >= 0 ? 'east' : 'west'}${at.y - w.player.y >= 0 ? 'north' : 'south'}`);
      furthest = Math.max(furthest, Math.hypot(at.x - w.player.x, at.y - w.player.y));
    }

    // A drone pinned to one bearing would pass every "a drone was drawn" check there is.
    expect(quarters.size, 'every side of the player').toBe(4);
    expect(furthest).toBeGreaterThan(1);
  });

  it('turns to face the way it is going, with the flip applied', () => {
    const w = droneRun(10, 2);
    pack(w, 6);
    const rig = createDroneRig(new Scene(), profileFor('high'));
    const frame = createInputFrame();

    const lined: number[] = [];
    const naive: number[] = [];
    // Only pairs of *drawn* frames count as travel. The group starts at the origin and unturned,
    // so a first vector taken off the unsynced rig is a line from wherever nothing was drawn.
    let previous: Sighting | null = null;
    for (let t = 0; t < 300; t++) {
      resetFrame(frame);
      // A walk, not a stand: the ring rides with the player, so its ground track is the orbit's
      // chord plus the stride, and a rig that turned only with the chord would crab sideways here.
      frame.moveX = 1;
      if (t > 150) frame.moveY = 1;
      step(w, frame);
      rig.sync(w, 1);
      const at = sight(rig);
      if (previous !== null) {
        const dx = at.x - previous.x;
        const dy = at.y - previous.y;
        if (Math.hypot(dx, dy) > 0.01) {
          // Measured off two drawn frames rather than off the number that turned the rig: this says
          // the shape lies along its own travel, which is the half a rig can get wrong while its
          // maths is right.
          lined.push(along(at.yaw, dx, dy));
          naive.push(along(Math.atan2(dx, dy), dx, dy));
        }
      }
      previous = at;
    }

    expect(lined.length, 'a run that turns').toBeGreaterThan(100);
    for (const [i, dot] of lined.entries()) {
      expect(dot, `sample ${i}: the cross lies along its travel`).toBeGreaterThan(0.98);
    }
    // And the convention matters here: `atan2(dy, dx)` — the one `facing.ts` exists to replace —
    // would put the rotor cross a quarter turn off its own motion over half the run.
    const off = naive.filter((dot) => dot < 0.98).length;
    expect(off, 'the naive yaw is off at most samples, the rig is not').toBeGreaterThan(
      Math.floor(naive.length / 2)
    );
  });

  it('holds its picture on a frame that did not step', () => {
    const w = droneRun(11, 2);
    pack(w, 6);
    const rig = createDroneRig(new Scene(), profileFor('high'));
    const frame = createInputFrame();
    for (let t = 0; t < 70; t++) {
      resetFrame(frame);
      step(w, frame);
      rig.sync(w, 1);
    }

    // Twice on the same interpolation point: everything comes off the tick and the player, so a
    // frame that did not step writes the same numbers it wrote the first time it was drawn — no
    // clock, no per-call randomness, nothing that drifts while the game is frozen.
    const first = sight(rig);
    rig.sync(w, 1);
    const again = sight(rig);
    expect(again.x).toBe(first.x);
    expect(again.y).toBe(first.y);
    expect(again.h).toBe(first.h);
    expect(again.yaw).toBe(first.yaw);

    // And the interpolation runs backwards, not forwards: `alpha === 0` lands on the previous
    // tick's point, so a drone is never drawn somewhere its rounds have not been loosed from.
    rig.sync(w, 0);
    const back = sight(rig);
    const probe = { x: 0, y: 0 };
    droneOrbit(w.tick - 1, w.player.x, w.player.y, probe);
    expect(Math.hypot(back.x - probe.x, back.y - probe.y), 'a tick behind, not ahead').toBeLessThan(
      1e-9,
    );
    expect(Math.hypot(first.x - back.x, first.y - back.y), 'and that is a real distance').toBeGreaterThan(0.01);
  });

  it('breathes at a height rather than sitting at one', () => {
    const w = droneRun(12, 2);
    pack(w, 6);
    const rig = createDroneRig(new Scene(), profileFor('high'));
    const frame = createInputFrame();

    const heights = new Set<number>();
    for (let t = 0; t < 300; t++) {
      resetFrame(frame);
      step(w, frame);
      rig.sync(w, 1);
      const at = sight(rig);
      // Above the crowd it flies over, below the player's head, and never through the floor.
      expect(at.h, `tick ${t}: a height`).toBeGreaterThan(0.5);
      expect(at.h, `tick ${t}: still under a man`).toBeLessThan(1.5);
      heights.add(Number(at.h.toFixed(4)));
    }

    expect(heights.size, 'a moving hover, not a decal').toBeGreaterThan(20);
  });

  it('draws a hull and a glow, neither of them needing the horde\'s instance buffers', () => {
    const scene = new Scene();
    const rig = createDroneRig(scene, profileFor('high'));
    expect(rig.group.children).toHaveLength(2);

    for (const child of rig.group.children) {
      const mesh = child as Mesh;
      expect(mesh.isMesh, 'two meshes, not a batch').toBe(true);
      // `aDie` and `aHit` belong to an instanced stream. A one-off rig drawn with a material that
      // reads them gets a black body and a console error, so they are checked away rather than
      // assumed absent.
      expect(mesh.geometry.getAttribute('aDie')).toBeUndefined();
      expect(mesh.geometry.getAttribute('aHit')).toBeUndefined();
    }

    const low = createDroneRig(new Scene(), profileFor('low'));
    expect((rig.group.children[0] as Mesh).castShadow, 'shadows on the high tier').toBe(true);
    expect((low.group.children[0] as Mesh).castShadow, 'and off on the low tier').toBe(false);
  });
});
