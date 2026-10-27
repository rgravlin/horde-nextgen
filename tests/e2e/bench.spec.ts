import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';

import type { App, ForgeState } from '../../src/game/appTypes';
import type { BenchResult } from '../../src/game/bench';

/**
 * The browser half of the bench (TECH.md "Bench mode", ARCHITECTURE.md "Tests").
 *
 * `tools/bench.ts` times one tick of the rules with no renderer; this times whole frames *with*
 * one, which is where a thousand-body horde can go wrong in ways the headless gate cannot see: an
 * instance buffer uploaded per entity, a particle field copied twice on its way to the GPU, a
 * lighting layout rebuilt every frame. The two numbers only mean something side by side — the
 * headless one is what a tick costs, this one is what a frame costs, and the gap between them is a
 * draw-path question.
 *
 * Nothing here is gated on speed, deliberately (TECH.md: "reported, not gated"). This box has no
 * GPU, so a frame-time threshold would be a test of SwiftShader rather than of the game, and a
 * number tuned to pass on a software rasteriser is a number that cannot tell anyone when the real
 * thing gets slower. What the spec *does* pin is that the window ran: a report exists, the sim
 * stepped inside it, and no error was caught while the horde was on the floor. A bench that
 * quietly measured an empty arena would be the useless kind of green, so the rig says so in its
 * own `warnings` (see `src/game/bench.ts`) and the lines below print them rather than swallowing
 * them — the two peak-load checks at the end of each test are what keep that honest: a window that
 * recorded no bodies and no particles on the floor fails here rather than printing a pretty number.
 *
 * Both documented doors are exercised, because they are different shapes of the same feature: the
 * URL (`?bench=1000`, the one a person types, which replaces the run) and `__forgeDebug.bench(n,
 * {seconds, chapter})` armed against a run already in progress, which is the shape a later
 * scenario would take.
 */

/**
 * The two shapes the page hands back, taken from where they are written rather than restated here.
 *
 * A mirrored copy of `BenchResult` would let this spec read `undefined` where it means to read a
 * number — the report's fields changed shape while this file was being written, which is exactly
 * how that mistake usually gets made — and the state hook has a real exported type for the same
 * reason. `import type` only, so nothing from `src` is loaded into the Node side of the test.
 */
type AnyWindow = {
  __forgeState?: () => ForgeState;
  __forgeDebug?: App['debug'];
  __benchResults?: BenchResult | null;
};

function readState(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as AnyWindow;
    return win.__forgeState ? win.__forgeState() : undefined;
  });
}

/** The window's report, or null while it is still running (and null on a page that never armed one). */
function readReport(page: Page): Promise<BenchResult | null> {
  return page.evaluate(() => (window as unknown as AnyWindow).__benchResults ?? null);
}

/**
 * Wait the window out.
 *
 * A wait on a condition rather than a sleep: the report appears the frame the window is spent, and
 * how long that takes depends entirely on how fast this box draws. Fifty seconds of a software
 * rasteriser at a thousand bodies is the pessimistic case and is still allowed to finish.
 */
async function waitForBench(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(
    () => ((window as unknown as AnyWindow).__benchResults ?? null) !== null,
    undefined,
    { timeout },
  );
}

/**
 * Write the run out, and say it.
 *
 * `test-results/` is the gitignored place Playwright puts run artefacts, so the JSON lands there
 * rather than in the repo root: the file is a measurement of one run of one machine, not a source
 * file. It is written *before* the assertions, so a failing run still leaves the numbers behind —
 * the report exists to be read exactly when something looks wrong.
 */
