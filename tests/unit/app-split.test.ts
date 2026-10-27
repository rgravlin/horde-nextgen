import { describe, expect, it } from 'vitest';
import { BIND_DEFS, buildBinds } from '../../src/input/bindings';
import { ENEMIES } from '../../src/content/enemies';
import { LEVELS } from '../../src/content/levels';
import { POWERUPS } from '../../src/content/powerups';
import { WEAPONS } from '../../src/content/weapons';
import { createApp } from '../../src/game/app';
import { snapshotSettings, type App } from '../../src/game/appTypes';
import { buildState, measureFps, nearestEnemies, type StateHost } from '../../src/game/appState';
import { createDebug, type DebugHost } from '../../src/game/appDebug';
import { defaultSettings, SAVE_KEY, type StorageLike } from '../../src/game/persistence';
import { createInputFrame } from '../../src/sim/input';
import { startChapter } from '../../src/sim/systems/levels';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { createRng, next } from '../../src/sim/rng';
import { createWorld, loadSlot, type World } from '../../src/sim/world';
import type { BenchRig } from '../../src/game/bench';

/**
 * The shell after it was split: shapes (`appTypes`), the state read (`appState`) and the debug
 * hooks (`appDebug`) beside the scene machine (`app`).
 *
 * A pure move of code proves nothing by itself, so these tests are about the three seams the
 * split put in place:
 *
 * - **One builder for the state.** `main.ts`'s title-screen placeholder and `app.state()` both go
 *   through `snapshotSettings`/`buildState`, so the placeholder cannot drift into a picture of a
 *   game that is not happening. The first block checks the snapshot against the live app.
 * - **The state builders take their state.** `buildState` reads a `StateHost`, and `nearestEnemies`
 *   and `measureFps` take their arguments, so a test drives them over a bare `World` with no app
 *   and no renderer — which is the point ARCHITECTURE.md makes about the headless half.
 * - **The debug hooks read the live world.** They are given a host whose world changes, because
 *   a bench window arms a *new* run: the body of the bug this file is guarding is a rig priming
 *   the world the page had already thrown away.
 *
 * The last block runs the whole thing through `createApp`, since that is how the browser
 * scenarios use these hooks.
 */

/** ms per frame: 100 buys the loop's five-step cap, so twelve frames are one second of play. */
const FRAME_MS = 100;

