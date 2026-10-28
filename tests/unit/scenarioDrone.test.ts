/**
 * The contract the ward drone's scenario keeps: the file the runner reads, and the route it scripts.
 *
 * `forge-scenarios.json` is the only check in the repo played by something outside the repository.
 * forge's runner (`/opt/forge-app/app.py`) drives a real page with its own step language and its
 * own comparison parser, and neither `npm test` nor `npm run test:e2e` ever opens that file, so
 * the sixth entry has two ways to be wrong that nothing else can see:
 *
 * - **malformed**, which the runner reports as a finding against the whole file: it wants one key
 *   per step, taken from its own `STEPS` tuple, and a `state` value that reads as a comparison.
 *   A step with two keys is not skipped, it is a finding, and the file's other five scenarios
 *   lose their screens with it.
 * - **unwinnable**, which it reports as a failing step. The drone is earned by walking to a crate,
 *   and a route tuned to one machine's clock is a coin flip on another's.
 *
 * So the checks below read the file rather than a recording of it, and play its keyboard in the
 * sim. That is the same fixed-step clock the page runs on (`step` is what the page calls once per
 * 1/60 s), which is what makes a rate sweep here mean something there: this box ran the whole
 * route at 0.85x to 1.0x of real time, and 0.57x while the shaders compiled, so the sweep below
 * runs 45 per cent slower than the slowest page measured and 25 per cent faster than the fastest.
 * Two things the harness does *not* copy, both said again where they matter: it never opens a
 * canvas, and it runs its clock straight through the card offers a page sits frozen on.
 *
 * Why the walk is a staircase rather than two long legs is the other half of the file, and it is
 * the part a rate sweep has to hold. At `TUNE.moveSpeed` of 6 m/s an L-shaped walk — east along
 * the bay, then south — needs the east leg and the south leg to land within about nine per cent of
 * the crate's 14:10 ratio, and travel time alone swings by more than that between the two runs
 * above. Alternating east and south at that ratio holds the bearing whatever the clock does, and
 * it *crosses* the crate rather than arriving at it, so the pickup does not depend on a distance
 * either. What is under test is therefore not a lucky recording: it is a shape that survives.
 *
 * Plain Node throughout, like the drone's other tests: the crate, the walk and the companion's
 * volleys are sim facts, and the picture half is read from a real rig mounted on a real run the
 * way `droneState.test.ts` reads it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Scene } from 'three/webgpu';

import { levelAt } from '../../src/content/levels';
import { powerupIndex } from '../../src/content/powerups';
import { buildBinds, moveVectorOf, pickSlotOf } from '../../src/input/bindings';
import { buildState, type StateHost } from '../../src/game/appState';
import { defaultSettings } from '../../src/game/persistence';
import { createDroneRig } from '../../src/render/droneRig';
import { profileFor } from '../../src/render/quality';
import type { View } from '../../src/render/renderer';
import { droneSnapshot } from '../../src/render/viewSnapshot';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { startChapter } from '../../src/sim/systems/levels';
import { Ev, createWorld, eventAt, release, type World } from '../../src/sim/world';

/** One step of the file: exactly one key, whose name is the kind. */
type Step = Record<string, unknown>;

interface Scenario {
  name: string;
  path: string;
  steps: Step[];
}

/** The step kinds `SHOTS_JS` knows, from the runner rather than invented here. */
const STEPS = ['click', 'fill', 'press', 'wait', 'hold', 'mouse', 'shot', 'state'];

/** How a `state` value has to read for the runner to parse it at all. */
const COMPARE = /^(==|!=|<=|>=|<|>)\s*(.*)$/;

/** Real-time multiples the sweep plays at; the page measured 0.57x to 1.0x on this box. */
const RATES = [0.55, 0.75, 1.0, 1.25];

const DT = 1 / 60;

/** The card the bay's crate holds, and the bind table the page's sampler would read. */
const DRONE = powerupIndex('drone');
const binds = buildBinds();

