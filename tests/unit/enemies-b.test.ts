import { describe, expect, it } from 'vitest';
import { ENEMIES, enemyIndex } from '../../src/content/enemies';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { launchBolt } from '../../src/sim/systems/enemyProjectiles';
import {
  DT,
  Ev,
  Tele,
  TUNE,
  clearEvents,
  createWorld,
  findEvent,
  type World,
} from '../../src/sim/world';
import { startWaves } from '../../src/sim/systems/waves';

/**
 * The ranged trio and the round pool they spend themselves through, checked as
 * behaviour driven through `step()`.
 *
 * `tests/unit/enemies-a.test.ts` pinned the melee-side five; this file pins the
 * three bodies that act at range, which means it also pins the `enemyShots` pool
 * they share — the segment hit-test, the i-frame gate, and the clamped burst that
 * lands where its telegraph ring was drawn rather than a step past it. A test that
 * stood the player in a ring and one that walked them out of it are a pair on
 * purpose: "damage lands at the telegraphed spot" and "dodging it works" are the
 * same fact read from either side, and the pair is what makes either one mean
 * something.
 *
 * Like the other behaviour file, several tests step one tick at a time with the
 * event ring cleared first, because a tell has to be pinned to the tick it entered
 * the ring on — telegraph-to-shot gaps are the subject, not incidental detail.
 */

/** Put one archetype down by id, with the HP the fight needs rather than the default. */
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

describe('shooter', () => {
  it('closes to its band, holds it, and shoots from it', () => {
    const w = createWorld(31, { arenaHalf: 40 });
    w.player.hp = 1000; // this test is about distance, not death
    const shooter = place(w, 'shooter', 12, 0);

    let minAll = Infinity;
    let maxHeld = 0;
    let minHeld = Infinity;
    let shots = 0;

    const f = createInputFrame();
    for (let t = 1; t <= 300; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);
      const d = gap(w, shooter);
      if (d < minAll) minAll = d;
      if (t >= 100) {
        if (d > maxHeld) maxHeld = d;
        if (d < minHeld) minHeld = d;
      }
      shots += enemyShots(w);
    }

    // It came in from twelve metres (it started beyond its band and chose to work
    // inside it) and it never once crossed the band's inner edge to go hug. The
    // second fact is the behaviour: a chaser with a gun would press to contact.
    expect(shots).toBeGreaterThan(0);
    expect(minAll).toBeGreaterThanOrEqual(4.4);
    expect(minHeld).toBeGreaterThanOrEqual(7.9);
    expect(maxHeld).toBeLessThanOrEqual(8.11);
  });

  it('gives ground to its band when the player stands inside it, then shoots', () => {
    const w = createWorld(39, { arenaHalf: 40 });
    w.player.hp = 1000;
    const shooter = place(w, 'shooter', 2.5, 0);

    let minAfter = Infinity;
    let maxAfter = 0;
    let shots = 0;

    const f = createInputFrame();
    for (let t = 1; t <= 200; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);
      if (t > 60) {
        const d = gap(w, shooter);
        if (d < minAfter) minAfter = d;
        if (d > maxAfter) maxAfter = d;
      }
      shots += enemyShots(w);
    }

    // It backed out of the band rather than shooting point-blank, stopped at its
    // standMin (4.5 m), and delivered from there. The player standing still is the
    // control: the bolt is only unreadable if you never move.
    expect(minAfter).toBeGreaterThanOrEqual(4.4);
    expect(maxAfter).toBeLessThanOrEqual(4.6);
    expect(shots).toBeGreaterThanOrEqual(1);
    expect(w.player.hp).toBeLessThan(1000);
  });

  it('flashes for at least 24 ticks before the bolt leaves', () => {
    const w = createWorld(38, { arenaHalf: 40 });
    w.player.hp = 1000;
    const shooter = place(w, 'shooter', 8.5, 0);
    const def = ENEMIES[enemyIndex('shooter')];

    let tellTick = -1;
    let shotTick = -1;
    let tellTimer = 0;

    const f = createInputFrame();
    for (let t = 1; t <= 200 && shotTick < 0; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);

      if (tellTick < 0) {
        const slot = firstTelegraph(w, Tele.Line);
        if (slot >= 0) {
          tellTick = t;
          tellTimer = w.enemies.timer[shooter];
        }
      }
      if (enemyShots(w) > 0) shotTick = t;
    }

    expect(tellTick).toBeGreaterThan(0);
    expect(shotTick).toBeGreaterThan(0);

    // 24 ticks is DESIGN.md's 400 ms floor for a tell a player must answer, and the
    // wind-up is exactly that long: the flash precedes the shot by the whole wind-up.
    expect(shotTick - tellTick).toBeGreaterThanOrEqual(24);
    expect((shotTick - tellTick) * DT).toBeGreaterThanOrEqual(0.4);
    // Six decimals rather than ten: the timer lives in a Float32Array.
    expect(tellTimer).toBeCloseTo(def.params.windup, 6);
  });
});

