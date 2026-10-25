import { describe, expect, it } from 'vitest';
import { ENEMIES, enemyIndex } from '../../src/content/enemies';
import { LEVELS } from '../../src/content/levels';
import { WEAPONS } from '../../src/content/weapons';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { MIN_THICK, PropKind, ZoneKind, acidAt, blocked, canTravel, installLayout, installZones, pointBlocked, pushOut, pushedX, pushedY } from '../../src/sim/systems/obstacles';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { Phase, bossesAlive, startChapter } from '../../src/sim/systems/levels';
import { Ev, Tele, TUNE, clearEvents, countAlive, countEvents, createWorld, findEvent, loadSlot, type World } from '../../src/sim/world';
import { ShotKind, launchBolt, lobGrenade } from '../../src/sim/systems/enemyProjectiles';

/**
 * The floor: cover that stops bodies and rounds, and the two hazards that hurt for
 * standing still.
 *
 * Everything here is driven through `step()`, because that is the only place the geometry
 * can be proved. A layout that `installLayout` accepts and `blocked` answers correctly for
 * in isolation is not yet a layout the game feels: what matters is that a held movement key
 * run into a wall leaves the player on this side of it, that a chaser pressed against cover
 * stays on its side, that a round retires at a crate rather than passing through it, and
 * that a pool costs HP. Those are the four facts the geometry is for, and each is written
 * below against a control run on the same seed with an empty floor — without the control, a
 * test that passes because nothing ever moved would look identical to one that passes
 * because the wall worked.
 *
 * The chapter arc (which chapter ends on which encounter, and the door the bosses arrive
 * through) is pinned here too, since the encounter and the floor are installed by the same
 * call and a chapter that never loads its floor never reaches its boss either.
 */

/** A wall as a layout would author it: centre and full size. */
function wall(x: number, y: number, w: number, h: number) {
  return { kind: PropKind.Wall, x, y, w, h };
}

/** A column: the same problem as a wall with the corners cut off, which is the other half
 *  of the collision code (`near`) and the shape chapter 1 and chapter 6 are built out of. */
function pillar(x: number, y: number, r = 1.5) {
  return { kind: PropKind.Pillar, x, y, w: r * 2, h: r * 2, r };
}

/** A crate: square cover, authored the way the layouts write it. */
function crate(x: number, y: number, s = 2) {
  return { kind: PropKind.Crate, x, y, w: s, h: s };
}

/**
 * Put a floor under a test world and switch the chapter arc on.
 *
 * The arc matters: a hazard is paid out by `updateLevels`, and that pass only runs while
 * a chapter is in progress — a fresh World has no floor by design, so a test that installs
 * geometry by hand has to say it is mid-chapter or the floor is scenery. Real runs get
 * this from `startChapter`, which installs a chapter's layout and hazards together.
 */
function withFloor(w: World, boxes: Parameters<typeof installLayout>[1], zones: Parameters<typeof installZones>[1]): World {
  installLayout(w, boxes);
  installZones(w, zones);
  w.wave.phase = Phase.Script;
  return w;
}

/** Whether a body of radius `r` overlaps any installed cover at (x, y). */
function inCover(w: World, x: number, y: number, r: number): boolean {
  return blocked(w.props, x, y, x, y, r);
}

/** Pin a body in stagger so it stays where the test put it. */
function pin(w: World, i: number): void {
  w.enemies.state[i] = 60_000;
}

/** The first Telegraph event naming shape `kind`, or -1. */
function telegraphOf(w: World, kind: number): number {
  const slot = findEvent(w, Ev.Telegraph);
  if (slot < 0) return -1;
  return w.events.b[slot] === kind ? slot : -1;
}

