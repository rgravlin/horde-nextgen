/**
 * Weapons part 1: the fire kinds the slice did not have.
 *
 * Each test pins one behaviour the task asked for, and each one is written so it
 * fails without that behaviour rather than merely reading it: the pellet test counts
 * entities, the pierce test puts a seventh body on the line so "no more than five"
 * has something to reject, the sweep test places bodies at 135° (inside a 300° arc)
 * and at 180° (outside it), the burst test places bodies on both sides of the 3 m
 * radius, and the lead test leaves the crowd running so an aim taken from where it
 * stands has somewhere wrong to land.
 *
 * Geometry tests freeze their targets with `stand`, which leans on the stagger state:
 * a staggering enemy rides the shove it was given instead of steering, and a freshly
 * placed body has no shove, so it stays exactly where the test put it. That is what
 * makes the distance assertions exact — a chaser left to itself would walk 4 m during
 * the catapult's 1.2 s flight and drift across the radius on its own. The lead test is
 * the one that has to leave them moving, because the whole point is where they get to.
 */

import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../../src/content/enemies';
import { WEAPONS, type WeaponDef } from '../../src/content/weapons';
import { createInputFrame, resetFrame, type InputFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { Ev, countAlive, countEvents, createWorld, findEvent, loadSlot, type World } from '../../src/sim/world';

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
  const def = WEAPONS[index];
  loadSlot(w.slots[0], index);
  return def;
}

/** The (damage, speed) of every round still in the air, as one array per round. */
function rounds(w: World): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < w.shots.cap; i++) {
    if (w.shots.alive[i] === 0) continue;
    const vx = w.shots.vx[i];
    const vy = w.shots.vy[i];
    out.push([w.shots.hp[i], Math.sqrt(vx * vx + vy * vy)]);
  }
  return out;
}

/** How far off the +x aim line each live round is pointing, in radians. */
function deflections(w: World): number[] {
  const out: number[] = [];
  for (let i = 0; i < w.shots.cap; i++) {
    if (w.shots.alive[i] === 0) continue;
    const vx = w.shots.vx[i];
    const vy = w.shots.vy[i];
    out.push(Math.asin(Math.max(-1, Math.min(1, vy / Math.sqrt(vx * vx + vy * vy)))));
  }
  return out;
}

