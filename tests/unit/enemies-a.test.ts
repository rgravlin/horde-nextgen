import { describe, expect, it } from 'vitest';
import { ENEMIES, enemyIndex } from '../../src/content/enemies';
import { WEAPONS } from '../../src/content/weapons';
import { createInputFrame, resetFrame, type InputFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { killEnemy, spawnEnemy } from '../../src/sim/systems/enemies';
import {
  DT,
  Ev,
  Tele,
  TUNE,
  clearEvents,
  countAlive,
  countEvents,
  createWorld,
  findEvent,
  type World,
} from '../../src/sim/world';

/**
 * The five behaviours added on top of the chaser, checked as behaviour.
 *
 * Each one is read out of the running tick rather than out of a helper's return value,
 * because that is what these five actually are: a state machine in `phase` and `timer`
 * that changes how a body moves and what it pays out when it dies. The chaser's own
 * behaviour is pinned in `combat.test.ts`; this file is about the four that are not a
 * plain walk, plus the armour that decides how much of a hit a body has to swallow.
 *
 * Several tests step one tick at a time with the event ring cleared first. The ring is a
 * ring, so a scan over it cannot tell "the tell that started this tick" from "the tell
 * that started nine ticks ago" without that, and the difference between those two is the
 * whole content of the charger's test.
 */

/** Put one archetype down by id, with the HP the fight needs rather than the default. */
function place(w: World, id: string, x: number, y: number, hp?: number): number {
  const i = spawnEnemy(w, enemyIndex(id), x, y);
  if (hp !== undefined) w.enemies.hp[i] = hp;
  return i;
}

/**
 * Run ticks on a reused frame, ring cleared before each.
 *
 * `fill` refills the same frame the way the sampler refills its scratch, so a test that
 * needs a held key gets one without allocating a frame per tick.
 */
function run(w: World, ticks: number, fill?: (f: InputFrame) => void): void {
  const f = createInputFrame();
  for (let t = 0; t < ticks; t++) {
    resetFrame(f);
    if (fill) fill(f);
    step(w, f);
  }
}

/** First Telegraph event of shape `kind` written since the ring was last cleared. */
function firstTelegraph(w: World, kind: number): number {
  const e = w.events;
  for (let k = 0; k < e.count; k++) {
    const slot = (e.head - e.count + k + e.cap * 2) % e.cap;
    if (e.type[slot] === Ev.Telegraph && e.b[slot] === kind) return slot;
  }
  return -1;
}

/** The speed a body is actually carrying, which is what a race measures. */
function speed(w: World, i: number): number {
  return Math.hypot(w.enemies.vx[i], w.enemies.vy[i]);
}

describe('swarmling', () => {
  it('is faster than a chaser, and does not run at you in a straight line', () => {
    /** One body, 20 m out, 200 ticks of chase — long enough to tell 4.6 from 3.4 m/s. */
    function race(id: string): { closed: number; top: number; weave: number; cross: number } {
      const w = createWorld(31, { arenaHalf: 40 });
      const i = place(w, id, 20, 0);
      const start = Math.hypot(w.enemies.x[i], w.enemies.y[i]);
      let top = 0;
      let weave = 0;
      let cross = 0;
      let side = 0;

      const f = createInputFrame();
      for (let t = 0; t < 200; t++) {
        resetFrame(f);
        step(w, f);
        const sp = speed(w, i);
        if (sp > top) top = sp;
        const dev = w.enemies.y[i];
        if (Math.abs(dev) > weave) weave = Math.abs(dev);
        const s = dev > 0 ? 1 : dev < 0 ? -1 : 0;
        if (s !== 0 && side !== 0 && s !== side) cross++;
        if (s !== 0) side = s;
      }

      // The player never moved and nothing shot, so the only variable is the gait.
      return { closed: start - Math.hypot(w.enemies.x[i], w.enemies.y[i]), top, weave, cross };
    }

    const chaser = race('chaser');
    const swarm = race('swarmling');

    expect(swarm.top).toBeGreaterThan(chaser.top);
    expect(swarm.closed).toBeGreaterThan(chaser.closed);

    // The weave is the reason a cloud of twenty is not one lane: the chaser's lateral
    // deviation from the direct line is exactly zero, the swarmling's crosses that line
    // dozens of times while it still closes.
    expect(chaser.weave).toBeCloseTo(0, 10);
    expect(swarm.cross).toBeGreaterThan(10);

    // And it is data, not a tuned constant in the behaviour: what the two bodies race at
    // is what the table says they run at (AGENTS.md: content is data in one place).
    expect(ENEMIES[enemyIndex('swarmling')].speed).toBeGreaterThan(ENEMIES[enemyIndex('chaser')].speed);
    expect(swarm.top).toBeCloseTo(ENEMIES[enemyIndex('swarmling')].speed, 6);
  });
});

describe('charger', () => {
  it('emits its telegraph at least 24 ticks before the dash velocity begins', () => {
    const w = createWorld(32, { arenaHalf: 40 });
    const def = ENEMIES[enemyIndex('charger')];
    const charger = place(w, 'charger', 6, 4);
    const f = createInputFrame();

    let tellTick = -1;
    let dashTick = -1;
    let tell: { shape: number; x: number; y: number; fx: number; fy: number; timer: number } | undefined;

    for (let t = 1; t <= 120 && dashTick < 0; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);

      if (tellTick < 0) {
        const slot = firstTelegraph(w, Tele.Line);
        if (slot >= 0) {
          tellTick = t;
          // Everything a charge line needs: which body, which shape, where it stands,
          // where it points and how much wind-up is left to fill.
          tell = {
            shape: w.events.b[slot],
            x: w.events.x[slot],
            y: w.events.y[slot],
            fx: w.enemies.fx[charger],
            fy: w.enemies.fy[charger],
            timer: w.enemies.timer[charger],
          };
        }
      }
      if (speed(w, charger) > def.params.dashSpeed / 2) dashTick = t;
    }

    expect(tellTick).toBeGreaterThan(0);
    expect(dashTick).toBeGreaterThan(0);

    // DESIGN.md sets 400 ms as the floor for any wind-up a player is asked to answer, and
    // 24 ticks is that floor. The wind-up is 0.5 s, so there are 31 ticks of it here.
    expect(dashTick - tellTick).toBeGreaterThanOrEqual(24);
    expect((dashTick - tellTick) * DT).toBeGreaterThanOrEqual(0.4);

    // The tell is not decoration: it names the body and carries a shape id, and the
    // two numbers the renderer still needs are in the pool at that moment — a unit
    // facing and the seconds left in the wind-up, which is how a line "fills up".
    // Six decimals rather than ten because the facing lives in a Float32Array, and
    // float32's own epsilon is about 1.2e-7.
    expect(tell!.shape).toBe(Tele.Line);
    expect(Math.hypot(tell!.fx, tell!.fy)).toBeCloseTo(1, 6);
    expect(tell!.timer).toBeCloseTo(def.params.windup, 10);
    expect(tell!.x).toBeCloseTo(6, 6);
    expect(tell!.y).toBeCloseTo(4, 6);
  });

  it('dashes down the line it locked, so a player who steps aside is not hit', () => {
    const w = createWorld(33, { arenaHalf: 40 });
    const charger = place(w, 'charger', 6, 4);
    const f = createInputFrame();

    let locked = false;
    let lockX = 0;
    let lockY = 0;
    let dashX = 0;
    let dashY = 0;

    for (let t = 1; t <= 120; t++) {
      resetFrame(f);
      // Sidestepping for the whole charge, which is what the telegraph is there to allow.
      f.moveY = 1;
      clearEvents(w);
      step(w, f);

      if (!locked) {
        const slot = firstTelegraph(w, Tele.Line);
        if (slot >= 0) {
          locked = true;
          lockX = w.enemies.fx[charger];
          lockY = w.enemies.fy[charger];
        }
      }
      const sp = speed(w, charger);
      if (dashX === 0 && dashY === 0 && sp > 6) {
        dashX = w.enemies.vx[charger] / sp;
        dashY = w.enemies.vy[charger] / sp;
      }
    }

    expect(locked).toBe(true);
    expect(dashX).not.toBe(0);

    // Same line, 31 ticks later. A charge that steered around the crowd would be a
    // homing missile, so this equality is the monster's whole identity. Tolerance is
    // float32's, since the dash divides the stored facing back out.
    expect(dashX).toBeCloseTo(lockX, 6);
    expect(dashY).toBeCloseTo(lockY, 6);

    // And the dodge works: it spent its charge on the floor the player left behind.
    expect(w.player.hp).toBe(w.player.maxHp);
    expect(w.over).toBe(false);
  });
});

