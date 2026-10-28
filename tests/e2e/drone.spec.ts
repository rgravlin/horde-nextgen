import { test, expect, type Page, type TestInfo } from '@playwright/test';

/**
 * The ward drone seen from the browser: is there a companion in the drawn frame, and is he drawn
 * where the simulation says he is?
 *
 * The two unit files next door stop short of this on purpose. `drone-geometry.test.ts` pins the
 * rig's maths over a bare `Scene`, and `droneView.test.ts` pins the lifetime of the pieces — that
 * the companion is mounted beside the player's rig rather than inside the per-World kit, and so
 * outlives a restart. Neither can see the shipped assembly: `renderer.ts` needs a canvas and a
 * backend, and the Node harness has neither, so a draw pass that never reached the rig would fail
 * no unit test at all. That is not hypothetical. The drone's picture is the second half of one
 * seam — the rig has to be *in* the scene and *synced* by the frame — and both halves are silent
 * when they go missing: the rounds keep coming out of empty air, the state keeps reporting the
 * drone stat, and the only thing that changes is the picture.
 *
 * So this file reads two places out of `__forgeState()` rather than any pixels, exactly as
 * `facing.spec.ts` reads two lines: `drone.orbit`, which the shell takes from `droneOrbit` (the
 * point the companion's rounds are loosed from), and `drone.drawn`, which it reads back off the
 * rig through `View.dronePoint`. The pair is the point. On its own `drawn` would be a number
 * copied out of the sim's own answer and would agree with itself on every frame, including the one
 * where nothing drew the drone; read beside `orbit`, the two part company the moment the rig is
 * unmounted, un-synced, or left standing where the last run parked it. A wrong answer has to be
 * possible for a check to mean anything, and this is where the wrong answers live.
 *
 * Each test is aimed at a moment where a wrong answer is possible:
 *
 * - a run that buys the companion and then walks 20 m across the floor. A rig the frame never
 *   synced keeps the transform it was built with, so the drone stays at the origin while the
 *   player leaves — the exact stale-read failure the unit file calls out, and only a moving player
 *   can show it;
 * - that same walk held in view for six seconds while the ring carries him round, which a drone
 *   drawn at one fixed offset off its player cannot do: it would visit one bearing and no more;
 * - a run that never bought him at all, which is the half that makes the first two say something.
 *
 * The thresholds were measured on this rig rather than derived, twice, and carry the margin in
 * brackets. A software rasteriser runs the 60 Hz clock at whatever speed this box allows (6 s of
 * the walk below is ~220 ticks), `drawn` is the *last drawn* frame and so trails the tick `orbit`
 * is struck at, and the drawn point is interpolated between two ticks. What a test here claims is
 * which side of the player the drone lies on and roughly how far out, not the last decimal.
 * Screenshots are taken as evidence for a reviewer; no pixels are compared
 * (docs/architecture/tests.md).
 */

/** m — the companion's orbit radius, from `sim/systems/drone.ts`. */
const ORBIT_R = 1.35;

/**
 * m — how far off a perfect ring point the drawn body may sit.
 *
 * Measured at 0.000 over 180 samples: interpolation runs along a chord, which shortens the radius
 * by almost nothing. The room here is for staleness, not for the maths.
 */
const ON_RING = 0.25;

/**
 * m — how far the drawn point may trail the ring point the shell prints beside it.
 *
 * Measured at 0.067, twice. About a seventh of what one tick of lag between the two reads costs at
 * a walking pace, which is the only thing that legitimately moves this number.
 */
const BEHIND_BY = 0.45;

/** m — how far the player has to travel for "he rides with the player" to mean anything. */
const FAR = 4;

type Point = { x: number; y: number };

type State = {
  scene: string;
  tick: number;
  errors: number;
  powerups: Array<{ id: string; tier: number }>;
  player: { x: number; y: number };
  drone: { shown: boolean; orbit: Point; drawn: { x: number; y: number; h: number } };
};

type AnyWindow = {
  __forgeState?: () => State;
  __forgeDebug?: { givePowerup(id: string): boolean };
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
 * Start a run and leave the pointer over the middle of the canvas.
 *
 * As in `facing.spec.ts`: the sampler holds one pointer position and keeps aiming at its last
 * ground point, so a run started with the cursor off the floor aims at wherever the last one left
 * it. That matters here because the companion answers to a fight that is happening rather than to
 * a frozen one, and a fight is what a walking player gets into.
 */
async function startRun(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForShell(page);
  await page.mouse.move(640, 360);
  await page.keyboard.press('Enter');
  await waitForScene(page, 'playing');
}

/**
 * Play until `want` holds, spending a level-up card when one appears.
 *
 * A level-up freezes the sim, and a frozen sim holds the drone exactly where it was, so reading
 * through the freeze would test the pause rather than the drawing.
 */
async function playUntil(
  page: Page,
  want: (s: State) => boolean,
  ms: number,
): Promise<State | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await readState(page);
    if (s !== undefined) {
      if (want(s)) return s;
      if (s.scene === 'levelup') await page.keyboard.press('Digit1');
      else if (s.scene !== 'playing') return undefined;
    }
    await page.waitForTimeout(50);
  }
  return undefined;
}

/**
 * Read the run every `gap` ms for `ms`, keeping only the frames that were actually playing.
 *
 * A held frame reports the same picture as the frame before it — that is what a pause means — so a
 * sample taken through one duplicates a moment already measured.
 */
