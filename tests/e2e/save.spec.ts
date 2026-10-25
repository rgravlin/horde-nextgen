import { test, expect, type Page } from '@playwright/test';

/**
 * Save and come back (TECH.md "Testing", the third scenario family).
 *
 * The feature is a round trip through the browser's own storage, so the test has to leave the
 * page: play a run, park it with Save on the pause screen, reload — a new app on a new World —
 * and take the run back out through the title's Continue. The assertions are the two numbers a
 * player would notice if they were wrong: where he stands and how far the run had got. A
 * Continue that quietly started a fresh run would move both by enough to fail here, which is
 * the point: the tolerances are a few frames of play wide, while a restart is metres and
 * hundreds of ticks away.
 *
 * Everything is read through `__forgeState()` rather than pixels, and every wait is on a
 * condition. The one sleep-shaped wait is the walk itself: how long the sim needs to cover four
 * metres in software rasterisation is a property of the machine, not of the game.
 */

type AnyWindow = {
  __forgeState?: () => {
    scene: string;
    tick: number;
    kills: number;
    errors: number;
    player: { x: number };
  };
  __forgeDebug?: Record<string, unknown>;
};

type Snapshot = ReturnType<NonNullable<AnyWindow['__forgeState']>>;

async function snapshot(page: Page): Promise<Snapshot | undefined> {
  return page.evaluate(() => {
    const win = window as unknown as AnyWindow;
    return win.__forgeState ? win.__forgeState() : undefined;
  });
}

/** Wait until the shell is up: the debug hook lands in the same turn as the state hook. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const win = window as unknown as AnyWindow;
    return typeof win.__forgeState === 'function' && win.__forgeDebug !== undefined;
  }, undefined, { timeout: 25_000 });
}

async function waitForScene(page: Page, scene: string, timeout = 10_000): Promise<void> {
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
 * Walk east until the player is `metres` past where the game put him, then let go.
 *
 * The distance, not the clock, is what the fixtures need: under SwiftShader a few seconds of
 * wall clock can be a fraction of that in play, and a run that has not travelled is a run whose
 * restored position proves nothing.
 */
async function walkEast(page: Page, metres: number): Promise<void> {
  await page.keyboard.down('KeyD');
  await page.waitForFunction(
    (want) => {
      const win = window as unknown as AnyWindow;
      return win.__forgeState !== undefined && win.__forgeState().player.x > want;
    },
    metres,
    { timeout: 30_000 },
  );
  await page.keyboard.up('KeyD');
}

/** How far a restored run may have drifted while the test was reading it: a few frames. */
const DRIFT_METRES = 1.5;
const DRIFT_TICKS = 120;

test('save, reload, Continue: the run comes back where it was saved', async ({ page }) => {
  await page.goto('/?seed=1');
  await waitForShell(page);
  await waitForScene(page, 'menu');

  // Nothing in storage yet, so the title has no way back to offer. This is the same question
  // the reload below will answer, asked while the answer is known.
  await expect(page.locator('[data-action="continue"]')).toBeHidden();

  await page.keyboard.press('Enter');
  await waitForScene(page, 'playing');
  // Twelve metres east is about two seconds of play at walking speed, which is the point: the
  // further the run has travelled, the further away "the same state" and "a fresh run" are.
  await walkEast(page, 12);

  // Pause, then ask for the state on screen to be kept.
  await page.keyboard.press('Escape');
  await waitForScene(page, 'paused');
  const saved = await snapshot(page);
  expect(saved, 'the run should have a clock and a place worth restoring').toBeDefined();
  expect(saved!.tick).toBeGreaterThan(100);
  expect(saved!.player.x).toBeGreaterThan(12);

  await page.locator('[data-action="save"]').click();

  // Reload: a new page, a new app and a new World, in the same browser storage.
  await page.reload();
  await waitForShell(page);
  await waitForScene(page, 'menu');

  // That the button is there at all is the round trip: Continue only appears while the shell
  // can read a run back out of storage, and it is a different app deciding that from the one
  // that wrote it.
  const cont = page.locator('[data-action="continue"]');
  await expect(cont).toBeVisible();
  await cont.click();
  await waitForScene(page, 'playing');

  const back = await snapshot(page);
  expect(back!.tick, 'the restored run starts from the tick it was saved at, not from zero')
    .toBeGreaterThanOrEqual(saved!.tick);
  expect(back!.tick, 'and only a few frames of play have gone by since').toBeLessThan(
    saved!.tick + DRIFT_TICKS,
  );
  expect(
    Math.abs(back!.player.x - saved!.player.x),
    `player.x came back at ${back!.player.x} rather than ${saved!.player.x}`,
  ).toBeLessThan(DRIFT_METRES);
  expect(back!.errors, 'the save round trip should stay error-free').toBe(0);

  // And it is a live run rather than a frozen one: still in play, the sim moves on from the
  // tick it was handed. Twenty ticks is a third of a second of play, which the page clears in a
  // few frames, and a Continue that loaded nothing would have to start from zero to get there.
  await page.waitForFunction(
    (from) => {
      const win = window as unknown as AnyWindow;
      return win.__forgeState !== undefined && win.__forgeState().tick > from;
    },
    back!.tick + 20,
    { timeout: 10_000 },
  );
  expect((await snapshot(page))!.errors).toBe(0);
});

test('Load on the pause screen puts the saved moment back', async ({ page }) => {
  await page.goto('/?seed=2');
  await waitForShell(page);
  await waitForScene(page, 'menu');
  await page.keyboard.press('Enter');
  await waitForScene(page, 'playing');
  await walkEast(page, 2);

  await page.keyboard.press('Escape');
  await waitForScene(page, 'paused');
  await page.locator('[data-action="save"]').click();
  const saved = await snapshot(page);
  expect(saved!.player.x).toBeGreaterThan(2);

  // Back into the fight and four metres further on, so the screen is showing somewhere the
  // save is not. That gap is what makes the next assertion mean anything.
  await page.locator('[data-action="resume"]').click();
  await waitForScene(page, 'playing');
  await walkEast(page, saved!.player.x + 4);

  await page.keyboard.press('Escape');
  await waitForScene(page, 'paused');
  const load = page.locator('[data-action="load"]');
  await expect(load).toBeVisible();
  await load.click();
  await waitForScene(page, 'playing');

  const back = await snapshot(page);
  expect(
    Math.abs(back!.player.x - saved!.player.x),
    `Load should hand back the saved position (${saved!.player.x}), not the four metres since`,
  ).toBeLessThan(DRIFT_METRES);
  expect(back!.tick).toBeGreaterThanOrEqual(saved!.tick);
  expect(back!.tick).toBeLessThan(saved!.tick + DRIFT_TICKS);
  expect(back!.errors, 'the pause-menu load should stay error-free').toBe(0);
});

test('an empty shelf offers no way back', async ({ page }) => {
  // Storage cleared on every navigation, so this says "no save, no Continue" rather than
  // whatever the previous test left in the shelf.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear();
    } catch {
      // A browser with storage switched off has the answer already.
    }
  });
  await page.goto('/?seed=3');
  await waitForShell(page);
  await waitForScene(page, 'menu');

  await expect(page.locator('[data-action="continue"]')).toBeHidden();
  // Which is not the same as the title having no buttons at all.
  await expect(page.locator('[data-action="start"]')).toBeVisible();
});