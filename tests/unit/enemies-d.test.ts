/**
 * The two bodies that do not walk at you, checked as behaviour driven through `step()`.
 *
 * `tests/unit/enemies-b.test.ts` pinned the ranged trio, which all travel the floor between
 * here and there like everything else. These two are the exceptions and each one is a
 * different kind of exception, so they are a file of their own rather than two more blocks
 * in that one:
 *
 * - The teleporter crosses its approach in a tick (`systems/enemies/phaser.ts`). What is
 *   pinned here is the bargain that makes that fair: the strip painted on the floor is
 *   exactly as long as the strip it spends, it lies there for thirty ticks — past DESIGN.md's
 *   400 ms floor — and it is spent down a bearing chosen before the player did anything, so a
 *   player who moved after the flash is standing somewhere the line was not.
 * - The spawner does all its damage through bodies it adds (`systems/enemies/nursery.ts`).
 *   What is pinned here is the beat they arrive on, the distance it keeps while it still has
 *   young in it, and where it puts them: behind itself, out beyond its own skin, so chasing
 *   it means walking through the trail it laid.
 *
 * The fixtures place bodies by hand rather than through the wave spawner: these tests are
 * about what one archetype does with the floor around it, and a drumbeat batch would put
 * other bodies in the room and make the distances unreadable.
 */

import { describe, expect, it } from 'vitest';
import { ENEMIES, enemyIndex } from '../../src/content/enemies';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { installLayout } from '../../src/sim/systems/obstacles';
import { DT, Ev, Tele, clearEvents, createWorld, type World } from '../../src/sim/world';

/** Put one archetype down by id. */
function place(w: World, id: string, x: number, y: number): number {
  return spawnEnemy(w, enemyIndex(id), x, y);
}

/** Distance from a body slot to the player's centre. */
function gap(w: World, i: number): number {
  return Math.hypot(w.enemies.x[i] - w.player.x, w.enemies.y[i] - w.player.y);
}

/** How many telegraph strips of `kind` the tick just run painted. */
function tells(w: World, kind: number): number {
  const e = w.events;
  let n = 0;
  for (let k = 0; k < e.count; k++) {
    const slot = (e.head - e.count + k + e.cap * 2) % e.cap;
    if (e.type[slot] === Ev.Telegraph && e.b[slot] === kind) n++;
  }
  return n;
}

/** Archetype ids put down by the tick just run, off the `Spawn` ring. */
function landed(w: World): string[] {
  const e = w.events;
  const out: string[] = [];
  for (let k = 0; k < e.count; k++) {
    const slot = (e.head - e.count + k + e.cap * 2) % e.cap;
    if (e.type[slot] === Ev.Spawn) out.push(ENEMIES[e.b[slot]].id);
  }
  return out;
}

