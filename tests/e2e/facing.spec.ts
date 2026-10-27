import { test, expect, type Page, type TestInfo } from '@playwright/test';

import { ENEMIES } from '../../src/content/enemies';

/**
 * The player rig's facing, seen from the browser: does the gun that is *drawn* point along the
 * line the rounds actually take?
 *
 * `tests/unit/facing.test.ts` pins the maths by standing a rig up in Node and reading its
 * matrix. What it cannot show is the shipped combination — auto-fire awake, the camera drifting
 * under a 2 m aim lead, the pointer moving between ticks — which is where the two halves of the
 * bug used to disagree with the fight: the rig was turned from the steered aim while the round
 * led a body, and it was turned with an `atan2` a quarter turn off the floor's.
 *
 * So this file reads two pairs out of `__forgeState()` rather than any pixels: `player.shot`,
 * the line the weapon pass gave this tick's round, and `player.barrel`, the line the rig was
 * drawn pointing along, read back off the rig itself (`View.playerFace`) instead of re-derived
 * from the first. That is the only way a browser check can see the bug at all — a state key
 * copied out of the sim's own answer agrees with itself every time, including while the barrel
 * is a quarter turn off its own tracers — and it keeps this file asserting facts rather than
 * pictures, which is the rule for Playwright here (docs/architecture/tests.md): screenshots are
 * taken as evidence for a reviewer, never compared.
 *
 * Each test is aimed at a moment where a wrong answer is possible:
 *
 * - a pointer parked on one side of the screen with the trigger held, so the shot *must* go
 *   where the pointer is and the barrel has to follow it (a quarter-turn yaw reads about (0, -1)
 *   here, not (1, 0));
 * - a crowd close and the pointer thrown the other way, so auto-fire takes the gun away from
 *   the cursor and the barrel has to go with it;
 * - the same crowd with the trigger held, where the cursor wins again — which is what stops
 *   this file passing on a rig that merely tracks whichever body happens to be closest;
 * - auto-fire off, the pointer dragged across the floor with the trigger down, where the
 *   cursor is the only thing that aims anything.
 *
 * The screen spots were measured against the pointer→ground ray on this rig (a 40° FOV, 55°
 * pitch, 22 m camera over a 1280x720 canvas), and the thresholds are wide on purpose: a
 * software rasteriser runs the 60 Hz clock only as fast as this box allows, so what a test
 * claims is which side of the player the barrel lies on, not the last decimal.
 */

/** A place to park the pointer, and where the gun points if it is parked there. */
type Spot = { at: [number, number]; dir: Line };

type Line = { x: number; y: number };

type State = {
  scene: string;
  backend: string;
  tick: number;
  kills: number;
  errors: number;
  enemies: { count: number; nearest: Array<{ x: number; y: number }> };
  player: { x: number; y: number; shot: Line; barrel: Line };
  settings: { autoFire: boolean };
};

type AnyWindow = {
  __forgeState?: () => State;
  __forgeDebug?: { spawn(type: number, n: number): number };
};

const EAST: Spot = { at: [1180, 360], dir: { x: 1, y: 0 } };
const NORTH: Spot = { at: [640, 60], dir: { x: 0, y: 1 } };
const WEST: Spot = { at: [60, 360], dir: { x: -1, y: 0 } };
const SOUTH: Spot = { at: [640, 660], dir: { x: 0, y: -1 } };

/** How far off the round's line the barrel may lie, as the dot of the two unit pairs. */
const ON_FIRE = 0.995;

/**
 * The drag's finish line: the barrel on the far side of the player and still on its own round.
 *
 * Both halves at one instant, since either alone is satisfiable by a broken rig — one that never
 * turns keeps the two lines together while pointing anywhere, and one that turns with the
 * quarter-turn error puts the barrel west while the round goes north.
 */
function westAndOnFire(s: State): boolean {
  return dot(s.player.barrel, WEST.dir) > 0.9 && dot(s.player.barrel, s.player.shot) > ON_FIRE;
}

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
 * The card matters: a level-up freezes the sim, and a frozen sim holds the barrel wherever it
 * was. Reading through the freeze would test the pause rather than the facing.
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

/** The dot of two unit pairs: 1 same way round, 0 sideways, -1 straight back. */
function dot(a: Line, b: Line): number {
  return a.x * b.x + a.y * b.y;
}

/** A snapshot of the two lines and the scene, phrased for a failure message. */
function lines(s: State | undefined): string {
  return s === undefined
    ? 'no state'
    : `${s.scene} at tick ${s.tick}: shot ${JSON.stringify(s.player.shot)} barrel ${JSON.stringify(
        s.player.barrel,
      )}`;
}

/**
 * Start a run, and leave the pointer over the middle of the canvas.
 *
 * The pointer starts there because the sampler holds one pointer position and keeps aiming at
 * its last ground point: a run started with the cursor off the floor would aim at wherever the
 * last one left it, and every spot below is measured on the floor rather than on the screen.
 */