describe('cover stops bodies', () => {
  it('leaves a player walking east on this side of a wall, and lets him through without it', () => {
    // One wall across the middle-east of the arena, and a run that walks straight at it.
    const build = (withWall: boolean): World => {
      const w = createWorld(301, { arenaHalf: 30 });
      w.player.hp = 1_000_000;
      if (withWall) installLayout(w, [wall(3, 0, 2, 24)]);
      return w;
    };

    const walked = (w: World): { x: number; neverInside: boolean } => {
      const f = createInputFrame();
      let neverInside = true;
      for (let t = 1; t <= 600; t++) {
        resetFrame(f);
        f.moveX = 1;
        step(w, f);
        // The body is tested as its own swept circle would be on the next tick: a body
        // whose own footprint overlaps cover is inside the wall, which is the failure.
        if (inCover(w, w.player.x, w.player.y, TUNE.playerRadius)) neverInside = false;
      }
      return { x: w.player.x, neverInside };
    };

    const stopped = walked(build(true));
    const clear = walked(build(false));

    // The control: the same input with no floor under it crosses the whole arena, so what
    // stops the other run is the wall rather than the maths.
    expect(clear.x).toBeGreaterThan(20);

    // Stopped, pressed up against it, and never once inside it.
    expect(stopped.neverInside, 'the player never overlaps cover').toBe(true);
    expect(stopped.x).toBeLessThanOrEqual(2 - TUNE.playerRadius + 1e-9);
    expect(stopped.x).toBeGreaterThan(1.2);
  });

  it('stops a dash as well as a walk: nothing crosses a two-metre wall in one tick', () => {
    const w = createWorld(302, { arenaHalf: 30 });
    w.player.hp = 1_000_000;
    installLayout(w, [wall(3, 0, 2, 24)]);

    const f = createInputFrame();
    let dashes = 0;
    let everInside = false;

    for (let t = 1; t <= 400; t++) {
      resetFrame(f);
      f.moveX = 1;
      // Held, so every dash the cooldown allows fires: a burst is 22 m/s for 0.18 s,
      // which is 0.37 m of travel a tick against a wall 2 m thick.
      f.dash = true;
      step(w, f);
      if (w.player.dashTime > 0) dashes++;
      if (inCover(w, w.player.x, w.player.y, TUNE.playerRadius)) everInside = true;
    }

    expect(dashes, 'the run actually dashed at the wall').toBeGreaterThan(10);
    expect(everInside, 'a dash must not cross a wall it started outside').toBe(false);
    expect(w.player.x).toBeLessThanOrEqual(2 - TUNE.playerRadius + 1e-9);
  });

  it('keeps a forty-strong pack on the far side of a wall that runs the arena', () => {
    const build = (withWall: boolean): World => {
      const w = createWorld(303, { arenaHalf: 30 });
      w.player.hp = 1_000_000;
      if (withWall) {
        // Full height in y: there is no way round, so "they never arrived" can only mean
        // the wall, not that they found a gap.
        installLayout(w, [wall(6, 0, 2, 60)]);
      }

      // The whole pack starts east of the wall, clear of its own footprint: a body put
      // down inside cover is moved to the nearest open floor, which is the right rule for
      // a spawn and would make "did they cross the wall" unreadable.
      const chaser = enemyIndex('chaser');
      for (let i = 0; i < 40; i++) {
        const col = i % 5;
        const row = (i / 5) | 0;
        spawnEnemy(w, chaser, 10 + col * 2.5, -16 + row * 2.5);
      }
      expect(w.enemies.count).toBe(40);
      return w;
    };

    const run = (w: World): { westmost: number; hp: number; everInside: boolean } => {
      const f = createInputFrame();
      let westmost = Infinity;
      let everInside = false;
      for (let t = 1; t <= 900; t++) {
        resetFrame(f);
        step(w, f);
        for (let i = 0; i < w.enemies.cap; i++) {
          if (w.enemies.alive[i] === 0) continue;
          const r = ENEMIES[w.enemies.kind[i]].radius;
          if (w.enemies.x[i] < westmost) westmost = w.enemies.x[i];
          if (inCover(w, w.enemies.x[i], w.enemies.y[i], r)) everInside = true;
        }
      }
      return { westmost, hp: w.player.hp, everInside };
    };

    const walled = run(build(true));
    const open = run(build(false));

    // Control: with no wall the pack reaches the player and he pays for it, so the
    // player's full health below is the wall's doing.
    expect(open.hp).toBeLessThan(1_000_000);
    expect(open.westmost).toBeLessThan(6);

    expect(walled.everInside, 'no body overlaps cover').toBe(false);
    expect(walled.westmost, 'no body crossed the wall').toBeGreaterThanOrEqual(7);
    expect(walled.hp, 'a horde that cannot reach you cannot hurt you').toBe(1_000_000);
  });

  it('puts a body down onto a column back out of it instead of welding it to the floor', () => {
    // Six bodies dropped into a column and onto its rim. That is not an invented state: it is
    // what a wave's landing point looks like when the side the spawner picked has a tank in
    // it, what every splitter's brood of splinters lands as, and what a chapter's escort is
    // put down as. Two rules meet here. A body already inside cover is travelled by its
    // destination alone, so the travel pass has no way to walk it out; and a body inside a
    // prop is invisible, unshootable and still counted. The one acceptable answer is that it
    // comes back out, which is what `pushOut` is for.
    const drops: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.8, 0.8]];

    const build = (withCover: boolean): World => {
      const w = createWorld(340, { arenaHalf: 30 });
      w.player.hp = 500;
      w.player.x = 9;
      if (withCover) installLayout(w, [pillar(0, 0)]);

      // Every drop point has to be inside the furniture, or the run below proves nothing:
      // the column's own footprint plus a body's is 1.9 m, and all six are closer than that.
      for (const [x, y] of drops) {
        expect(inCover(w, x, y, 0.4), `(${x}, ${y}) is inside cover exactly when there is cover`).toBe(withCover);
      }
      for (const [x, y] of drops) spawnEnemy(w, enemyIndex('chaser'), x, y);
      expect(w.enemies.count).toBe(drops.length);
      return w;
    };

    const run = (w: World): { inside: number; hp: number } => {
      const f = createInputFrame();
      let inside = 0;
      for (let t = 1; t <= 600; t++) {
        resetFrame(f);
        step(w, f);
        for (let i = 0; i < w.enemies.cap; i++) {
          if (w.enemies.alive[i] === 0) continue;
          if (inCover(w, w.enemies.x[i], w.enemies.y[i], ENEMIES[w.enemies.kind[i]].radius)) inside++;
        }
      }
      return { inside, hp: w.player.hp };
    };

    const walledColumn = build(true);
    const openColumn = build(false);
    const column = run(walledColumn);
    const open = run(openColumn);

    expect(column.inside, 'not one body spent one tick inside the column').toBe(0);
    // The control also gets bitten, so a run where nothing arrives would not read as a wall.
    expect(column.hp, 'and every one of them came out fighting').toBeLessThan(500);
    expect(open.hp).toBeLessThan(500);
    expect(walledColumn.errors, 'the column cost no errors').toBe(0);
  });

  it('puts a body down inside a wall back out of it, and never smuggles it through', () => {
    // The same question with the box shape, on a wall that has no gap anywhere along it.
    const drops: [number, number][] = [[0, 0], [0, 8], [0, -14], [0.5, 3]];

    const build = (withWall: boolean): World => {
      const w = createWorld(341, { arenaHalf: 30 });
      w.player.hp = 1_000_000;
      if (withWall) installLayout(w, [wall(0, 0, 2, 60)]);
      for (const [x, y] of drops) {
        expect(inCover(w, x, y, 0.4), `(${x}, ${y}) is inside cover exactly when there is cover`).toBe(withWall);
      }
      for (const [x, y] of drops) spawnEnemy(w, enemyIndex('chaser'), x, y);
      return w;
    };

    const run = (w: World): { inside: number; hp: number } => {
      const f = createInputFrame();
      let inside = 0;
      for (let t = 1; t <= 400; t++) {
        resetFrame(f);
        step(w, f);
        for (let i = 0; i < w.enemies.cap; i++) {
          if (w.enemies.alive[i] === 0) continue;
          if (inCover(w, w.enemies.x[i], w.enemies.y[i], ENEMIES[w.enemies.kind[i]].radius)) inside++;
        }
      }
      return { inside, hp: w.player.hp };
    };

    const walled = run(build(true));
    const open = run(build(false));

    // Out of the wall and back for more, which is what the control shows these four do when
    // nothing stands between them and the player.
    expect(open.hp, 'four chasers with a clear line bite').toBeLessThan(1_000_000);
    expect(walled.inside, 'nobody was left inside the wall').toBe(0);
    // They came back out on the far side of a wall that runs the arena, which is the honest
    // reading of it: put down in cover is not the same as let through it.
    expect(walled.hp, 'and a wall they cannot cross cannot hug').toBe(1_000_000);
  });
});