function scenarios(): Scenario[] {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL('../../forge-scenarios.json', import.meta.url)), 'utf8'),
  ) as Scenario[];
}

/** The entry under test, and everything that was already in the file. */
const file = scenarios();
const drone = file.find((s) => s.name === 'ward drone');

/**
 * One step of the file, played against the sim.
 *
 * `wait` and `hold` are turned into ticks by multiplying their milliseconds by `rate`, because a
 * page takes its simulation steps from wall time: `hold: ['KeyD', 200]` at rate 0.55 is the same
 * key held down on a machine getting half the frames. A held key is resolved through the real bind
 * table, so a key the game stops binding drives nothing rather than driving something else.
 *
 * `mouse` carries no intent — it is where the cursor sits, and the companion does not aim through
 * it — so it is skipped rather than guessed at. A card press is one tick of `frame.pick`, which is
 * how a page unwedges a run from a card offer; `picks: false` leaves the offers standing, which is
 * how the control keeps its run free of *any* companion and not merely of the crate's one.
 *
 * Rounds are counted from the file's second `state` step to the end, the crowd phase its last two
 * steps assert on, and only from a gun on the player's side that began more than a metre off them.
 * That is the measurement `droneChest.test.ts` makes and it needs the same two exclusions to mean
 * a companion: a round from either hand begins at exactly `TUNE.playerRadius + TUNE.shotStart`,
 * 0.6 m, and an enemy bolt arrives with `a` of -1, while the companion looses from his orbit point
 * 1.35 m out. The metre between those is empty of everything, which is what lets one count tell a
 * drone from a pistol. `handRounds` counts the other side so a control's zero can be checked for
 * being a measurement rather than a blindfold.
 *
 * HP is refilled every tick, the concession `playChapter` and `drone.test.ts` both make: a route
 * shot dead on the way reports the fight rather than the route.
 */
function play(w: World, steps: Step[], rate: number, opts: { picks: boolean; strip: boolean }): {
  failed: string[];
  nearest: number;
  droneRounds: number;
  handRounds: number;
  crowd: number;
  /** Whether the run ends owning the card the crate carries. */
  ownsDrone: boolean;
} {
  const frame = createInputFrame();
  const view = picture();
  const crate = levelAt(0).supply;
  expect(crate, 'the bay declares a crate for the route to walk onto').toBeTruthy();
  const at = crate![0]!;
  const out = {
    failed: [] as string[],
    nearest: Infinity,
    droneRounds: 0,
    handRounds: 0,
    crowd: 0,
    ownsDrone: false,
  };
  let marks = 0;

  for (const st of steps) {
    const [kind, value] = Object.entries(st)[0]!;

    if (kind === 'state') {
      marks++;
      // Stand the picture, then read it: `drone.shown` and `drone.drawn.h` are reads of what was
      // drawn, so a check taken before the draw is a check on the frame before the check.
      view.draw(w, 1, DT, false);
      const shot = buildState(host(w, view));
      for (const [key, want] of Object.entries(value as Record<string, string>)) {
        const got = key
          .split('.')
          .reduce<unknown>(
            (node, part) =>
              node === null || node === undefined
                ? undefined
                : (node as Record<string, unknown>)[part],
            shot,
          );
        if (!holds(got, want)) out.failed.push(`${key} ${want} — read ${JSON.stringify(got)}`);
      }
      continue;
    }

    let ticks = 0;
    let mx = 0;
    let my = 0;
    let pick = 0;
    if (kind === 'wait') {
      ticks = Math.round(((value as number) / 1000 / DT) * rate);
    } else if (kind === 'hold') {
      const [code, ms] = value as unknown as [string, number];
      ticks = Math.round((ms / 1000 / DT) * rate);
      const vector = moveVectorOf(binds.actionOf(code));
      expect(vector, `${code} drives a bound move`).toBeTruthy();
      if (vector) {
        mx = vector[0];
        my = vector[1];
      }
    } else if (kind === 'press') {
      ticks = 1;
      pick = opts.picks ? pickSlotOf(binds.actionOf(value as string)) : 0;
    }

    for (let t = 0; t < ticks; t++) {
      resetFrame(frame);
      frame.moveX = mx;
      frame.moveY = my;
      if (pick > 0 && t === 0) frame.pick = pick;
      w.player.hp = 1_000_000;
      if (opts.strip) {
        // Not just the chapter's crate: a rolled pack pays whatever `payChest` draws, and the
        // control's claim is *no companion*, so nothing that could hand one out stays on the floor.
        for (let i = 0; i < w.chests.cap; i++) if (w.chests.alive[i] === 1) release(w.chests, i);
      }

      const near = Math.hypot(at.x - w.player.x, at.y - w.player.y);
      if (near < out.nearest) out.nearest = near;

      const before = w.events.written;
      step(w, frame);
      view.draw(w, 1, DT, false);

      if (marks >= 2) {
        for (let e = before; e < w.events.written; e++) {
          const i = eventAt(w, e);
          if (i < 0 || w.events.type[i] !== Ev.Shot || (w.events.a[i] as number) < 0) continue;
          const off = Math.hypot(
            (w.events.x[i] as number) - w.player.x,
            (w.events.y[i] as number) - w.player.y,
          );
          if ((w.events.b[i] as number) >= 0 && off > 1) out.droneRounds++;
          else if (off <= 1) out.handRounds++;
        }
      }
    }
  }

  out.ownsDrone = w.powerTiers[DRONE] > 0;
  out.crowd = w.enemies.count;
  return out;
}

