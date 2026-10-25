import { test, expect, type Page } from '@playwright/test';

/**
 * The first end-to-end slice (TECH.md "Testing").
 *
 * It plays the game the way the design brief says a person would — start, move,
 * let auto-fire kill, take a level-up, pause, resume — and reads the result through
 * the `window.__forgeState()` seam rather than pixels, so it asserts on facts
 * (a position changed, a kill happened, a power-up was granted) and on the run
 * staying error-free. The whole game runs in software rasterisation here, so the
 * waits are generous and every wait is on a condition, not a bare sleep, where the
 * outcome is what matters.
 *
 * Chromium needs the unsafe-GPU flags to get any backend at all; the project config
 * passes them. The webgl2 pass forces `forceWebGL: true` via `?gl=webgl2`, so the
 * same play is checked again on the fallback backend (TECH.md "Second pass").
 */

type AnyWindow = {
  __forgeState?: () => {
    scene: string;
    backend: string;
    tick: number;
    kills: number;
    errors: number;
    powerups: Array<{ id: string; tier: number }>;
    player: { x: number };
  };
  __forgeDebug?: { grantXp: (n: number) => void };
};

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as AnyWindow;
    return win.__forgeState ? win.__forgeState() : undefined;
  });
}

/**
 * Wait until the shell is up.
 *
 * The debug hook is installed in the same synchronous turn as the state hook, once
 * the renderer resolves, so its presence is the signal that a run can actually be
 * driven — before it, `__forgeState` only answers "menu".
 */
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

async function errorCount(page: Page): Promise<number> {
  const state = await snapshot(page);
  return state?.errors ?? -1;
}

test('playing slice: start, level-up, pause/resume, move, auto-fire kills', async ({ page }) => {
  // The 500ms initial wait is the scenario harness's own "capture the start state"
  // beat; the first assertion is that a page load with no interaction sits in the
  // menu, so the Start button has a real job.
  await page.goto('/?seed=1');
  await waitForShell(page);
  await waitForScene(page, 'menu');

  const start = await snapshot(page);
  expect(start, 'a fresh page should report zero caught errors').toMatchObject({ errors: 0 });

  // 1 — leave the menu. Enter is the accept key (mirrors the Start button).
  await page.keyboard.press('Enter');
  await waitForScene(page, 'playing');

  // 2 — a level-up offer can be reached, offered and taken. XP is granted through
  // the documented debug hook rather than farmed, so this leg is about the scene
  // machine and the card, not about surviving long enough to level.
  await page.evaluate(() => {
    const win = window as unknown as AnyWindow;
    win.__forgeDebug?.grantXp(6);
  });
  await waitForScene(page, 'levelup');
  await page.keyboard.press('Digit1');
  await page.waitForFunction(
    () => {
      const win = window as unknown as AnyWindow;
      return win.__forgeState !== undefined && win.__forgeState().powerups.length > 0;
    },
    undefined,
    { timeout: 5000 },
  );
  // Picking a card should hand control back to play.
  await waitForScene(page, 'playing');

  // 3 — pause is a full freeze: the clock stops, so `tick` must not advance.
  await page.keyboard.press('Escape');
  await waitForScene(page, 'paused');
  const tickWhilePaused = await page.evaluate(() => {
    const win = window as unknown as AnyWindow;
    return win.__forgeState ? win.__forgeState().tick : -1;
  });
  await page.waitForTimeout(600);
  const tickAfterPause = await page.evaluate(() => {
    const win = window as unknown as AnyWindow;
    return win.__forgeState ? win.__forgeState().tick : -1;
  });
  expect(tickAfterPause, 'a paused scene must not step the sim').toBe(tickWhilePaused);

  // ...and Esc resumes.
  await page.keyboard.press('Escape');
  await waitForScene(page, 'playing');

  // 4 — aim + move. Hold D and the player has to travel east.
  const startX = (await snapshot(page))?.player.x ?? 0;
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyD');
  const moved = await page.evaluate(() => {
    const win = window as unknown as AnyWindow;
    return win.__forgeState !== undefined && win.__forgeState().player.x > 0.2;
  });
  expect(moved, `player.x should grow from ${startX} once D is held`).toBe(true);

  // 5 — auto-fire is on, so the first chasers to close should die under fire. Poll
  // for it because a software renderer runs the 60 Hz sim in real time only when it
  // can hold the frame budget.
  await page.waitForFunction(
    () => {
      const win = window as unknown as AnyWindow;
      return win.__forgeState !== undefined && win.__forgeState().kills > 0;
    },
    undefined,
    { timeout: 30_000 },
  );

  // 6 — no uncaught error at any point across the whole run.
  expect(await errorCount(page), 'the run should stay error-free').toBe(0);
});

test('webgl2 pass: ?gl=webgl2 forces the WebGL2 backend', async ({ page }) => {
  await page.goto('/?seed=1&gl=webgl2');
  await waitForShell(page);

  // The URL flag is the whole point of the second pass: it must reach the renderer as
  // `forceWebGL: true` and come back out as the WebGL2 backend.
  await page.waitForFunction(
    () => {
      const win = window as unknown as AnyWindow;
      return win.__forgeState !== undefined && win.__forgeState().backend === 'webgl2';
    },
    undefined,
    { timeout: 25_000 },
  );

  const state = await snapshot(page);
  expect(state?.backend).toBe('webgl2');
  expect(await errorCount(page), 'the WebGL2 path should stay error-free').toBe(0);
});