function writeReport(testInfo: TestInfo, name: string, payload: unknown): string {
  const dir = testInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

/** One human-readable block, for whoever runs this by hand and reads the terminal. */
function summarize(url: string, r: BenchResult): string {
  const held =
    `${r.load.enemies.mean}/${r.target.enemies} bodies · ${r.load.shots.mean}/${r.target.shots} rounds · ` +
    `${r.load.particles.mean}/${r.target.particles} particles`;
  return (
    `${url} — ${r.backend}, ${r.frames} frames, ${r.ticks} ticks, ${r.fps} fps\n` +
    `  frame ms: median ${r.frameMs.median}, p95 ${r.frameMs.p95}, max ${r.frameMs.max}; ` +
    `code inside them: median ${r.workMs.median}, max ${r.workMs.max} ` +
    `(budget ${r.budgetMs}, ${r.workOverBudget} over)\n` +
    `  held on the floor: ${held}\n` +
    (r.warnings.length > 0 ? `  ${r.warnings.join('\n  ')}\n` : '  no warnings\n')
  );
}

/** The shared tail of both passes: read the report, keep the artefact, then judge it. */
async function collect(page: Page, testInfo: TestInfo, name: string): Promise<BenchResult> {
  const url = new URL(page.url());
  const where = `${url.pathname}${url.search}`;
  const report = await readReport(page);
  if (report !== null) {
    const file = writeReport(testInfo, name, { generated: new Date().toISOString(), url: where, ...report });
    console.log(`\n${summarize(where, report)}  wrote ${file}`);
  }
  const state = await readState(page);
  return expectReport(report, state);
}

/**
 * What a bench window owes the reader, and nothing about how fast it was.
 *
 * `frames > 0` and `ticks > 0` together are the load claim: a window that recorded frames while the
 * sim stepped is a window that played. Anything stricter (a frame-time ceiling, or a share of the
 * target load that has to survive to the end of the window) would be a SwiftShader number, and a
 * test of the software rasteriser is not a test of the game.
 */
function expectReport(report: BenchResult | null, state: Awaited<ReturnType<typeof readState>>) {
  expect(report, 'the bench window should end with a report on window.__benchResults').not.toBeNull();
  const r = report as BenchResult;
  expect(r.frames, 'a window that measured no frames measured nothing').toBeGreaterThan(0);
  expect(r.ticks, 'the sim should have stepped while the window ran').toBeGreaterThan(0);
  expect(state?.mode, 'a bench page reports its mode as bench').toBe('bench');
  expect(state?.errors ?? -1, 'the horde should not throw').toBe(0);
  return r;
}

test('bench mode: ?bench=1000 runs the headline load and reports frame times', async ({ page }, testInfo) => {
  // Five seconds of measured window plus a second of warm-up, rather than the twenty the URL
  // defaults to: five is long enough to see a draw path that is 3x off the headless number, which
  // is the whole job here, and it keeps the software pass inside the per-test timeout.
  await page.goto('/?bench=1000&seconds=5');
  await page.waitForFunction(() => {
    const win = window as unknown as AnyWindow;
    return typeof win.__forgeState === 'function' && win.__forgeDebug !== undefined;
  });

  await waitForBench(page, 50_000);
  const r = await collect(page, testInfo, 'bench-results.json');

  // The load the window claims to have held, reported above and checked only that it was there at
  // all. Under SwiftShader one frame can cost more than five of the sim's 1/60 s slices, and the
  // rig tops the floor up once per *frame*, so a slow box is expected to run below the target —
  // which is what the warning is for. On a real GPU the same window holds it, and the two cases are
  // told apart by the report rather than by a threshold in here.
  expect(r.load.enemies.peak, 'bodies should be on the floor while the window runs').toBeGreaterThan(0);
  expect(r.load.particles.peak, 'the particle field should be filled').toBeGreaterThan(0);
});

test('bench mode: __forgeDebug.bench arms a window against a run in progress', async ({ page }, testInfo) => {
  await page.goto('/?seed=1');
  await page.waitForFunction(() => {
    const win = window as unknown as AnyWindow;
    return typeof win.__forgeState === 'function' && win.__forgeDebug !== undefined;
  });
  await page.waitForFunction(() => (window as unknown as AnyWindow).__forgeState?.().scene === 'menu');

  // Leave the title screen first: what this pass is about is arming a window against a run that is
  // already going, which is the shape a scenario written later would take.
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as unknown as AnyWindow).__forgeState?.().scene === 'playing');

  // The three options the debug hook documents, all of them reaching the rig: the horde size, the
  // window and the floor. `chapter` is 0-based on the way in and 1-based in the report, the same
  // way a chapter is named everywhere else.
  const seeded = await page.evaluate(() => {
    const win = window as unknown as AnyWindow;
    return win.__forgeDebug?.bench(300, { seconds: 3, chapter: 4 }) ?? -1;
  });
  expect(seeded, 'arming a window should put the horde on the floor before its first frame').toBeGreaterThanOrEqual(
    300,
  );

  const during = await readState(page);
  expect(during?.mode, 'the page is benching, not playing').toBe('bench');

  await waitForBench(page, 50_000);
  const r = await collect(page, testInfo, 'bench-results-debug.json');
  expect(r.target.enemies, 'the window should measure the horde size it was given').toBe(300);
  expect(r.chapter, 'the chapter option should pick the floor the window ran on').toBe(5);
});