describe('grenadier', () => {
  it('bursts at the point it rang, and the player standing in it pays', () => {
    const w = createWorld(33, { arenaHalf: 40 });
    const def = ENEMIES[enemyIndex('grenadier')];
    place(w, 'grenadier', 0, 8);

    let ring: { x: number; y: number; tick: number } | undefined;
    let boom: { x: number; y: number; tick: number } | undefined;

    const f = createInputFrame();
    for (let t = 1; t <= 120 && !boom; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);

      const slot = firstTelegraph(w, Tele.RingAt);
      if (slot >= 0 && ring === undefined) {
        ring = { x: w.events.x[slot], y: w.events.y[slot], tick: t };
      }
      const boomSlot = findEvent(w, Ev.Explosion);
      if (boomSlot >= 0) {
        boom = { x: w.events.x[boomSlot], y: w.events.y[boomSlot], tick: t };
      }
    }

    // The lob happened, it was announced, and it was long enough to read: at least
    // 24 ticks between the ring opening and the burst (this one flew 48).
    expect(ring).toBeDefined();
    expect(boom).toBeDefined();
    expect(boom!.tick - ring!.tick).toBeGreaterThanOrEqual(24);

    // Damage lands at the telegraphed spot — the burst's centre is the ring's centre
    // to within float drift (2e-6 m), not a step of flight past it. That clamp is
    // what makes "read the ring, leave the ring" a true statement in the game.
    expect(Math.hypot(boom!.x - ring!.x, boom!.y - ring!.y)).toBeLessThan(0.01);

    // And the player who stood there is inside the burst and down its full price.
    const reach = def.params.blastRadius + TUNE.playerRadius;
    expect(Math.hypot(w.player.x - boom!.x, w.player.y - boom!.y)).toBeLessThanOrEqual(reach);
    expect(w.player.hp).toBe(w.player.maxHp - def.params.blastDamage);
  });

  it('spends its lob on the floor a dodging player left behind', () => {
    const w = createWorld(34, { arenaHalf: 40 });
    const def = ENEMIES[enemyIndex('grenadier')];
    place(w, 'grenadier', 0, 8);

    let boom: { x: number; y: number; tick: number } | undefined;

    const f = createInputFrame();
    for (let t = 1; t <= 120 && !boom; t++) {
      resetFrame(f);
      // Held sideways escape, which is what the ring is there to allow: the player
      // starts walking before the first throw and keeps walking through its flight.
      f.moveY = -1;
      clearEvents(w);
      step(w, f);
      const boomSlot = findEvent(w, Ev.Explosion);
      if (boomSlot >= 0) {
        boom = { x: w.events.x[boomSlot], y: w.events.y[boomSlot], tick: t };
      }
    }

    // The grenade still went — it is not that nothing happened — but the burst paid
    // out on empty floor: the player is clear outside the ring at the tick it lands,
    // and never lost HP to it.
    expect(boom).toBeDefined();
    const reach = def.params.blastRadius + TUNE.playerRadius;
    expect(Math.hypot(w.player.x - boom!.x, w.player.y - boom!.y)).toBeGreaterThan(reach);
    expect(w.player.hp).toBe(w.player.maxHp);
    expect(w.over).toBe(false);
  });
});