describe('teleporter', () => {
  const def = ENEMIES[enemyIndex('teleporter')];

  /**
   * Run one teleporter a tick at a time, logging the tick it paints a line, the distance it
   * travelled on any tick that moved it more than 4 m, and the gap at both.
   */
  function phasing(
    seed: number,
    start: [number, number],
    flee = false,
  ): {
    tells: [number, number][];
    jumps: [number, number, number][];
    crossed: boolean;
    hp: number;
  } {
    const w = createWorld(seed, { arenaHalf: 40 });
    w.player.hp = 1000;
    const body = place(w, 'teleporter', start[0], start[1]);
    const f = createInputFrame();
    const painted: [number, number][] = [];
    const jumped: [number, number, number][] = [];
    let crossed = false;

    for (let t = 1; t <= 220; t++) {
      resetFrame(f);
      // The escape starts on the second tick: the line was already painted on the first, so
      // this is the case the archetype exists to serve — a player who read it and moved.
      if (flee && t >= 2) f.moveX = 1;
      clearEvents(w);
      const bx = w.enemies.x[body];
      const by = w.enemies.y[body];
      step(w, f);
      if (tells(w, Tele.Line) > 0) painted.push([t, gap(w, body)]);
      const moved = Math.hypot(w.enemies.x[body] - bx, w.enemies.y[body] - by);
      if (moved > 4) {
        jumped.push([t, moved, gap(w, body)]);
        crossed = true;
      }
    }

    return { tells: painted, jumps: jumped, crossed, hp: w.player.hp };
  }

  it('paints the line for thirty ticks, then spends the whole of it', () => {
    const still = phasing(91, [0, 9]);

    // It armed inside its band: nine metres is between `phaseMin` (no room to read eight
    // metres of line at arm's length) and `armRange` (past it, a phase is only a shortcut and
    // not worth a tell). One phase, because the window is shorter than the cycle: half a
    // second of wind-up, a fifth of a second of run, a third of recover and a second and a
    // half of cooldown, and a body that spent its phase on top of the player has to walk back
    // out of `phaseMin` before it will draw another line.
    expect(still.tells.length, 'a stationary player should be phased at').toBe(1);
    expect(still.crossed, 'and the line should be spent').toBe(true);

    const [tellTick, tellGap] = still.tells[0];
    expect(tellGap).toBeGreaterThanOrEqual(def.params.phaseMin);
    expect(tellGap).toBeLessThanOrEqual(def.params.armRange);

    const jump = still.jumps[0];
    expect(jump).toBeDefined();
    const [jumpTick, jumpDist] = jump!;

    // Thirty ticks of standing still between the flash and the jump — the whole `windup`,
    // which is half a second and therefore above DESIGN.md's 400 ms floor for a tell a player
    // has to answer. Shorter than this and the strip is decoration; the runner also takes its
    // feet off the throttle for the whole of it, so the line is not drawn by something
    // already moving.
    expect(jumpTick - tellTick).toBe(30);
    expect((jumpTick - tellTick) * DT).toBeGreaterThanOrEqual(0.4);

    // The first move is the whole of `phaseSkip` — five metres in one tick, which is no way
    // for anything to travel and is the reason this file is not more blocks in
    // `enemies-b.test.ts`. What makes it legal rather than a cheat is the next assertion: the
    // painted line is exactly the line it spends, so the strip on the floor said all of this.
    expect(jumpDist).toBeCloseTo(def.params.phaseSkip, 4);
    expect(def.params.dashReach).toBeCloseTo(
      def.params.phaseSkip + def.params.phaseSpeed * def.params.phaseTime,
      9,
    );
  });

  it('hits a player who stays inside the line it was shown', () => {
    expect(phasing(92, [0, 9]).hp).toBeLessThan(1000);
  });

  it('spends the line on the floor a player who moved left behind', () => {
    const fled = phasing(92, [0, 9], true);

    // The same phase happened — nothing was given up to make the dodge possible — but it
    // landed on empty floor: the bearing was locked the tick the flash started, so a body
    // that turned to follow would be a homing missile with a shorter wind-up. The player who
    // read it is standing more than three metres from where it arrived, and still whole.
    expect(fled.crossed).toBe(true);
    expect(fled.jumps[0]![2]).toBeGreaterThan(3);
    expect(fled.hp).toBe(1000);
  });

  it('never promises a line that runs through cover', () => {
    const w = createWorld(93, { arenaHalf: 40 });
    w.player.hp = 1000;
    // A wall straight across the approach, in the middle of the eight metres it would have
    // painted. `kind: 0` is cover, and it is written by hand here because the test is about
    // one rectangle of floor rather than a chapter's layout.
    installLayout(w, [{ kind: 0, x: 0, y: 4.5, w: 30, h: 1.5 }]);
    const body = place(w, 'teleporter', 0, 9);

    const f = createInputFrame();
    let painted = 0;
    let crossed = false;
    let nearest = Infinity;
    for (let t = 1; t <= 200; t++) {
      resetFrame(f);
      clearEvents(w);
      const bx = w.enemies.x[body];
      const by = w.enemies.y[body];
      step(w, f);
      painted += tells(w, Tele.Line);
      if (Math.hypot(w.enemies.x[body] - bx, w.enemies.y[body] - by) > 4) crossed = true;
      nearest = Math.min(nearest, w.enemies.y[body]);
    }

    // Nothing to answer and nothing arriving: the whole segment is tested *before* the tell
    // goes out, so the strip is not drawn and then crossed through the wall. The body stays
    // on the far side of the cover it was shown, which is the same rule every walk obeys.
    expect(painted, 'no line through a wall').toBe(0);
    expect(crossed, 'no jump through a wall').toBe(false);
    expect(nearest).toBeGreaterThan(4.5 + 0.75);
  });

  it('only commits inside its band', () => {
    // At arm's length there are no eight metres of floor to read, so it walks instead. The
    // window is three quarters of a second long and it never once paints a strip.
    const close = phasing(94, [0, 3]);
    expect(close.tells, 'no phase inside `phaseMin`').toEqual([]);
    expect(close.crossed).toBe(false);

    // Out past `armRange` it has to come in first, and it does not waste a tell on a line
    // that would stop short of the player. Somewhere on the way in it found the band.
    const far = phasing(95, [0, 20]);
    expect(far.tells.length, 'a body twenty metres out should find its band').toBeGreaterThan(0);
    expect(far.tells[0]![1]).toBeLessThanOrEqual(def.params.armRange);
    expect(far.crossed).toBe(true);
  });
});