describe('exploder', () => {
  it('fuses for half a second and bursts the player inside the radius', () => {
    const w = createWorld(34, { arenaHalf: 40 });
    const def = ENEMIES[enemyIndex('exploder')];
    const bomb = place(w, 'exploder', 3.5, 0);
    const f = createInputFrame();

    let fuseTick = -1;
    let burstTick = -1;
    let burstReach = 0;
    let burstShape = 0;

    for (let t = 1; t <= 60 && burstTick < 0; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);

      if (fuseTick < 0 && firstTelegraph(w, Tele.Ring) >= 0) fuseTick = t;
      const boom = findEvent(w, Ev.Explosion);
      if (boom >= 0) {
        burstTick = t;
        burstShape = w.events.b[boom];
        burstReach = Math.hypot(w.player.x - w.events.x[boom], w.player.y - w.events.y[boom]);
      }
    }

    // It armed itself at 3.5 m, inside its 3.6 m arm range, and cooked for the full fuse.
    expect(fuseTick).toBe(1);
    expect(burstTick).toBeGreaterThan(0);
    expect(burstTick - fuseTick).toBeGreaterThanOrEqual(24);
    expect(burstShape).toBe(Math.round(def.params.blastRadius * 10));
    expect(w.enemies.alive[bomb]).toBe(0);

    // The burst is what hurt the player, not the hug: it went off further away than a
    // contact reach, so the 26 is area damage arriving through the i-frame gate once.
    const touch = TUNE.playerRadius + def.radius + def.params.touchRange;
    expect(burstReach).toBeGreaterThan(touch);
    expect(burstReach).toBeLessThanOrEqual(def.params.blastRadius + TUNE.playerRadius);
    expect(w.player.hp).toBe(w.player.maxHp - def.params.blastDamage);
  });

  it('pays its blast out on death too, at the place it died and to whoever is standing there', () => {
    const w = createWorld(35, { arenaHalf: 40 });
    const def = ENEMIES[enemyIndex('exploder')];
    const bomb = place(w, 'exploder', 6, 0, 1);
    // 1.2 m off the firing line, so no round can reach it: anything it loses came out of
    // the burst. The player is 6 m away, outside the 3.2 m radius.
    const bystander = place(w, 'chaser', 6, 1.2, 500);

    let hurt = 500;
    const f = createInputFrame();
    for (let t = 1; t <= 60; t++) {
      resetFrame(f);
      f.fire = true;
      step(w, f);
      if (w.enemies.alive[bomb] === 0) {
        hurt = w.enemies.hp[bystander];
        break;
      }
    }

    expect(w.kills).toBe(1); // the bomb died to a round; the bystander survived its blast
    expect(hurt).toBe(500 - def.params.blastDamage);
    expect(w.player.hp).toBe(w.player.maxHp);
  });

  it('chain-reacts through a cluster of bombers and spends the whole stack in one tick', () => {
    const w = createWorld(36, { arenaHalf: 40 });
    const trio = [place(w, 'exploder', 20, 20), place(w, 'exploder', 21.5, 20), place(w, 'exploder', 20, 21.5)];

    killEnemy(w, trio[0]);
    expect(w.blasts.count).toBe(1); // queued by the kill, not spent inside it

    step(w, createInputFrame());

    // One bomb went and the other two went with it, and the stack came back empty rather
    // than recursing down into itself: the resolver spent its child, then its grandchild.
    expect(trio.map((i) => w.enemies.alive[i])).toEqual([0, 0, 0]);
    expect(w.kills).toBe(3);
    expect(w.blasts.count).toBe(0);
    expect(w.blasts.dropped).toBe(0);
  });
});