describe('healer', () => {
  it('mends two wounded allies to full, pulsing on its two-second beat', () => {
    const w = createWorld(35, { arenaHalf: 40 });
    const def = ENEMIES[enemyIndex('healer')];
    const a1 = place(w, 'chaser', 7.5, 0, 5);
    const a2 = place(w, 'chaser', 8, 0.5, 5);
    // Pinned in stagger so they hold still: this test is about where the healing
    // comes from, and a walking casualty would make the geometry unreadable.
    w.enemies.state[a1] = 60_000;
    w.enemies.state[a2] = 60_000;
    place(w, 'healer', 11, 0);

    let pulses = 0;
    const f = createInputFrame();
    for (let t = 1; t <= 150; t++) {
      resetFrame(f);
      clearEvents(w);
      step(w, f);
      pulses += countType(w, Ev.Heal);
    }

    // 2.5 s at a 2 s beat is exactly two pulses: one on arrival over the two
    // wounded bodies, one after the full cooldown. A faster cadence would read as
    // more than two here, and that is the point of counting rather than sampling.
    expect(pulses).toBe(2);

    // Both allies came back to what their archetype starts with — the heal caps at
    // full, it does not turn the pack into sponges.
    const chaser = ENEMIES[enemyIndex('chaser')];
    expect(w.enemies.hp[a1]).toBe(chaser.hp);
    expect(w.enemies.hp[a2]).toBe(chaser.hp);
    expect(def.params.healRange).toBe(5); // the aura's 5 m is the one DESIGN.md names
  });

  it('runs from the player the moment it is inside its leash', () => {
    const w = createWorld(36, { arenaHalf: 40 });
    const healer = place(w, 'healer', 3, 0);

    const f = createInputFrame();
    let everClosed = false;
    for (let t = 1; t <= 120; t++) {
      resetFrame(f);
      step(w, f);
      if (gap(w, healer) < 3 - 1e-9) everClosed = true;
    }

    // Started 3 m out and finished past its 8 m leash, never once coming closer:
    // inside the leash it is full-speed away, and it kites at the edge from there.
    expect(everClosed).toBe(false);
    expect(gap(w, healer)).toBeGreaterThanOrEqual(7.5);
    expect(w.player.hp).toBe(w.player.maxHp);
  });
});

describe('enemy projectiles', () => {
  /**
   * One tight volley of three bolts down the x axis at a stationary start, run to
   * 60 ticks. `walk` just gives the player a held key; `dash` lets it stand for
   * 19 ticks and then dash the bolts' own line, into them.
   */
  function volley(seed: number, mode: 'walk' | 'dash') {
    const w = createWorld(seed, { arenaHalf: 40 });
    for (const y of [-0.3, 0, 0.3]) launchBolt(w, -6, y, 1, 0, 13, 8, 2);

    const hitR = TUNE.shotRadius + TUNE.playerRadius;
    let firstHit = -1;
    let crossedWhileInv = 0;

    const f = createInputFrame();
    for (let t = 1; t <= 60; t++) {
      resetFrame(f);
      if (mode === 'walk') {
        f.moveX = -1;
      } else if (t >= 20) {
        f.moveX = -1;
        f.dash = true;
      }
      clearEvents(w);
      step(w, f);

      if (firstHit < 0 && w.player.hp < w.player.maxHp) firstHit = t;

      // A tick "counts as crossed" when a live bolt's centre is inside disc reach
      // while the player still has i-frames — a pass-through, not a near miss.
      let crossed = false;
      for (let i = 0; i < w.enemyShots.cap; i++) {
        if (w.enemyShots.alive[i] === 0) continue;
        if (Math.hypot(w.enemyShots.x[i] - w.player.x, w.enemyShots.y[i] - w.player.y) < hitR) {
          crossed = true;
        }
      }
      if (crossed && w.player.iframes > 0) crossedWhileInv++;
    }

    return { firstHit, crossedWhileInv, hp: w.player.hp };
  }

  it('spends a three-bolt volley on one i-frame window, and a dash through it on none', () => {
    const walked = volley(37, 'walk');
    const dashed = volley(37, 'dash');

    // Control first: with no i-frames up when they arrive, the bolts are lethal,
    // and the gate collapses the volley to one hit of 8 rather than three — the
    // second and third bolts pass through the invulnerable player instead of
    // being absorbed. Without the gate this number is 24 down, not 8.
    expect(walked.firstHit).toBeGreaterThan(0);
    expect(walked.hp).toBe(100 - 8);

    // The dash is the same corridor, entered with i-frames on: no damage, and at
    // least one tick where a bolt was inside disc reach while the player was
    // invulnerable. It was ignored, not dodged — the i-frame gate, not the
    // movement, is what this pins.
    expect(dashed.firstHit).toBe(-1);
    expect(dashed.hp).toBe(100);
    expect(dashed.crossedWhileInv).toBeGreaterThan(0);
  });
});