describe('spawner', () => {
  const def = ENEMIES[enemyIndex('spawner')];

  it('pays out three broods of three on its beat, then stops', () => {
    const w = createWorld(96, { arenaHalf: 40 });
    w.player.hp = 1000;
    place(w, 'spawner', 0, 12);

    const f = createInputFrame();
    const broods: [number, number][] = [];
    for (let t = 1; t <= 900; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);
      const n = landed(w).filter((id) => id === 'spawnling').length;
      if (n > 0) broods.push([t, n]);
    }

    // Three broods, three young each, and then nothing: the faucet runs dry and what is left
    // is a fat body that only walks at you. `spawnBroods` and `spawnCount` are the two
    // numbers that decide this, and nine bodies are the whole of its damage.
    expect(broods.length, 'three broods').toBe(def.params.spawnBroods);
    expect(broods.every((b) => b[1] === def.params.spawnCount), 'three young each').toBe(true);

    // On a beat, and wound at spawn rather than primed: the first brood lands 2.8 s after it
    // arrives, the same grace the broodmother gets, and the two behind it are exactly one beat
    // apart. A spawner that dropped a brood on arrival would put nine bodies on the floor the
    // tick it appeared. The beat is 169 ticks rather than 168 because the tick a brood is paid
    // out on is not charged to the next cooldown.
    const beat = Math.round(def.params.spawnGap / DT) + 1;
    expect(broods[0]![0]).toBe(beat);
    for (let i = 1; i < broods.length; i++) {
      expect(broods[i]![0] - broods[i - 1]![0]).toBe(beat);
    }
    expect(w.errors).toBe(0);
  });

  it('holds its band while armed and presses once dry', () => {
    const w = createWorld(97, { arenaHalf: 40 });
    w.player.hp = 1000;
    const body = place(w, 'spawner', 0, 12);
    const dry = Math.round((3 * def.params.spawnGap) / DT) + 1;

    const f = createInputFrame();
    let armedMin = Infinity;
    let dryMin = Infinity;
    for (let t = 1; t <= 800; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);
      const d = gap(w, body);
      if (t <= dry) armedMin = Math.min(armedMin, d);
      else dryMin = Math.min(dryMin, d);
    }

    // While it still has young in it, it gives ground: it came in from twelve metres, stopped
    // at its 5 m `keepMin` and sat there, which is what makes the young arrive in front of a
    // player who walked at it. Killing it on the way in is the answer, and it is meant to be.
    expect(armedMin).toBeGreaterThanOrEqual(4.4);

    // Once the broods are gone the same body becomes a brawler: 1.15x its cruise, all the way
    // in. The trail it laid is the price of the chase, which is the sentence the archetype is.
    expect(dryMin).toBeLessThan(2.5);
  });

  it('lands its young behind itself, clear of its own body', () => {
    const w = createWorld(98, { arenaHalf: 40 });
    w.player.hp = 1000;
    const body = place(w, 'spawner', 0, 12);

    const f = createInputFrame();
    const young: [number, number, number][] = [];
    for (let t = 1; t <= 900; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);
      const e = w.events;
      for (let k = 0; k < e.count; k++) {
        const slot = (e.head - e.count + k + e.cap * 2) % e.cap;
        if (e.type[slot] !== Ev.Spawn) continue;
        if (ENEMIES[e.b[slot]].id !== 'spawnling') continue;
        // `a` names the pool slot the spawn wrote and `x`/`y` the point it was put down at —
        // the only place a landing point still exists once the body has started walking.
        young.push([
          Math.hypot(e.x[slot] - w.enemies.x[body], e.y[slot] - w.enemies.y[body]),
          Math.hypot(e.x[slot] - w.player.x, e.y[slot] - w.player.y),
          gap(w, body),
        ]);
      }
    }

    expect(young.length).toBe(def.params.spawnBroods * def.params.spawnCount);
    for (const [fromParent, fromPlayer, parentPlayer] of young) {
      // Out beyond the parent's own skin, so the brood is a fan and not one lane, and so no
      // body spawns inside the body that made it: `spawnSpread` beyond the two radii, read
      // here as the ring they are laid on.
      expect(fromParent).toBeGreaterThan(def.params.spawnSpread);
      // And farther from the player than the parent is. A trail that landed in front of the
      // sac would be an ambush, which is the one arrival rule the chapter scripts keep.
      expect(fromPlayer).toBeGreaterThan(parentPlayer + 1.2);
    }
  });
});