async function watch(page: Page, ms: number, gap = 60): Promise<State[]> {
  const seen: State[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await readState(page);
    if (s !== undefined && s.scene === 'playing') seen.push(s);
    await page.waitForTimeout(gap);
  }
  return seen;
}

/** Distance between two world-space pairs. */
function gap(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Which side of his player the drone is on, as a quadrant index. */
function quadrant(s: State): number {
  const dx = s.drone.drawn.x - s.player.x;
  const dy = s.drone.drawn.y - s.player.y;
  return (dx >= 0 ? 0 : 2) + (dy >= 0 ? 0 : 1);
}

/**
 * The walk as it was read, one line per sample, built only when something already failed.
 *
 * Built on the failure path alone and capped: assembling it per sample would cost 90 string joins
 * a run, and the only reader is a person reading a red test.
 */
function report(seen: State[]): string {
  return seen
    .slice(0, 30)
    .map(
      (s) =>
        `tick ${s.tick}: drawn ${s.drone.drawn.x.toFixed(2)},${s.drone.drawn.y.toFixed(
          2,
        )} orbit ${s.drone.orbit.x.toFixed(2)},${s.drone.orbit.y.toFixed(
          2,
        )} at ${gap(s.drone.drawn, s.player).toFixed(2)} m`,
    )
    .join('\n');
}

/** Evidence for a reviewer: the frame at a moment the test has just pinned numerically. */
async function film(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`drone-${name}.png`) });
}

test('the companion is drawn, on his ring, and rides with a player who walks away', async ({
  page,
}, testInfo) => {
  await startRun(page, '/?seed=5');

  // The card, through the shell's own grant door rather than by waiting to be dealt one: the
  // level-up offer is three cards drawn at random, so a spec that hoped for the companion could
  // not say which run it had been looking at.
  const granted = await page.evaluate(() =>
    (window as unknown as AnyWindow).__forgeDebug?.givePowerup('drone') ?? false,
  );
  expect(granted, 'the ward drone card is grantable').toBe(true);

  const armed = await playUntil(page, (s) => s.drone.shown, 5_000);
  expect(armed, 'the companion appears in the drawn frame').not.toBeUndefined();

  // Then walk, which is where the test's teeth are. Two things are measured against every sample
  // and neither is a copy of the other: how far the body sits from the player, and how far it sits
  // from the ring point the shell prints beside it. A rig nobody synced fails both after the first
  // metre — the player leaves and the drawing does not — and a rig that tracked a stale or fixed
  // ring point fails the second while still looking plausible on the first.
  await page.keyboard.down('KeyD');
  const seen = await watch(page, 6_000);
  await page.keyboard.up('KeyD');
  await film(page, testInfo, 'ring');

  expect(seen.length, 'and there were frames to read').toBeGreaterThan(20);
  const first = seen[0];
  const last = seen[seen.length - 1];
  expect(
    gap({ x: last.player.x, y: last.player.y }, { x: first.player.x, y: first.player.y }),
    'the player crossed most of the floor',
  ).toBeGreaterThan(FAR);

  for (const s of seen) {
    // Held in view for six seconds of a walk rather than caught once. A companion that winked out
    // between waves, or as soon as the crowd thinned, fails here rather than on a lucky sample.
    expect(s.drone.shown, `tick ${s.tick}: still drawn`).toBe(true);
    expect(
      Math.abs(gap(s.drone.drawn, s.player) - ORBIT_R),
      `tick ${s.tick}: one ring out`,
    ).toBeLessThan(ON_RING);
    expect(gap(s.drone.drawn, s.drone.orbit), `tick ${s.tick}: behind its ring`).toBeLessThan(
      BEHIND_BY,
    );

    // Above the crowd rather than behind it: the height is what says *flying*, and it is the other
    // half of the transform a frame would have to skip to leave the drone on the floor. Measured
    // 0.99 to 1.11 over the whole walk, which is the hover height and its breath.
    expect(s.drone.drawn.h, `tick ${s.tick}: airborne`).toBeGreaterThan(0.9);
    expect(s.drone.drawn.h, `tick ${s.tick}: and not a kilometre up`).toBeLessThan(1.2);
  }

  // The ring is walked, not merely stood on: the bearing has to travel, which a drone held at one
  // fixed offset off its player cannot do. Measured all four on this box, three asked for.
  const quadrants = new Set(seen.map(quadrant));
  expect(
    quadrants.size,
    `the ring was carried round, not held at one bearing: seen ${quadrants.size}`,
  ).toBeGreaterThanOrEqual(3);

  expect(last.errors, `no errors while he flew:\n${report(seen)}`).toBe(0);
});

test('a run that never bought the companion draws none', async ({ page }) => {
  await startRun(page, '/?seed=5');

  const seen = await watch(page, 2_000);
  expect(seen.length, 'the run played').toBeGreaterThan(8);

  // The control. Without it the test above only shows that something was drawn somewhere: a
  // companion that was always in the scene, whatever the run owned, would pass it just as happily
  // as one the run had earned — and that is the failure mode this whole seam is exposed to.
  for (const s of seen) {
    expect(
      s.powerups.some((p) => p.id === 'drone'),
      `tick ${s.tick}: this run never bought him`,
    ).toBe(false);
    expect(s.drone.shown, `tick ${s.tick}: and nothing was drawn for him`).toBe(false);
  }

  const last = seen[seen.length - 1];
  expect(last.errors, 'and the run took no errors').toBe(0);
});