describe('cover stops rounds', () => {
  it('drops a pistol round at a crate, and lands the same shot on open floor', () => {
    const build = (withCrate: boolean): World => {
      const w = createWorld(304, { arenaHalf: 30 });
      w.player.hp = 1_000_000;
      loadSlot(w.slots[0], 0); // the pistol: projectile, 26 m of reach
      expect(w.slots[0].weapon).toBe(0);
      if (withCrate) installLayout(w, [{ kind: PropKind.Crate, x: 4, y: 0, w: 2, h: 2 }]);

      // One chaser due east, well past the crate and inside the gun's range.
      const i = spawnEnemy(w, enemyIndex('chaser'), 12, 0);
      pin(w, i);
      return w;
    };

    const shoot = (w: World): number => {
      const f = createInputFrame();
      const target = 0;
      for (let t = 1; t <= 300; t++) {
        resetFrame(f);
        f.fire = true;
        f.aimX = 1;
        step(w, f);
        if (w.enemies.alive[target] === 0) break;
      }
      return w.enemies.alive[target] === 0 ? 0 : w.enemies.hp[target];
    };

    const behind = shoot(build(true));
    const open = shoot(build(false));

    // The control: the same gun at the same range kills the same body, so a full health
    // bar below means the crate ate the rounds rather than that the shot never happened.
    expect(open, 'the pistol drops a chaser on open floor').toBe(0);
    expect(behind, 'a crate between them keeps him alive').toBeGreaterThan(0);
  });

  it('refuses a sight line for a hitscan ray, which is what makes cover readable', () => {
    const build = (withWall: boolean): World => {
      const w = createWorld(305, { arenaHalf: 40 });
      w.player.hp = 1_000_000;
      const sniper = WEAPONS.findIndex((d) => d.id === 'sniper');
      expect(sniper).toBeGreaterThan(0);
      loadSlot(w.slots[0], sniper);
      if (withWall) installLayout(w, [wall(10, 0, 2, 20)]);
      const i = spawnEnemy(w, enemyIndex('armored'), 20, 0);
      pin(w, i);
      return w;
    };

    const shoot = (w: World): number => {
      const f = createInputFrame();
      let shots = 0;
      for (let t = 1; t <= 120; t++) {
        resetFrame(f);
        f.fire = true;
        f.aimX = 1;
        clearEvents(w);
        step(w, f);
        shots += countEvents(w, Ev.Shot);
      }
      expect(shots, 'the gun fired during the run').toBeGreaterThanOrEqual(2);
      return w.enemies.hp[0];
    };

    const behind = shoot(build(true));
    const open = shoot(build(false));

    expect(open).toBeLessThan(ENEMIES[enemyIndex('armored')].hp);
    expect(behind, 'the ray stops at the wall, as the sight line says it must').toBe(
      ENEMIES[enemyIndex('armored')].hp,
    );
  });

  it('frees a round the moment it reaches cover, instead of flying it the whole arena', () => {
    // The two tests above ask whether cover stops a round by asking what it did to a body.
    // This one asks the question the pool cares about, which is whether the slot came back:
    // a round that flies *through* a crate is both a lie about cover and a leak, and 2,048
    // rounds that never die is a pool that stops answering `fire` by wave three.
    const build = (withCrate: boolean): World => {
      const w = createWorld(342, { arenaHalf: 30 });
      w.player.hp = 1_000_000;
      loadSlot(w.slots[0], 0); // the pistol: a round, at 55 m/s
      if (withCrate) installLayout(w, [crate(4, 0)]);
      return w;
    };

    // One trigger pull, then the finger comes off, so what is left in the air at the end is
    // one round's own history rather than a stream.
    const shoot = (w: World): { peak: number; alive: number; far: number } => {
      const f = createInputFrame();
      let peak = 0;
      let far = 0;
      for (let t = 1; t <= 15; t++) {
        resetFrame(f);
        f.fire = t === 1;
        f.aimX = 1;
        step(w, f);
        peak = Math.max(peak, countAlive(w.shots));
        for (let i = 0; i < w.shots.cap; i++) {
          if (w.shots.alive[i] === 0) continue;
          if (w.shots.x[i] > far) far = w.shots.x[i];
        }
      }
      return { peak, alive: countAlive(w.shots), far };
    };

    const eaten = shoot(build(true));
    const flown = shoot(build(false));

    expect(eaten.peak, 'the gun fired').toBeGreaterThan(0);
    expect(eaten.alive, 'and the round was out of the pool within a quarter second').toBe(0);
    expect(eaten.far, 'never once seen east of the crate it was fired at').toBeLessThan(5);
    expect(flown.alive, 'the same shot on open floor is still in the air at tick 15').toBe(1);
    expect(flown.far, 'ten metres past where the crate would have stood').toBeGreaterThan(10);
  });

  it('retires a bolt and a lob at cover, so cover protects whoever hides behind it', () => {
    // Both shapes the horde fires, at the same piece of wall. Cover that only stops the
    // player's rounds is not cover, it is a decoration the enemy shoots through, and every
    // layout in the game is drawn on the assumption that a body can hide behind something.
    const fire = (w: World, kind: number): void => {
      if (kind === ShotKind.Bolt) launchBolt(w, -6, 0, 1, 0, 25, 10, 2);
      else lobGrenade(w, -6, 0, 1, 0, 12, 1.2, 18, 2.5);
    };

    for (const kind of [ShotKind.Bolt, ShotKind.Grenade]) {
      const shape = kind === ShotKind.Bolt ? 'bolt' : 'lob';

      const build = (withWall: boolean): World => {
        const w = createWorld(343 + kind, { arenaHalf: 30 });
        w.player.hp = 100;
        w.player.x = 8;
        if (withWall) installLayout(w, [wall(0, 0, 2, 20)]);
        fire(w, kind);
        expect(countAlive(w.enemyShots)).toBe(1);
        return w;
      };

      const run = (w: World): { hp: number; booms: number; far: number } => {
        const f = createInputFrame();
        let booms = 0;
        let far = 0;
        for (let t = 1; t <= 200; t++) {
          resetFrame(f);
          clearEvents(w);
          step(w, f);
          booms += countEvents(w, Ev.Explosion);
          for (let i = 0; i < w.enemyShots.cap; i++) {
            if (w.enemyShots.alive[i] === 0) continue;
            if (w.enemyShots.x[i] > far) far = w.enemyShots.x[i];
          }
        }
        return { hp: w.player.hp, booms, far };
      };

      const behind = run(build(true));
      const open = run(build(false));

      expect(open.hp, `on open floor the ${shape} is paid for`).toBeLessThan(100);
      expect(behind.hp, `a wall between them and the player stops the ${shape}`).toBe(100);
      expect(behind.far, `the ${shape} never emerges on the far side of cover`).toBeLessThanOrEqual(1);
      expect(open.far, `while on open floor it reaches the man it was aimed at`).toBeGreaterThan(7);
      expect(behind.booms, `a ${shape} spent on a wall bursts nowhere`).toBe(0);
    }
  });
});