describe('wave recipes', () => {
  it('deliver the ranged trio through the wave spawner without filling the shot pool', () => {
    const w = createWorld(77, { arenaHalf: 60 });
    w.player.hp = 1_000_000;
    w.autoFire = true;
    startWaves(w);

    let maxShots = 0;
    // Archetypes *seen*, not archetypes alive at the last tick: a chapter that
    // spent an archetype and shot its way through it has still delivered it, and
    // "alive at 3000" would make the recipe's mix a matter of which bodies the
    // pistol happened to leave standing. Every body that arrives announces itself
    // with a Spawn event whose `b` slot names its archetype — splinter children
    // included — so scanning the ring each tick reads the chapter's true mix.
    const seen = new Set<string>();

    const f = createInputFrame();
    for (let t = 1; t <= 3000; t++) {
      resetFrame(f);
      f.fire = true;
      step(w, f);
      if (w.enemyShots.count > maxShots) maxShots = w.enemyShots.count;

      const e = w.events;
      for (let k = 0; k < e.count; k++) {
        const slot = (e.head - e.count + k + e.cap * 2) % e.cap;
        if (e.type[slot] === Ev.Spawn) seen.add(ENEMIES[e.b[slot]].id);
      }
    }

    // The wave recipes, not just `spawnEnemy`: by the far end of a chapter the pack
    // the spawner builds carries all three new archetypes, because PACKS names them
    // from wave 3 on. The recipe is the reason a browser scenario (and a player) can
    // learn what a chapter is made of.
    for (const id of ['shooter', 'grenadier', 'healer']) {
      expect(seen.has(id), `${id} should reach the horde through the recipes`).toBe(true);
    }

    // The 512-slot round pool was used and drained, never approached.
    expect(maxShots).toBeGreaterThan(0);
    expect(maxShots).toBeLessThan(64);

    // And a full chapter crossed every archetype the drumbeat is allowed to carry.
    // `boss` bodies are excluded rather than forgiven: an end-of-level encounter is not
    // also wave fodder, so the recipes stop short of them and tests/unit/bosses.test.ts
    // pins the door they do come through. Equality over the trash set rather than a floor:
    // a future archetype that no recipe names would fail here, and so would a chapter that
    // cannot show one.
    const drumbeat = ENEMIES.filter((d) => !d.boss);
    expect(seen.size).toBe(drumbeat.length);
    for (const def of drumbeat) expect(seen.has(def.id), def.id).toBe(true);
    expect(w.errors).toBe(0);
  });
});

/** Count events of `type` in the ring (cleared per tick by the callers). */
function countType(w: World, type: number): number {
  const e = w.events;
  let n = 0;
  for (let k = 0; k < e.count; k++) {
    if (e.type[(e.head - e.count + k + e.cap * 2) % e.cap] === type) n++;
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