describe('splitter', () => {
  it('leaves three splinters where it stood, so killing one makes the crowd bigger', () => {
    const w = createWorld(37, { arenaHalf: 40 });
    const def = ENEMIES[enemyIndex('splitter')];
    expect(def.splits).toBeDefined();

    const parent = place(w, 'splitter', 5, 0, 1);
    let born = -1;
    let died = -1;
    let deadX = 0;
    let deadY = 0;

    const f = createInputFrame();
    for (let t = 1; t <= 60; t++) {
      resetFrame(f);
      f.fire = true;
      step(w, f);
      if (w.enemies.alive[parent] === 0) {
        // Stopped on the death tick rather than run out: the pistol would have shot the
        // three children down as well, and "the crowd grew" has to be read while they
        // are still in it.
        died = t;
        born = countAlive(w.enemies);
        deadX = w.enemies.x[parent];
        deadY = w.enemies.y[parent];
        break;
      }
    }

    expect(died).toBeGreaterThan(0);
    // One body gave its slot back and three took one, so the horde grew by two from the
    // death. That is the cost of the mechanic and the reason to kill it away from the pack.
    expect(born).toBeGreaterThan(1);
    expect(born).toBe(def.splits!.count);

    const children: number[] = [];
    for (let i = 0; i < w.enemies.cap; i++) {
      if (w.enemies.alive[i] === 1) children.push(i);
    }

    // Out of the pool, whole, and of the child archetype the table names rather than
    // whatever row happens to sit next to the splitter. They are put down around the body
    // rather than inside it, which is why a splitter killed in the open is a different
    // situation from one killed with its back to a wall.
    const childDef = ENEMIES[enemyIndex(def.splits!.def)];
    const edge = def.radius + childDef.radius;
    expect(children).toHaveLength(def.splits!.count);
    for (const i of children) {
      expect(w.enemies.kind[i]).toBe(enemyIndex(def.splits!.def));
      expect(w.enemies.hp[i]).toBe(childDef.hp);
      const d = Math.hypot(w.enemies.x[i] - deadX, w.enemies.y[i] - deadY);
      expect(d).toBeGreaterThan(edge); // clear of the body it came out of, not stacked in it
      expect(d).toBeLessThan(1.5); // and still at the place it died
    }

    // A splinter leaves nothing behind, so a run cannot cascade into an infinite crowd.
    const before = countAlive(w.enemies);
    killEnemy(w, children[0]);
    expect(countAlive(w.enemies)).toBe(before - 1);
  });
});