describe('floor hazards', () => {
  it('costs a player HP while he stands in a pool, and nothing once he is out of it', () => {
    const build = (poolUnderPlayer: boolean): World => {
      const w = createWorld(306, { arenaHalf: 30 });
      // 20 a second, and the pool is 3 m across so "standing in it" is unambiguous.
      withFloor(w, [], [{ kind: ZoneKind.Acid, x: poolUnderPlayer ? 0 : 20, y: 0, r: 3, dps: 20 }]);
      return w;
    };

    const f = createInputFrame();
    const wet = build(true);
    for (let t = 1; t <= 60; t++) {
      resetFrame(f);
      step(wet, f);
    }

    const dry = build(false);
    for (let t = 1; t <= 60; t++) {
      resetFrame(f);
      step(dry, f);
    }

    // Priced through the i-frame gate, so a second in the pool costs its `dps` and no
    // more: 0.5 s of immunity per bite, two bites in a second at 20/s.
    expect(wet.player.hp).toBeLessThan(95);
    expect(wet.player.hp).toBeGreaterThan(60);
    expect(dry.player.hp, 'dry floor costs nothing').toBe(100);
    expect(wet.errors).toBe(0);
  });

  it('kills what stands in it, and the corpse leaves the pool instead of soaking in it', () => {
    const w = createWorld(307, { arenaHalf: 30 });
    withFloor(w, [], [{ kind: ZoneKind.Acid, x: 8, y: 0, r: 3, dps: 200 }]);
    expect(acidAt(w.zones, 8, 0)).toBe(200);
    expect(acidAt(w.zones, 20, 0)).toBe(0);

    const inPool = spawnEnemy(w, enemyIndex('chaser'), 8, 0);
    const outside = spawnEnemy(w, enemyIndex('chaser'), 20, 0);
    pin(w, inPool);
    pin(w, outside);

    const f = createInputFrame();
    for (let t = 1; t <= 240; t++) {
      resetFrame(f);
      step(w, f);
    }

    // Two hundred a second through the gate is four seconds of pool against twenty HP of
    // chaser, so by the far end the body is gone rather than merely worn. The one outside
    // is the control: the pool is a place, and a body that is not in it pays nothing.
    expect(w.enemies.alive[inPool], 'the pool finished the chaser').toBe(0);
    expect(w.enemies.hp[outside], 'a body outside the pool is untouched').toBe(
      ENEMIES[enemyIndex('chaser')].hp,
    );
    expect(w.errors).toBe(0);
  });

  it('tells for at least 0.4 s before a plate drops, and only pays what is under it', () => {
    const w = createWorld(308, { arenaHalf: 30 });
    withFloor(w, [], [{ kind: ZoneKind.Crusher, x: 8, y: 0, r: 2.5, dps: 40, gap: 1.2, warn: 0.5 }]);

    const under = spawnEnemy(w, enemyIndex('chaser'), 8, 0);
    const aside = spawnEnemy(w, enemyIndex('chaser'), 8, 12);
    pin(w, under);
    pin(w, aside);

    let tellTick = -1;
    let boomTick = -1;
    let tells = 0;
    const f = createInputFrame();

    for (let t = 1; t <= 240; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);

      const ring = telegraphOf(w, Tele.RingAt);
      if (ring >= 0) {
        tells++;
        if (tellTick < 0) tellTick = w.tick;
      }
      const boom = findEvent(w, Ev.Explosion);
      if (boom >= 0 && boomTick < 0) boomTick = w.tick;
    }

    expect(tells, 'the plate tells once per cycle').toBeGreaterThanOrEqual(2);
    expect(tellTick).toBeGreaterThan(0);
    expect(boomTick).toBeGreaterThan(0);

    // The warning is the whole point of a crusher, so its length is a fact rather than a
    // feel: DESIGN.md's floor is 0.4 s and this plate was authored at 0.5 s.
    expect(boomTick - tellTick).toBeGreaterThanOrEqual(24);

    // And the shape is the damage: the body under the plate is gone and the body twelve
    // metres away never had anything to answer.
    expect(w.enemies.alive[under], 'the plate killed what stood under it').toBe(0);
    expect(w.enemies.hp[aside]).toBe(ENEMIES[enemyIndex('chaser')].hp);
  });

  it('hurts whichever side is standing in it, which is what makes a pool a position', () => {
    const w = createWorld(309, { arenaHalf: 30 });
    withFloor(w, [], [{ kind: ZoneKind.Acid, x: 0, y: 0, r: 2, dps: 30 }]);

    // The player starts at the middle of the arena, which is where the pool is.
    expect(acidAt(w.zones, w.player.x, w.player.y)).toBe(30);

    // Pinned inside the pool: an enemy that walks through it would also be walking out of
    // it, and the question here is whether the floor charges the horde at all, not whether
    // a chaser can be lured. The control for that is the suite above. Out of hug range
    // (1.7 m, against 0.75 m of contact) so the only thing taking the player's HP is acid.
    const other = spawnEnemy(w, enemyIndex('chaser'), 1.7, 0);
    pin(w, other);

    const f = createInputFrame();
    let playerHits = 0;
    let lastHp = w.player.hp;
    for (let t = 1; t <= 120; t++) {
      resetFrame(f);
      step(w, f);
      if (w.player.hp < lastHp) playerHits++;
      lastHp = w.player.hp;
    }

    expect(playerHits, 'the pool bit the player more than once').toBeGreaterThan(1);
    expect(w.enemies.alive[other], 'and it bit the chaser too').toBe(0);
    expect(w.errors).toBe(0);
  });

  it('stops charging the moment he walks out of the pool', () => {
    // The other half of a damage-over-time floor, and the half that decides whether it reads:
    // a pool that keeps taking after you have left it is a health bar that drains, and a
    // player who cannot tell which of the things around him is still costing him HP has no
    // decision to make, only a clock. So: two seconds standing in it, then two seconds out
    // of it on the same clock, and the price has to stop with the pool.
    const build = (wet: boolean): World => {
      const w = createWorld(344, { arenaHalf: 30 });
      withFloor(w, [], wet ? [{ kind: ZoneKind.Acid, x: 0, y: 0, r: 3, dps: 20 }] : []);
      return w;
    };

    const f = createInputFrame();

    const wet = build(true);
    let bites = 0;
    let lastHp = wet.player.hp;
    for (let t = 1; t <= 120; t++) {
      resetFrame(f);
      step(wet, f);
      if (wet.player.hp < lastHp) {
        bites++;
        lastHp = wet.player.hp;
      }
    }
    expect(bites, 'two seconds in corrosion costs more than one bite').toBeGreaterThan(1);
    expect(bites).toBeLessThan(6);

    // Same clock, dry floor now. Nothing else about the world changes, so the only thing
    // that could stop the damage is the pool being gone.
    const left = wet.player.hp;
    wet.player.x = 20;
    for (let t = 1; t <= 120; t++) {
      resetFrame(f);
      step(wet, f);
      expect(wet.player.hp, `tick ${t}: the pool was eight metres behind him`).toBe(left);
    }

    const dry = build(false);
    for (let t = 1; t <= 240; t++) {
      resetFrame(f);
      step(dry, f);
    }
    expect(dry.player.hp, 'a floor with no pool in it costs nothing at all').toBe(100);
    expect(wet.errors).toBe(0);
  });
});

