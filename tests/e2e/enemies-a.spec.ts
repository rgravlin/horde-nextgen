import { test, expect, type Page } from '@playwright/test';
import { ENEMIES } from '../../src/content/enemies';

/**
 * The new enemy behaviours where only a browser can check them: in the real loop, with
 * the wave spawner, the auto-fire decision and the renderer's own read of the pools.
 *
 * `tests/unit/enemies-a.test.ts` pins the state machines by driving `step()` directly —
 * the charger's 31 ticks of wind-up, the splitter's three children, the 26 of burst
 * damage, armour that only counts inside its arc. What that cannot prove is that a
 * archetype *arrives*: that `__forgeDebug.spawn` can put chargers down, that the live
 * state reports them by type, and that a horde of the five new bodies runs for half a
 * minute without throwing. This file does, and it is the only place the first two can
 * live: `forge-scenarios.json` has no step that evaluates JavaScript (its vocabulary is
 * click, fill, press, wait, hold, mouse, shot, state), so a spawn call has to be made
 * from a spec.
 *
 * The archetype indexes come from `content/enemies.ts` rather than being written out, so
 * reordering the table moves the test instead of quietly aiming it at something else.
 *
 * Every wait is on a condition and takes a level-up card on the way (see `playUntil`),
 * because a level-up freezes the sim and a wait that ignored that would time out on a
 * game waiting for a pick rather than on one that stopped working.
 */

type State = {
  scene: string;
  tick: number;
  kills: number;
  errors: number;
  enemies: {
    count: number;
    byType: Record<string, number>;
    nearest: Array<{ type: string; x: number; y: number; hp: number }>;
  };
  player: { alive: boolean; hp: number };
};

type AnyWindow = {
  __forgeState?: () => State;
  __forgeDebug?: { spawn(type: number, n: number): number };
};

function readState(page: Page): Promise<State | undefined> {
  return page.evaluate(() => {
    const win = window as unknown as AnyWindow;
    return win.__forgeState ? JSON.parse(JSON.stringify(win.__forgeState())) : undefined;
  });
}

/** Wait for the shell: both hooks land in the same turn once the renderer resolves. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const win = window as unknown as AnyWindow;
    return typeof win.__forgeState === 'function' && win.__forgeDebug !== undefined;
  }, undefined, { timeout: 25_000 });
}

async function waitForScene(page: Page, scene: string, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    (want) => {
      const win = window as unknown as AnyWindow;
      return win.__forgeState !== undefined && win.__forgeState().scene === want;
    },
    scene,
    { timeout },
  );
}

/**
 * Play until `want` holds, spending a level-up card when one appears.
 *
 * Returns as soon as the condition is true, and gives up the moment the run stops (the
 * player died), so a death is reported as a failure rather than burning the budget.
 */
async function playUntil(page: Page, want: (s: State) => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await readState(page);
    if (s !== undefined) {
      if (want(s)) return true;
      if (s.scene === 'levelup') await page.keyboard.press('Digit1');
      else if (s.scene !== 'playing') return false;
    }
    await page.waitForTimeout(100);
  }
  return false;
}

/**
 * Start a run on `path` and put `n` bodies of each archetype in `ring` on the ring
 * around the player.
 *
 * The archetype indexes are looked up in Node and passed in as data: `page.evaluate`
 * serialises its argument and runs the function in the browser, where this file's
 * imports do not exist, so the table has to be read before the call, not inside it.
 */
async function ringedRun(page: Page, path: string, ring: Array<[string, number]>): Promise<State> {
  await page.goto(path);
  await waitForShell(page);
  await page.keyboard.press('Enter');
  await waitForScene(page, 'playing');

  const kinds = ring.map(([id, n]) => {
    const kind = ENEMIES.findIndex((e) => e.id === id);
    if (kind < 0) throw new Error(`no archetype named "${id}"`);
    return { id, kind, n };
  });

  const made = await page.evaluate((crowd: Array<{ id: string; kind: number; n: number }>) => {
    const win = window as unknown as AnyWindow;
    const out: Record<string, number> = {};
    // One evaluate for the whole crowd, so the first shots are fired at bodies rather
    // than at an empty arena and the counts read back are the ones that were put down.
    for (const body of crowd) out[body.id] = win.__forgeDebug?.spawn(body.kind, body.n) ?? 0;
    return { made: out, state: JSON.parse(JSON.stringify(win.__forgeState!())) };
  }, kinds);

  expect(made.state, 'the run should be reporting state').toBeDefined();
  return made.state;
}

test('chargers: spawnable through __forgeDebug, and counted by type', async ({ page }) => {
  const before = await ringedRun(page, '/?seed=21', [['charger', 6]]);

  expect(before.enemies.count, 'the ring of chargers should exist to shoot at').toBe(6);
  // `byType` is the scenario's only view of *what* is on screen, so this is the check
  // that the count is a count and not a zeroed-out shape: six chargers in, six counted.
  expect(before.enemies.byType.charger, 'chargers should be counted by type').toBe(6);
  expect(before.errors, 'the run should start error-free').toBe(0);

  // Then let it play. A charger that reached the player is the whole point of the
  // archetype, so one of them has to get close enough to appear in the nearest list —
  // and the pack has to start dying, or the spawn only proved the state reader.
  const fought = await playUntil(
    page,
    (s) => s.kills > before.kills && s.enemies.nearest.some((e) => e.type === 'charger'),
    30_000,
  );
  expect(fought, 'the chargers should be fought, and one should close on the player').toBe(true);

  const end = await readState(page);
  expect(end?.errors, 'the run should stay error-free').toBe(0);
});

test('the five new archetypes run in the live loop, and a dead splitter leaves splinters', async ({
  page,
}) => {
  const before = await ringedRun(page, '/?seed=22', [
    ['swarmling', 8],
    ['charger', 4],
    ['exploder', 4],
    ['splitter', 4],
    ['armored', 3],
  ]);

  const expected = { swarmling: 8, charger: 4, exploder: 4, splitter: 4, armored: 3 };
  expect(before.enemies.count).toBe(23);
  for (const [id, n] of Object.entries(expected)) {
    expect(before.enemies.byType[id], `${id} should be counted by type`).toBe(n);
  }

  // Splinters are only ever born from a splitter's death, so a non-zero count is the
  // live-loop proof that the split fires when the real damage pass kills the body —
  // which is the one thing the unit test cannot show, since it calls the kill directly.
  const split = await playUntil(page, (s) => (s.enemies.byType.splinter ?? 0) > 0, 40_000);
  expect(split, 'a splitter killed in the live loop should leave splinters').toBe(true);

  const fought = await playUntil(page, (s) => s.kills >= before.kills + 6, 40_000);
  expect(fought, 'the new bodies should be killable, not just spawnable').toBe(true);

  const end = await readState(page);
  expect(end?.errors, 'the run should stay error-free').toBe(0);
});