describe('weapon data', () => {
  it('carries a family, a mesh and an sfx id, and a delivery path, for every weapon', () => {
    const families = ['guns', 'medieval', 'alien'];
    // Every kind the schema declares has a path now, so a new entry naming one of them
    // shoots. A kind declared without a path would be a gun that silently does not.
    const delivered = ['projectile', 'hitscan', 'beam', 'arc', 'melee', 'chain', 'orb'];

    for (const def of WEAPONS) {
      expect(families, `${def.id} family`).toContain(def.family);
      expect(def.mesh, `${def.id} mesh`).not.toEqual('');
      expect(def.sfx, `${def.id} sfx`).not.toEqual('');
      expect(delivered, `${def.id} fire kind ${def.fire}`).toContain(def.fire);
      expect(def.dmg).toBeGreaterThan(0);
      expect(def.range).toBeGreaterThan(0);
      // Exactly one thing a trigger pull spends. A gun with both a magazine and a
      // charge cell would have to be empty twice before it stopped, and the HUD gauge
      // would show whichever one it happened to read first.
      const spends = [def.ammo, def.heat, def.energy].filter((c) => c !== undefined).length;
      expect(spends, `${def.id} constraint count`).toBe(1);
    }
  });

  it('names every hand in the roster, in the order the table holds them', () => {
    const ids = WEAPONS.map((d) => d.id);
    // Pinned as a list rather than a count: a sixth alien hand is a decision somebody
    // makes here, and a hand that quietly disappears takes its entry in this list with it.
    expect(ids).toEqual([
      'pistol',
      'shotgun',
      'sniper',
      'longbow',
      'flail',
      'catapult',
      'plasmaRepeater',
      'chainLightningWand',
      'laserLance',
      'singularityGun',
      'smg',
      'assaultRifle',
      'lmg',
      'railgun',
      'crossbow',
      'pike',
      'throwingAxes',
      'disruptorOrb',
    ]);

    const byId = (id: string): WeaponDef => WEAPONS[WEAPONS.findIndex((d) => d.id === id)];
    expect(byId('shotgun').pellets).toBe(8);
    expect(byId('sniper').fire).toBe('hitscan');
    expect(byId('sniper').pierce).toBe(4); // four pass-throughs, so five bodies
    expect(byId('longbow').family).toBe('medieval');
    expect(byId('longbow').pierce).toBe(2);
    expect(byId('longbow').dot).toEqual({ dps: 16, seconds: 2.5 });
    expect(byId('flail').fire).toBe('melee');
    expect(byId('catapult').aoe).toBe(3);

    // The alien four: one per family role, and each one's own constraint.
    for (const id of ['plasmaRepeater', 'chainLightningWand', 'laserLance', 'singularityGun']) {
      expect(byId(id).family, id).toBe('alien');
    }
    expect(byId('chainLightningWand').chain).toBe(5);
    expect(byId('singularityGun').fire).toBe('orb');
    expect(byId('singularityGun').pull).toBeGreaterThan(0);

    // The enemy table is pinned the same way the weapon one is, so that adding an archetype
    // is a decision made here rather than a drift. What each behaviour does is pinned in
    // tests/unit/enemies-a.test.ts (melee five), tests/unit/enemies-b.test.ts (ranged trio),
    // tests/unit/enemies-c.test.ts (the two marks) and tests/unit/bosses.test.ts (the three
    // encounters); this only guards the shape of the data. The last three carry `boss`, which
    // takes them out of the wave recipes — an encounter a chapter ends on is not also
    // drumbeat fodder.
    expect(ENEMIES.map((d) => d.id)).toEqual([
      'chaser',
      'swarmling',
      'charger',
      'exploder',
      'splitter',
      'splinter',
      'armored',
      'shooter',
      'grenadier',
      'healer',
      'broodmother',
      'matron',
      'atlas',
      'sniper',
      'orbiter',
    ]);
    expect(ENEMIES.filter((d) => d.boss).map((d) => d.id)).toEqual([
      'broodmother',
      'matron',
      'atlas',
    ]);
    // A boss is allowed to be big; nothing else is, because the hit queries pad for the
    // widest body in the table (HIT_PAD) and a 3 m trash body would widen every shot.
    for (const def of ENEMIES) {
      if (!def.boss) expect(def.radius, def.id).toBeLessThanOrEqual(0.7);
    }
  });
});

describe('shotgun (projectile, pellets)', () => {
  it('puts eight pellets inside the spread cone on one trigger pull', () => {
    const w = createWorld(101);
    const def = arm(w, 'shotgun');

    run(w, 1, shoot);

    expect(countAlive(w.shots)).toBe(8);
    expect(countEvents(w, Ev.Shot)).toBe(8);
    // One shell, eight pellets: the magazine is the volley, not the pellet. The
    // magazine is optional on a def (a heat or charge gun has none), hence the read.
    expect(w.slots[0].ammo).toBe((def.ammo ? def.ammo.mag : 0) - 1);

    const angles = deflections(w);
    expect(angles).toHaveLength(8);
    for (const a of angles) {
      expect(Math.abs(a)).toBeLessThanOrEqual(def.spread + 1e-9);
    }
    // Inside the cone is only interesting if the cone is wide: eight identical
    // lines would pass the loop above. Half the cone is 0.1 rad, and a real volley
    // scatters well past it.
    let wide = 0;
    for (const a of angles) if (Math.abs(a) > 0.1) wide++;
    expect(wide).toBeGreaterThanOrEqual(2);
  });

  it('keeps the cone inside its spread across seeds', () => {
    const def = WEAPONS[1];
    for (const seed of [7, 202, 4242]) {
      const w = createWorld(seed);
      arm(w, 'shotgun');
      run(w, 1, shoot);
      const angles = deflections(w);
      expect(angles).toHaveLength(8);
      for (const a of angles) expect(Math.abs(a)).toBeLessThanOrEqual(def.spread + 1e-9);
    }
  });

  it('retires every pellet once its range is flown', () => {
    const w = createWorld(103);
    arm(w, 'shotgun');

    run(w, 45, shoot);

    // 22 m of range at 30 m/s is 0.73 s, so by the 45th tick the air is clear.
    // 45 is just under the gun's next volley (0.77 s), so this counts one shell
    // spent rather than two volleys overlapping — and the magazine lost one shell,
    // not eight, because the magazine counts volleys.
    expect(countAlive(w.shots)).toBe(0);
    expect(w.slots[0].ammo).toBe(5);
  });
});

