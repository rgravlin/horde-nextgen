/**
 * Headless bench: what one tick of the simulation costs at the load the game has to
 * draw (TECH.md "Pools with hard caps", "Target 60 fps with 1,000+ enemies").
 *
 * It is a *step* bench, not a frame bench. Nothing here touches a canvas: the point is
 * the fixed-timestep half of the budget, which is the half that can be measured without a
 * GPU and the half a renderer has to fit inside. At 60 Hz a frame is 16.7 ms and the sim
 * gets a slice of it; the gate is 4 ms at the headline load, which leaves the rest for
 * drawing. The browser's own frame times come from `?bench=1000` and are reported, not
 * gated.
 *
 * How the load is built, and why it is rebuilt every tick:
 *
 * The load is seeded to the target before each measured tick and the tick is what is
 * timed. A bench that loaded once and then let the arena empty itself would measure the
 * drain — by tick 200 most of the horde is dead and most of the rounds are spent — and a
 * number that drifts down as the run goes on is not a load. Re-seeding is setup, so it
 * sits outside the timer, and every tick is measured at the same load: 1,000 bodies,
 * 1,500 rounds in the air, 600 shards, 8,000 particles and 16 lights, which is the
 * picture the brief asks the game to hold.
 *
 * The load's *shape* comes from `src/game/bench.ts` — the counts, which weapons have a
 * flight, and the scatter that spreads them out — because the two benches only mean
 * something side by side. The headless number is what a tick of the rules costs, the
 * browser number is what a frame of the game costs, and the gap between them is a
 * draw-path question; that comparison is worth nothing if the two are not measuring the
 * same pile.
 *
 * The floor is under the load on purpose. Cover is what makes a horde expensive: every
 * body asks the prop grid one or two questions a tick, and a bench on open arena measures
 * a fight the shipped chapters do not have. `--floor=none` drops it when you want the two
 * numbers separately.
 *
 * Run it: `npm run bench` (or `npm run bench -- --ticks=1200 --floor=none`). Exits
 * non-zero when the median goes over the budget, so a change that makes a tick slower
 * cannot land quietly.
 */

import { writeFileSync } from 'node:fs';

import { ENEMIES } from '../src/content/enemies';
import { BENCH_TARGET, FLYING_WEAPONS, scatter } from '../src/game/bench';
import { WEAPONS } from '../src/content/weapons';
import { createInputFrame } from '../src/sim/input';
import { LIGHT_CAP, PARTICLE_CAP } from '../src/sim/fx';
import { step } from '../src/sim/step';
import { spawnEnemy } from '../src/sim/systems/enemies';
import { startChapter } from '../src/sim/systems/levels';
import { alloc, createWorld, release, type Pool, type World } from '../src/sim/world';

/** The headline load, from TECH.md's performance target, shared with the browser bench. */
const TARGET_ENEMIES = BENCH_TARGET.enemies;
const TARGET_SHOTS = BENCH_TARGET.shots;
const TARGET_SHARDS = BENCH_TARGET.shards;
const TARGET_PARTICLES = BENCH_TARGET.particles;

/** Ticks measured per run, after the warm-up. */
const DEFAULT_TICKS = 600;

/** Ticks thrown away first: the arena is still filling up during them. */
const WARMUP = 60;

/** Milliseconds one tick may take at that load before the bench calls it a regression. */
const DEFAULT_BUDGET = 4;

interface Flags {
  ticks: number;
  budget: number;
  /** Chapter whose floor is installed, or -1 for open arena. */
  floor: number;
  enemies: number;
  shots: number;
  particles: number;
  out: string | null;
}

/** Read `--key=value` arguments. Nothing else about this file is configurable. */
function readArgs(argv: string[]): Flags {
  const flags: Flags = {
    ticks: DEFAULT_TICKS,
    budget: DEFAULT_BUDGET,
    floor: 9,
    enemies: TARGET_ENEMIES,
    shots: TARGET_SHOTS,
    particles: TARGET_PARTICLES,
    out: null,
  };

  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const key = (eq < 0 ? arg : arg.slice(0, eq)).replace(/^--/, '');
    const raw = eq < 0 ? '' : arg.slice(eq + 1);
    const n = Number(raw);

    if (key === 'floor') flags.floor = raw === 'none' ? -1 : Number.isFinite(n) ? n : flags.floor;
    else if (key === 'out' && raw) flags.out = raw;
    else if (Number.isFinite(n) && n > 0) {
      if (key === 'ticks') flags.ticks = n;
      else if (key === 'budget') flags.budget = n;
      else if (key === 'enemies') flags.enemies = n;
      else if (key === 'shots') flags.shots = n;
      else if (key === 'particles') flags.particles = n;
    }
  }
  return flags;
}