/** The runner's comparison, in the runner's semantics: JS equality on the raw value. */
function holds(got: unknown, expr: string): boolean {
  const parts = COMPARE.exec(expr);
  if (parts === null) throw new Error(`"${expr}" is not a comparison the runner can read`);
  let rhs: unknown = parts[2];
  try {
    rhs = JSON.parse(parts[2]);
  } catch {
    // A bare word, which the runner compares as the string it is.
  }
  const a = got as Scalar;
  const b = rhs as Scalar;
  switch (parts[1]) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '>=':
      return (a as number) >= (b as number);
    case '<=':
      return (a as number) <= (b as number);
    case '<':
      return (a as number) < (b as number);
    default:
      return (a as number) > (b as number);
  }
}

type Scalar = number | string | boolean;

/** A host over a played run: no app and no backend, and a picture only where one is handed in. */
function host(w: World, view: View | null = null): StateHost {
  return {
    world: w,
    scene: 'playing',
    backend: 'none',
    mode: 'campaign',
    errors: 0,
    settings: defaultSettings(),
    bindings: binds,
    frameTimes: new Float32Array(30),
    view,
  };
}

/** A picture to ask, built the way `droneState.test.ts` builds its stand-in view. */
function picture(): View {
  const rig = createDroneRig(new Scene(), profileFor('high'));
  return {
    backend: 'none',
    quality: 'high',
    errors: 0,
    draw: (world, alpha) => rig.sync(world, alpha),
    aim: () => false,
    playerFace: (out) => {
      out.x = 1;
      out.y = 0;
      return out;
    },
    dronePoint: (out) => droneSnapshot(rig.group, out),
    resize: () => {},
  };
}

/** Chapter 1, played: the floor the scenario's page gets, with auto-fire on as it ships. */
function bay(seed: number): World {
  const w = createWorld(seed);
  startChapter(w, 0);
  w.autoFire = true;
  return w;
}