describe('the geometry itself', () => {
  it('answers "clear" for an empty floor and never lets a fast segment cross a thick one', () => {
    const w = createWorld(310, { arenaHalf: 20 });
    expect(w.props.n).toBe(0);
    expect(w.zones.n).toBe(0);
    // A fresh World has no floor at all: not chapter 1, not an empty-ish chapter 1.
    expect(blocked(w.props, 0, 0, 10, 0, 0.12)).toBe(false);
    expect(canTravel(w.props, 0, 0, 10, 0, 0.12)).toBe(true);

    // The wall stops short of the arena's north edge on purpose, so the last query below
    // is a segment that genuinely misses it rather than one that leaves the floor.
    installLayout(w, [wall(0, 0, 2, 20)]);
    expect(pointBlocked(w.props, 0, 0, 0.12), 'the middle of a wall is not open floor').toBe(true);
    expect(pointBlocked(w.props, 5, 0, 0.12)).toBe(false);

    // A railgun round covers 3.3 m of this wall in one tick. The sweep is what stops it.
    expect(canTravel(w.props, -3, 0, 6, 0, TUNE.shotRadius)).toBe(false);
    // North of the wall's own span, so this really is a segment that misses it rather
    // than one that happens to end short of it.
    expect(canTravel(w.props, -3, 15, 6, 0, TUNE.shotRadius), 'a segment that misses the wall').toBe(true);

    // A body put down inside cover is put back out of it, rather than through it.
    expect(pushOut(w.props, 0.4, 0, 0)).toBe(true);
    expect(pointBlocked(w.props, pushedX(), pushedY(), 0.4)).toBe(false);
  });

  it('refuses a box thinner than the fastest thing that would tunnel it', () => {
    const w = createWorld(311, { arenaHalf: 20 });
    installLayout(w, [
      wall(0, 0, 0.6, 10), // thinner than MIN_THICK: refused
      wall(10, 0, MIN_THICK, 10), // exactly at the floor: accepted
    ]);

    expect(w.props.dropped, 'the thin box was counted, not quietly dropped').toBe(1);
    expect(w.props.n).toBe(1);
    expect(blocked(w.props, 9, 0, 11, 0, 0)).toBe(true);
  });

  it('installs every authored chapter without refusing a single box', () => {
    // The layouts are hand-authored metres, and `MIN_THICK` is the one rule they have to
    // obey to be solid at dash and railgun speed. Checked over all ten chapters rather than
    // asserted in a comment: a typo'd wall is a layout bug and this is the only place it
    // can be caught before it ships as scenery you can walk through.
    for (let i = 0; i < LEVELS.length; i++) {
      const w = createWorld(312 + i, { arenaHalf: 60 });
      startChapter(w, i);
      const level = LEVELS[i];
      expect(w.props.dropped, `${level.id} authored a box under ${MIN_THICK} m`).toBe(0);
      expect(w.props.n, `${level.id} installed its cover`).toBe(level.props.length);
      expect(w.zones.n, `${level.id} installed its hazards`).toBe(level.hazards.length);
      expect(w.chapter).toBe(i);
      expect(w.wave.phase).toBe(Phase.Script);
      expect(w.wave.running).toBe(true);
    }
  });
});