/**
 * Empty a pool back to nothing, so the next seed starts from the target count.
 *
 * Releasing rather than reallocating keeps the free lists intact and allocates nothing:
 * a bench that allocated a new pool every tick would be timing its own setup.
 */
function drain(p: Pool): void {
  for (let i = 0; i < p.cap; i++) {
    if (p.alive[i] !== 0) release(p, i);
  }
}

/** Put `n` bodies down in a ring around the player, cycling through the roster. */
function seedEnemies(w: World, n: number): void {
  drain(w.enemies);
  for (let k = 0; k < n; k++) {
    const kind = k % ENEMIES.length;
    const ring = 6 + scatter(k, 1) * 14;
    const a = (k / n) * Math.PI * 2 + scatter(k, 2) * 0.4;
    spawnEnemy(w, kind, w.player.x + Math.cos(a) * ring, w.player.y + Math.sin(a) * ring);
  }
}

/** Put `n` rounds in the air, cycling the guns so every kind of flight gets paid for. */
function seedShots(w: World, n: number): void {
  const shots = w.shots;
  drain(shots);
  for (let k = 0; k < n; k++) {
    const slot = alloc(shots);
    if (slot < 0) return;
    // Only the guns with a flight are seeded. A weapon whose `speed` is 0 resolves inside the
    // tick it is loosed (hitscan, beam, chain) and has no round in the air to time, so a pool
    // slot holding one is a slot that costs nothing — which is the opposite of what a load is.
    const weapon = FLYING_WEAPONS[k % FLYING_WEAPONS.length];
    const def = WEAPONS[weapon];
    const a = scatter(k, 3) * Math.PI * 2;
    const ring = 1 + scatter(k, 4) * 6;
    shots.x[slot] = w.player.x + Math.cos(a) * ring;
    shots.y[slot] = w.player.y + Math.sin(a) * ring;
    shots.vx[slot] = Math.cos(a) * def.speed;
    shots.vy[slot] = Math.sin(a) * def.speed;
    shots.hp[slot] = def.dmg;
    shots.life[slot] = 1.2;
    shots.kind[slot] = weapon;
    shots.state[slot] = def.pierce + 1;
  }
}

/** Put `n` XP shards on the floor, inside and outside the magnet field. */
function seedShards(w: World, n: number): void {
  const shards = w.shards;
  drain(shards);
  for (let k = 0; k < n; k++) {
    const slot = alloc(shards);
    if (slot < 0) return;
    const a = scatter(k, 5) * Math.PI * 2;
    const ring = scatter(k, 6) * 12;
    shards.x[slot] = w.player.x + Math.cos(a) * ring;
    shards.y[slot] = w.player.y + Math.sin(a) * ring;
    shards.vx[slot] = (scatter(k, 7) - 0.5) * 6;
    shards.vy[slot] = (scatter(k, 8) - 0.5) * 6;
    shards.life[slot] = 12;
    shards.kind[slot] = k % ENEMIES.length;
  }
}

/**
 * Fill the particle field to `n` and light sixteen emitters around the player.
 *
 * Written straight into the field rather than through the event ring: the point is the
 * cost of the field, and 8,000 particles manufactured as events would first have to be
 * squeezed through a ring that holds 1,024.
 */
function seedFx(w: World, n: number): void {
  const fx = w.fx;
  const count = n > fx.cap ? fx.cap : n;
  for (let i = 0; i < count; i++) {
    const a = scatter(i, 9) * Math.PI * 2;
    const ring = scatter(i, 10) * 20;
    fx.x[i] = w.player.x + Math.cos(a) * ring;
    fx.y[i] = w.player.y + Math.sin(a) * ring;
    fx.z[i] = 0.05 + scatter(i, 11) * 1.2;
    fx.vx[i] = (scatter(i, 12) - 0.5) * 6;
    fx.vy[i] = (scatter(i, 13) - 0.5) * 6;
    fx.vz[i] = scatter(i, 14) * 3;
    fx.life[i] = 0.2 + scatter(i, 15) * 1.1;
    fx.span[i] = fx.life[i];
    fx.size[i] = 0.08 + scatter(i, 16) * 0.3;
    fx.kind[i] = i % 4;
  }
  fx.head = count % fx.cap;
  fx.count = count;

  for (let i = 0; i < LIGHT_CAP; i++) {
    const a = (i / LIGHT_CAP) * Math.PI * 2;
    fx.lightX[i] = w.player.x + Math.cos(a) * 5;
    fx.lightY[i] = w.player.y + Math.sin(a) * 5;
    fx.lightZ[i] = 1.2;
    fx.lightPower[i] = 0.8;
    fx.lightLife[i] = 0.3;
    fx.lightSpan[i] = 0.3;
    fx.lightKind[i] = i % 3 === 0 ? 2 : 1;
  }
  fx.lightCount = LIGHT_CAP;
}

