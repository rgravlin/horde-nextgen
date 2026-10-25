/**
 * Weapons part 2: the alien fire kinds and the two gauges that feed them.
 *
 * Each test pins one behaviour the task asked for and is written to fail without it,
 * not merely to read it:
 *
 * - the chain test lines up nine bodies for a bolt that can only take six, so "stops
 *   at five jumps" has three witnesses, and reads the hit list rather than a health
 *   total, so a bolt that spent two jumps on one body cannot pass;
 * - the beam and repeater tests assert the *shape* of the heat curve — on, a gap of
 *   real length, then on again — and that nothing is damaged during the gap, which is
 *   the difference between a gauge and a decoration;
 * - the energy test drains the cell by hand next to a cleared cooldown, so the only
 *   thing holding the trigger is the constraint under test;
 * - the burn tests measure damage after the shaft that caused it is gone, which is the
 *   only way to tell a burn from a hit;
 * - the orb test compares each body against the closest a *stationary* body would get
 *   to a rock flying past it, so the pull has to be the reason.
 *
 * Geometry tests freeze their targets with `stand`, which leans on the stagger state:
 * a staggering body rides the shove it was given instead of steering, and a freshly
 * placed body has no shove, so it stays exactly where the test put it — and if it does
 * not move, the only thing that could have moved it is the weapon.
 */

