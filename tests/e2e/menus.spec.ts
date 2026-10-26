import { expect, test, type Page } from '@playwright/test';

/**
 * The menus, driven the way a player drives them.
 *
 * The panels are not decoration over the simulation, so the checks are not on pixels: every
 * assertion is on `__forgeState()`, which is the harness's seam too. Three things have to be true
 * for the Settings screen to be worth having, and each could fail with the panels looking
 * perfectly good:
 *
 * - a dial change is **stored**, not merely applied, so it is the same after a reload;
 * - a keybind change reaches the table the sampler reads, so the new key pauses the game and the
 *   old one no longer does;
 * - a panel is a **freeze**: opening Settings mid-run stops the sim rather than letting it run on
 *   behind a translucent box.
 *
 * Two fixtures keep the fixtures honest. `ready` waits for `__forgeDebug`, which the shell only
 * installs once the app exists — before that, `__forgeState` answers from the menu placeholder and
 * every scene and setting in it is a default, so a poll that only waits for a *scene* can read the
 * page before the game is in it. `keys` clicks the canvas first: a keyboard event goes to
 * whatever has focus, and a freshly loaded page has none.
 */

interface Shown {
  scene: string;
  tick: number;
  errors: number;
  settings: { shake: number; autoFire: boolean; binds: Record<string, string> };
}

function shown(page: Page): Promise<Shown> {
  // Read the hook the game publishes rather than the DOM: a panel that shows the wrong number is
  // a different bug from a game that runs on the wrong setting, and only the second matters.
  return page.evaluate(() => (window as any).__forgeState());
}

const scene = (page: Page): Promise<string> => shown(page).then((s) => s.scene);

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__forgeDebug !== undefined, null, {
    timeout: 20_000,
  });
}

async function waitScene(page: Page, want: string): Promise<void> {
  await ready(page);
  await expect.poll(() => scene(page), { timeout: 20_000 }).toBe(want);
}

async function keys(page: Page): Promise<void> {
  await page.locator('#gl').click({ position: { x: 10, y: 10 } });
}

async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-action="settings"]').first().click();
  await waitScene(page, 'settings');
}

/** Open a tab of the Settings panel; each tab's rows live in their own list. */
async function openTab(page: Page, tab: string): Promise<void> {
  await page.locator(`[data-action="tab:${tab}"]`).click();
}

test('a setting that was changed is still changed after a reload', async ({ page }) => {
  await page.goto('/?seed=11');
  await waitScene(page, 'menu');
  await openSettings(page);

  const before = (await shown(page)).settings.shake;
  await openTab(page, 'gameplay');
  await page.locator('[data-setting="shake"]').click();
  const moved = (await shown(page)).settings.shake;
  expect(moved, 'the dial moved off its old value').not.toBe(before);

  // What is in the drawer, read straight out of it. Splitting this from the reload check keeps
  // "it was never written" separate from "it was written and not read back".
  const filed = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('neonhorde.settings.v1') ?? 'null'),
  );
  expect(filed, 'the settings file is the one the panel wrote').not.toBeNull();
  expect(filed.shake).toBe(moved);

  // The reload is the point: this reads the file back through a fresh app.
  await page.reload();
  await waitScene(page, 'menu');
  const back = await shown(page);
  expect(back.settings.shake).toBe(moved);
  expect(back.errors, 'a settings file that would not parse is counted, and this one parsed').toBe(
    0,
  );
});

test('a rebound key is the key the game listens to', async ({ page }) => {
  await page.goto('/?seed=11');
  await waitScene(page, 'menu');
  await openSettings(page);
  await openTab(page, 'controls');

  // Focus first, then arm the row, then press. The capture-phase listener takes a pointer button
  // as a source too, so a click while the row is armed would be read as the new bind — and the
  // canvas has to hold focus before a key press goes anywhere.
  await keys(page);
  await page.locator('[data-bind="pause"]').click();
  await page.keyboard.press('KeyZ');
  await expect
    .poll(() => shown(page).then((s) => s.settings.binds['pause']), { timeout: 20_000 })
    .toBe('KeyZ');

  // Out of the panel and into a run, on the new map: `Escape` no longer means anything, because
  // the key it carried now lives on `z`, so leaving the panel is the new key's job.
  await page.keyboard.press('KeyZ');
  await waitScene(page, 'menu');
  await page.keyboard.press('Enter');
  await waitScene(page, 'playing');

  // The old pause key is off the map, so it must do nothing at all.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  expect(await scene(page)).toBe('playing');

  await page.keyboard.press('KeyZ');
  await waitScene(page, 'paused');
  expect((await shown(page)).errors).toBe(0);
});

test('the pause freezes the run, and lets go when asked', async ({ page }) => {
  await page.goto('/?seed=11');
  await waitScene(page, 'menu');
  await keys(page);
  await page.keyboard.press('Enter');
  await waitScene(page, 'playing');

  await page.keyboard.press('Escape');
  await waitScene(page, 'paused');
  const stopped = await shown(page);
  await page.waitForTimeout(600);
  const still = await shown(page);
  expect(still.tick, 'six tenths of a second on the pause panel costs no simulation time').toBe(
    stopped.tick,
  );

  await page.keyboard.press('Escape');
  await waitScene(page, 'playing');
  const played = await shown(page);
  expect(played.tick, 'and the clock resumes rather than staying stopped').toBeGreaterThan(
    stopped.tick,
  );
  expect(played.errors).toBe(0);
});