/**
 * Keep the player standing, so the tick under test is a fight and not a post-mortem.
 *
 * The step stops early once the run is over — that is the death flow working — and a bench
 * that let the arena kill him during the warm-up would spend 660 ticks timing an empty
 * function and report a beautiful number for nothing. The health is therefore refilled
 * with the load. What is measured is the cost of the fight, not its outcome.
 */
function hold(w: World): void {
  w.player.alive = true;
  w.player.hp = 1_000_000;
  w.over = false;
}

/** Reset the world to the target load, so every measured tick starts at the same load. */
function reload(w: World, f: Flags): void {
  hold(w);
  seedEnemies(w, f.enemies);
  seedShots(w, f.shots);
  seedShards(w, TARGET_SHARDS);
  seedFx(w, f.particles);
}

/** Median, 95th percentile, worst and mean of a run, in milliseconds. */
function stats(times: Float64Array): { median: number; p95: number; max: number; mean: number } {
  const copy = Array.from(times);
  copy.sort((a, b) => a - b);
  const at = (q: number): number => copy[Math.min(copy.length - 1, Math.floor(q * copy.length))];
  let sum = 0;
  for (const t of copy) sum += t;
  return { median: at(0.5), p95: at(0.95), max: copy[copy.length - 1], mean: sum / copy.length };
}

function main(): number {
  const f = readArgs(process.argv.slice(2));
  const frame = createInputFrame();
  frame.fire = true;
  frame.moveX = 1;

  const world = createWorld(7, { arenaHalf: 60 });
  if (f.floor >= 0) startChapter(world, f.floor);

  reload(world, f);

  let peakParticles = 0;
  let peakLights = 0;
  let leastBodies = Number.POSITIVE_INFINITY;
  let leastRounds = Number.POSITIVE_INFINITY;
  const times = new Float64Array(f.ticks);

  for (let t = 0; t < f.ticks + WARMUP; t++) {
    reload(world, f);
    const started = performance.now();
    step(world, frame);
    const took = performance.now() - started;

    if (t >= WARMUP) {
      times[t - WARMUP] = took;
      if (world.fx.count > peakParticles) peakParticles = world.fx.count;
      if (world.fx.lightCount > peakLights) peakLights = world.fx.lightCount;
      // What is left *after* the tick, tracked at its worst: a tick that starts with
      // 1,000 bodies and ends with 20 spent half of it resolving deaths, and the low
      // water mark is where that shows.
      if (world.enemies.count < leastBodies) leastBodies = world.enemies.count;
      if (world.shots.count < leastRounds) leastRounds = world.shots.count;
    }
  }

  const s = stats(times);
  const passed = s.median <= f.budget;
  const label = f.floor >= 0 ? `chapter ${f.floor + 1}` : 'open arena';
  // The low water marks, reported so a load that is not actually held shows up.
  const leftBodies = Number.isFinite(leastBodies) ? leastBodies : 0;
  const leftRounds = Number.isFinite(leastRounds) ? leastRounds : 0;

  console.log(`\nbench: ${f.ticks} ticks on ${label}, target ${f.enemies} bodies + ${f.shots} rounds + ${TARGET_SHARDS} shards + ${f.particles} particles + ${LIGHT_CAP} lights`);
  console.log(`  seeded: ${f.enemies} bodies · ${f.shots} rounds · ${TARGET_SHARDS} shards · ${f.particles} particles · ${LIGHT_CAP} lights`);
  console.log(`  left after a tick (worst): ${leftBodies} bodies · ${leftRounds} rounds · ${peakParticles} particles · ${peakLights} lights`);
  console.log(`  step median ${s.median.toFixed(3)} ms · p95 ${s.p95.toFixed(3)} ms · max ${s.max.toFixed(3)} ms · mean ${s.mean.toFixed(3)} ms`);
  console.log(`  budget ${f.budget} ms → ${passed ? 'PASS' : 'FAIL'} (${(f.budget - s.median).toFixed(3)} ms at the median)`);
  if (world.fx.dropped > 0) {
    console.log(`  note: the event ring dropped ${world.fx.dropped} events before the particle field reached them`);
  }

  if (f.out) {
    const body = JSON.stringify(
      {
        generated: new Date().toISOString(),
        floor: label,
        target: { enemies: f.enemies, shots: f.shots, shards: TARGET_SHARDS, particles: PARTICLE_CAP, lights: LIGHT_CAP },
        leftAfterTick: { enemies: leftBodies, shots: leftRounds, particles: peakParticles, lights: peakLights },
        ticks: f.ticks,
        medianMs: s.median,
        p95Ms: s.p95,
        maxMs: s.max,
        meanMs: s.mean,
        budgetMs: f.budget,
        passed,
      },
      null,
      2,
    );
    writeFileSync(f.out, body);
    console.log(`  wrote ${f.out}`);
  }

  return passed ? 0 : 1;
}

process.exit(main());
