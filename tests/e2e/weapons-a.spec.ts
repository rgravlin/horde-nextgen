import { test, expect, type Page } from '@playwright/test';

/**
 * The new fire kinds where only a browser can check them: in the real loop, with the
 * renderer's pointer-to-ground aim and the trigger coming from a real button.
 *
 * `tests/unit/weapons-a.test.ts` pins the geometry (eight pellets, five bodies on a
 * ray, the 300° notch, the 3 m burst) by driving `step()` directly. That proves the
 * maths; it cannot prove that a weapon granted through `__forgeDebug.giveWeapon`
 * reaches the trigger at all. This file does, and it is the only place that check can
 * live: `forge-scenarios.json` has no step that evaluates JavaScript (its vocabulary
 * is click/fill/press/wait/hold/mouse/shot/state) and no key grants a weapon, so the
 * shotgun scenario cannot be written there.
 *
 * Every wait is on a condition and takes its level-up cards on the way (see
 * `playUntil`), because a level-up freezes the sim and a wait that ignored that would
 * time out on a game waiting for a pick rather than on one that stopped working.
 */

type WeaponState = { id: string; family: string; ammo: number; heat: number; reloading: boolean };

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

/**
 * Play until `want` holds, spending a level-up card when one appears.
 *
 * Returns as soon as the condition is true, so a fast weapon finishes the test early,
 * and gives up the moment the run stops (the player is dead) so a death is reported as
 * a failure instead of burning the whole budget.
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
 * Start a run on `path`, put `id` in the firing hand and ring it with `n` bodies.
 *
 * The grant and the crowd go in one evaluate so the first shot is fired at targets
 * rather than at an empty arena, which is what makes "kills rose" mean something.
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

test('shotgun: granted to the firing hand, it clears the crowd it is pointed at', async ({ page }) => {
  const before = await armedRun(page, '/?seed=11', 'shotgun', 20);

  expect(before.activeWeapon, 'a granted weapon goes into the hand that fires').toBe('shotgun');
  expect(before.enemies.count, 'the ring of targets should exist to shoot at').toBeGreaterThan(0);

  // A shell is one magazine entry and eight pellets, so the magazine dropping below a
  // full six (or going into its reload) is the visible half of "eight pellets were
  // really created"; the count itself is pinned in the unit test.
  const drained = await playUntil(
    page,
    (s) => s.weapons.some((w) => w.id === 'shotgun' && (w.ammo < 6 || w.reloading)),
    15_000,
  );
  expect(drained, 'the shotgun should be spending shells').toBe(true);

  // Four kills is the shotgun's signature: one shell is eight pellets, so a weapon
  // that works takes a chunk out of the ring rather than picking bodies off one by one.
  const cleared = await playUntil(page, (s) => s.kills >= before.kills + 4, 30_000);
  expect(cleared, `kills should rise from ${before.kills} to 4+ with the shotgun in hand`).toBe(true);

  const end = await readState(page);
  expect(end?.errors, 'the run should stay error-free').toBe(0);
});

test('hitscan and arc: a ray and a lobbed shell both reach a crowd in the live loop', async ({ page }) => {
  // Nothing here is a projectile: a ray is resolved the tick it is fired and a shell
  // only detonates, so a kill is the proof each delivery path ran end to end.
  const ray = await armedRun(page, '/?seed=12', 'sniper', 12);
  expect(ray.activeWeapon, 'the sniper should be the active hand').toBe('sniper');
  const rayHits = await playUntil(page, (s) => s.kills >= ray.kills + 3, 30_000);
  expect(rayHits, 'the sniper should be killing at range').toBe(true);

  // Second grant, both hands now full: it has to replace the hand in play, or the run
  // would keep firing the sniper and prove nothing about the shell. A fresh ring goes
  // in with it, so the burst has a crowd to land in rather than whatever is left.
  await page.evaluate(() => {
    const win = window as unknown as AnyWindow;
    const ok = win.__forgeDebug?.giveWeapon('catapult') ?? false;
    if (!ok) throw new Error('giveWeapon("catapult") reported no such weapon');
    win.__forgeDebug?.spawn(0, 14);
  });
  const armed = await readState(page);
  expect(armed?.activeWeapon, 'the second grant should replace the active hand').toBe('catapult');

  const burst = await playUntil(page, (s) => s.kills >= armed!.kills + 3, 25_000);
  expect(burst, 'the shell should be clearing bodies where it lands').toBe(true);

  const end = await readState(page);
  expect(end?.errors, 'the run should stay error-free').toBe(0);
});