async function startRun(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForShell(page);
  await page.mouse.move(640, 360);
  await page.keyboard.press('Enter');
  await waitForScene(page, 'playing');
}

/** Put a ring of chasers around the player, close enough that auto-fire wakes on them. */
async function ringOfChasers(page: Page, n: number): Promise<number> {
  // The archetype index is looked up in Node and passed in as data: `page.evaluate` runs its
  // function in the browser, where this file's imports do not exist.
  const kind = ENEMIES.findIndex((def) => def.id === 'chaser');
  expect(kind, 'the ring is chasers').toBeGreaterThanOrEqual(0);
  return page.evaluate(
    ({ index, count }) => (window as unknown as AnyWindow).__forgeDebug?.spawn(index, count) ?? 0,
    { index: kind, count: n },
  );
}

/** Evidence for a reviewer: the frame at a moment the test has just pinned numerically. */
async function film(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`facing-${name}.png`) });
}

test('the barrel follows the pointer: east, then north', async ({ page }, testInfo) => {
  await startRun(page, '/?seed=5');

  // The trigger stays down for both legs. A held trigger always shoots the steer, so the shot
  // line is the pointer's own line here whatever the crowd does, and a rig that disagrees with
  // it is a picture problem rather than a fight problem.
  await page.mouse.move(...EAST.at);
  await page.mouse.down();

  // Due east. The shipped `atan2(aimY, aimX)` turned this rig to about (0, -1) — the barrel lay
  // south while the rounds went east — so the x test is the one that fails without the fix, and
  // the y bound is what keeps "sideways" from counting as a pass.
  const east = await playUntil(
    page,
    (s) =>
      s.player.barrel.x > 0.9 &&
      Math.abs(s.player.barrel.y) < 0.25 &&
      dot(s.player.barrel, s.player.shot) > ON_FIRE,
    10_000,
  );
  const afterEast = await readState(page);
  await film(page, testInfo, 'aim-right');
  expect(
    east,
    `a pointer parked due east should draw the barrel east, not (0, -1); ${lines(afterEast)}`,
  ).toBe(true);

  // Then due north, which the same wrong turn put at about (1, 0): the two legs together pin
  // the quarter turn in both directions rather than catching one by luck.
  await page.mouse.move(...NORTH.at);
  const north = await playUntil(
    page,
    (s) =>
      s.player.barrel.y > 0.9 &&
      Math.abs(s.player.barrel.x) < 0.25 &&
      dot(s.player.barrel, s.player.shot) > ON_FIRE,
    10_000,
  );
  const afterNorth = await readState(page);
  await film(page, testInfo, 'aim-up');
  expect(
    north,
    `a pointer parked due north should draw the barrel north, not (1, 0); ${lines(afterNorth)}`,
  ).toBe(true);

  await page.mouse.up();
  expect((await readState(page))?.errors, 'the run should stay error-free').toBe(0);
});

test('auto-fire leads a body, and the barrel goes with the round rather than the cursor', async ({
  page,
}, testInfo) => {
  await startRun(page, '/?seed=5');

  // Eight to fourteen metres out against an eighteen-metre auto-fire range, so the gun wakes on
  // the ring. One `evaluate` for the whole crowd, as in `enemies-a.spec.ts`: the first reads
  // should see bodies, not an empty arena.
  expect(await ringOfChasers(page, 14), 'the ring should have landed').toBeGreaterThan(0);

  // Park the pointer on the far side of the player from the body nearest at that moment, so the
  // steered line and the shot line have to disagree. Without that the test would be watching two
  // lines that were always the same, and any rig at all would pass it.
  const before = await readState(page);
  expect(before?.enemies.nearest.length, 'a body should be near enough to lead').toBeGreaterThan(0);
  const body = before!.enemies.nearest[0];
  const toBody = { x: body.x - before!.player.x, y: body.y - before!.player.y };
  const away = [WEST, EAST, SOUTH, NORTH].sort(
    (a, b) => dot(a.dir, toBody) - dot(b.dir, toBody),
  )[0];
  await page.mouse.move(...away.at);

  // Bodies in reach, the gun taken off the pointer by auto-fire (the pointer's own dot against
  // the barrel is the read of that, since the pointer was parked away from the crowd), and the
  // barrel still on its round. All three at one instant: the last one alone would also be true
  // of a rig that never turns, and the first two alone of a rig drawn anywhere at all.
  const led = await playUntil(
    page,
    (s) =>
      s.enemies.count > 0 &&
      dot(s.player.barrel, away.dir) < -0.3 &&
      dot(s.player.shot, away.dir) < -0.3 &&
      dot(s.player.barrel, s.player.shot) > ON_FIRE,
    25_000,
  );
  const sample = await readState(page);
  await film(page, testInfo, 'horde');
  expect(
    led,
    `somewhere in the crowd fight the gun should leave the pointer and the barrel should follow; ${lines(
      sample,
    )} with ${sample?.enemies.count} bodies`,
  ).toBe(true);

  expect((await readState(page))?.errors, 'the crowd fight should stay error-free').toBe(0);
});