describe('the chapter arc', () => {
  it('ends on the encounter its data names, escorted by its own last recipe row', () => {
    const w = createWorld(320, { arenaHalf: 60 });
    w.player.hp = 100_000;
    w.autoFire = true;
    startChapter(w, 4); // Reactor Rim: a matron, with an escort
    expect(LEVELS[4].bosses).toEqual(['matron']);

    const f = createInputFrame();
    let arrived = false;
    // Seven waves of reactor-rim is 84 s of drumbeat, and whether a pistol survives it is a
    // balance question, not this one: the health is topped back up every tick so the only
    // thing that can stop this run short is the arc itself never reaching its encounter.
    for (let t = 1; t <= 6000 && !w.over; t++) {
      resetFrame(f);
      f.fire = true;
      step(w, f);
      w.player.hp = 100_000;
      if (w.wave.phase === Phase.Encounter) {
        if (!arrived) {
          arrived = true;
          expect(bossesAlive(w), 'the encounter is on the floor the tick the chapter changes').toBe(true);
          // Escort as well as boss: an encounter alone in a room is a health bar.
          let live = 0;
          for (let i = 0; i < w.enemies.cap; i++) live += w.enemies.alive[i];
          expect(live).toBeGreaterThan(1);
        }
        break;
      }
    }

    expect(arrived, 'the drumbeat stops and the encounter walks in').toBe(true);
    expect(w.wave.running, 'the spawner is switched off for the fight').toBe(false);
    expect(bossesAlive(w)).toBe(true);
  });

  it('loads the next chapter when the encounter dies, with the next chapter floor', () => {
    const w = createWorld(321, { arenaHalf: 60 });
    w.player.hp = 100_000;
    w.autoFire = true;
    startChapter(w, 0);
    const firstProps = w.props.n;
    const firstBoxes = Array.from(w.props.x0.slice(0, w.props.n));

    const f = createInputFrame();
    let sawBoss = false;

    for (let t = 1; t <= 9000 && w.chapter === 0; t++) {
      resetFrame(f);
      f.fire = true;
      step(w, f);

      if (!sawBoss && bossesAlive(w)) {
        // Stop the fight rather than play it: what is under test is the door the bosses
        // arrive through and the floor that loads behind them.
        sawBoss = true;
        for (let i = 0; i < w.enemies.cap; i++) {
          if (w.enemies.alive[i] !== 0 && ENEMIES[w.enemies.kind[i]].boss) w.enemies.hp[i] = 0;
        }
      }
    }

    expect(sawBoss, 'chapter 1 ended on its broodmother').toBe(true);
    expect(w.chapter, 'the run moved on to chapter 2').toBe(1);
    expect(w.wave.phase, 'the new chapter opens mid-script').toBe(Phase.Script);
    expect(w.wave.running).toBe(true);
    expect(w.wave.index, 'the new chapter starts at its own wave 1').toBe(1);

    // The previous room's walls do not stay standing in the next one.
    const nowBoxes = Array.from(w.props.x0.slice(0, w.props.n));
    expect(nowBoxes.length).not.toBe(firstBoxes.length);
    expect(nowBoxes.length).toBeGreaterThan(0);
    expect(firstProps).toBeGreaterThan(0);
    expect(w.errors).toBe(0);
  });

  it('runs a whole chapter on a floor and stays error-free and finite', () => {
    // A sweep rather than a spot check: the same tick that drops a plate also moves
    // everyone standing under it, and the failures geometry produces are the quiet ones —
    // a body sealed inside cover, a spawn that lands in a wall, a clock that never resets.
    // Chapter 5 is in the list because it is the smallest room in the game: a floor has to
    // stay big enough for a batch to find a side it can arrive on, and a chapter that
    // quietly spawns nothing looks from out here exactly like a chapter that works.
    for (const chapter of [1, 4, 5, 9]) {
      const w = createWorld(330 + chapter, { arenaHalf: 60 });
      w.player.hp = 100_000;
      w.autoFire = true;
      startChapter(w, chapter);

      const f = createInputFrame();
      let sealed = 0;
      let peak = 0;
      for (let t = 1; t <= 2400; t++) {
        resetFrame(f);
        f.fire = true;
        step(w, f);

        let stuck = 0;
        for (let i = 0; i < w.enemies.cap; i++) {
          if (w.enemies.alive[i] === 0) continue;
          if (inCover(w, w.enemies.x[i], w.enemies.y[i], ENEMIES[w.enemies.kind[i]].radius)) stuck++;
        }
        if (stuck > sealed) sealed = stuck;
        if (w.enemies.count > peak) peak = w.enemies.count;
        expect(Number.isFinite(w.player.x) && Number.isFinite(w.player.y)).toBe(true);
      }

      expect(sealed, `chapter ${chapter + 1} sealed a body inside cover`).toBe(0);
      expect(peak, `chapter ${chapter + 1} never filled its floor`).toBeGreaterThan(0);
      expect(w.errors, `chapter ${chapter + 1} counted an error`).toBe(0);
    }
  });
});