describe('sniper (hitscan)', () => {
  it('hits five bodies standing on one line and no more', () => {
    const w = createWorld(104, { arenaHalf: 40 });
    arm(w, 'sniper');

    // Seven bodies 2 m apart, all tougher than anything the ray can kill in one
    // pass, so the number hurt is the pierce budget rather than a body count.
    const line = [4, 6, 8, 10, 12, 14, 16].map((x) => place(w, x, 0, 500));

    run(w, 2, shoot);

    const hurt = line.filter((i) => w.enemies.hp[i] < 500);
    expect(hurt).toHaveLength(5);
    expect(countEvents(w, Ev.Hit)).toBe(5);
    // The five nearest: the ray walks outward and stops when its budget is gone.
    expect(line.slice(5).every((i) => w.enemies.hp[i] === 500)).toBe(true);
    // And it never became a projectile: a ray is resolved the tick it is fired.
    expect(countAlive(w.shots)).toBe(0);
  });

  it('spends one ray per trigger pull, not one per tick', () => {
    const w = createWorld(105, { arenaHalf: 40 });
    arm(w, 'sniper');
    place(w, 8, 0, 2000);

    run(w, 60, shoot);

    // 0.75 shots/s: a whole second of held trigger is one shot and 95 damage, not
    // sixty. The pool stays empty because a ray is never a projectile, and the
    // target survives because 2000 hp is more than one ray can remove.
    expect(countEvents(w, Ev.Shot)).toBe(1);
    expect(countEvents(w, Ev.Hit)).toBe(1);
    expect(w.enemies.hp[0]).toBeCloseTo(2000 - 95, 6);
    expect(countAlive(w.shots)).toBe(0);
  });
});

describe('longbow (charged projectile)', () => {
  it('flies a full draw faster and harder than a tapped one', () => {
    const held = createWorld(107, { arenaHalf: 40 });
    arm(held, 'longbow');
    run(held, 45, shoot);

    const tapped = createWorld(108, { arenaHalf: 40 });
    arm(tapped, 'longbow');
    run(tapped, 3, shoot);
    run(tapped, 1); // the trigger comes up: the draw is loosed where it stands

    const full = rounds(held);
    const loose = rounds(tapped);
    expect(full).toHaveLength(1);
    expect(loose).toHaveLength(1);

    expect(full[0][0]).toBeGreaterThan(loose[0][0] * 1.4);
    expect(full[0][1]).toBeGreaterThan(loose[0][1] + 20);
  });

  it('takes three bodies off a line, one for itself and two pierced', () => {
    const w = createWorld(109, { arenaHalf: 40 });
    arm(w, 'longbow');
    const line = [8, 9.5, 11, 13, 20].map((x) => place(w, x, 0, 500));
    for (const i of line) stand(w, i);

    run(w, 40, shoot);

    expect(countEvents(w, Ev.Hit)).toBe(3);
    expect(line.slice(3).every((i) => w.enemies.hp[i] === 500)).toBe(true);
  });
});

describe('flail (melee sweep)', () => {
  it('clips everything inside the 300° arc and nothing in the notch behind', () => {
    const w = createWorld(110);
    arm(w, 'flail');

    // Aim is +x. Inside the arc: dead ahead, 45° to the side, and 135° back to the
    // side. Outside it: straight downrange out of reach, and dead astern.
    const front = place(w, 2.5, 0, 500);
    const quarter = place(w, 1.5, 1.5, 500);
    const backQuarter = place(w, -1.5, 1.5, 500);
    const astern = place(w, -2.5, 0, 500);
    const outOfReach = place(w, 0, 5, 500);

    run(w, 2, shoot);

    expect([front, quarter, backQuarter].every((i) => w.enemies.hp[i] < 500)).toBe(true);
    expect(w.enemies.hp[astern]).toBe(500);
    expect(w.enemies.hp[outOfReach]).toBe(500);
    expect(countEvents(w, Ev.Hit)).toBe(3);
    // A sweep that reaches nothing behind still cannot be hurt from behind for free:
    // the chaser is 2.5 m away and contact needs 1.15 m.
    expect(w.player.hp).toBe(100);
  });

  it('shoves what it hits away from the player', () => {
    const w = createWorld(111);
    arm(w, 'flail');
    const victim = place(w, 2, 0, 500);

    run(w, 1, shoot);

    expect(w.enemies.state[victim]).toBe(3); // staggered, so the shove is being ridden
    expect(w.enemies.vx[victim]).toBeCloseTo(9, 6); // the flail's full shove, straight back
    expect(w.enemies.vy[victim]).toBe(0);
  });
});

