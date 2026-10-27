import { describe, expect, it } from 'vitest';

import { ENEMIES, enemyIndex } from '../../src/content/enemies';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { queryEnemies, step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { Phase } from '../../src/sim/systems/enemies/shared';
import { createWorld, type World } from '../../src/sim/world';

/**
 * The burrower, and the one rule it exists to prove: a shot cannot hit what it cannot see.
 *
 * Every hit path in the sim finds a body through the spatial hash — the hitscan march, the
 * chain jump, the melee arc, the flying round's segment test, the drone's target scan, the
 * thorns pulse and the burst resolver all query the same grid through the same findability
 * mask — so the grid, not a per-weapon `if`, is what decides who can be hit. That makes
 * "under the floor" one fact rather than thirteen, and it is the fact these tests pin: a body
 * in `Phase.Burrowed` is not in the grid, so nothing can hit it, and it is back in the grid
 * the tick after it is up, so the same shot lands.
 *
 * The mask is a *snapshot*, read at the top of the tick and indexed against the positions the
 * grid is rebuilt from, which is why the tests below ask about the phase as it stood before
 * `step` rather than after: a body that dives mid-tick is still where the grid put it, and a
 * query that disagreed with the grid would be a second answer to the same question.
 *
 * The second half of the rule matters as much as the first: being untargetable must not be free
 * damage. A body under the floor is denied its own touch, and the burst it pays out is
 * announced by a ring before it lands, so the player is never asked to answer something they
 * could not see coming. The middle fixture is the same six seconds played two ways — standing,
 * and walking — and the whole difference between the two is whether the player read the ring.
 */

/** Put one burrower down, and hand back its slot so the assertions read as "it". */
function placeBurrower(w: World, x: number, y: number): number {
  const i = spawnEnemy(w, enemyIndex('burrower'), x, y);
  expect(w.enemies.kind[i], 'the burrower is in the table').toBe(
    ENEMIES.findIndex((d) => d.id === 'burrower')
  );
  return i;
}

/** Is slot `i` in the buffer the shared hit query just filled? */
function findable(w: World, i: number): boolean {
  const n = queryEnemies(w, w.enemies.x[i], w.enemies.y[i], 3);
  for (let k = 0; k < n; k++) if (w.query[k] === i) return true;
  return false;
}

/** Any body at all under the floor this tick? */
function anyoneBuried(w: World): boolean {
  for (let k = 0; k < w.enemies.cap; k++) {
    if (w.enemies.phase[k] === Phase.Burrowed) return true;
  }
  return false;
}

describe('a body under the floor', () => {
  it('leaves the broad phase while it digs and comes back into it when it surfaces', () => {
    const w = createWorld(0xbeef, { arenaHalf: 40 });
    // Enough life that the run is about what the burrower does, not about the player dying.
    w.player.maxHp = 1000;
    w.player.hp = 1000;

    // Eight metres out: the band it digs from, close enough for the trench to reach and far
    // enough that going under the floor is worth the second it costs.
    const i = placeBurrower(w, 0, -8);

    const f = createInputFrame();
    let buried = 0;
    let surfaced = 0;

    for (let t = 1; t <= 400; t++) {
      resetFrame(f);
      // As the tick starts, which is how the grid was built: the mask and the grid are both
      // written before anything moves, so this is the same fact they were indexed from.
      const hidden = w.enemies.phase[i] === Phase.Burrowed;
      if (hidden) buried++;
      else surfaced++;

      step(w, f);
      if (w.enemies.alive[i] === 0) continue;

      // The mask and the phase may never disagree about what the grid was allowed to hold, and
      // the query must answer with the mask.
      expect(w.hash.findable[i], `tick ${t}: mask`).toBe(hidden ? 0 : 1);
      expect(findable(w, i), `tick ${t}: query`).toBe(!hidden);

      if (hidden) {
        // Not the auto-fire's target either, which is the other half of "untargetable is not
        // free damage": a gun that woke for it would spend its ammo on a hole in the floor.
        expect(w.nearest, `tick ${t}: auto-fire aimed at a buried body`).not.toBe(i);
      }
    }

    // It went down and it came back up, so both halves of the loop above were exercised.
    expect(buried, 'never dug').toBeGreaterThan(0);
    expect(surfaced, 'never surfaced').toBeGreaterThan(0);
    expect(w.errors).toBe(0);
  });

  it('buys the player a ring long enough to leave, and only hits one who stayed', () => {
    const played = (walk: boolean): { hp: number; buried: number; buriedHits: number } => {
      const w = createWorld(0x5e7, { arenaHalf: 40 });
      w.player.maxHp = 1000;
      w.player.hp = 1000;
      placeBurrower(w, 0, -6);

      const f = createInputFrame();
      let buried = 0;
      let buriedHits = 0;

      for (let t = 1; t <= 360; t++) {
        resetFrame(f);
        if (walk) {
          // Straight away from it at full speed, from the tick it dove: the answer the
          // archetype asks for, taken early and kept taking.
          f.moveY = 1;
        }
        const anyBuried = anyoneBuried(w);
        if (anyBuried) buried++;

        const before = w.player.hp;
        step(w, f);

        // Damage may only ever land on a tick when nothing was underground to begin with.
        // Anything else would be a hit with no tell in front of it.
        if (w.player.hp < before && anyBuried) buriedHits++;
      }

      return { hp: w.player.hp, buried, buriedHits };
    };

    const stood = played(false);
    const walked = played(true);

    expect(stood.buriedHits, 'a buried body dealt damage').toBe(0);
    // The standing player is punished: this is a fight the player can win, so standing in the
    // ring has to cost something.
    expect(stood.hp, 'standing in the ring cost nothing').toBeLessThan(1000);

    // And the one who kept moving is not touched at all: the trench commits to a line rather
    // than chasing, so it overshoots and comes up as a body you can kill.
    expect(walked.buriedHits, 'a buried body dealt damage').toBe(0);
    expect(walked.hp, 'walking out of the line still cost HP').toBe(1000);
    expect(walked.buried, 'it never went under while the player ran').toBeGreaterThan(0);
  });

  it('is out of the drone target ring while it digs, and back in it once it is up', () => {
    /**
     * Sixty ticks with the burrower held under the floor, or held above it.
     *
     * The companion's whole target step is one query of a 14 m ring around the player through
     * the same buffer and the same mask the weapons use, so the ring is asked the question the
     * drone asks, and the two runs differ in one fact: whether the body is in the grid.
     */
    const ring = (buried: boolean): boolean[] => {
      const w = createWorld(0xd0de, { arenaHalf: 40 });
      w.player.maxHp = 1000;
      w.player.hp = 1000;
      const i = placeBurrower(w, 0, -8);
      w.stats.drone = 1;

      const seen: boolean[] = [];
      const f = createInputFrame();
      for (let t = 1; t <= 60; t++) {
        resetFrame(f);
        if (buried) {
          // The phase is what the mask is built from and the timer is what would otherwise let
          // it up before the run ends.
          w.enemies.phase[i] = Phase.Burrowed;
          w.enemies.timer[i] = 5;
        }
        const n = queryEnemies(w, w.player.x, w.player.y, 14);
        let hit = false;
        for (let k = 0; k < n; k++) if (w.query[k] === i) hit = true;
        seen.push(hit);
        step(w, f);
      }

      return seen;
    };

    const buried = ring(true);
    const above = ring(false);

    expect(buried.includes(true), 'a buried body was in the target ring').toBe(false);
    expect(above.includes(true), 'nobody above ground was in the target ring').toBe(true);
  });
});
