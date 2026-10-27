import { describe, expect, it } from 'vitest';
import {
  BIND_DEFS,
  buildBinds,
  describeBinds,
  describeSource,
  isBindOverrides,
  swapBinds,
} from '../../src/input/bindings';
import { createApp } from '../../src/game/app';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  type StorageLike,
} from '../../src/game/persistence';

/**
 * The settings and the key map, pinned where they are actually decided.
 *
 * Two files own this feature and neither of them is a screen: `input/bindings.ts` compiles the
 * map the sampler looks keys up in, and `game/persistence.ts` is what a settings change gets
 * written into. The Settings tab and the Controls tab only show those two. So these tests are
 * about the decisions behind the panels — which source carries which meaning after a change, and
 * whether a change survives the page.
 *
 * The second one is why the fixtures read the file back instead of trusting the object in
 * memory: a setting that only lives in RAM still looks right in the menu for the whole of the run
 * you changed it in, which is exactly the version of this feature that would otherwise ship.
 */

/** A `Map` with the `Storage` shape, plus the keys it was handed and the ones it wrote. */
function memory(seed: Record<string, string> = {}): StorageLike & { writes: string[] } {
  const data = new Map<string, string>(Object.entries(seed));
  const writes: string[] = [];
  return {
    writes,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
      writes.push(key);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe('the bind table', () => {
  it('resolves a source to the action the shipped map gives it', () => {
    const table = buildBinds();
    expect(table.actionOf('Escape')).toBe('pause');
    expect(table.actionOf('KeyW')).toBe('up');
    expect(table.actionOf('Mouse0')).toBe('fire');
    expect(table.actionOf('KeyJ')).toBeUndefined();
  });

  it('owes a preventDefault to a key it swallowed, and not to one it does not use', () => {
    const table = buildBinds();
    // The arrows and Space scroll the page, so they are swallowed bound or not; a bound key owes
    // one because the page must not type into itself mid-run.
    expect(table.swallows('Space')).toBe(true);
    expect(table.swallows('ArrowLeft')).toBe(true);
    expect(table.swallows('KeyD')).toBe(true);
    expect(table.swallows('KeyJ')).toBe(false);
  });

  it('gives the displaced action the keys the rebound action was holding', () => {
    // The rule the Controls tab's caption promises: a remap is a swap, so no action is left with
    // nothing. Rebind pause onto the dash key and dash picks up pause's pair.
    const table = buildBinds(swapBinds({}, 'pause', 'Space'));
    expect(table.actionOf('Space')).toBe('pause');
    expect(table.sourcesOf('pause')).toEqual(['Space']);
    expect(table.sourcesOf('dash')).toEqual(['Escape', 'KeyP']);
    expect(table.actionOf('Escape')).toBe('dash');
  });

  it('takes the stolen source away, and hands the displaced action what is left', () => {
    // Fire starts on a hand-bound key here, so the swap has something to give back: dash takes
    // `KeyK`, fire takes `Space`, and neither action ends up with nothing.
    const table = buildBinds(swapBinds({ fire: ['KeyK'] }, 'fire', 'Space'));
    expect(table.actionOf('Space')).toBe('fire');
    expect(table.sourcesOf('fire')).toEqual(['Space']);
    expect(table.sourcesOf('dash')).toEqual(['KeyK']);
    expect(table.actionOf('KeyK')).toBe('dash');
  });

  it('reads its own rows back, and only what it was asked for', () => {
    const table = buildBinds();
    expect(describeBinds(table, ['dash', 'pause'])).toBe(
      'Dash: space / left shift / right shift · Pause: esc / p',
    );
    // An action with no key is left out rather than printed as an empty row.
    expect(describeBinds(buildBinds({ swap: [] }), ['swap'])).toBe('');
  });

  it('prints a source as the key a player would read on their own board', () => {
    expect(describeSource('KeyW')).toBe('w');
    expect(describeSource('Digit1')).toBe('1');
    expect(describeSource('Mouse0')).toBe('mouse 0');
    expect(describeSource('Escape')).toBe('esc');
  });

  it('refuses a bind file that is not a bind file', () => {
    expect(isBindOverrides({ dash: ['KeyK'] })).toBe(true);
    expect(isBindOverrides({})).toBe(true);
    // An action that does not exist, and a value that is not a list of sources, are both a file
    // we are unwilling to build a map out of.
    expect(isBindOverrides({ flight: ['KeyK'] })).toBe(false);
    expect(isBindOverrides({ dash: 'KeyK' })).toBe(false);
    expect(isBindOverrides(null)).toBe(false);
  });

  it('has one row per action a player can rebind', () => {
    const actions = BIND_DEFS.map((def) => def.action);
    expect(new Set(actions).size).toBe(actions.length);
    for (const def of BIND_DEFS) expect(def.defaults.length, def.action).toBeGreaterThan(0);
  });
});

describe('the settings file', () => {
  it('round-trips through storage, the key map included', () => {
    const store = memory();
    saveSettings(store, {
      ...defaultSettings(),
      autoFire: false,
      shake: 0.2,
      binds: { dash: ['KeyK'] },
    });

    // Read back out of the file rather than out of the object above: this is the half that
    // decides whether the dial you moved is still moved once the page reloads.
    const back = loadSettings(store);
    expect(back.autoFire).toBe(false);
    expect(back.shake).toBeCloseTo(0.2, 10);
    expect(back.binds.dash).toEqual(['KeyK']);
    // What nobody touched keeps its default instead of being rewritten as one.
    expect(back.quality).toBe(defaultSettings().quality);
    expect(store.writes.length).toBe(1);
  });

  it('shrugs off a file that will not parse, and says so once', () => {
    // The key is found by writing a good file first, so this pins the read rather than a
    // hard-coded key string.
    const probe = memory();
    saveSettings(probe, defaultSettings());
    const broken = memory({ [probe.writes[0]]: '{"shake":' });

    const quiet: string[] = [];
    const back = loadSettings(broken, { note: (problem) => quiet.push(problem) });
    expect(back.autoFire).toBe(defaultSettings().autoFire);
    expect(back.shake).toBe(defaultSettings().shake);
    expect(quiet.length).toBe(1);
  });
});

describe('the shell running on those settings', () => {
  /** An app with no renderer and no overlay, driven through the door `main.ts` uses. */
  function headless(meta?: {
    unlockedChapters: number;
    bestTimes: number[];
    history: [];
    arenaUnlocked: boolean;
  }) {
    return createApp({ view: null, hud: null, seed: 1, backend: 'none', storage: null, meta });
  }

  it('reports the live key map, not a copy of the shipped one', () => {
    const app = headless();
    expect(app.state().settings.binds['pause']).toBe('Escape KeyP');

    app.rebind('pause', 'KeyZ');
    // The state and the sampler read one table. If this ever stops being true, a scenario that
    // presses `z` gets a key the game no longer listens to.
    expect(app.state().settings.binds['pause']).toBe('KeyZ');
    expect(app.bindings.actionOf('KeyZ')).toBe('pause');
    expect(app.bindings.actionOf('Escape')).toBeUndefined();
  });

  it('gives the whole map back on reset', () => {
    const app = headless();
    app.rebind('pause', 'KeyZ');
    app.resetBindings();
    expect(app.state().settings.binds['pause']).toBe('Escape KeyP');
  });

  it('passes an auto-fire change down into the world it governs', () => {
    const app = headless();
    expect(app.world.autoFire).toBe(true);
    app.command('start');
    app.setSetting('autoFire', false);
    expect(app.world.autoFire).toBe(false);
    expect(app.state().settings.autoFire).toBe(false);
  });

  it('only opens a chapter the run has earned', () => {
    const app = headless();
    app.command('start');
    expect(app.scene).toBe('playing');

    // Nothing past the first floor is unlocked, so a locked tile is inert rather than a way to
    // skip ahead.
    app.choose(4);
    expect(app.world.chapter).toBe(0);

    const earned = headless({
      unlockedChapters: 5,
      bestTimes: [],
      history: [],
      arenaUnlocked: false,
    });
    earned.command('start');
    earned.choose(4);
    expect(earned.scene).toBe('playing');
    expect(earned.world.chapter).toBe(4);
  });

  it('keeps a panel a freeze, and hands back where it opened', () => {
    const app = headless();
    app.command('start');
    app.command('pause');
    expect(app.scene).toBe('paused');

    app.command('settings');
    expect(app.scene).toBe('settings');
    const frozen = app.world.tick;
    for (let t = 1; t <= 40; t++) app.advance(t * 16);
    expect(app.world.tick, 'a panel is a frozen scene, so nothing steps behind it').toBe(frozen);

    app.command('back');
    expect(app.scene).toBe('paused');
    app.command('resume');
    expect(app.scene).toBe('playing');
    expect(app.state().errors).toBe(0);
  });
});
