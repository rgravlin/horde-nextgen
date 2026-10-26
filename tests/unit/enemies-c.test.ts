import { describe, expect, it } from 'vitest';
import { ENEMIES, enemyIndex } from '../../src/content/enemies';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { Phase } from '../../src/sim/systems/enemies/shared';
import { DT, Ev, Tele, clearEvents, createWorld, type World } from '../../src/sim/world';

/**
 * The two marks: the sniper and the orbiter, checked as behaviour driven through `step()`.
 *
 * `tests/unit/enemies-a.test.ts` pinned the melee five and `enemies-b.test.ts` the ranged
 * trio; this pins the pair that shares `systems/enemies/marksmen.ts`, and what they share is
 * the thing worth pinning. Both decide a line the tick their tell starts and then do nothing
 * about it: no steering, no lookahead, no second chance. So half of what follows is one fact
 * read from either side — a player who stands still in a painted line is hit, a player who
 * starts moving after it is painted is not — because the first half alone would also pass if
 * the bolt simply missed everyone, which is not a telegraph but noise.
 *
 * The other half is feet. A sniper is pinned by the band it works from and an orbiter by the
 * ring it walks, and both are pinned over long runs rather than one tick, because a circle that
 * holds for a second and then collapses into a hug looks identical in a short fixture and plays
 * nothing like the game.
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

/** The slot of the first sight-line telegraph in the ring, or -1. */
function firstSightLine(w: World): number {
  const e = w.events;
  for (let k = 0; k < e.count; k++) {
    const slot = (e.head - e.count + k + e.cap * 2) % e.cap;
    if (e.type[slot] === Ev.Telegraph && e.b[slot] === Tele.Line) return slot;
  }
  return -1;
}

describe('sniper', () => {
  it('closes from outside its band, stops at the band, and shoots from it', () => {
    const w = createWorld(41, { arenaHalf: 40 });
    w.player.hp = 1000; // this test is about distance, not death
    const sniper = place(w, 'sniper', 0, 22);
    const def = ENEMIES[enemyIndex('sniper')];

    let closest = Infinity;
    let minHeld = Infinity;
    let maxHeld = 0;
    let shots = 0;

    const f = createInputFrame();
    for (let t = 1; t <= 400; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);
      const d = gap(w, sniper);
      if (d < closest) closest = d;
      if (t >= 150) {
        if (d > maxHeld) maxHeld = d;
        if (d < minHeld) minHeld = d;
      }
      shots += enemyShots(w);
    }

    // It came in from twenty-two metres because that is where it was put, and it stopped at
    // the band's outer edge rather than walking in to hug. A chaser with a gun would press to
    // contact; the whole archetype is that it does not, which is why the bolt arrives out of
    // fifteen metres of open floor with three quarters of a second of line drawn behind it.
    expect(closest).toBeLessThan(21);
    expect(closest).toBeGreaterThanOrEqual(def.params.bandMin);
    expect(minHeld).toBeGreaterThanOrEqual(def.params.bandMin);
    expect(maxHeld).toBeLessThanOrEqual(def.params.bandMax + 0.2);
    expect(shots).toBeGreaterThan(0);
  });

  it('gives ground to its band when it starts inside it, then shoots from the band', () => {
    const w = createWorld(42, { arenaHalf: 40 });
    w.player.hp = 1000;
    const sniper = place(w, 'sniper', 0, 5);
    const def = ENEMIES[enemyIndex('sniper')];

    let furthest = 0;
    let shots = 0;

    const f = createInputFrame();
    for (let t = 1; t <= 300; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);
      const d = gap(w, sniper);
      if (d > furthest) furthest = d;
      shots += enemyShots(w);
    }

    // Backed out from five metres and delivered from the band, which is the other half of the
    // rule: a body that only ever closed would stand on top of a player who walked at it and
    // fire a bolt that needed no answer at all.
    expect(furthest).toBeGreaterThan(def.params.bandMin);
    expect(furthest).toBeLessThanOrEqual(def.params.bandMax);
    expect(shots).toBeGreaterThan(0);
  });

  it('hits a player who never moves, twice in five seconds', () => {
    const w = createWorld(43, { arenaHalf: 40 });
    w.player.hp = 1000;
    place(w, 'sniper', 0, 13);
    const def = ENEMIES[enemyIndex('sniper')];

    let hits = 0;
    let hp = w.player.hp;

    const f = createInputFrame();
    for (let t = 1; t <= 300; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);
      if (w.player.hp < hp) {
        hits++;
        hp = w.player.hp;
      }
    }

    // The control. Standing in a painted line costs the full price of the bolt, twice, and
    // neither hit is luck: the line was drawn at thirteen metres and held for three quarters
    // of a second before the round left, at a player who never changed anything.
    expect(hits).toBe(2);
    expect(1000 - w.player.hp).toBeGreaterThanOrEqual(2 * def.params.boltDamage);
  });

  it('spends its bolt on the floor a player left after the line was locked', () => {
    const w = createWorld(44, { arenaHalf: 40 });
    w.player.hp = 1000;
    place(w, 'sniper', 0, 13);

    const f = createInputFrame();
    let running = false;
    let bolts = 0;
    let tellTick = -1;

    for (let t = 1; t <= 300; t++) {
      resetFrame(f);
      // Sideways escape, started the tick the sight line appeared and held: what the tell is
      // there to allow. The line was taken before the first step, so the bolt is already aimed
      // at empty floor by the time the player is moving.
      if (running) f.moveX = 1;
      clearEvents(w);
      step(w, f);

      if (tellTick < 0 && firstSightLine(w) >= 0) {
        tellTick = t;
        running = true;
      }
      bolts += enemyShots(w);
    }

    // The bolt went — it is not that nothing happened — and it paid out on floor, against a
    // player who had 0.77 s of sideways walk before it left. This is the half of the pair that
    // makes the test above mean something: a bolt that could not be answered would hit here
    // too, and the game would be asking the player to read a line that moved.
    expect(tellTick).toBeGreaterThan(0);
    expect(bolts).toBeGreaterThan(0);
    expect(w.player.hp).toBe(1000);
    expect(w.over).toBe(false);
  });

  it('draws the sight line for at least 36 ticks before the bolt leaves', () => {
    const w = createWorld(45, { arenaHalf: 40 });
    w.player.hp = 1000;
    const sniper = place(w, 'sniper', 0, 13);
    const def = ENEMIES[enemyIndex('sniper')];

    let tellTick = -1;
    let tellTimer = 0;
    let shotTick = -1;
    let duringWindow = 0;

    const f = createInputFrame();
    for (let t = 1; t <= 200 && shotTick < 0; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);

      if (tellTick < 0) {
        if (firstSightLine(w) >= 0) {
          tellTick = t;
          tellTimer = w.enemies.timer[sniper];
        }
      } else {
        const shots = enemyShots(w);
        // The 36 ticks are the window, counted rather than sampled: a bolt anywhere inside it
        // would be a shot fired into its own telegraph, which is a shot nobody was offered.
        if (t <= tellTick + 36) duringWindow += shots;
        else if (shots > 0) shotTick = t;
      }
    }

    expect(tellTick).toBeGreaterThan(0);
    expect(duringWindow).toBe(0);
    expect(shotTick).toBeGreaterThan(0);
    expect(shotTick - tellTick).toBeGreaterThan(36);
    expect((shotTick - tellTick) * DT).toBeGreaterThanOrEqual(0.4);
    // Six decimals rather than ten: the timer lives in a Float32Array.
    expect(tellTimer).toBeCloseTo(def.params.windup, 6);
  });
});

