import { test, expect, type Page } from '@playwright/test';

/**
 * The alien hands and the two gauges, in the live loop.
 *
 * `tests/unit/weapons-b.test.ts` drives `step()` directly and owns the geometry: that a
 * bolt takes six bodies and no more, that a beam cuts four at once, that a singularity
 * drags before it pops, that a dry cell cannot buy a bolt. That proves the maths. This
 * file pins the two things a headless step cannot see:
 *
 * - **the paths run in a real frame.** The grant goes through `__forgeDebug.giveWeapon`
 * → `loadSlot`, the aim comes from the renderer's pointer-to-ground ray or from
 *   auto-fire, and the trigger comes from a live accumulator. A delivery path that only
 *   works when a test hand-builds the world has not been shown to work.
 * - **the gauges are live state.** Heat and charge live on the hand, are written by the
 *   firing pass and read back through `window.__forgeState()` once a frame, so the same
 *   numbers the HUD draws are what a scenario can assert on.
 *
 * Most of it reads a *trace* — the hand and the kill total sampled every ~50 ms — rather
 * than one snapshot, because a state that reports a total (`kills`) cannot report a hit
 * list. Two measurements come out of a trace: `killsDuringVents`, which says whether the
 * gauge actually held the trigger (a venting hand kills nobody, and the vent has to be a
 * gap of real length), and `biggestStep`, which says whether a hit reached several bodies
 * in one tick — the signature of a chain bolt or a pop, where single-target fire at these
 * rates peels them off one or two at a time. Both were calibrated by breaking the path
 * they watch: with the bolt capped at one body the biggest window took 1 kill and with
 * the orb's burst gone it took 0, against 4+ for both when the paths run.
 *
 * Every wait takes its level-up cards on the way, because a level-up freezes the sim and
 * a wait that ignored that would time out on a game waiting for a pick rather than on one
 * that stopped working.
 */

type WeaponState = {
  id: string;
  family: string;
  ammo: number;
  heat: number;
  energy: number;
  venting: boolean;
  reloading: boolean;
};

type State = {
  scene: string;
  kills: number;
  errors: number;
  activeWeapon: string;
  weapons: WeaponState[];
  enemies: { count: number };
  player: { alive: boolean; hp: number };
};

