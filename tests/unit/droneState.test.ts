/**
 * The companion as the state reports him: two places, a flag, and where each one came from.
 *
 * `__forgeState().drone` answers two questions at once — is there a drone in the drawn frame, and
 * where is it — and it answers them from two places: `orbit` off `droneOrbit`, the sim's answer,
 * which is also the point the companion's rounds are loosed from, and `drawn` off the rig, which
 * is the only thing that can say whether a body was on screen at all. Those are the file's whole
 * subject, because the two are free to come apart and a state key written from `droneOrbit` twice
 * would agree with itself on every frame, including the frame where the rig was never mounted,
 * never synced, or left standing where the last run parked it.
 *
 * Nothing else in the suite covers this. `app-split.test.ts` checks the same seam with a `View`
 * that hands back a hand-written point, which is the right fixture for "the state asks the picture
 * rather than assuming" and cannot say anything about a real drone. `drone-geometry.test.ts` and
 * `droneView.test.ts` check the rig over a bare `Scene`, including that it stands on the orbit
 * point. This is where the two meet: a real rig, stood by a real `step`ped run, read back through
 * the same `droneSnapshot` the shipped view calls, into the object a scenario asserts on.
 *
 * What it still cannot see is the assembly: that `renderer.ts` calls the rig's pass at all needs a
 * canvas and a backend, and is pinned in the browser by `tests/e2e/drone.spec.ts` (TECH.md
 * "Tests"). The stand-in view below copies that one line — `draw` stands the drone — for the same
 * reason and with the same limit.
 *
 * Plain Node throughout, like the render tests it sits beside.
 */

import { describe, expect, it } from 'vitest';
import { Scene } from 'three/webgpu';

import { buildBinds } from '../../src/input/bindings';
import { POWERUPS } from '../../src/content/powerups';
import { buildState, type StateHost } from '../../src/game/appState';
import { defaultSettings } from '../../src/game/persistence';
import { createDroneRig, type DroneRig } from '../../src/render/droneRig';
import { profileFor } from '../../src/render/quality';
import type { View } from '../../src/render/renderer';
import { droneSnapshot } from '../../src/render/viewSnapshot';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { grantPowerup } from '../../src/sim/systems/pickups';
import { ORBIT_R, droneOrbit } from '../../src/sim/systems/drone';
import { createWorld, type World } from '../../src/sim/world';

/** The tier the rig is built against; only the shadow differs between tiers, and nothing draws. */
const PROFILE = profileFor('high');

/** One frame's worth of wall time, which is what `View.draw` is handed. */
const FRAME = 1 / 60;

/** m — how far off the ring point the drawn body may sit, for "on his ring" to mean anything. */
const ON_RING = 0.2;

/**
 * A picture built around a real rig.
 *
 * `draw` stands the drone the way `renderer.ts` draws it and `dronePoint` reads it back through
 * the same helper the shipped view calls, rather than through a point written out here. Both
 * halves matter: the seam is a *read* of the drawing, so the fixture has to be able to answer
 * something the sim would not have answered on its own, and a hand-written answer would only ever
 * test the writing.
 */
function pictureOf(rig: DroneRig): View {
  return {
    backend: 'none',
    quality: 'high',
    errors: 0,
    draw: (world, alpha) => rig.sync(world, alpha),
    aim: () => false,
    playerFace: (out) => {
      out.x = 1;
      out.y = 0;
      return out;
    },
    dronePoint: (out) => droneSnapshot(rig.group, out),
    resize: () => {},
  };
}

/** A host over a bare world: no app, no backend, and a picture only where one is handed in. */
function hostOver(w: World, view: View | null = null): StateHost {
  return {
    world: w,
    scene: 'playing',
    backend: 'none',
    mode: 'campaign',
    errors: 0,
    settings: defaultSettings(),
    bindings: buildBinds(),
    frameTimes: new Float32Array(30),
    view,
  };
}

/** One drawn frame, in the order the frame draws it: stand the rig, then read the state. */
function draw(view: View, w: World, alpha = 1): void {
  view.draw(w, alpha, FRAME, false);
}

/** Walk `w` for `ticks` along (`dx`, `dy`), so the ring it circles is a moving one. */
function walk(w: World, ticks: number, dx: number, dy: number): World {
  const frame = createInputFrame();
  for (let t = 0; t < ticks; t++) {
    resetFrame(frame);
    frame.moveX = dx;
    frame.moveY = dy;
    step(w, frame);
  }
  expect(w.player.alive, 'and the run was still running').toBe(true);
  return w;
}

/**
 * A run that owns the companion, walked for `ticks`.
 *
 * The card goes in through `grantPowerup` rather than by writing the stat, so the fixture comes in
 * through the door a player — and `__forgeDebug.givePowerup`, which is how the browser spec arms
 * him — actually uses.
 */