describe('orbiter', () => {
  /** How far off its ring it may be read as still walking one. */
  const SLACK = 0.15;

  it('holds its ring for five seconds of a player standing still, and shoots from it', () => {
    const w = createWorld(46, { arenaHalf: 40 });
    w.player.hp = 1000;
    const orbiter = place(w, 'orbiter', 0, 9.5);
    const def = ENEMIES[enemyIndex('orbiter')];
    const ring = def.params.orbitRadius;

    let minHeld = Infinity;
    let maxHeld = 0;
    let bolts = 0;

    const f = createInputFrame();
    for (let t = 1; t <= 300; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);
      const d = gap(w, orbiter);
      // The first second is the approach: it was put down at 9.5 m and walked in. What this
      // test is about is the four seconds of circle after that.
      if (t > 60) {
        if (d < minHeld) minHeld = d;
        if (d > maxHeld) maxHeld = d;
      }
      bolts += enemyShots(w);
    }

    // 6.5 m give or take a centimetre, for four seconds straight: the ring is held rather than
    // visited. Two fans of three went out of it, and the player standing in the middle of that
    // circle paid a round per fan, which is what a strafing shooter costs a player who answers
    // it by standing still.
    expect(minHeld).toBeGreaterThanOrEqual(ring * (1 - SLACK));
    expect(maxHeld).toBeLessThanOrEqual(ring * (1 + SLACK));
    expect(bolts).toBeGreaterThanOrEqual(6);
    expect(w.player.hp).toBeLessThan(1000);
  });

  it('keeps the ring while the player runs, and keeps firing from it', () => {
    const w = createWorld(47, { arenaHalf: 400 });
    w.player.hp = 100000;
    const orbiter = place(w, 'orbiter', 0, 9.5);
    const def = ENEMIES[enemyIndex('orbiter')];
    const ring = def.params.orbitRadius;

    let minHeld = Infinity;
    let maxHeld = 0;
    let bolts = 0;

    const f = createInputFrame();
    for (let t = 1; t <= 400; t++) {
      resetFrame(f);
      // A held straight run, from a player fast enough to keep outrunning it: the spring is
      // what this test is really about, because a circle that only holds against a statue is a
      // habit rather than a behaviour.
      if (t > 30) f.moveX = 1;
      clearEvents(w);
      step(w, f);
      const d = gap(w, orbiter);
      if (t > 120) {
        if (d < minHeld) minHeld = d;
        if (d > maxHeld) maxHeld = d;
      }
      bolts += enemyShots(w);
    }

    // It chased rather than watched, stayed on its ring while it did, and still spent its fans
    // on the way. Read from the third second onward for the same reason the still test waits:
    // the first stretch is the body finding the ring it started outside.
    expect(minHeld).toBeGreaterThanOrEqual(ring * (1 - SLACK));
    expect(maxHeld).toBeLessThanOrEqual(ring * (1 + SLACK));
    expect(bolts).toBeGreaterThanOrEqual(3);
  });

  it('walks the circle while the line is up and spends a three-round fan at the end of it', () => {
    const w = createWorld(48, { arenaHalf: 40 });
    w.player.hp = 1000;
    const orbiter = place(w, 'orbiter', 0, 9.5);
    const def = ENEMIES[enemyIndex('orbiter')];

    let tellTick = -1;
    let tellTimer = 0;
    let shotTick = -1;
    let bolts = 0;
    let slowest = Infinity;

    const f = createInputFrame();
    for (let t = 1; t <= 300 && shotTick < 0; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);

      if (tellTick < 0) {
        if (firstSightLine(w) >= 0) {
          tellTick = t;
          tellTimer = w.enemies.timer[orbiter];
        }
      }
      // Its feet, read over the whole sight window. This is the file's other design decision:
      // the line is pinned for the wind-up and the strafe deliberately is not, so the bearing a
      // player is shown is a bearing that is leaving them rather than one they are standing in.
      if (w.enemies.phase[orbiter] === Phase.Windup) {
        const sp = Math.hypot(w.enemies.vx[orbiter], w.enemies.vy[orbiter]);
        if (sp < slowest) slowest = sp;
      }
      const shots = enemyShots(w);
      if (shots > 0) {
        shotTick = t;
        bolts = shots;
      }
    }

    expect(tellTick).toBeGreaterThan(0);
    expect(shotTick).toBeGreaterThan(0);

    // 27 ticks of sight line: over DESIGN.md's 400 ms floor, and worth the time because the
    // body keeps moving through all of it.
    expect(shotTick - tellTick).toBeGreaterThanOrEqual(24);
    expect((shotTick - tellTick) * DT).toBeGreaterThanOrEqual(0.4);
    expect(tellTimer).toBeCloseTo(def.params.windup, 6);

    // Three rounds, not one: the fan is what makes the strafe worth having, since a single
    // bolt from a body that keeps turning is aimed at a bearing that stopped existing the tick
    // the wind-up started.
    expect(bolts).toBe(def.params.bolts);

    // 78 % of its cruise at the slowest tick of the window, which is what "it shoots from the
    // circle rather than from a stop" is worth as a number.
    expect(slowest).toBeGreaterThanOrEqual(def.speed * 0.7);
  });

  it('fans the floor a player who waited for the tell then walked has left behind', () => {
    const w = createWorld(49, { arenaHalf: 40 });
    w.player.hp = 1000;
    place(w, 'orbiter', 0, 9.5);

    const f = createInputFrame();
    let running = false;
    let bolts = 0;
    let tellTick = -1;
    let fanTick = -1;

    for (let t = 1; t <= 300; t++) {
      resetFrame(f);
      if (running) f.moveX = 1;
      clearEvents(w);
      step(w, f);

      if (tellTick < 0 && firstSightLine(w) >= 0) {
        tellTick = t;
        running = true;
      }
      bolts += enemyShots(w);
      if (fanTick < 0 && bolts > 0) fanTick = t;
      // The first fan only, plus the time its slowest round needs to cross the ring. What
      // happens later is a different fact and not a comfortable one: once a player has been
      // holding one straight line for seconds, the lead taken from that line lands, which is
      // the same deal the sniper's pair makes. Reading the whole run as "dodged" would quietly
      // unpin the difference between a telegraph and a lottery.
      if (fanTick > 0 && t > fanTick + 45) break;
    }

    // The fan went — it is not that nothing happened — and it paid out on floor, against a
    // player who had 0.45 s of sideways walk before the first round left and more while it
    // flew. Same pair as the sniper's, from the body that does not stop to take aim.
    expect(tellTick).toBeGreaterThan(0);
    expect(bolts).toBeGreaterThanOrEqual(3);
    expect(w.player.hp).toBe(1000);
    expect(w.over).toBe(false);
  });
});