test('a held trigger takes the barrel off the crowd and back onto the cursor', async ({
  page,
}, testInfo) => {
  await startRun(page, '/?seed=5');
  expect(await ringOfChasers(page, 14), 'the ring should have landed').toBeGreaterThan(0);

  // The companion to the test above, and the reason that one is allowed to trust a barrel
  // pointing at a body: with the trigger down the gun shoots the steer even under auto-fire, so
  // a rig that merely tracked the nearest body — or derived a line of its own, which is what
  // used to happen — fails here instead of passing on the crowd it was given.
  await page.mouse.move(...EAST.at);
  await page.mouse.down();

  const held = await playUntil(
    page,
    (s) =>
      s.enemies.count > 0 &&
      dot(s.player.barrel, EAST.dir) > 0.9 &&
      dot(s.player.barrel, s.player.shot) > ON_FIRE,
    20_000,
  );
  const sample = await readState(page);
  await film(page, testInfo, 'held-into-crowd');
  expect(
    held,
    `with the trigger down the barrel should sit on the cursor amid the crowd; ${lines(
      sample,
    )} with ${sample?.enemies.count} bodies`,
  ).toBe(true);

  await page.mouse.up();
  expect((await readState(page))?.errors, 'the run should stay error-free').toBe(0);
});

test('auto-fire off: a cursor dragged with the trigger down keeps the gun on its own line', async ({
  page,
}, testInfo) => {
  // Mouse aim mode, the other half of the shipped pair. Auto-fire is seeded off through the
  // settings key — the same door `save.spec.ts` uses for storage — so the gun only shoots where
  // the pointer points: there is no lock for the rig to hide behind, and the cursor is the only
  // thing that aims anything.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('neonhorde.settings.v1', JSON.stringify({ autoFire: false }));
    } catch {
      // A browser with storage switched off cannot be told anything, and has no auto-fire.
    }
  });
  await startRun(page, '/?seed=5');

  expect(
    (await readState(page))?.settings.autoFire,
    'the seed should have reached the settings, or this run is the auto-fire one',
  ).toBe(false);

  expect(await ringOfChasers(page, 8), 'the ring should have landed').toBeGreaterThan(0);

  // East with the trigger down, then dragged west without letting go: the gun has to travel with
  // the cursor, which a rig frozen at spawn cannot do and a rig built on `atan2(aimY, aimX)`
  // does sideways instead. The sweep keeps to the measured east↔west band (mid-height, where a
  // screen point lands due east or due west rather than off to a corner) and stops short of the
  // player's own feet, where a pointer stops being a direction.
  await page.mouse.move(...EAST.at);
  await page.mouse.down();
  const seenEast = await playUntil(
    page,
    (s) => dot(s.player.barrel, EAST.dir) > 0.9 && dot(s.player.barrel, s.player.shot) > ON_FIRE,
    12_000,
  );
  const atEast = await readState(page);
  await film(page, testInfo, 'drag-east');

  let sawWest = false;
  if (seenEast) {
    // The drag itself is real input, eleven stops from x=1080 to x=100 at the mid line, and the
    // fire button never comes up. What is checked afterwards is that the rig kept up: the aim
    // moves between ticks, so a barrel that ends up west of the player *and* on its own round
    // has been turning the whole way.
    for (let x = 1080; x >= 100 && !sawWest; x -= 90) {
      await page.mouse.move(x, 360);
      await page.waitForTimeout(120);
      sawWest = await playUntil(page, westAndOnFire, 500);
    }
  }
  const afterDrag = await readState(page);
  await film(page, testInfo, 'drag-west');
  expect(seenEast, `the barrel should start on the east cursor; ${lines(atEast)}`).toBe(true);
  expect(sawWest, `the barrel should follow the cursor to the west; ${lines(afterDrag)}`).toBe(
    true,
  );

  // And the rounds still arrive: a held trigger at a crowd should empty some magazine, which is
  // the aim chain working end to end rather than the picture merely agreeing with itself. A run
  // that died on the way reads as a failure here, which is right: the play ran out, not the
  // budget.
  const killed = await playUntil(page, (s) => s.kills > 0, 15_000);
  const last = await readState(page);
  await film(page, testInfo, 'drag-kill');
  expect(killed, `shots should still land in mouse aim mode; ${lines(last)}`).toBe(true);
  expect(last?.errors, 'mouse aim mode should stay error-free').toBe(0);

  await page.mouse.up();
});