type AnyWindow = {
  __forgeState?: () => State;
  __forgeDebug?: {
    grantXp(n: number): void;
    giveWeapon(id: string): boolean;
    spawn(type: number, n: number): number;
  };
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

/** The hand holding `id`, or undefined if nothing does. */
function hand(state: State | undefined, id: string): WeaponState | undefined {
  return state?.weapons.find((w) => w.id === id);
}

/** That hand's charge, or -1 when nothing holds the weapon — so a missing hand reads
 *  as "never drained" instead of comparing against undefined. */
function charge(state: State | undefined, id: string): number {
  const w = hand(state, id);
  return w === undefined ? -1 : w.energy;
}

/**
 * Sample the live run every ~50 ms for at most `ms`, stopping early once `stop` holds.
 *
 * Snapshots taken during a level-up are not kept and do not end the trace: the sim is
 * frozen there, so they would repeat the last live reading, and the cards need a key
 * spent on them before the run moves again.
 */
async function watch(page: Page, ms: number, stop?: (s: State) => boolean): Promise<State[]> {
  const out: State[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await readState(page);
    if (s === undefined) break;
    if (s.scene === 'levelup') {
      await page.keyboard.press('Digit1');
      continue;
    }
    if (s.scene !== 'playing') break;
    out.push(s);
    if (stop !== undefined && stop(s)) break;
    await page.waitForTimeout(50);
  }
  return out;
}

/** The most kills any one ~50 ms window of the trace took. */
function biggestStep(trace: State[]): number {
  let worst = 0;
  for (let i = 1; i < trace.length; i++) {
    const step = trace[i].kills - trace[i - 1].kills;
    if (step > worst) worst = step;
  }
  return worst;
}

/**
 * Kills that landed while the barrel was venting, ignoring the first `grace` samples of
 * each vent.
 *
 * The grace is for rounds already in the air when the gauge maxed out: a plasma bolt
 * covers its whole 22 m in half a second, so the tail of the last legal volley still
 * lands inside the vent. Past that, a venting hand fires nothing, so a kill here means
 * the gauge was not actually holding the trigger.
 */
function killsDuringVents(trace: State[], id: string, grace: number): number {
  let bled = 0;
  let run = 0;
  for (let i = 1; i < trace.length; i++) {
    const venting = hand(trace[i], id)?.venting === true;
    run = venting ? run + 1 : 0;
    if (venting && run > grace) bled += Math.max(0, trace[i].kills - trace[i - 1].kills);
  }
  return bled;
}

/** Whether any sample of the trace caught the barrel venting at all. */
function sawVent(trace: State[], id: string): boolean {
  return trace.some((s) => hand(s, id)?.venting === true);
}

/**
 * Start a run on `path`, put `id` in the firing hand and ring it with `n` bodies.
 *
 * Grant and crowd go in one evaluate so the first trigger pull has something to fire at,
 * which is what makes "kills rose" mean something. The ring is 8-14 m out, inside the
 * reach of all four alien hands (22 m repeater, 16 m lance, 13 m orb, 9 m wand) and so
 * inside the auto-fire gate, which only wakes up for a body within the weapon's own
 * reach.
 */
async function armedRun(page: Page, path: string, id: string, n: number): Promise<State> {
  await page.goto(path);
  await waitForShell(page);
  await page.keyboard.press('Enter');
  await waitForScene(page, 'playing');
  await page.evaluate((opts: { weapon: string; bodies: number }) => {
    const win = window as unknown as AnyWindow;
    if (!(win.__forgeDebug?.giveWeapon(opts.weapon) ?? false)) {
      throw new Error(`giveWeapon("${opts.weapon}") reported no such weapon`);
    }
    win.__forgeDebug?.spawn(0, opts.bodies);
  }, { weapon: id, bodies: n });

  const s = await readState(page);
  expect(s, 'the run should be reporting state').toBeDefined();
  return s as State;
}

test('laser lance: the beam cuts, cooks itself into vent, and cools enough to cut again', async ({
  page,
}) => {
  const before = await armedRun(page, '/?seed=21', 'laserLance', 24);
  expect(before.activeWeapon, 'the lance should be the hand in play').toBe('laserLance');
  expect(before.enemies.count, 'the ring of targets should exist to shoot at').toBeGreaterThan(0);

  // Until the gauge maxes out. Four seconds of beam is what cooks it, and the wait ends
  // at the vent rather than at the deadline, so a gauge that never filled fails the test
  // instead of timing out into a maybe.
  const hot = await watch(page, 12_000, (s) => hand(s, 'laserLance')?.venting === true);
  expect(sawVent(hot, 'laserLance'), 'four seconds of beam should cook the lance').toBe(true);

  // Through the dead air, to the tick the hand is cold enough to cut again. The vent
  // measured 27 samples of 50 ms here, and a gauge that merely trickled heat — or a
  // `venting` flag nobody obeys — gives either no gap or a gap of one or two samples.
  const gap = await watch(page, 8_000, (s) => hand(s, 'laserLance')?.venting === false);
  const lastGap = gap[gap.length - 1];
  expect(gap.length, 'the vent should be a gap of real length, not a flicker').toBeGreaterThan(15);

  // And the gap is dead air, not a weaker beam. A beam is instantaneous, so anything
  // killed half a second into a vent was killed by a gun that should have been cold.
  expect(killsDuringVents(gap, 'laserLance', 10), 'a venting barrel kills nobody').toBe(0);

  // The hand has to come back on its own and go back to work, with heat still above
  // zero: it recovers at the def's `recover` mark, not when it goes stone cold, which is
  // the only reason both thresholds are in content.
  expect(lastGap, 'the run should outlive the vent').toBeDefined();
  const woke = await watch(page, 12_000, (s) => s.kills >= (lastGap as State).kills + 4);
  expect(
    woke[woke.length - 1]?.kills ?? -1,
    `the beam should cut again once the barrel is cold (it stopped at ${(lastGap as State).kills})`,
  ).toBeGreaterThanOrEqual((lastGap as State).kills + 4);

  const after = await readState(page);
  expect(after?.errors, 'the run should stay error-free').toBe(0);
});

test('plasma repeater: a heat gauge instead of a magazine, and it never reloads', async ({
  page,
}) => {
  const before = await armedRun(page, '/?seed=22', 'plasmaRepeater', 20);
  expect(before.activeWeapon, 'the repeater should be the hand in play').toBe('plasmaRepeater');

  // Eleven bolts a second for four and a half seconds, then the barrel vents.
  const hot = await watch(page, 12_000, (s) => hand(s, 'plasmaRepeater')?.venting === true);
  expect(sawVent(hot, 'plasmaRepeater'), 'a held trigger should cook the repeater').toBe(true);

  // Through the vent, until the barrel is cold enough to fire again — and here the
  // kill trace settles the question the repeater cannot answer the way the lance does.
  // A bolt is airborne for up to half a second, so kills keep landing for a dozen
  // samples after the gauge maxes out; past that they have to stop, and they do.
  const gap = await watch(page, 8_000, (s) => hand(s, 'plasmaRepeater')?.venting === false);
  const lastGap = gap[gap.length - 1];
  expect(gap.length, 'the vent should be a gap of real length, not a flicker').toBeGreaterThan(15);
  expect(killsDuringVents(gap, 'plasmaRepeater', 12), 'a venting barrel kills nobody').toBe(0);

  // Then it comes back on its own: a gauge that only ever went up — or whose vent
  // nobody obeyed — would either strand the run holding a dead weapon or keep firing
  // through the gap.
  expect(lastGap, 'the run should outlive the vent').toBeDefined();
  const woke = await watch(page, 12_000, (s) => s.kills >= (lastGap as State).kills + 4);
  expect(
    woke[woke.length - 1]?.kills ?? -1,
    `the repeater should fire again once the barrel is cold (it stopped at ${(lastGap as State).kills})`,
  ).toBeGreaterThanOrEqual((lastGap as State).kills + 4);

  const end = await readState(page);
  const gun = hand(end, 'plasmaRepeater') as WeaponState;
  // The gauge is the whole constraint, so a magazine showing up alongside it would mean
  // the weapon now pays twice for one bolt.
  expect(gun.ammo, 'no magazine').toBe(0);
  expect(gun.reloading, 'and nothing to reload').toBe(false);
  expect(end?.errors, 'the run should stay error-free').toBe(0);
});

test('chain lightning wand: one bolt walks through the ring and pays charge for it', async ({
  page,
}) => {
  const before = await armedRun(page, '/?seed=23', 'chainLightningWand', 24);
  expect(before.activeWeapon, 'the wand should be the hand in play').toBe('chainLightningWand');

  const trace = await watch(page, 10_000, (s) => charge(s, 'chainLightningWand') < 40);
  const last = trace[trace.length - 1] as State;
  expect(
    last,
    'the run should still be going at the end of the trace',
  ).toBeDefined();
  expect(charge(last, 'chainLightningWand'), 'the cell should be down past two bolts').toBeLessThan(
    40,
  );

  // The wand's signature, and the reason the trace exists: a bolt that jumps takes
  // several bodies in the tick it fires, where a bolt that stops at the first body peels
  // them off one at a time. At 2.4 bolts a second a single 50 ms window holds a quarter
  // of a bolt, so four kills in one window is a walk, not a run of singles.
  const step = biggestStep(trace);
  expect(step, `biggest kill count any one window took (want 4+ = one bolt)`).toBeGreaterThanOrEqual(
    4,
  );

  // And the cell is not just spent, it refills: 22 units a second against a bolt costing
  // 25 means the last second of every cycle the wand is dry, so kills that keep climbing
  // over the next window are bolts bought out of a recovered cell.
  const killsAtDrain = last.kills;
  const refill = await watch(page, 12_000, (s) => s.kills >= killsAtDrain + 8);
  const after = refill[refill.length - 1] as State | undefined;
  expect(after, `kills should rise from ${killsAtDrain} as the cell recovers`).toBeDefined();
  expect(
    (after as State).kills,
    'a dry cell should buy more bolts, not stay dry',
  ).toBeGreaterThanOrEqual(killsAtDrain + 8);

  const end = await readState(page);
  expect(end?.errors, 'the run should stay error-free').toBe(0);
});

test('singularity gun: it gathers the ring it is pointed at and pops it', async ({ page }) => {
  const before = await armedRun(page, '/?seed=24', 'singularityGun', 20);
  expect(before.activeWeapon, 'the singularity gun should be the hand in play').toBe(
    'singularityGun',
  );

  // An orb carries no hit budget while it flies — it resolves once, at the end of its
  // drift, inside a 3.2 m circle — so a working one clears a pocket of the ring in one
  // tick. The gather is the unit test's measurement; this is the burst, and it is
  // unambiguous at 0.9 orbs a second: no single 50 ms window holds two orbs, so a kill
  // step of four can only be one orb going off.
  const trace = await watch(page, 12_000);
  const step = biggestStep(trace);
  expect(step, `biggest kill count any one window took (want 4+ = one pop)`).toBeGreaterThanOrEqual(
    4,
  );

  const last = trace[trace.length - 1] as State;
  expect(charge(last, 'singularityGun'), 'and the orbs cost charge').toBeLessThan(100);

  const end = await readState(page);
  expect(end?.errors, 'the run should stay error-free').toBe(0);
});