describe('the drone scenario, as a file', () => {
  it('joins the five that were there without disturbing them', () => {
    expect(file.map((s) => s.name)).toEqual([
      'slice',
      'hunting',
      'save',
      'arena',
      'facing',
      'ward drone',
    ]);

    // Names are slugged and duplicates dropped by the runner, so two entries that slug alike cost
    // a screen quietly rather than failing loudly.
    const slugs = file.map((s) => s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    expect(new Set(slugs).size, 'every scenario keeps its own name once slugged').toBe(
      slugs.length,
    );
    expect(drone, 'the drone route is in the file').toBeTruthy();
  });

  it('spends one key per step, and only keys the runner knows', () => {
    for (const sc of file) {
      for (const st of sc.steps) {
        const keys = Object.keys(st);
        expect(keys.length, `${sc.name}: ${JSON.stringify(st)} is one step`).toBe(1);
        expect(STEPS, `${sc.name}: ${keys[0]} is a step kind`).toContain(keys[0]!);
      }
    }
  });

  it('names keys the snapshot serves, and compares the way the runner parses', () => {
    const steps = drone!.steps.filter((st) => st.state !== undefined);
    expect(steps.length, 'the route checks the run three times').toBe(3);

    // Read against a live snapshot rather than a list written here, so renaming a key in
    // `buildState` fails this instead of turning the scenario into a comparison on `undefined` —
    // which is what a runner would report as a passing step that proved nothing.
    const shot = buildState(host(bay(5), picture()));
    for (const st of steps) {
      for (const [key, want] of Object.entries(st.state as Record<string, string>)) {
        expect(COMPARE.test(want), `${key} "${want}" is a comparison`).toBe(true);
        const got = key
          .split('.')
          .reduce<unknown>(
            (node, part) =>
              node === null || node === undefined
                ? undefined
                : (node as Record<string, unknown>)[part],
            shot,
          );
        expect(got, `${key} is in the snapshot`).not.toBeUndefined();
      }
    }
  });

  it('earns the drone by playing, which is the only reason the route exists', () => {
    const text = JSON.stringify(drone);
    expect(text, 'no debug door: AGENTS.md wants a scenario that plays there').not.toContain(
      '__forgeDebug',
    );
    expect(drone!.steps.some((s) => 'click' in s || 'fill' in s), 'and no DOM').toBe(false);
    expect(drone!.path, 'the seed picks which run, it does not teleport to a state').toBe(
      '/?seed=5',
    );
    expect(drone!.steps[0], 'it opens on a wait, so the page has time to boot').toEqual({
      wait: 5000,
    });
  });
});

describe('the drone scenario, played', () => {
  it('walks its route at every clock the harness has shown', () => {
    for (const rate of RATES) {
      const run = play(bay(5), drone!.steps, rate, { picks: true, strip: false });
      expect(run.failed.join('; '), `${rate}x: every check holds`).toBe('');
      expect(run.nearest, `${rate}x: the walk goes onto the crate`).toBeLessThan(1.2);
      expect(run.ownsDrone, `${rate}x: and the walk bought the card`).toBe(true);
    }

    // And the same keyboard on a floor with nothing to pick up never gets a companion, so the
    // route above is a route rather than a fixture. The controls' measurements are checked beside
    // it: the round filter still sees the player's own gun, so its zero is a reading and not a
    // blindfold.
    const control = play(bay(5), drone!.steps, 1, { picks: false, strip: true });
    expect(control.nearest, 'the control walks the same line, past a crate that is not there')
      .toBeLessThan(1.2);
    expect(control.failed, 'and the checks notice').not.toEqual([]);
    expect(control.failed.join('; '), 'the companion is what they miss').toContain('drone.shown');
    expect(control.droneRounds, 'nothing looses a round from outside the player metre').toBe(0);
    expect(control.ownsDrone, 'the control never owns the card').toBe(false);
    expect(control.handRounds, 'while the players own gun is firing in that window')
      .toBeGreaterThan(0);
  });

  it('ends over a crowd the companion shoots into', () => {
    const run = play(bay(5), drone!.steps, 1, { picks: true, strip: false });
    expect(run.droneRounds, 'a few seconds over a converging horde is dozens of rounds')
      .toBeGreaterThan(12);
    expect(run.crowd, 'and there are bodies left to shoot at on the last frame').toBeGreaterThan(0);
  });
});