describe('the chapters are rooms', () => {
  it('gives every chapter its own name, its own obstacles and somewhere to stand', () => {
    expect(LEVELS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(LEVELS.map((l) => l.id)).size, 'two chapters answer to the same id').toBe(LEVELS.length);
    expect(new Set(LEVELS.map((l) => l.name)).size, 'two chapters answer to the same name').toBe(LEVELS.length);

    // A floor plan that repeats is a chapter that repeats. The layouts are hand-authored
    // metres, so a copy-paste here means two chapters played in one room, and the only place
    // that is visible is the data.
    const plans = LEVELS.map((l) =>
      l.props.map((p) => `${p.kind}@${p.x},${p.y} ${p.w}x${p.h}${p.r === undefined ? '' : ` r${p.r}`}`).join('|'),
    );
    expect(new Set(plans).size, 'two chapters share a floor plan').toBe(LEVELS.length);

    for (let i = 0; i < LEVELS.length; i++) {
      const level = LEVELS[i];

      expect(level.props.length, `${level.id} authored no cover`).toBeGreaterThan(0);
      expect(level.hazards.length, `${level.id} authored no hazard`).toBeGreaterThan(0);
      // The room has to stay bigger than the view the horde arrives out of (a chapter whose
      // floor is smaller than the 32x18 view rect gives the spawner nowhere to put a batch)
      // and no bigger than the floor a World is built with, which is what `setArena` clamps
      // to. A number outside that band is a chapter that stops spawning, quietly.
      expect(level.size, `${level.id} shrank its arena below the view`).toBeGreaterThanOrEqual(40);
      expect(level.size, `${level.id} declared more floor than there is`).toBeLessThanOrEqual(60);

      // Nothing is authored outside the room it is authored for: a wall in the fog past the
      // arena's edge is data nothing can reach, and the round and body paths already refuse
      // to leave the floor, so it would be a wall that only looks like a wall.
      for (const p of level.props) {
        expect(Math.abs(p.x) + p.w / 2, `${level.id} put cover outside its own arena`).toBeLessThanOrEqual(level.size);
        expect(Math.abs(p.y) + p.h / 2, `${level.id} put cover outside its own arena`).toBeLessThanOrEqual(level.size);
      }

      // Where a run is dropped, which is the one spot the data has to be read around. A
      // chapter may not open by charging you for the floor you were put onto, nor by putting
      // you inside it: the player starts in the middle, so the middle is the one place a
      // layout is written *from*.
      const w = createWorld(350 + i, { arenaHalf: 60 });
      startChapter(w, i);
      expect(pointBlocked(w.props, w.player.x, w.player.y, TUNE.playerRadius), `${level.id} starts the run inside cover`).toBe(
        false,
      );
      expect(acidAt(w.zones, w.player.x, w.player.y), `${level.id} starts the run standing in a hazard`).toBe(0);
      expect(Math.abs(w.player.x) + TUNE.playerRadius, `${level.id} starts the run off its own floor`).toBeLessThanOrEqual(
        -w.minX + 1e-6,
      );
      expect(Math.abs(w.player.y) + TUNE.playerRadius, `${level.id} starts the run off its own floor`).toBeLessThanOrEqual(
        -w.minY + 1e-6,
      );
    }
  });

  it('writes the docks, the foundry and the reactor as three different kinds of room', () => {
    // The three the campaign is built around, checked by what stands in them rather than by
    // a sentence in a comment: an open floor of columns, a floor of chokepoints, and a ring
    // whose middle is a place you go through. Each is a different answer to where a horde
    // arrives from, which is the only reason a layout is content rather than decoration.
    const docks = LEVELS[0];
    const foundry = LEVELS[1];
    const reactor = LEVELS[4];

    const kindCount = (level: (typeof LEVELS)[number], kind: number): number =>
      level.props.filter((p) => p.kind === kind).length;
    const hazardCount = (level: (typeof LEVELS)[number], kind: number): number =>
      level.hazards.filter((h) => h.kind === kind).length;

    // The docks: mostly open, and what cover there is is columns. A first chapter is where a
    // player learns to read bodies, and a body read through a maze is not read.
    expect(kindCount(docks, PropKind.Pillar), 'the docks are built out of columns').toBeGreaterThanOrEqual(3);
    expect(kindCount(docks, PropKind.Wall), 'and are not built out of corridors').toBeLessThan(3);
    expect(docks.props.length).toBeLessThan(foundry.props.length);

    // The foundry: long walls laid as chokes, with corrosion in the bottom of them, so the
    // lanes are a route with a price on it rather than a free run.
    expect(kindCount(foundry, PropKind.Wall), 'the foundry is built out of chokes').toBeGreaterThanOrEqual(4);
    expect(hazardCount(foundry, ZoneKind.Acid), 'with pools in the lanes').toBeGreaterThanOrEqual(2);

    // The reactor: a ring of vessels with the plates in the two lanes it leaves. Its middle
    // is not a place to stand, which is the whole layout.
    expect(kindCount(reactor, PropKind.Tank), 'the reactor is a ring').toBeGreaterThanOrEqual(4);
    expect(hazardCount(reactor, ZoneKind.Crusher), 'and the ring is priced').toBeGreaterThanOrEqual(2);

    // And each room is lit and fogged as its own, which is the only way a chapter tint is a
    // fact about the chapter rather than about the renderer.
    const tints = new Set(LEVELS.map((l) => l.palette.fog));
    expect(tints.size, 'three chapters would be three more colours').toBeGreaterThanOrEqual(3);
    expect(new Set(LEVELS.map((l) => l.palette.key)).size).toBeGreaterThanOrEqual(3);
    expect(docks.palette.fog).not.toBe(foundry.palette.fog);
    expect(docks.palette.fog).not.toBe(reactor.palette.fog);
    expect(foundry.palette.fog).not.toBe(reactor.palette.fog);
    expect(docks.palette.key).not.toBe(reactor.palette.key);
  });
});
