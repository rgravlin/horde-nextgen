/**
 * The bench rig: what `?bench=1000` runs, and what `__forgeDebug.bench(n, {seconds})` starts.
 *
 * The headless gate (`tools/bench.ts`) times one tick of the simulation with no renderer. This is
 * the other half of the same question: what a whole browser frame costs with the headline load on
 * the floor — the half that includes the draw, which is where a 1,000-body horde can go wrong in
 * ways a headless run cannot see (an instance buffer uploaded per entity, a particle field copied
 * twice, a light rebuilt every frame).
 *
 * Two rules make the numbers worth reading, and both come from the headless bench:
 *
 * - **The load is held, not spawned once.** A window that lets the arena empty measures the
 *   drain. Every play frame tops the bodies, the rounds, the shards and the particle field back to
 *   the target, so the frame at second 19 is paid for by the same load as the frame at second 1. It
 *   is topped up rather than rebuilt, which is what keeps it a *fight* — the crowd chases, the guns
 *   clear lanes, the splitters split — at a pinned load rather than a frozen diorama.
 * - **The window is real time, and its first second is thrown away.** Shaders compile and the
 *   first frame of a floor pays for the whole layout. Warm-up is discarded, so a slow machine
 *   reports a slow machine rather than a shader compile.
 *
 * Every frame is timed twice, from a clock handed in rather than from the timestamps the frame loop
 * is handed, and the two answers mean different things:
 *
 * - **work** is the span between two reads inside the frame — after its ticks and after its draw.
 *   That is the number this file owns, and the only one that can call a frame over budget: a
 *   frame-to-frame gap cannot, because a healthy game idles at 16.7 ms between frames and would read
 *   as over budget every time.
 * - **period** is the end-to-end cost of the frame, this frame's end minus the last one's. Real
 *   fps comes from it, because fps is a claim about wall time and not about work.
 *
 * Reporting only the first would have hidden the thing worth knowing on the machine this was
 * written on: a thousand bodies cost 6 ms of JS inside a 230 ms frame, and a report that printed
 * "15 fps, 9 of 26 frames over budget" for that is a report that points at the wrong file. The
 * second number is what says the time went to the GPU or to how the browser paces rAF, and that the
 * draw path is not where to look. Both come from the same injected clock, which is also why the
 * clock is a port: a unit test hands over a counter and gets exact numbers.
 *
 * The player is held alive on purpose: the step stops early once a run is over, so a bench whose
 * player dies spends the rest of its window measuring a summary screen. Nothing here is a game
 * rule — the same argument `fx.ts` makes about particles, and the reason the load it fills is the
 * presentation half of the World that no rule reads.
 *
 * The figures are reported, not gated (TECH.md "Bench mode"): this box has no GPU, and a gate on a
 * software rasteriser would only ever be a test of SwiftShader. What the report does owe the reader
 * is a warning when the frame budget is blown, one when the frames are slow for a reason outside
 * the JS, and one when the load it thought it was measuring was not on the floor.
 */

import { ENEMIES } from '../content/enemies';
import { WEAPONS } from '../content/weapons';
import type { InputFrame } from '../sim/input';
import { alloc, type World } from '../sim/world';
import { spawnEnemy } from '../sim/systems/enemies';
import { choosePick } from '../sim/systems/pickups';

/**
 * The busiest moment, from TECH.md's performance target and the headless gate.
 *
 * One copy of these numbers, read by `tools/bench.ts` and by the browser rig, because the two
 * benches only mean something side by side: the headless number is what a tick of the rules costs,
 * the browser number is what a frame of the game costs, and the gap between them is a draw-path
 * question. Written twice they drift, and the comparison goes with them.
 */
export const BENCH_TARGET = {
  enemies: 1000,
  shots: 1500,
  shards: 600,
  particles: 8000,
} as const;

/**
 * Below this many frames per second a window is not holding 60 Hz on any reading.
 *
 * Half the target rather than the target: `requestAnimationFrame` paces itself to whatever the
 * display and the compositor can do, so a healthy page will happily report 55 fps and be fine. The
 * number exists to catch the case where a whole window runs at a third of the target and nothing
 * else in the report would say so.
 */