describe('catapult (arc and burst)', () => {
  it('damages every body inside the 3 m radius at the landing point and none outside', () => {
    const w = createWorld(112, { arenaHalf: 40 });
    arm(w, 'catapult');

    // The shell is lobbed 18 m down the +x aim line. Inside the burst: four bodies
    // between 0.6 m and 2.2 m from the landing point. Outside: three at 4.9 m and
    // farther, one of which the shell flies straight over.
    const inside = [
      [17.5, 0],
      [18.5, 1.2],
      [18.8, -1.5],
      [17.2, -2],
    ].map(([x, y]) => {
      const i = place(w, x, y, 500);
      stand(w, i);
      return i;
    });
    const outside = [
      [23, 0],
      [18, 5],
      [13, 0],
    ].map(([x, y]) => {
      const i = place(w, x, y, 500);
      stand(w, i);
      return i;
    });

    run(w, 1, shoot);
    run(w, 71);

    const slot = findEvent(w, Ev.Explosion);
    expect(slot).toBeGreaterThan(-1);
    const bx = w.events.x[slot];
    const by = w.events.y[slot];
    // It landed at the aim point, not at the first body it passed.
    expect(bx).toBeGreaterThan(17);
    expect(bx).toBeLessThan(18.6);
    expect(by).toBeCloseTo(0, 6);

    for (const i of inside) expect(w.enemies.hp[i]).toBeLessThan(500);
    for (const i of outside) expect(w.enemies.hp[i]).toBe(500);
    expect(w.kills).toBe(0);
  });

  it('carries no hit budget while it flies', () => {
    const w = createWorld(113, { arenaHalf: 40 });
    arm(w, 'catapult');
    const under = place(w, 6, 0, 500);
    stand(w, under);

    run(w, 40, shoot);

    // 40 ticks is 0.67 s of the shell's 1.16 s flight: it is still airborne and has
    // hurt nothing on the way, which is the cost of aiming a burst weapon.
    expect(countAlive(w.shots)).toBe(1);
    expect(w.enemies.hp[under]).toBe(500);
    expect(countEvents(w, Ev.Hit)).toBe(0);
  });

  it('leads a running pack when auto-fire owns the aim', () => {
    const w = createWorld(116, { arenaHalf: 40 });
    arm(w, 'catapult');
    w.autoFire = true;

    // Six bodies closing in from 10 m with nobody holding the trigger, so auto-fire
    // picks the aim. It has to aim where they will be when the shell lands: a burst
    // aimed at their feet flies the full 18 m and arrives behind a pack that left
    // that ground half a second earlier, which would leave the only area weapon in
    // the game unable to hurt anything in a live run.
    const pack: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      pack.push(place(w, Math.cos(a) * 10, Math.sin(a) * 10, 500));
    }

    run(w, 240);

    expect(countEvents(w, Ev.Explosion)).toBeGreaterThan(0);
    expect(pack.every((i) => w.enemies.hp[i] < 500)).toBe(true);
    expect(w.player.alive).toBe(true);
  });
});

describe('falloff', () => {
  it('reduces damage at range on the same weapon and the same aim', () => {
    const shotAt = (distance: number): number => {
      const w = createWorld(114, { arenaHalf: 40 });
      const victim = place(w, distance, 0, 500);
      arm(w, 'sniper');
      run(w, 1, shoot);
      return 500 - w.enemies.hp[victim];
    };

    const near = shotAt(5); // inside the 14 m full-damage band
    const far = shotAt(30); // past the ramp, which is 55% of the way to 40 m

    expect(near).toBeCloseTo(95, 6);
    expect(far).toBeLessThan(70);
    expect(far).toBeLessThan(near * 0.75);
  });

  it('keeps the multiplier flat past the end of the ramp', () => {
    const shotAt = (distance: number): number => {
      const w = createWorld(115, { arenaHalf: 40 });
      const victim = place(w, distance, 0, 500);
      arm(w, 'sniper');
      run(w, 1, shoot);
      return 500 - w.enemies.hp[victim];
    };

    // 45 m and 55 m are both past the 40 m end of the ramp, so the same multiplier
    // has to reach both — a falloff that kept sliding would be a weapon that quietly
    // stops working at the far edge of its range.
    const at45 = shotAt(45);
    const at55 = shotAt(55);
    expect(at45).toBeLessThan(95);
    expect(at55).toBeCloseTo(at45, 6);
  });
});