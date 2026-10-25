import { describe, expect, it } from 'vitest';
import { ENEMIES, enemyIndex } from '../../src/content/enemies';
import { WEAPONS } from '../../src/content/weapons';
import { createInputFrame, resetFrame, type InputFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { Ev, Tele, TUNE, clearEvents, createWorld, findEvent, loadSlot, type World } from '../../src/sim/world';

/**
 * The three end-of-level encounters, checked as behaviour driven through `step()`.
 *
 * A boss is only worth having if the fight is answerable, so most of these tests are
 * written as a pair or a bound on the *answer*: a player who reads the tell and moves pays
 * nothing, a player who stands in the telegraphed spot pays, and the difference is measured
 * rather than argued about. That is DESIGN.md's bar for a telegraph (at least 400 ms of
 * warning a player can answer) and the reason the encounters are behaviours rather than big
 * numbers on a chaser.
 *
 * Which chapter ends on which encounter, and the door they arrive through, is pinned in
 * `tests/unit/levels.test.ts`. This file is only about what each body does once it is on
 * the floor — the wave recipes stop short of them, which is why
 * `tests/unit/enemies-b.test.ts` counts the drumbeat archetypes without them.
 */

/** Put one archetype down by id, with the HP the test needs rather than the default. */
function place(w: World, id: string, x: number, y: number, hp?: number): number {
  const i = spawnEnemy(w, enemyIndex(id), x, y);
  if (hp !== undefined) w.enemies.hp[i] = hp;
  return i;
}

/** Distance from a body slot to the player's centre. */
function gap(w: World, i: number): number {
  return Math.hypot(w.enemies.x[i] - w.player.x, w.enemies.y[i] - w.player.y);
}

/** Count events of `type` in the ring — read after `step`, before the next clear. */
function countType(w: World, type: number): number {
  const e = w.events;
  let n = 0;
  for (let k = 0; k < e.count; k++) {
    if (e.type[(e.head - e.count + k + e.cap * 2) % e.cap] === type) n++;
  }
  return n;
}

/** Enemy rounds fired since the ring was last cleared: `Shot` with no gun behind it. */
function enemyShots(w: World): number {
  const e = w.events;
  let n = 0;
  for (let k = 0; k < e.count; k++) {
    const slot = (e.head - e.count + k + e.cap * 2) % e.cap;
    if (e.type[slot] === Ev.Shot && e.a[slot] === -1) n++;
  }
  return n;
}

/** Spawn events naming archetype `id` since the ring was last cleared. */
function spawnedOf(w: World, id: number): number {
  const e = w.events;
  let n = 0;
  for (let k = 0; k < e.count; k++) {
    const slot = (e.head - e.count + k + e.cap * 2) % e.cap;
    if (e.type[slot] === Ev.Spawn && e.b[slot] === id) n++;
  }
  return n;
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

/**
 * One tick at a time, ring cleared first, with the frame refilled by `fill` and the
 * finished tick read back by `watch`.
 *
 * The read-back matters: a slam's flash and the burst it was warning about are two events
 * two ticks apart, and a test that only samples the ring once at the end cannot tell a
 * 450 ms tell from a one-tick one.
 */
function eachTick(
  w: World,
  ticks: number,
  fill: (f: InputFrame, t: number) => void,
  watch: (t: number) => void = () => {},
): void {
  const f = createInputFrame();
  for (let t = 1; t <= ticks; t++) {
    resetFrame(f);
    fill(f, t);
    clearEvents(w);
    step(w, f);
    watch(t);
  }
}

describe('atlas', () => {
  it('walks its ring instead of pressing in to hug', () => {
    const w = createWorld(501, { arenaHalf: 40 });
    w.player.hp = 100_000; // this test is about the ring, not about dying
    const boss = place(w, 'atlas', 9, 0);
    const def = ENEMIES[enemyIndex('atlas')];

    let closest = Infinity;
    let widest = 0;
    eachTick(w, 600, () => {}, () => {
      const d = gap(w, boss);
      if (closest > d) closest = d;
      if (widest < d) widest = d;
    });

    // It came in from nine metres and stayed in the band it works at: never inside
    // contact range, never so far out that the player has to give ground to reach it. The
    // whole answer to it is a flank, and a flank is not something you can take from a body
    // that walks up and hugs.
    expect(closest).toBeGreaterThan(4);
    expect(widest).toBeLessThan(9.5);
    expect(def.params.standoff).toBe(5.5);
  });

  it('flashes the slam for at least 24 ticks, and a player who stands in it pays', () => {
    const w = createWorld(502, { arenaHalf: 40 });
    const boss = place(w, 'atlas', 3.5, 0);
    const def = ENEMIES[enemyIndex('atlas')];

    let tellTick = -1;
    let boomTick = -1;
    let tellTimer = 0;
    let boom = { x: 0, y: 0, r: 0, bx: 0, by: 0 };

    eachTick(w, 600, () => {}, () => {
      if (tellTick < 0) {
        const slot = firstTelegraph(w, Tele.Ring);
        if (slot >= 0) {
          tellTick = w.tick;
          tellTimer = w.enemies.timer[boss];
        }
      }
      if (boomTick < 0) {
        const slot = findEvent(w, Ev.Explosion);
        if (slot >= 0) {
          boomTick = w.tick;
          // The body is read on the tick the burst resolves. The ring was drawn on where
          // the boss stood when the wind-up opened and it does not move during one, so
          // burst-centre-to-body is the pair the telegraph promises; read 570 ticks later
          // the boss has walked back out to its ring and the same comparison is noise.
          boom = {
            x: w.events.x[slot],
            y: w.events.y[slot],
            r: w.events.b[slot] / 10,
            bx: w.enemies.x[boss],
            by: w.enemies.y[boss],
          };
        }
      }
    });

    expect(tellTick).toBeGreaterThan(0);
    expect(boomTick).toBeGreaterThan(0);
    expect(boomTick - tellTick).toBeGreaterThanOrEqual(24);
    expect((boomTick - tellTick) / 60).toBeGreaterThanOrEqual(0.4);

    // The flash lasts exactly the wind-up the data names, and the burst is the ring the
    // flash drew — same radius, centred on the body — so the shape on the floor is the
    // shape of the damage, which is the whole bargain DESIGN.md asks a telegraph to keep.
    expect(tellTimer).toBeCloseTo(def.params.slamWindup, 6);
    expect(boom.r).toBeCloseTo(def.params.blastRadius, 6);
    expect(Math.hypot(boom.x - boom.bx, boom.y - boom.by)).toBeLessThan(0.01);

    // And the player who never moved is inside it, and pays its full price.
    const reach = def.params.blastRadius + TUNE.playerRadius;
    expect(Math.hypot(w.player.x - boom.x, w.player.y - boom.y)).toBeLessThanOrEqual(reach);
    expect(w.player.hp).toBe(w.player.maxHp - def.params.blastDamage);
  });

  it('pays nothing to a player who walks out of the ring', () => {
    const w = createWorld(503, { arenaHalf: 40 });
    // Raised, and deliberately above maxHp: the run is 600 ticks long and the player
    // has to still be standing at the far end for "took none of it" to be readable.
    // So the check below is against the number it started at, not against maxHp.
    w.player.hp = 100_000;
    place(w, 'atlas', 3.5, 0);

    let slams = 0;
    let dodged = 0;
    eachTick(
      w,
      200,
      (f) => {
        // Straight off the body, which is the answer the telegraph offers. Held for 3.3 s:
        // long enough for the burst to land well inside the arena, short enough that the
        // player never runs out of floor and gets a second slam it could not leave.
        f.moveX = -1;
      },
      () => {
        const n = countType(w, Ev.Explosion);
        slams += n;
        // Every burst landed on floor the player had already left.
        let inside = 0;
        const e = w.events;
        for (let k = 0; k < e.count; k++) {
          const slot = (e.head - e.count + k + e.cap * 2) % e.cap;
          if (e.type[slot] !== Ev.Explosion) continue;
          if (Math.hypot(w.player.x - e.x[slot], w.player.y - e.y[slot]) <= e.b[slot] / 10) inside++;
        }
        expect(inside).toBe(0);
        dodged += n;
      },
    );

    // The burst still happened — it is not that nothing occurred — it just spent itself on
    // the ground the player walked off 450 ms ago.
    expect(dodged).toBeGreaterThan(0);
    expect(slams).toBe(dodged);
    expect(w.player.hp).toBe(100_000);
    expect(w.over).toBe(false);
  });
});

describe('broodmother', () => {
  it('looses five broods of three splinters and then stops', () => {
    const w = createWorld(504, { arenaHalf: 40 });
    w.player.hp = 100_000;
    place(w, 'broodmother', 10, 0);
    const splinter = enemyIndex('splinter');

    let brooded = 0;
    let lastBroodTick = 0;
    eachTick(w, 1500, () => {}, () => {
      const n = spawnedOf(w, splinter);
      if (n > 0) {
        brooded += n;
        lastBroodTick = w.tick;
      }
    });

    // Five broods of three, then nothing: the boss runs out of children well before the
    // chapter runs out of room, which is what makes "deal with it before the brood lands"
    // a decision with a deadline rather than a treadmill.
    expect(brooded).toBe(15);
    expect(lastBroodTick).toBeLessThan(1200);
  });

  it('leaves a ring of children and a burst when it dies', () => {
    const w = createWorld(505, { arenaHalf: 40 });
    place(w, 'broodmother', 6, 0, 1);
    loadSlot(w.slots[0], 0); // the pistol, aimed straight down the line at it
    const splinter = enemyIndex('splinter');

    let spawned = 0;
    let boom = { x: 0, y: 0, r: 0, fellX: 0, fellY: 0 };

    // Stepped rather than run whole, and stopped at the tick the burst resolves: the four
    // children are counted where they land. With the trigger still held the pistol picks
    // two of them off out of the corner of the same shot, which is the gun working exactly
    // as designed and would read here as a split that only made two bodies.
    const f = createInputFrame();
    for (let t = 1; t <= 60; t++) {
      resetFrame(f);
      f.fire = true;
      clearEvents(w);
      step(w, f);

      spawned += spawnedOf(w, splinter);
      const slot = findEvent(w, Ev.Explosion);
      if (slot < 0) continue;
      const fell = findEvent(w, Ev.Kill);
      boom = {
        x: w.events.x[slot],
        y: w.events.y[slot],
        r: w.events.b[slot] / 10,
        fellX: w.events.x[fell],
        fellY: w.events.y[fell],
      };
      break;
    }

    const def = ENEMIES[enemyIndex('broodmother')];
    // The death pays out both halves of its data: the four children it breaks into, and
    // the burst it leaves behind.
    expect(spawned).toBe(def.splits?.count);
    expect(boom.r).toBeCloseTo(def.params.blastRadius, 6);

    // The burst is drawn at the point the death event names, to the centimetre — the shape
    // on the floor is the shape of the damage, rather than a step of flight past it.
    expect(Math.hypot(boom.x - boom.fellX, boom.y - boom.fellY)).toBeLessThan(0.01);

    // Four splinters on the floor, and the player was never close enough to be asked.
    let live = 0;
    for (let i = 0; i < w.enemies.cap; i++) {
      if (w.enemies.alive[i] === 0) continue;
      live++;
      expect(w.enemies.kind[i]).toBe(splinter);
    }
    expect(live).toBe(def.splits?.count);
    expect(w.player.hp).toBe(w.player.maxHp);
  });
});

describe('matron', () => {
  it('closes to its band, holds it, and fans three bolts a volley', () => {
    const w = createWorld(506, { arenaHalf: 40 });
    w.player.hp = 100_000;
    const boss = place(w, 'matron', 14, 0);
    const def = ENEMIES[enemyIndex('matron')];

    let closest = Infinity;
    let biggestFan = 0;
    let shots = 0;
    eachTick(w, 600, () => {}, () => {
      const d = gap(w, boss);
      if (closest > d) closest = d;
      const fired = enemyShots(w);
      if (biggestFan < fired) biggestFan = fired;
      shots += fired;
    });

    // It walked down from fourteen metres into the 6..11 band and stayed in it, and it
    // fired in threes: a body that both holds a band and shoots through it, which is what
    // makes trading shots with it from the open the losing side of the trade.
    expect(shots).toBeGreaterThan(0);
    expect(biggestFan).toBe(def.params.bolts);
    expect(closest).toBeGreaterThanOrEqual(def.params.standMin - 0.2);
  });

  it('mends a wounded pack on its own beat, not on the shot beat', () => {
    const w = createWorld(507, { arenaHalf: 40 });
    w.player.hp = 100_000;
    const a1 = place(w, 'chaser', 7.5, 0, 5);
    const a2 = place(w, 'chaser', 8, 0.5, 5);
    // Pinned in stagger the way the healer test does it: this test is about where the
    // mending comes from, and a walking casualty makes the geometry unreadable.
    w.enemies.state[a1] = 60_000;
    w.enemies.state[a2] = 60_000;
    place(w, 'matron', 10, 0);

    let pulses = 0;
    eachTick(w, 400, () => {}, () => {
      pulses += countType(w, Ev.Heal);
    });

    // Two beats in 6.7 s at a 3 s beat, and both allies came back to full: a magazine of
    // player damage undone twice, which is why the answer is to kill the support first.
    expect(pulses).toBe(2);
    const chaser = ENEMIES[enemyIndex('chaser')];
    expect(w.enemies.hp[a1]).toBe(chaser.hp);
    expect(w.enemies.hp[a2]).toBe(chaser.hp);
    // The boss's aura is the bigger instrument: over twice the healer's reach, half again
    // its price, and it pulses while the fan is still going.
    const healer = ENEMIES[enemyIndex('healer')];
    expect(ENEMIES[enemyIndex('matron')].params.healRange).toBeGreaterThan(healer.params.healRange);
    expect(healer.params.healRange).toBe(5);
  });
});

describe('a boss and its own body', () => {
  it('does not ride a shove, and the same gun staggers a chaser', () => {
    const shotgun = WEAPONS.findIndex((d) => d.id === 'shotgun');
    expect(shotgun).toBeGreaterThan(0);
    expect(WEAPONS[shotgun].knockback).toBeGreaterThan(0);

    const boss = createWorld(508, { arenaHalf: 40 });
    loadSlot(boss.slots[0], shotgun);
    const atlas = place(boss, 'atlas', 5, 0, 4_000);
    let bossStaggered = 0;
    eachTick(boss, 60, (f) => {
      f.fire = true;
    }, () => {
      if (boss.enemies.state[atlas] > 0) bossStaggered++;
    });

    // The control: the same gun at the same range does stagger the trash, so what the boss
    // is missing is the immunity rather than the shot.
    const crowd = createWorld(509, { arenaHalf: 40 });
    loadSlot(crowd.slots[0], shotgun);
    const chaser = place(crowd, 'chaser', 5, 0, 4_000);
    let staggered = 0;
    eachTick(crowd, 60, (f) => {
      f.fire = true;
    }, () => {
      if (crowd.enemies.state[chaser] > 0) staggered++;
    });

    expect(boss.enemies.hp[atlas]).toBeLessThan(4_000);
    expect(crowd.enemies.hp[chaser]).toBeLessThan(4_000);
    expect(bossStaggered).toBe(0);
    expect(staggered).toBeGreaterThan(0);
  });
});