const SLOW_FPS = 30;

/**
 * Which weapons have a flight to hold.
 *
 * A round with `speed` 0 resolves inside the tick it is loosed (hitscan, beam, chain), so there is
 * no round in the air to count and giving it a velocity would invent a flight that weapon does not
 * have. Both benches draw their projectile load from this list, so "1,500 rounds" means 1,500
 * rounds that fly rather than 1,500 pool slots, a third of which hold nothing.
 */
export const FLYING_WEAPONS: readonly number[] = (() => {
  const flying: number[] = [];
  for (let i = 0; i < WEAPONS.length; i++) if (WEAPONS[i].speed > 0) flying.push(i);
  return flying;
})();

/**
 * Deterministic scatter from two integers, good enough to break a ring up.
 *
 * Not `world.rng`: the load has to be the same shape every run, or the two halves of a
 * before/after comparison are two different fights, and a rig that drew from the stream would
 * shift every weapon and wave draw that came after it. `fx.ts` makes the same argument about the
 * same problem.
 */
export function scatter(i: number, salt: number): number {
  let h = (i * 2654435761 + salt * 40503) | 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** What one bench window measured. Plain JSON: it goes to `window.__benchResults` and to a file. */
export interface BenchResult {
  kind: 'bench';
  /** Which backend drew the window, so a WebGPU and a WebGL2 run are two data points. */
  backend: string;
  /** 1-based, because every other place a chapter is named is 1-based. */
  chapter: number;
  /** Seconds of measured window, excluding the warm-up. */
  seconds: number;
  warmupSeconds: number;
  /** Frames inside the measured window. */
  frames: number;
  /** Sim ticks run inside it, which is how a machine that cannot keep up shows up. */
  ticks: number;
  /**
   * Real frames per second over the sampled span: `frames` over `measuredMs`.
   *
   * Derived from the same two numbers it is a claim about, so a reader can check it. It is not
   * `1000 / median`, and on a run with a fat tail those two come out a long way apart — which is
   * how this file's first version came to print "9 fps" for a window that ran at 4.
   */
  fps: number;
  /** Wall milliseconds from the window's first frame to its last, and how much of that the
   * samples cover. A gap between the two means frames the rig did not time, which is a bug in the
   * rig rather than a fact about the machine, so it has to be visible rather than averaged away. */
  elapsedMs: number;
  measuredMs: number;
  /** End-to-end frame period. This is what a "60 fps" claim is a claim about. */
  frameMs: TimeStats;
  /**
   * The share of that the page's own code accounts for, measured between two reads of the clock
   * inside one frame. A frame can miss 60 fps with this well inside budget, and the difference
   * between the two numbers says where the rest went — which is the first thing a person profiling
   * a slow run needs, and the reason both are reported rather than the faster-looking one alone.
   */
  workMs: TimeStats;
  /** The frame time a 60 Hz target allows. */
  budgetMs: number;
  /** Frames whose *work* went over it: the ones this code owns. */
  workOverBudget: number;
  /** What was asked for, so a window that could not hold it reads as a miss rather than a win. */
  target: { enemies: number; shots: number; particles: number };
  load: {
    enemies: { target: number; mean: number; min: number; peak: number };
    shots: { target: number; mean: number; min: number; peak: number };
    particles: { target: number; mean: number; min: number; peak: number };
    lights: { peak: number };
  };
  /** Cards the rig took on the player's behalf, so the window never stopped for one. */
  levelUps: number;
  warnings: string[];
}

export interface BenchOptions {
  /** Seconds of measured window after the warm-up. */
  seconds?: number;
  /** Seconds of held load discarded first. */
  warmup?: number;
  enemies?: number;
  shots?: number;
  shards?: number;
  particles?: number;
  /** Frame work time above which a frame counts as over budget. */
  budgetMs?: number;
  /** 0-based chapter index whose floor is under the window. */
  chapter?: number;
  backend?: string;
  /** Millisecond clock. Handed in so a headless run can drive a window with a counter. */
  now?: () => number;
}

/** The live rig, as the shell and `main.ts` see it. */
export interface BenchRig {
  readonly options: Required<BenchOptions>;
  /** True from arming until the window is spent. */
  readonly running: boolean;
  readonly done: boolean;
  /** Null until the window is spent, then the report. */
  readonly result: BenchResult | null;
  /**
   * Pin the load and the trigger at the top of a play frame, and mark the clock.
   *
   * Called before the frame's ticks run, so every tick in the frame is fought against the load
   * rather than against whatever is left of it.
   */
  hold(w: World, input: InputFrame): void;
  /**
   * Take a level-up card the window would otherwise stop for.
   *
   * Called after the frame's ticks and before the scene is decided: an offer freezes the sim until
   * somebody reads it, and nobody reads during a bench, so the window would spend the rest of its
   * seconds timing a menu. The first card goes through the sim's own door and is counted, rather
   * than the level being pretend away.
   */
  resolve(w: World): void;
  /** Book this frame: its work time, its load, and whether the window is spent. */
  frame(w: World, steps: number): void;
}

/** One tracked load: what it aimed at and what it actually measured. */
interface Tracker {
  target: number;
  sum: number;
  n: number;
  min: number;
  peak: number;
}

function tracker(target: number): Tracker {
  return { target, sum: 0, n: 0, min: Number.POSITIVE_INFINITY, peak: 0 };
}

function track(t: Tracker, value: number): void {
  t.sum += value;
  t.n++;
  if (value < t.min) t.min = value;
  if (value > t.peak) t.peak = value;
}

function readTracker(t: Tracker): { target: number; mean: number; min: number; peak: number } {
  return {
    target: t.target,
    mean: t.n > 0 ? Math.round((t.sum / t.n) * 10) / 10 : 0,
    min: Number.isFinite(t.min) ? t.min : 0,
    peak: t.peak,
  };
}

const ms = (v: number): number => Math.round(v * 1000) / 1000;

/** Median, 95th percentile, worst and mean of a millisecond series. */
type TimeStats = { median: number; p95: number; max: number; mean: number };

const noStats = (): TimeStats => ({ median: 0, p95: 0, max: 0, mean: 0 });

/** Median, 95th percentile, worst and mean of what was recorded, in milliseconds. */
function timeStats(times: Float32Array, n: number): TimeStats {
  const copy = Array.prototype.slice.call(times, 0, n) as number[];
  copy.sort((a, b) => a - b);
  const at = (q: number): number => copy[Math.min(copy.length - 1, Math.floor(q * copy.length))];
  let sum = 0;
  for (const t of copy) sum += t;
  return { median: ms(at(0.5)), p95: ms(at(0.95)), max: ms(copy[copy.length - 1]), mean: ms(sum / copy.length) };
}

function countOver(times: Float32Array, n: number, budget: number): number {
  let over = 0;
  for (let i = 0; i < n; i++) if (times[i] > budget) over++;
  return over;
}

/** How much of a load has been eaten and needs replacing.
 *
 * A deficit rather than a rebuild: the fight is allowed to kill things, and the rig's job is only
 * that the *count* does not sag while the window is being timed.
 */
function deficit(target: number, live: number): number {
  return target > live ? target - live : 0;
}

function holdBodies(w: World, target: number): void {
  const need = deficit(target, w.enemies.count);
  if (need <= 0) return;
  const px = w.player.x;
  const py = w.player.y;
  const salt = w.tick;
  for (let i = 0; i < need; i++) {
    // Cycling the roster keeps the mixed pack the chapters write rather than one archetype on its
    // own, and starting each frame one further along it keeps two runs of the same window from
    // being the same pack twice.
    const kind = (i + salt) % ENEMIES.length;
    const ring = 6 + scatter(i + salt, 1) * 14;
    const a = scatter(i + salt, 2) * Math.PI * 2;
    spawnEnemy(w, kind, px + Math.cos(a) * ring, py + Math.sin(a) * ring);
  }
}

function holdShots(w: World, target: number): void {
  const need = deficit(target, w.shots.count);
  if (need <= 0) return;
  const pool = w.shots;
  const px = w.player.x;
  const py = w.player.y;
  const salt = w.tick;
  for (let i = 0; i < need; i++) {
    const weapon = FLYING_WEAPONS[(i + salt) % FLYING_WEAPONS.length];
    const def = WEAPONS[weapon];
    const a = scatter(i + salt, 3) * Math.PI * 2;
    const ring = 1 + scatter(i + salt, 4) * 6;
    const slot = alloc(pool);
    if (slot < 0) return;
    pool.x[slot] = px + Math.cos(a) * ring;
    pool.y[slot] = py + Math.sin(a) * ring;
    pool.vx[slot] = Math.cos(a) * def.speed;
    pool.vy[slot] = Math.sin(a) * def.speed;
    pool.hp[slot] = def.dmg;
    pool.life[slot] = 1.2;
    pool.kind[slot] = weapon;
    pool.state[slot] = def.pierce + 1;
  }
}

function holdShards(w: World, target: number): void {
  const need = deficit(target, w.shards.count);
  if (need <= 0) return;
  const pool = w.shards;
  const px = w.player.x;
  const py = w.player.y;
  const salt = w.tick;
  for (let i = 0; i < need; i++) {
    const slot = alloc(pool);
    if (slot < 0) return;
    const a = scatter(i + salt, 5) * Math.PI * 2;
    const ring = scatter(i + salt, 6) * 12;
    pool.x[slot] = px + Math.cos(a) * ring;
    pool.y[slot] = py + Math.sin(a) * ring;
    pool.vx[slot] = (scatter(i + salt, 7) - 0.5) * 6;
    pool.vy[slot] = (scatter(i + salt, 8) - 0.5) * 6;
    pool.life[slot] = 12;
    pool.kind[slot] = (i + salt) % ENEMIES.length;
  }
}

/**
 * Fill the particle field back to `target`.
 *
 * Written into the field rather than through the event ring for the reason the headless bench
 * gives: the point is the cost of the field, and 8,000 sparks manufactured as events would first
 * have to squeeze through a ring that holds 1,024. It is also why writing World state from
 * outside `src/sim` is allowed here at all — `fx.ts` is presentation and no rule reads it, so the
 * load it carries is the half the draw path has to afford rather than a fight being rewritten.
 *
 * A dead slot is overwritten and a live one stepped over: the field is a ring, and the newest
 * spark is the one worth drawing.
 */
function holdFx(w: World, target: number): void {
  const fx = w.fx;
  let need = deficit(target, fx.count);
  if (need <= 0) return;
  const cap = fx.cap;
  const px = w.player.x;
  const py = w.player.y;
  const salt = w.tick;
  for (let guard = 0; guard < cap && need > 0; guard++) {
    const slot = fx.head;
    fx.head = (fx.head + 1) % cap;
    if (fx.life[slot] > 0) continue;
    const a = scatter(slot + salt, 9) * Math.PI * 2;
    const ring = scatter(slot + salt, 10) * 20;
    fx.x[slot] = px + Math.cos(a) * ring;
    fx.y[slot] = py + Math.sin(a) * ring;
    fx.z[slot] = 0.05 + scatter(slot + salt, 11) * 1.2;
    fx.vx[slot] = (scatter(slot + salt, 12) - 0.5) * 6;
    fx.vy[slot] = (scatter(slot + salt, 13) - 0.5) * 6;
    fx.vz[slot] = scatter(slot + salt, 14) * 3;
    const life = 0.6 + scatter(slot + salt, 15) * 0.9;
    fx.life[slot] = life;
    fx.span[slot] = life;
    fx.size[slot] = 0.08 + scatter(slot + salt, 16) * 0.3;
    fx.kind[slot] = (slot + salt) % 4;
    fx.count++;
    need--;
  }
}

/** Build one bench window. Nothing runs until `hold` or `frame` is called. */
export function createBenchRig(options: BenchOptions = {}): BenchRig {
  const opts: Required<BenchOptions> = {
    seconds: options.seconds ?? 20,
    warmup: options.warmup ?? 1,
    enemies: options.enemies ?? BENCH_TARGET.enemies,
    shots: options.shots ?? BENCH_TARGET.shots,
    shards: options.shards ?? BENCH_TARGET.shards,
    particles: options.particles ?? BENCH_TARGET.particles,
    budgetMs: options.budgetMs ?? 1000 / 60,
    chapter: options.chapter ?? 0,
    backend: options.backend ?? 'none',
    now: options.now ?? ((): number => Date.now()),
  };

  /** Room for 120 fps across the whole window, plus slack, so a fast machine cannot run out. */
  const capacity = Math.ceil((opts.warmup + opts.seconds) * 120) + 64;
  /** The two timings, one frame per index, kept apart because they answer different questions. */
  const periods = new Float32Array(capacity);
  const works = new Float32Array(capacity);

  const enemyLoad = tracker(opts.enemies);
  const shotLoad = tracker(opts.shots);
  const fxLoad = tracker(opts.particles);

  let running = true;
  let result: BenchResult | null = null;
  let recorded = 0;
  /** Wall milliseconds the recorded samples cover, for `measuredMs` and for `fps`. */
  let sampledMs = 0;
  let clipped = false;
  let ticks = 0;
  let cards = 0;
  let lightPeak = 0;
  /** When this frame's work started, or -1 before the first frame. */
  let began = -1;
  /** When the previous frame ended, for the period. -1 before the first. */
  let lastEnd = -1;
  /** When the window started, for the warm-up and the cut-off. */
  let opened = -1;

  const warmupMs = opts.warmup * 1000;
  const windowMs = (opts.warmup + opts.seconds) * 1000;

  function hold(w: World, input: InputFrame): void {
    if (!running) return;
    const now = opts.now();
    if (opened < 0) opened = now;
    began = now;

    // The player has to survive the window for a different reason than he has to be pointed: a
    // dead run stops stepping, so the rest of the window would time an empty frame. Health is
    // refilled rather than damage turned off, which keeps the hit path — the contact check,
    // i-frames, the damage numbers — on the bill.
    const p = w.player;
    p.alive = true;
    if (p.hp < p.maxHp) p.hp = p.maxHp;
    w.over = false;

    holdBodies(w, opts.enemies);
    holdShots(w, opts.shots);
    holdShards(w, opts.shards);
    holdFx(w, opts.particles);

    // The trigger is held whatever the setting says, so a bench measures a fight rather than a
    // stand-off, and a run with auto-fire off benches the same load as one with it on.
    input.fire = true;
  }

  function resolve(w: World): void {
    if (!running) return;
    // Bounded rather than searching: a run that somehow keeps offering cards has a problem worth
    // reporting, and a window that stops to find out is a window that measured nothing.
    let guard = 0;
    while (w.pendingLevelUp && guard++ < 16) {
      if (!choosePick(w, 0)) break;
      cards++;
    }
  }

  function frame(w: World, steps: number): void {
    if (!running || opened < 0) return;
    const now = opts.now();
    // A frame the rig did not open — a frozen scene, where `hold` never ran — has no work span to
    // book, but it still costs time and still spends the window. Timing a frozen screen would be
    // useless and letting one hold the window open forever is worse: the report says the load fell
    // off the floor rather than the page measuring nothing.
    const took = began >= 0 ? now - began : 0;
    const period = lastEnd >= 0 ? now - lastEnd : 0;
    began = -1;
    lastEnd = now;
    ticks += steps;

    const elapsed = now - opened;
    // A frame counts once its *whole* span is inside the measured window, so no sample carries a
    // piece of the shader-compile warm-up into the numbers that are meant to be steady state. The
    // straddling frame's time still counts against the window, which is why `measuredMs` can come
    // out short of `elapsedMs` by one frame's worth even when nothing was lost.
    if (period > 0 && elapsed - period >= warmupMs) {
      if (recorded < capacity) {
        const at = recorded;
        periods[at] = period;
        works[at] = took;
        sampledMs += period;
        track(enemyLoad, w.enemies.count);
        track(shotLoad, w.shots.count);
        track(fxLoad, w.fx.count);
        if (w.fx.lightCount > lightPeak) lightPeak = w.fx.lightCount;
        recorded++;
      } else {
        clipped = true;
      }
    }

    if (elapsed >= windowMs) finish(now);
  }

  function finish(now: number): void {
    running = false;
    const warnings: string[] = [];
    const spent = recorded > 0 ? timeStats(periods, recorded) : noStats();
    const worked = recorded > 0 ? timeStats(works, recorded) : noStats();
    const over = countOver(works, recorded, opts.budgetMs);
    const budget = ms(opts.budgetMs);
    const elapsedMs = ms(now - opened);
    const measuredMs = ms(sampledMs);
    const fps = sampledMs > 0 ? Math.round((recorded / (sampledMs / 1000)) * 10) / 10 : 0;
    const bodies = readTracker(enemyLoad);
    const rounds = readTracker(shotLoad);
    const sparks = readTracker(fxLoad);

    if (recorded === 0) {
      warnings.push(
        `no frame was measured: the ${ms(windowMs)} ms window never got past its warm-up, so the page was not playing while it ran`,
      );
    } else {
      if (over > 0) {
        warnings.push(
          `frame budget blown: the page's own code took over ${budget} ms on ${over} of ${recorded} frames ` +
            `(${Math.round((over / recorded) * 100)}%), median ${worked.median} ms and worst ${worked.max} ms of ` +
            `work inside a ${spent.median} ms frame`,
        );
      } else if (fps < SLOW_FPS) {
        // The other kind of slow, and the one a work-only report would have called fine: the frames
        // miss 60 Hz while the JS fits, so the milliseconds went to the GPU or to how this browser
        // paces rAF. Said out loud because the alternative is a reader blaming the simulation.
        warnings.push(
          `only ${fps} fps without the code going over budget: ${worked.median} ms of work inside a ` +
            `${spent.median} ms frame, so the rest is the draw or the browser's pacing, not this code ` +
            `(backend ${opts.backend})`,
        );
      }
      const untracked = ms(elapsedMs - opts.seconds * 1000 - measuredMs);
      if (untracked > 1000) {
        // More than a second of the measured window arrived with no timing attached, which is a
        // fact about the rig rather than about the machine: the numbers above are over `measuredMs`,
        // not over the window, and a reader entitled to assume they are the same thing needs to be
        // told they are not.
        warnings.push(
          `the rig timed ${measuredMs} ms of a ${ms(opts.seconds * 1000)} ms window: ${untracked} ms of it ` +
            `came with no frame attached, so fps and the frame times are over the sampled span only`,
        );
      }
      const missed: string[] = [];
      if (bodies.mean < bodies.target * 0.8) missed.push(`bodies ${bodies.mean} of ${bodies.target}`);
      if (rounds.mean < rounds.target * 0.8) missed.push(`rounds ${rounds.mean} of ${rounds.target}`);
      if (sparks.mean < sparks.target * 0.8) missed.push(`particles ${sparks.mean} of ${sparks.target}`);
      if (missed.length > 0) {
        warnings.push(`the load was not held — ${missed.join(', ')} — so these frames are cheaper than the target`);
      }
      if (clipped) warnings.push(`the sample window filled at ${capacity} frames and stopped recording`);
    }

    result = {
      kind: 'bench',
      backend: opts.backend,
      chapter: opts.chapter + 1,
      seconds: opts.seconds,
      warmupSeconds: opts.warmup,
      frames: recorded,
      ticks,
      fps,
      elapsedMs,
      measuredMs,
      frameMs: spent,
      workMs: worked,
      budgetMs: budget,
      workOverBudget: over,
      target: { enemies: opts.enemies, shots: opts.shots, particles: opts.particles },
      load: {
        enemies: bodies,
        shots: rounds,
        particles: sparks,
        lights: { peak: lightPeak },
      },
      levelUps: cards,
      warnings,
    };
  }

  return {
    options: opts,
    get running() {
      return running;
    },
    get done() {
      return result !== null;
    },
    get result() {
      return result;
    },
    hold,
    resolve,
    frame,
  };
}