function flight(seed: number, ticks: number, dx: number, dy: number): World {
  const w = createWorld(seed);
  const card = POWERUPS.findIndex((p) => p.id === 'drone');
  expect(card, 'the ward drone card is what buys the companion').toBeGreaterThanOrEqual(0);
  expect(grantPowerup(w, card), 'the card grants').toBe(true);
  expect(w.stats.drone, '`drone` is the stat the rig draws on').toBe(1);
  return walk(w, ticks, dx, dy);
}

/**
 * A picture to ask: a fresh rig on a bare scene, and the `View` that draws with it.
 *
 * Destructured whole where a test also moves the rig, and `{ view }` alone everywhere else.
 */
function aPicture(): { rig: DroneRig; view: View } {
  const rig = createDroneRig(new Scene(), PROFILE);
  return { rig, view: pictureOf(rig) };
}

/** The sim's own answer for this tick, read separately from the state's copy of it. */
function orbitOf(w: World): { x: number; y: number } {
  const at = { x: 0, y: 0 };
  droneOrbit(w.tick, w.player.x, w.player.y, at);
  return at;
}

/** How far two world points sit apart, which is what "the same place" means here. */
function apart(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('the companion in the state snapshot', () => {
  it('reports no drone for a default World, at no height', () => {
    const w = createWorld(7);
    expect(w.stats.drone, 'a run that never bought the card').toBe(0);

    // Nothing to ask, so nothing drawn — and `drawn` answers no place rather than the orbit's own
    // point, which is what keeps the pair free to disagree.
    const quiet = buildState(hostOver(w)).drone;
    expect(quiet.shown, 'no picture, so nothing was drawn').toBe(false);
    expect(quiet.drawn, 'and no height, because no height was drawn at').toEqual({
      x: 0,
      y: 0,
      h: 0,
    });

    // A rig to ask, but one that has never stood anywhere: the same answer, and for a different
    // reason. The rig is built hidden rather than visible-by-default, so a state that reported a
    // drone whenever it merely had a rig to ask would fail here rather than in the browser. (Read
    // field by field rather than against the object above: with a picture to ask, the empty place
    // comes back through the floor's flip as `-0`, which is the same place and not the same
    // number.)
    const { view } = aPicture();
    const asked = buildState(hostOver(w, view)).drone;
    expect(asked.shown, 'a rig nobody drew with').toBe(false);
    expect(Math.hypot(asked.drawn.x, asked.drawn.y), 'and no place, either').toBe(0);
    expect(asked.drawn.h, 'at no height').toBe(0);
  });

  it('prints the sim answer beside the hidden one, on the ring and not on the man', () => {
    const w = flight(7, 60, 1, 0);
    const { rig, view } = aPicture();

    // Stand the drone first, so the ring below is printed over a frame that really drew it: the
    // point of the pair is that both halves travel together or not at all, not that one of them
    // was skipped.
    draw(view, w);
    const seen = buildState(hostOver(w, view)).drone;
    expect(seen.shown, 'this run owns the companion').toBe(true);
    expect(apart(seen.drawn, seen.orbit), 'drawn sits on the printed ring').toBeLessThan(ON_RING);

    // And the ring is a ring: 1.35 m out, measured off the player, which is the number
    // `droneOrbit`'s own file pins and the browser spec measures the drawn body against.
    expect(
      apart(seen.orbit, { x: w.player.x, y: w.player.y }),
      'one ring out, not parked on his player',
    ).toBeCloseTo(ORBIT_R, 4);
    expect(rig.group.visible, 'the rig that answered is the rig that drew').toBe(true);
  });

  it('asks the rig every time, so a drone left over from the last run reads as gone', () => {
    const armed = flight(7, 90, 1, 0);
    const { view } = aPicture();

    draw(view, armed);
    const flown = buildState(hostOver(armed, view)).drone;
    expect(flown.shown, 'drawn for the run that bought him').toBe(true);
    const last = { ...flown.drawn };

    // The same rig and the same picture, over a run that never bought him: a restart builds a new
    // World and keeps the rig, which is the case the rig exists to survive. The transform is still
    // the last run's — a taken-out drone is hidden, not moved — so only the flag can say he is
    // gone, and this is the check that he does.
    //
    // The new run walks the other way on purpose. Two runs of the same length down the same axis
    // end with their rings over the same ground, and then the stale point and the fresh one would
    // coincide for a reason that has nothing to do with what is being measured.
    const quiet = walk(createWorld(8), 90, -1, 0);
    expect(quiet.stats.drone, 'a fresh run with no companion').toBe(0);
    draw(view, quiet);

    const seen = buildState(hostOver(quiet, view)).drone;
    expect(seen.shown, 'and the state reads the rig rather than latching').toBe(false);
    expect(seen.drawn, 'a place is not a drone: the stale transform is still reported').toEqual(
      last,
    );
    expect(
      apart(seen.drawn, seen.orbit),
      'a metre off the new ring, which nothing would be drawn at',
    ).toBeGreaterThan(1);
  });

  it('reports a drawn drone over the run that earned him, and none over the same run unearned', () => {
    const w = flight(7, 120, 0, 1);
    const { view } = aPicture();
    draw(view, w);

    const seen = buildState(hostOver(w, view)).drone;
    expect(seen.shown, 'armed, drawn, and reported').toBe(true);
    expect(apart(seen.drawn, seen.orbit), 'on the ring').toBeLessThan(ON_RING);
    expect(seen.drawn.h, 'above the crowd rather than behind it').toBeGreaterThan(0.9);

    // The control the browser spec insists on, at the other end of the same seam: nothing is
    // inferred from the drone *stat*, and a state that assumed a picture when it had one to ask
    // would answer true here. Same World, same tick, nobody to ask.
    const blind = buildState(hostOver(w)).drone;
    expect(blind.shown, 'the same run with no view to ask').toBe(false);
    expect(blind.drawn, 'and no place either').toEqual({ x: 0, y: 0, h: 0 });
  });

  it('reads the drawn half off the rig, in world terms, not off the orbit', () => {
    const w = flight(7, 90, 1, 0);
    const { rig, view } = aPicture();
    draw(view, w);
    expect(buildState(hostOver(w, view)).drone.shown, 'stood on his ring first').toBe(true);

    // Then park him a whole diagonal off the ring, at a height no drone flies at, in the
    // coordinates the scene keeps: render z is `-y`. Two failures hide in that one line and each
    // is worth a check of its own — a `drawn` recalculated from `droneOrbit` beside `orbit`, and a
    // read that forgot to undo the floor's flip. Neither is visible from a drone standing where it
    // belongs, which is the exact reason this parks one somewhere it does not belong.
    const want = orbitOf(w);
    const parked = { x: want.x + 5, y: want.y - 4 };
    rig.group.position.set(parked.x, 2, -parked.y);

    const seen = buildState(hostOver(w, view)).drone;
    expect(seen.shown, 'still drawing, just somewhere else').toBe(true);
    expect(seen.drawn, 'the rig place, flipped out of render coordinates').toEqual({
      x: parked.x,
      y: parked.y,
      h: 2,
    });
    expect(seen.orbit, 'with the sim answer still printed beside it').toEqual(want);
    expect(apart(seen.drawn, seen.orbit), 'and the two a long way apart').toBeGreaterThan(5);
  });

  it('flips over the tick the card is taken, from hidden to drawn', () => {
    const w = createWorld(7);
    const { view } = aPicture();

    draw(view, w);
    const before = buildState(hostOver(w, view)).drone;
    expect(before.shown, 'a run that has not bought him yet').toBe(false);
    expect(before.drawn.h, 'and nothing is standing in the air').toBe(0);

    // Take the card mid-run and keep playing, which is how a page actually gets a companion: the
    // level-up offer is three cards drawn at random, so no scenario can plan on being handed this
    // one. Same rig, same view, same state builder — the only thing that changes is the run, and
    // the two reads have to follow it.
    const card = POWERUPS.findIndex((p) => p.id === 'drone');
    expect(grantPowerup(w, card), 'the card grants').toBe(true);
    walk(w, 90, 1, 0);
    draw(view, w);

    const after = buildState(hostOver(w, view)).drone;
    expect(after.shown, 'and then he is there').toBe(true);
    expect(after.drawn.h, 'standing at his own height').toBeGreaterThan(0.9);
    expect(apart(after.drawn, after.orbit), 'on the ring the state prints beside him').toBeLessThan(
      ON_RING,
    );
  });

  it('answers the same twice over a frame it leaves alone', () => {
    const w = flight(7, 90, 1, 0);
    const { view } = aPicture();
    draw(view, w);

    const host = hostOver(w, view);
    const tick = w.tick;
    const first = buildState(host).drone;
    const again = buildState(host).drone;

    // Asking twice is the same answer twice, which is what lets a scenario read the state a dozen
    // times a second while it watches a run. Two objects rather than one reused scratch, for the
    // other half of the same reason: a snapshot that handed out a shared object would be rewritten
    // under a reader that kept it, and a stale read is the exact failure this pair exists to catch.
    expect(again).toEqual(first);
    expect(again, 'not one object handed out twice').not.toBe(first);
    expect(w.tick, 'and nothing moved while it was read').toBe(tick);

    // And the first answer really does stay where it was: move the drone, read again, and the
    // object held from before still reports the frame it was taken on.
    walk(w, 60, -1, 0);
    draw(view, w);
    const later = buildState(host).drone;
    expect(later).not.toEqual(first);
    expect(first, 'the earlier read is untouched').toEqual(again);
  });
});