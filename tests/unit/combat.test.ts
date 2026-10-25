import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../../src/content/enemies';
import { POWERUPS } from '../../src/content/powerups';
import { WEAPONS } from '../../src/content/weapons';
import { hashWorld } from '../../src/sim/hash';
import { createInputFrame, resetFrame, type InputFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { awardXp, choosePick, grantPowerup, reroll } from '../../src/sim/systems/pickups';
import { startWaves } from '../../src/sim/systems/waves';
import {
  Ev,
  TUNE,
  alloc,
  clearEvents,
  countAlive,
  countEvents,
  createWorld,
  type World,
} from '../../src/sim/world';

/** Put an enemy of the chaser archetype at (x, y), optionally tougher than default. */
function place(w: World, x: number, y: number, hp = ENEMIES[0].hp): number {
  const i = spawnEnemy(w, 0, x, y);
  w.enemies.hp[i] = hp;
  return i;
}

/** Put an XP shard at (x, y) at rest, ready for the magnet test. */
function placeShard(w: World, x: number, y: number): number {
  const i = alloc(w.shards);
  w.shards.x[i] = x;
  w.shards.y[i] = y;
  w.shards.life[i] = TUNE.shardLife;
  return i;
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

describe('weapons', () => {
  it('kills a chaser standing between the muzzle and the wall', () => {
    const w = createWorld(11);
    const victim = place(w, 5, 0);

    run(w, 60, shoot);

    expect(w.enemies.alive[victim]).toBe(0);
    expect(countAlive(w.enemies)).toBe(0);
    expect(w.kills).toBe(1);
    expect(countEvents(w, Ev.Kill)).toBe(1);
    // The body dropped its shard where it fell, and a shot event proves the
    // pistol actually cycled rather than the chaser expiring for free.
    expect(countAlive(w.shards)).toBe(1);
    expect(countEvents(w, Ev.Shot)).toBeGreaterThan(0);
  });

  it('spends a shot once its pierce is used up', () => {
    const w = createWorld(12);
    const pistol = WEAPONS[0];
    expect(pistol.pierce).toBe(1); // one hit for itself plus one pass-through

    const near = place(w, 5, 0, 500);
    const mid = place(w, 7, 0, 500);
    const far = place(w, 9, 0, 500);
    // One round in the magazine, so pierce is the only thing limiting the hits
    // rather than the gun simply running out of time.
    w.slots[0].ammo = 1;

    run(w, 40, shoot);

    const hurt = [near, mid, far].filter((i) => w.enemies.hp[i] < 500);
    expect(countEvents(w, Ev.Shot)).toBe(1);
    expect(countEvents(w, Ev.Hit)).toBe(2);
    expect(hurt).toEqual([near, mid]);
    expect(w.enemies.hp[far]).toBe(500);
  });

  it('blocks firing while the magazine is reloading, then reloads on its own', () => {
    const w = createWorld(13);
    place(w, 6, 0, 500);
    const slot = w.slots[0];
    const pistol = WEAPONS[0];
    expect(slot.ammo).toBe(pistol.ammo.mag);

    run(w, 1, shoot);
    expect(countEvents(w, Ev.Shot)).toBe(1);

    // Empty the mag by hand and keep the trigger down: the empty mag buys a
    // reload, and a reloading gun does not shoot however hard you hold fire.
    slot.ammo = 0;
    slot.reload = pistol.ammo.reload;
    clearEvents(w);
    run(w, 30, shoot);
    expect(countEvents(w, Ev.Shot)).toBe(0);
    expect(slot.reload).toBeGreaterThan(0);
    expect(slot.ammo).toBe(0);

    // Past the 1.1 s reload the mag is full again and firing resumes by itself.
    run(w, 50, shoot);
    expect(slot.reload).toBe(0);
    expect(countEvents(w, Ev.Shot)).toBeGreaterThan(0);
    expect(slot.ammo).toBeLessThan(pistol.ammo.mag);
  });

  it('fires on a held trigger, and on auto-fire only when something is in range', () => {
    const manual = createWorld(14);
    run(manual, 60, shoot);
    expect(countEvents(manual, Ev.Shot)).toBeGreaterThan(0);

    // Auto-fire with an empty arena must not dribble ammo onto the floor.
    const idle = createWorld(15);
    idle.autoFire = true;
    expect(idle.enemyNear).toBe(Infinity);
    run(idle, 60);
    expect(countEvents(idle, Ev.Shot)).toBe(0);

    // The same world with a chaser 6 m away is a target within the 18 m rule.
    place(idle, 6, 0, 500);
    run(idle, 60);
    expect(idle.enemyNear).toBeLessThan(TUNE.autoFireRange);
    expect(countEvents(idle, Ev.Shot)).toBeGreaterThan(0);
  });

  it('swaps hands and fires from whichever one is active', () => {
    const w = createWorld(16);
    // A swap with an empty off hand changes nothing: no hand is left empty.
    run(w, 10, (f) => {
      f.swap = true;
    });
    expect(w.activeSlot).toBe(0);

    // Load the off hand, then swap once and keep the trigger down: only the new
    // active hand drains, which is what shows the shots come out of slot 1.
    w.slots[1].weapon = 0;
    w.slots[1].ammo = 3;
    place(w, 6, 0, 500);
    let tick = 0;
    run(w, 60, (f) => {
      f.fire = true;
      f.swap = tick++ === 0;
    });

    expect(w.activeSlot).toBe(1);
    expect(w.slots[1].ammo).toBeLessThan(3);
    expect(w.slots[0].ammo).toBe(WEAPONS[0].ammo.mag);
    expect(countEvents(w, Ev.Shot)).toBeGreaterThan(1);
  });
});

describe('enemy contact damage', () => {
  it('takes one hit per i-frame window rather than one per tick', () => {
    const open = createWorld(17);
    place(open, 0.9, 0);

    run(open, 1);

    expect(open.player.hp).toBe(94); // 6 contact damage, and i-frames after it
    expect(open.player.iframes).toBeCloseTo(TUNE.hurtIframes, 10);

    // The same contact for a whole i-frame window costs nothing.
    const shielded = createWorld(18);
    place(shielded, 0.9, 0);
    shielded.player.iframes = 0.5;

    run(shielded, 29);

    expect(shielded.player.hp).toBe(100);

    run(shielded, 10);

    expect(shielded.player.hp).toBe(94);
  });

  it('ends the run when HP reaches 0', () => {
    const w = createWorld(19);
    place(w, 0.9, 0);
    w.player.hp = 6;

    run(w, 1);

    expect(w.player.hp).toBe(0);
    expect(w.player.alive).toBe(false);
    expect(w.over).toBe(true);
    expect(countEvents(w, Ev.Death)).toBe(1);

    // Dead is terminal: no firing, no spawning and no further damage.
    startWaves(w);
    run(w, 120, shoot);
    expect(w.player.hp).toBe(0);
    expect(countAlive(w.enemies)).toBe(1);
    expect(countEvents(w, Ev.Shot)).toBe(0);
  });
});

describe('xp shards and level-up', () => {
  it('reels in a shard inside the magnet radius and leaves one outside it', () => {
    const near = createWorld(20);
    placeShard(near, 1, 0);

    run(near, 30);

    expect(countAlive(near.shards)).toBe(0);
    expect(near.player.xp).toBe(ENEMIES[0].xp);

    const far = createWorld(21);
    placeShard(far, 10, 0);

    run(far, 30);

    expect(countAlive(far.shards)).toBe(1);
    expect(far.player.xp).toBe(0);

    // 3 m is outside the 2.5 m field, so a run with no Magnet Field still has to
    // walk to it; one tier of the power-up buys 1.2 m and reaches it.
    const outOfField = createWorld(22);
    placeShard(outOfField, 3, 0);
    run(outOfField, 30);
    expect(countAlive(outOfField.shards)).toBe(1);

    const withMagnet = createWorld(23);
    const magnet = POWERUPS.findIndex((p) => p.id === 'magnet');
    grantPowerup(withMagnet, magnet);
    expect(withMagnet.stats.magnet).toBeGreaterThan(0);
    placeShard(withMagnet, 3, 0);

    run(withMagnet, 30);

    expect(countAlive(withMagnet.shards)).toBe(0);
    expect(withMagnet.player.xp).toBe(ENEMIES[0].xp);
  });

  it('offers three cards once the XP threshold is crossed', () => {
    const w = createWorld(24);

    awardXp(w, 4);
    expect(w.pendingLevelUp).toBe(false);

    awardXp(w, 1); // the first threshold is 5 XP
    expect(w.pendingLevelUp).toBe(true);
    expect(countEvents(w, Ev.LevelUp)).toBe(1);

    const cards = Array.from(w.levelUpChoices);
    expect(cards).toHaveLength(TUNE.pickCount);
    // Distinct while the pool has room for three, and every card is still upgradable.
    expect(new Set(cards).size).toBe(TUNE.pickCount);
    for (const card of cards) {
      expect(w.powerTiers[card]).toBeLessThan(POWERUPS[card].maxTier);
    }
  });

  it('rerolls the offer once, and only once', () => {
    const w = createWorld(25);
    // A mid-run state: Damage Boost is already maxed, so the offer draws from
    // Fire Rate and Magnet, and a reroll has somewhere else to go.
    for (let i = 0; i < 5; i++) grantPowerup(w, 0);
    awardXp(w, 5);
    expect(w.pendingLevelUp).toBe(true);

    const before = Array.from(w.levelUpChoices);
    expect(reroll(w)).toBe(true);
    const after = Array.from(w.levelUpChoices);

    expect(after).not.toEqual(before);
    expect(reroll(w)).toBe(false); // one reroll per level-up, and this one is spent

    // Taking a card ends the offer, raises that power-up and the player's level,
    // and clears the reroll for the next one.
    expect(choosePick(w, 0)).toBe(true);
    expect(w.pendingLevelUp).toBe(false);
    expect(w.player.level).toBe(2);
    expect(w.rerollUsed).toBe(false);
    expect(w.powerTiers[after[0]]).toBe(1);

    awardXp(w, 10);
    expect(w.pendingLevelUp).toBe(true);
    expect(w.rerollUsed).toBe(false);
    expect(reroll(w)).toBe(true);
  });

  it('picks a card straight out of an InputFrame, for replays', () => {
    const w = createWorld(26);
    awardXp(w, 5);
    expect(w.pendingLevelUp).toBe(true);

    // The UI stops ticking while the cards are up, then a replay frame can pick
    // a card through the InputFrame, which is how replays stay reproducible.
    const f = createInputFrame();
    f.pick = 2;
    step(w, f);

    expect(w.pendingLevelUp).toBe(false);
    expect(w.player.level).toBe(2);
    expect(w.powerTiers[w.levelUpChoices[1]]).toBe(1);
  });
});

describe('power-ups', () => {
  it('caps a power-up at its fifth tier', () => {
    const w = createWorld(27);
    const damage = POWERUPS.findIndex((p) => p.id === 'damage');
    const fireRate = POWERUPS.findIndex((p) => p.id === 'fireRate');

    for (let i = 0; i < 8; i++) grantPowerup(w, damage);

    expect(w.powerTiers[damage]).toBe(POWERUPS[damage].maxTier);
    expect(w.stats.dmg).toBeCloseTo(1 + 0.25 * 5, 10);

    // Refolding for the next power-up leaves the first one's contribution alone,
    // so the cap holds however many grants arrive and in what order.
    grantPowerup(w, fireRate);
    expect(w.powerTiers[fireRate]).toBe(1);
    expect(w.stats.dmg).toBeCloseTo(1 + 0.25 * 5, 10);
    expect(w.stats.fireRate).toBeCloseTo(1 + 0.18, 10);
  });
});

describe('waves', () => {
  it('spawn more enemies as the chapter runs on', () => {
    const w = createWorld(28, { arenaHalf: 40 });
    w.player.hp = 1_000_000; // keep the player alive: the spawner is the only variable
    startWaves(w);

    run(w, 600);
    const early = countEvents(w, Ev.Spawn);
    clearEvents(w);
    run(w, 600);
    const late = countEvents(w, Ev.Spawn);

    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(early);
    expect(w.wave.index).toBe(2); // two 12 s waves done by the 20 s mark
    expect(countAlive(w.enemies)).toBe(early + late);
  });

  it('spawns outside the view rect rather than in the player eyeline', () => {
    const w = createWorld(29, { arenaHalf: 40 });
    w.player.hp = 1_000_000;
    startWaves(w);

    run(w, 900);

    const half = TUNE.viewHalfY;
    const ring = TUNE.viewHalfX;
    const px = w.player.x;
    const py = w.player.y;
    let seen = 0;
    for (let k = 0; k < w.events.count; k++) {
      const slot = (w.events.head - w.events.count + k + w.events.cap * 2) % w.events.cap;
      if (w.events.type[slot] !== Ev.Spawn) continue;
      seen++;
      const dx = Math.abs(w.events.x[slot] - px);
      const dy = Math.abs(w.events.y[slot] - py);
      expect(dx > ring || dy > half).toBe(true);
    }

    expect(seen).toBeGreaterThan(0);
  });

  it('leaves an idle world empty', () => {
    const w = createWorld(30);

    run(w, 300);

    expect(countAlive(w.enemies)).toBe(0);
    expect(w.wave.running).toBe(false);
  });
});

describe('combat loop', () => {
  /** One fight, start to finish: a pack in range, waves rising, auto-fire, picks taken. */
  function fight(seed: number, ticks: number): World {
    const w = createWorld(seed, { arenaHalf: 40 });
    w.autoFire = true;
    w.player.hp = 1_000_000;
    for (let i = 0; i < 6; i++) place(w, 4 + i * 1.5, Math.sin(i) * 3);
    startWaves(w);

    const f = createInputFrame();
    for (let t = 0; t < ticks; t++) {
      resetFrame(f);
      f.fire = true;
      f.moveX = t % 120 < 60 ? 1 : -1;
      f.aimX = Math.cos(t * 0.1);
      f.aimY = Math.sin(t * 0.1);
      f.pick = w.pendingLevelUp ? 1 : 0;
      step(w, f);
    }
    return w;
  }

  it('fights a whole chapter inside the pools', () => {
    const w = fight(4242, 1800);

    expect(w.tick).toBe(1800);
    expect(w.over).toBe(false);
    expect(w.kills).toBeGreaterThan(0);
    // Nothing overflowed: the caps held, so a 30 s fight stays a fight rather
    // than a pool full of corpses.
    expect(w.shots.count).toBeLessThan(w.shots.cap);
    expect(w.shards.count).toBeLessThan(w.shards.cap);
    expect(w.enemies.count).toBeLessThan(w.enemies.cap);
  });

  it('fights the same seed the same way twice', () => {
    const a = fight(4242, 1800);
    const b = fight(4242, 1800);

    expect(a.kills).toBe(b.kills);
    expect(a.player.level).toBeGreaterThan(1);
    expect([a.enemies.freeCount, a.shots.freeCount, a.shards.freeCount]).toEqual([
      b.enemies.freeCount,
      b.shots.freeCount,
      b.shards.freeCount,
    ]);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it('fingerprints a change of seed, so the loop is really driven by world.rng', () => {
    const a = fight(7, 600);
    const b = fight(8, 600);

    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });
});