/** A `Map` with the `Storage` shape, recording what was written. */
function memory(seed: Record<string, string> = {}): StorageLike & { writes: string[] } {
  const data = new Map<string, string>(Object.entries(seed));
  const writes: string[] = [];
  return {
    writes,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

/**
 * Play `frames` of `FRAME_MS`, holding the run open.
 *
 * The clock is monotonic across the whole driver because `advance` wants a timestamp, not a
 * duration: a second burst that restarted at zero would hand the accumulator back the time it had
 * just banked.
 */
function drive(app: App, frames: number, keepAlive = true): void {
  let now = 0;
  for (let i = 0; i < frames; i++) {
    now += FRAME_MS;
    const w = app.world;
    if (keepAlive && !w.over) w.player.hp = w.player.maxHp;
    app.advance(now);
    for (let guard = 0; guard < 8 && app.scene === 'levelup'; guard++) app.pick(0);
  }
}

/** An app with nothing but a world and a clock. */
function headless(storage: StorageLike | null = null): App {
  return createApp({ view: null, hud: null, seed: 1, backend: 'none', storage });
}

/** A host over a bare world, for the state builders that no longer close over an app. */
function hostOver(w: World, over: Partial<StateHost> = {}): StateHost {
  return {
    world: w,
    scene: 'playing',
    backend: 'none',
    mode: 'campaign',
    errors: 0,
    settings: defaultSettings(),
    bindings: buildBinds(),
    frameTimes: new Float32Array(30),
    ...over,
  };
}

/**
 * A hand-made debug host: a world that gets replaced, and the two doors a real shell owns.
 *
 * `restart` swaps in a fresh world, which is what the real one does — that replacement is the
 * whole reason the host answers `world()` instead of holding a world.
 */
function rigOver(w: World) {
  let world = w;
  const restarts: number[] = [];
  const rigs: BenchRig[] = [];
  const host: DebugHost = {
    world: () => world,
    frame: createInputFrame(),
    restart(chapter: number) {
      restarts.push(chapter);
      const fresh = createWorld(11, { arenaHalf: 40 });
      startChapter(fresh, chapter);
      world = fresh;
    },
    arm(rig: BenchRig | null) {
      if (rig !== null) rigs.push(rig);
    },
    backend: 'none',
    now: () => 0,
  };
  return { debug: createDebug(host), restarts, rigs, world: (): World => world };
}

describe('the settings snapshot, from one builder', () => {
  it('is what the app reports, key for key', () => {
    const app = headless();
    // `main.ts` builds its title-screen placeholder out of `defaultSettings()`/`buildBinds()` and
    // the app builds its live state out of the same two calls. One builder, so a scenario that
    // reads `settings` before the game exists reads the same shape it reads afterwards.
    expect(app.state().settings).toEqual(snapshotSettings(defaultSettings(), buildBinds()));

    app.rebind('pause', 'KeyZ');
    app.setSetting('autoFire', false);
    expect(app.state().settings).toEqual(snapshotSettings(app.settings, app.bindings));
  });

  it('carries a row for every rebindable action, off the live table', () => {
    const app = headless();
    const state = app.state();
    for (const def of BIND_DEFS) {
      expect(state.settings.binds[def.action], def.action).toBe(def.defaults.join(' '));
    }
    app.rebind('pause', 'KeyZ');
    expect(app.state().settings.binds['pause']).toBe('KeyZ');
    expect(app.state().settings.binds['pause']).not.toBe('Escape KeyP');
  });
});

describe('the state read over a bare world', () => {
  it('reports the scene and the mode it was handed', () => {
    const w = createWorld(7);
    expect(buildState(hostOver(w)).scene).toBe('playing');
    // Both come from the host rather than from the world: a frozen scene and a bench window are
    // facts about the shell, and `buildState` is given them.
    expect(buildState(hostOver(w, { scene: 'paused' })).scene).toBe('paused');
    expect(buildState(hostOver(w, { mode: 'bench' })).mode).toBe('bench');
    expect(buildState(hostOver(w, { backend: 'webgpu' })).backend).toBe('webgpu');
  });

  it('keeps every archetype key, so a type that has not arrived is still assertable', () => {
    const state = buildState(hostOver(createWorld(7)));
    expect(Object.keys(state.enemies.byType).sort()).toEqual(ENEMIES.map((d) => d.id).sort());
    for (const def of ENEMIES) expect(state.enemies.byType[def.id], def.id).toBe(0);
  });

  it('counts what is on the floor out of the pools', () => {
    const w = createWorld(7);
    spawnEnemy(w, 0, 3, 0);
    spawnEnemy(w, 0, 0, 4);
    const state = buildState(hostOver(w));
    expect(state.enemies.count).toBe(2);
    expect(state.enemies.byType[ENEMIES[0].id]).toBe(2);
    expect(state.enemies.nearest).toHaveLength(2);
  });

  it('lists the hands the run holds, with the gauges as counts', () => {
    const w = createWorld(7);
    const longbow = WEAPONS.findIndex((def) => def.id === 'longbow');
    loadSlot(w.slots[1], longbow);
    const state = buildState(hostOver(w));
    expect(state.weapons.map((hand) => hand.id)).toEqual(['pistol', 'longbow']);
    expect(state.weapons[0].reloading).toBe(false);
    expect(state.activeWeapon).toBe('pistol');
    w.activeSlot = 1;
    expect(buildState(hostOver(w)).activeWeapon).toBe('longbow');
  });

  it('names the power-ups owned and the cards on the table, and drops the empty slots', () => {
    const w = createWorld(7);
    w.powerTiers[0] = 2;
    // A bare world's offer is three zeros, which is not three copies of the first card: -1 is the
    // empty slot, and an index off the end of the table is a hole, not a card.
    w.levelUpChoices.set([1, -1, POWERUPS.length]);
    const state = buildState(hostOver(w));
    expect(state.powerups).toEqual([{ id: POWERUPS[0].id, tier: 2 }]);
    expect(state.levelUpChoices).toEqual([POWERUPS[1].id]);
  });

  it('sums the two error tallies', () => {
    const w = createWorld(7);
    w.errors = 2;
    expect(buildState(hostOver(w, { errors: 3 })).errors).toBe(5);
  });

  it('reads fps off a cold ring as 0', () => {
    expect(buildState(hostOver(createWorld(7))).fps).toBe(0);
  });
});

describe('the state helpers', () => {
  it('measures fps only once the ring has filled', () => {
    const ring = new Float32Array(4);
    expect(measureFps(ring)).toBe(0);
    ring.fill(1 / 60);
    expect(measureFps(ring)).toBe(60);
    ring.fill(1 / 30);
    expect(measureFps(ring)).toBe(30);
    // A ring that is four entries long and only three warm still says "warming up": a partial
    // average would report a shader compile as the framerate.
    ring[0] = 0;
    expect(measureFps(ring)).toBe(0);
  });

  it('keeps the ten nearest bodies, closest first', () => {
    const w = createWorld(7, { arenaHalf: 40 });
    for (let i = 0; i < 24; i++) {
      const r = 4 + i * 1.5;
      spawnEnemy(w, 0, Math.cos(i) * r, Math.sin(i) * r);
    }
    expect(w.enemies.count).toBe(24);
    const near = nearestEnemies(w);
    expect(near).toHaveLength(10);
    const far = (p: { x: number; y: number }): number => {
      const dx = p.x - w.player.x;
      const dy = p.y - w.player.y;
      return dx * dx + dy * dy;
    };
    for (let i = 1; i < near.length; i++) {
      expect(far(near[i])).toBeGreaterThanOrEqual(far(near[i - 1]));
    }
  });

  it('leaves a body that has 0 hp out of the list', () => {
    const w = createWorld(7, { arenaHalf: 40 });
    spawnEnemy(w, 0, 2, 0);
    spawnEnemy(w, 0, 6, 0);
    expect(nearestEnemies(w).map((p) => p.x)).toEqual([2, 6]);
    w.enemies.hp[0] = 0;
    const left = nearestEnemies(w);
    expect(left).toHaveLength(1);
    expect(left[0].x).toBeCloseTo(6, 10);
  });
});

describe('the debug hooks', () => {
  it('puts the asked-for crowd on the floor, and reads a bad type as the first one', () => {
    const at = rigOver(createWorld(3));
    expect(at.debug.spawn(0, 12)).toBe(12);
    expect(at.world().enemies.count).toBe(12);

    const other = rigOver(createWorld(3));
    expect(other.debug.spawn(9999, 3)).toBe(3);
    expect(other.world().enemies.kind[0]).toBe(0);
  });

  it('refuses a weapon that does not exist, and fills the empty hand with one that does', () => {
    const at = rigOver(createWorld(3));
    const w = at.world();
    // A name off the table is a refused grant rather than a hand holding nothing.
    expect(at.debug.giveWeapon('jetpack')).toBe(false);
    expect(w.slots[1].weapon).toBe(-1);
    expect(w.activeSlot).toBe(0);

    expect(at.debug.giveWeapon('longbow')).toBe(true);
    expect(w.slots[1].weapon).toBe(WEAPONS.findIndex((def) => def.id === 'longbow'));
    expect(w.activeSlot, 'a granted weapon has to be the one being fired').toBe(1);
  });

  it('keeps granting into the active hand once both are full', () => {
    const at = rigOver(createWorld(3));
    const w = at.world();
    expect(at.debug.giveWeapon('longbow')).toBe(true);
    const shotgun = WEAPONS.findIndex((def) => def.id === 'shotgun');
    expect(at.debug.giveWeapon('shotgun')).toBe(true);
    expect(w.activeSlot, 'a second grant does not move the player off the hand they hold').toBe(1);
    expect(w.slots[1].weapon).toBe(shotgun);
  });

  it('rewires the rng, so a scripted scene stays reproducible', () => {
    const at = rigOver(createWorld(3));
    const w = at.world();
    at.debug.setSeed(9);
    const probe = createRng(9);
    const want = [next(probe), next(probe), next(probe)];
    expect([next(w.rng), next(w.rng), next(w.rng)]).toEqual(want);
  });

  it('hands the xp to the sim, which is what decides about cards', () => {
    const at = rigOver(createWorld(3));
    const w = at.world();
    at.debug.grantXp(100000);
    expect(w.player.xp).toBe(100000);
    expect(w.pendingLevelUp, 'awardXp runs the level check, so the cards come up').toBe(true);
    expect(buildState(hostOver(w)).levelUpChoices).toHaveLength(3);
  });

  it('arms a bench window on a fresh run and primes the world that run is in', () => {
    const at = rigOver(createWorld(3));
    const before = at.world();
    spawnEnemy(before, 0, 1, 1);

    const made = at.debug.bench(20, { seconds: 1, warmup: 0 });

    expect(at.restarts).toEqual([0]);
    expect(at.rigs).toHaveLength(1);
    expect(made).toBeGreaterThan(0);
    // The point of the host: the rig primes the world the restart made, not the one the call
    // started on, and the number it gives back is that world's crowd.
    expect(at.world().enemies.count).toBe(made);
    expect(before.enemies.count, 'the world the page has thrown away was not the one it filled').toBe(1);
  });

  it('takes the chapter from the floor it is on, and clamps one it is given', () => {
    const at = rigOver(createWorld(3));
    at.world().chapter = 4;
    at.debug.bench(1);
    expect(at.restarts).toEqual([4]);

    at.debug.bench(1, { chapter: 999 });
    expect(at.restarts[at.restarts.length - 1]).toBe(LEVELS.length - 1);
  });
});

describe('the same pieces inside the shell', () => {
  it('plays, and says so through the state seam', () => {
    const app = headless();
    app.command('start');
    drive(app, 120);

    const state = app.state();
    expect(state.tick).toBeGreaterThan(0);
    expect(state.errors).toBe(0);
    expect(state.scene).toBe('playing');

    // The read is a read: two of them agree, and neither spends a tick.
    expect(app.state()).toEqual(state);
    expect(app.world.tick).toBe(state.tick);
  });

  it('keeps the __forgeState() key set the scenarios assert on', () => {
    const app = headless();
    const state = app.state();
    expect(Object.keys(state).sort()).toEqual(
      [
        'scene',
        'backend',
        'tick',
        'chapter',
        'mode',
        'player',
        'wave',
        'boss',
        'chapterComplete',
        'victory',
        'score',
        'kills',
        'enemies',
        'weapons',
        'activeWeapon',
        'powerups',
        'levelUpChoices',
        'fps',
        'errors',
        'settings',
      ].sort(),
    );
    expect(Object.keys(state.player).sort()).toEqual(
      ['x', 'y', 'hp', 'maxHp', 'shield', 'level', 'xp', 'dashReady', 'alive'].sort(),
    );
    expect(Object.keys(state.wave).sort()).toEqual(['index', 'timeLeft', 'bossAlive'].sort());
    expect(Object.keys(state.boss).sort()).toEqual(['alive', 'name', 'hp', 'maxHp'].sort());
    expect(Object.keys(state.enemies).sort()).toEqual(['count', 'byType', 'nearest'].sort());
    expect(Object.keys(state.settings).sort()).toEqual(
      ['quality', 'particles', 'damageNumbers', 'autoFire', 'shake', 'binds'].sort(),
    );
  });

  it('turns the mode over to the bench, and writes nothing while it runs', () => {
    // Fifty seconds of play, past the thirty-second autosave interval twice, with the player
    // held alive so the run does not end and excuse the missing write.
    const plain = memory();
    const control = headless(plain);
    control.command('start');
    drive(control, 500);
    expect(
      plain.writes.filter((key) => key === SAVE_KEY).length,
      'the control proves an interval falls due inside fifty seconds of play',
    ).toBeGreaterThan(0);

    const benched = memory();
    const app = headless(benched);
    app.command('start');
    expect(app.debug.bench(200, { seconds: 40 })).toBeGreaterThan(0);
    drive(app, 500);

    expect(app.state().mode).toBe('bench');
    expect(app.bench, 'the rig is still on the app, spent rather than gone').not.toBeNull();
    // A rig is a test bench, not a run to come back to: a thousand seeded bodies would blow the
    // quota and hand the next player a Continue into a measurement (see `keepShelf`).
    expect(benched.writes).toEqual([]);
  });
});