import { describe, expect, it } from 'vitest';
import { WEAPONS, type WeaponDef } from '../../src/content/weapons';
import { createInputFrame, resetFrame, type InputFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import {
  Ev,
  clearEvents,
  countAlive,
  countEvents,
  createWorld,
  eventSlot,
  findEvent,
  loadSlot,
  type World,
} from '../../src/sim/world';

/** Put an enemy of the only archetype in content at (x, y) with `hp` health. */
function place(w: World, x: number, y: number, hp: number): number {
  const i = spawnEnemy(w, 0, x, y);
  w.enemies.hp[i] = hp;
  return i;
}

/** Hold a body in place for the whole test, for geometry that must stay put. */
function stand(w: World, i: number): void {
  w.enemies.state[i] = 4096;
}

/** Run ticks with a frame the caller refills; the frame itself is reused. */
function run(w: World, ticks: number, fill?: (f: InputFrame) => void): void {
  const f = createInputFrame();
  for (let t = 0; t < ticks; t++) {
    resetFrame(f);
    if (fill) fill(f);
    step(w, f);
  }
}

const shoot: (f: InputFrame) => void = (f) => {
  f.fire = true;
};

/** Hand `id` to the first weapon slot, loaded, so the test is about the gun. */
function arm(w: World, id: string): WeaponDef {
  const index = WEAPONS.findIndex((d) => d.id === id);
  expect(index).toBeGreaterThanOrEqual(0);
  loadSlot(w.slots[0], index);
  return WEAPONS[index];
}

/**
 * The enemy slot each unread `Hit` names, oldest first, repeats included.
 *
 * Taken from the ring rather than from the health totals because the thing being pinned
 * is "one hit per body", and eight bodies at 499/500 HP look exactly like four bodies
 * hit twice.
 */
function hitList(w: World): number[] {
  const out: number[] = [];
  for (let k = 0; k < w.events.count; k++) {
    const i = eventSlot(w, k);
    if (w.events.type[i] === Ev.Hit) out.push(w.events.b[i]);
  }
  return out;
}

/** The one live shot, or -1. Only valid in tests that keep one shot in the air. */
function shotSlot(w: World): number {
  for (let i = 0; i < w.shots.cap; i++) {
    if (w.shots.alive[i] === 1) return i;
  }
  return -1;
}

/** Straight-line distance from an enemy to a point. */
function dist(w: World, i: number, x: number, y: number): number {
  const dx = w.enemies.x[i] - x;
  const dy = w.enemies.y[i] - y;
  return Math.sqrt(dx * dx + dy * dy);
}

describe('chain lightning wand (chain, energy)', () => {
  it('walks the bolt to bodies it has not hurt yet, and stops after five jumps', () => {
    const w = createWorld(211, { arenaHalf: 40 });
    arm(w, 'chainLightningWand');

    // A ladder down the aim line, 2.5 m between bodies, so every body has a neighbour
    // well inside the 6.5 m jump and the bolt is never short of somewhere to go. Nine
    // bodies against a bolt that can take six is the point: the six that got hurt are
    // the jump count running out, not the pack running out.
    const ladder: number[] = [];
    for (let k = 0; k < 9; k++) ladder.push(place(w, 2 + 2.5 * k, 0, 500));
    for (const i of ladder) stand(w, i);

    run(w, 1, shoot);

    const hits = hitList(w);
    expect(hits).toHaveLength(6); // the body it found plus five jumps
    expect(new Set(hits).size).toBe(6); // and six different bodies, not four twice
    expect(ladder.filter((i) => w.enemies.hp[i] < 500)).toHaveLength(6);
    expect(countAlive(w.enemies)).toBe(9);
  });

  it('starts a second bolt with a clean hit list', () => {
    const w = createWorld(212, { arenaHalf: 40 });
    arm(w, 'chainLightningWand');
    const ladder: number[] = [];
    for (let k = 0; k < 9; k++) ladder.push(place(w, 2 + 2.5 * k, 0, 500));
    for (const i of ladder) stand(w, i);

    // First bolt, then the ring drained so the second one's hits are the only ones
    // counted. The 0.42 s cooldown has passed by the tick the bolt is due again.
    run(w, 25, shoot);
    expect(hitList(w)).toHaveLength(6);
    clearEvents(w);

    run(w, 25, shoot);

    const second = hitList(w);
    expect(second).toHaveLength(6);
    expect(new Set(second).size).toBe(6);
    // Bodies the first bolt already chewed on are still valid targets: the list of
    // "already hurt" belongs to one bolt, not to the weapon for the rest of the run.
    // Without that reset this bolt would find every body used and land nowhere at all.
  });

  it('does not spend charge on a bolt with nobody to chain to', () => {
    const w = createWorld(213, { arenaHalf: 40 });
    arm(w, 'chainLightningWand');
    const slot = w.slots[0];

    // An empty arena and the trigger held down for a second: a bolt needs a body to
    // start from, and a weapon that ate charge for nothing would drain itself dry.
    run(w, 60, shoot);

    expect(countEvents(w, Ev.Shot)).toBe(0);
    expect(slot.energy).toBe(100);
  });

  it('runs on charge: it will not fire what it cannot pay for, and pays again as the cell recovers', () => {
    const w = createWorld(214, { arenaHalf: 40 });
    arm(w, 'chainLightningWand');
    const target = place(w, 5, 0, 500);
    stand(w, target);
    const slot = w.slots[0];

    // Set the hand down one step short of a bolt (10 of 100 against a price of 25) and
    // clear the cooldown, so charge is the only reason not to shoot. A third of a second
    // of holding the trigger buys back 7.3 units — still short.
    slot.energy = 10;
    slot.cooldown = 0;
    clearEvents(w);

    run(w, 20, shoot);

    expect(slot.energy).toBeLessThan(25);
    expect(countEvents(w, Ev.Shot)).toBe(0);

    // A second of the same lifts it back over the price of a bolt, and the wand shoots.
    run(w, 60, shoot);

    expect(countEvents(w, Ev.Shot)).toBeGreaterThan(0);
    expect(slot.energy).toBeLessThan(100); // ... and it paid for them
  });
});

describe('laser lance (beam, heat)', () => {
  it('cuts every tick it can, cooks itself into vent, and cools far enough to cut again', () => {
    const w = createWorld(221, { arenaHalf: 40 });
    arm(w, 'laserLance');
    const body = place(w, 8, 0, 500);
    stand(w, body);
    const slot = w.slots[0];

    // Seven seconds of held trigger, sampling the hand and the target every tick.
    const on: boolean[] = [];
    const health: number[] = [];
    for (let t = 0; t < 420; t++) {
      run(w, 1, shoot);
      on.push(slot.beam > 0);
      health.push(w.enemies.hp[body]);
    }

    // Four seconds of beam is what cooked it: long enough that a gauge which merely
    // trickled heat would never have locked, short enough that it locked well before
    // the run ended and had time to prove it came back.
    const vented = on.indexOf(false);
    expect(vented).toBeGreaterThan(200);
    expect(vented).toBeLessThan(260);

    let gap = 0;
    while (vented + gap < on.length && !on[vented + gap]) gap++;
    expect(gap).toBeGreaterThan(60);
    expect(on[on.length - 1]).toBe(true);

    // The gap is dead air, not a weaker beam: nothing touched the body while the barrel
    // was venting, and it started taking damage again the moment the hand was cold.
    const atVent = health[vented];
    expect(health[vented + gap - 1]).toBe(atVent);
    expect(health[health.length - 1]).toBeLessThan(atVent);
  });

  it('cuts four bodies on the line at once, and stops at the fifth', () => {
    const w = createWorld(222, { arenaHalf: 40 });
    const def = arm(w, 'laserLance');
    const line: number[] = [];
    for (let k = 0; k < 6; k++) line.push(place(w, 3 + k * 1.5, 0, 500));
    for (const i of line) stand(w, i);

    // One tick is enough: a beam resolves every tick, so this is asking how many bodies
    // one tick of it reaches, and the answer is the def's pierce plus the first body.
    run(w, 1, shoot);

    expect(def.pierce).toBe(3);
    const hits = hitList(w);
    expect(hits).toHaveLength(4);
    expect(new Set(hits).size).toBe(4);
    expect(line.filter((i) => w.enemies.hp[i] < 500)).toHaveLength(4);
  });
});

describe('plasma repeater (projectile, heat)', () => {
  it('runs on a heat gauge instead of a magazine: it vents, and it never reloads', () => {
    const w = createWorld(223, { arenaHalf: 40 });
    const def = arm(w, 'plasmaRepeater');
    const body = place(w, 8, 0, 500);
    stand(w, body);
    const slot = w.slots[0];

    expect(def.ammo).toBeUndefined();

    let vented = false;
    let shotsAfterVent = 0;
    for (let t = 0; t < 420; t++) {
      const before = countEvents(w, Ev.Shot);
      run(w, 1, shoot);
      const made = countEvents(w, Ev.Shot) - before;
      if (slot.venting) vented = true;
      else if (vented) shotsAfterVent += made;
    }

    expect(vented).toBe(true);
    expect(shotsAfterVent).toBeGreaterThan(0); // it came back on its own
    expect(slot.reload).toBe(0); // there was never a magazine to hand
    expect(slot.ammo).toBe(0); // and no magazine to drain into that zero
    expect(slot.energy).toBe(0); // nor a charge cell
    expect(countEvents(w, Ev.Shot)).toBeGreaterThan(30);
    expect(w.enemies.hp[body]).toBeLessThan(500);
  });
});

describe('burn, from the longbow fire arrow', () => {
  it('keeps taking damage after the shaft is gone, and stops when the burn runs out', () => {
    const w = createWorld(231, { arenaHalf: 40 });
    arm(w, 'longbow');
    const body = place(w, 12, 0, 500);
    stand(w, body);

    // One shaft only: a held draw is loosed the moment the button comes up, so 25 ticks
    // of trigger is one arrow.
    run(w, 25, shoot);

    // Then forty ticks of nobody firing, and the books are only read once the arrow is
    // gone. It carries two pass-throughs and 40 m of range against one body standing 12 m
    // out, so it flies on past the body it hit and gives its slot back somewhere further
    // still — waiting for the pool to empty is what makes "everything the body loses next
    // is the burn" a fact rather than a hope. The shaft lands at about t=7 and is gone by
    // t=28; the single `Hit` is its, and the burn writes none.
    let landed = -1;
    for (let t = 0; t < 40; t++) {
      const before = w.enemies.hp[body];
      run(w, 1);
      if (landed < 0 && w.enemies.hp[body] < before) landed = t;
    }

    expect(landed).toBeGreaterThanOrEqual(0);
    expect(countAlive(w.shots)).toBe(0); // no shaft left to blame
    expect(countEvents(w, Ev.Hit)).toBe(1); // ... and the one it made is already spent
    expect(w.enemies.dotT[body]).toBeGreaterThan(0);
    expect(w.enemies.dotDps[body]).toBe(16);
    expect(w.enemies.hp[body]).toBeLessThan(500 - 40); // the shaft itself bit harder

    // What the body loses next is what the burn clock still owes it — 16 a second over
    // the 1.97 s left on the timer — paid out over seconds and then stopped stone dead.
    // The band is the discrete timer: the tick that ends a burn still pays a full 1/60 s.
    const atImpact = w.enemies.hp[body];
    const owed = w.enemies.dotT[body] * 16;
    run(w, 200);
    const bled = atImpact - w.enemies.hp[body];
    expect(bled).toBeGreaterThan(owed - 0.1);
    expect(bled).toBeLessThan(owed + 0.5);

    expect(w.enemies.dotT[body]).toBe(0);
    const settled = w.enemies.hp[body];
    run(w, 60);
    expect(w.enemies.hp[body]).toBe(settled); // and it stays stopped
  });

  it('leaves one burn channel per body, so a second arrow renews it instead of doubling it', () => {
    const w = createWorld(232, { arenaHalf: 40 });
    arm(w, 'longbow');
    const body = place(w, 12, 0, 500);
    stand(w, body);

    // Trigger held: the bow looses at a full draw, redraws, and lands three shafts, each
    // of which re-applies the burn to a body that is still burning.
    run(w, 120, shoot);

    expect(w.enemies.dotDps[body]).toBe(16); // one channel, never two
    expect(w.enemies.dotT[body]).toBeGreaterThan(0);

    // Settle first. Bringing the button up looses the draw the bow was still holding, and
    // a shaft from the last full draw is still in the air, so the first half-second is
    // shafts rather than burn — measure across it and the number is a mix of both. Wait
    // it out, then check there is still more than a second of burn on the clock, which is
    // what makes the window below a measurement of a burn and nothing else.
    run(w, 50);
    expect(countAlive(w.shots)).toBe(0);
    expect(w.enemies.dotT[body]).toBeGreaterThan(1);

    // And the rate stayed one burn's worth. 16 damage over the second, where two stacks
    // would be 32 and no DoT at all would be nothing.
    const before = w.enemies.hp[body];
    run(w, 60);
    const bled = before - w.enemies.hp[body];
    expect(bled).toBeGreaterThan(15);
    expect(bled).toBeLessThan(17);
  });
});

describe('singularity gun (orb, energy)', () => {
  it('drags every body inside its radius toward itself, then pops them', () => {
    const w = createWorld(241, { arenaHalf: 40 });
    const def = arm(w, 'singularityGun');

    // Three bodies 2.4 m off the aim line — inside the 3.2 m vacuum, and frozen, so the
    // only thing that can move them is the orb. A body that is merely stood there gets
    // no closer than 2.4 m to a rock flying past it, and never leaves its line.
    const ring = [place(w, 7.5, 2.4, 500), place(w, 9, -2.4, 500), place(w, 10.5, 2.4, 500)];
    for (const i of ring) stand(w, i);
    const offsets = ring.map((i) => Math.abs(w.enemies.y[i]));

    const pulled = [false, false, false];
    const drawnIn = [false, false, false];

    // One orb, then the whole 1.3 s of its drift with the trigger off the button.
    for (let t = 0; t < 90; t++) {
      run(w, 1, t === 0 ? shoot : undefined);
      const orb = shotSlot(w);
      if (orb < 0) continue;
      for (let k = 0; k < ring.length; k++) {
        if (Math.abs(w.enemies.y[ring[k]]) < offsets[k] - 0.8) pulled[k] = true;
        if (dist(w, ring[k], w.shots.x[orb], w.shots.y[orb]) < 1.8) drawnIn[k] = true;
      }
    }

    expect(def.aoe).toBe(3.2);
    expect(pulled).toEqual([true, true, true]);
    expect(drawnIn).toEqual([true, true, true]);

    // And it detonated where it stopped: one explosion event carrying its own radius,
    // and every body it gathered took the burst.
    const boom = findEvent(w, Ev.Explosion);
    expect(boom).toBeGreaterThanOrEqual(0);
    expect(w.events.b[boom]).toBe(32);
    expect(countAlive(w.shots)).toBe(0);
    for (const i of ring) expect(w.enemies.hp[i]).toBeLessThan(500);
  });
});