describe('armored', () => {
  /** One armored at 3 m, held at a fixed facing, taking one pistol round down the x axis. */
  function hit(seed: number, id: string, fx: number, fy: number): number {
    const w = createWorld(seed, { arenaHalf: 40 });
    const i = place(w, id, 3, 0, 500);
    w.enemies.fx[i] = fx;
    w.enemies.fy[i] = fy;
    run(w, 5, (f) => {
      f.fire = true;
      f.aimX = 1;
    });
    expect(countEvents(w, Ev.Hit)).toBe(1);
    return 500 - w.enemies.hp[i];
  }

  it('halves the damage of a hit inside its facing cone and eats the full number from behind', () => {
    const pistol = WEAPONS[0];
    const armored = ENEMIES[enemyIndex('armored')];
    expect(pistol.dmg).toBe(14);
    expect(armored.params.armorArc).toBeGreaterThan(0);
    expect(armored.params.armorSide).toBe(0);

    const frontal = hit(41, 'armored', -1, 0); // looking down the barrel
    const behind = hit(42, 'armored', 1, 0); // turned away from it
    const flank = hit(43, 'armored', 0, 1); // broadside to it

    expect(behind).toBe(pistol.dmg); // no plate outside the arc
    expect(flank).toBe(pistol.dmg);
    expect(frontal).toBe(pistol.dmg - armored.armor);
    expect(frontal * 2).toBe(behind);
  });

  it('keeps a flat plate for a body that declares no facing arc', () => {
    const pistol = WEAPONS[0];
    const splitter = ENEMIES[enemyIndex('splitter')];
    expect(splitter.armor).toBeGreaterThan(0);
    expect(splitter.params.armorArc).toBeUndefined();

    // The two defaults in `armorAgainst` fold back to the flat number: a body that names
    // no arc and no side value is armoured the same way from every direction, so the
    // directional read is an opt-in the armored is the only one to make.
    expect(hit(44, 'splitter', -1, 0)).toBe(pistol.dmg - splitter.armor);
    expect(hit(45, 'splitter', 0, 1)).toBe(pistol.dmg - splitter.armor);
    expect(hit(46, 'splitter', 1, 0)).toBe(pistol.dmg - splitter.armor);
  });
});