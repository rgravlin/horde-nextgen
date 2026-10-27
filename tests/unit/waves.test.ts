/**
 * The wave script: timed packs, obstacle-safe landing, and the chapter's price.
 *
 * Three things a chapter's `waves`/`duration`/`difficulty` data promises, and each is checked
 * where the promise can be broken:
 *
 * - A pack lands **at its second**. Not before (nothing else in the chapter puts that archetype
 *   down that early) and not after (the set piece the chapter was drawn around either happens
 *   or it does not). Chapter 1's splitter pack is the one pinned: it is timed at 0:20, four
 *   seconds ahead of the point in the drumbeat recipe where a splitter appears at all, so up to
 *   0:24 the only source a splitter can have is the script.
 * - A body comes down **on clear floor, outside the player's eyeline**. Landing points are
 *   chosen against `pointBlocked` before anything is spawned, so this runs the ten authored
 *   layouts — the pinwheel, the canal, the cross of the kill floor — and names the chapter,
 *   second, archetype and position of anything that arrives inside cover or inside the view
 *   rect. Both halves are the same rule: an arrival you cannot see and cannot shoot is a hit
 *   the player never had a chance to answer. Each chapter is its own test because the layouts
 *   are what differ, and a failure should say which room it tripped in.
 * - The **price climbs**. `spawnRate` and `hp` are two dials that multiply into one difficulty,
 *   and a chapter that only moved one of them would still read as progress on the page, so the
 *   product is what has to rise — and the hp dial has to reach the bodies, not just the table.
 *
 * The player in these runs is immortal and holds the trigger: that keeps a horde thin enough
 * that a ten-chapter run stays a unit test rather than a bench, and it keeps the only variable
 * in the room the thing under test — where and when the spawner puts bodies down.
 *
 * Reads go through the tick's `Ev.Spawn` ring rather than by scanning the pool, because a scan
 * cannot tell a body that arrived this tick from one that has stood there for a minute. In that
 * ring `a` is the pool slot the spawn wrote, `b` its archetype and `x`/`y` the point it was put
 * down at, which is the only place a landing position still exists once the body has started
 * walking.
 */

import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../../src/content/enemies';
import { ELITES, LEVELS, eliteIndex } from '../../src/content/levels';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { startChapter } from '../../src/sim/systems/levels';
import { pointBlocked } from '../../src/sim/systems/obstacles';
import { DT, Ev, TUNE, clearEvents, createWorld, type World } from '../../src/sim/world';

/**
 * Archetypes that arrive as somebody's offspring rather than as a pack.
 *
 * A splitter's splinters, a broodmother's brood and a spawner's young come out of the body
 * that already stands on the floor, which is what makes them read: four splinters appear
 * *around* the splitter that just died, wherever it died, and a spawner's brood lands behind
 * it while it walks. The view-rect rule is about arrivals, so they are excluded from that
 * half of the check — and only from that half: the cover rule below still counts them, and
 * passes, because a child put down inside a wall is the same unreadable arrival.
 *
 * The exemption keys off *how a body arrives*, not off which numbers it carries, which is why
 * the spawner's young are their own archetype: they would otherwise be exempted by being
 * swarmlings, and a swarmling also arrives from the wave recipes, where the rule has to hold.
 */
const OFFSPRING = new Set(
  ENEMIES.filter((d) => d.splits !== undefined || d.brood !== undefined).flatMap((d) => [
    d.splits?.def,
    d.brood?.def,
  ]),
);

/** One chapter, started the way the game starts one: its floor, its clock, its script. */
function chapter(index: number, seed: number): World {
  const w = createWorld(seed);
  w.player.hp = 100_000;
  w.autoFire = true;
  startChapter(w, index);
  return w;
}

/**
 * One tick, run the way the harnesses run a chapter: trigger down, walking figure of eight.
 *
 * The player moves on purpose. Landing points are picked relative to the player, so a player
 * who stands still only ever exercises the cover that happens to sit round the origin, and
 * every chapter's middle is its emptiest floor.
 */
function tick(w: World, t: number, f: ReturnType<typeof createInputFrame>): void {
  resetFrame(f);
  f.fire = true;
  f.moveX = t % 240 < 120 ? 1 : -1;
  f.moveY = t % 360 < 180 ? 1 : -1;
  step(w, f);
  w.player.hp = 100_000;
}

/** The ring's live window, oldest first, as event-slot indices. Cleared by the caller. */
function spawnSlots(w: World, out: number[]): number {
  const e = w.events;
  let n = 0;
  for (let k = 0; k < e.count; k++) {
    const slot = (e.head - e.count + k + e.cap * 2) % e.cap;
    if (e.type[slot] === Ev.Spawn) out[n++] = slot;
  }
  return n;
}

/** How many of this tick's spawn events name archetype `id`. */
function spawned(w: World, slots: number[], n: number, id: string): number {
  let c = 0;
  for (let i = 0; i < n; i++) if (ENEMIES[w.events.b[slots[i]]].id === id) c++;
  return c;
}

describe('the wave script', () => {
  it('lands a scripted pack at its second, and at no second before it', () => {
    const w = chapter(0, 501);
    const level = LEVELS[0];
    const beat = level.waves.find((b) => b.t < 24 && b.pack.some((g) => g[0] === 'splitter'));
    expect(beat, 'the bay scripts a splitter pack').toBeDefined();
    const at = beat!;
    const count = at.pack.reduce((n, g) => n + g[1], 0);
    expect(count).toBe(5);

    // The recipe cannot account for a splitter this early: waves 1 and 2 — the two rows the
    // drumbeat reads up to 0:24 — name none, so every splitter below is either the script's or
    // nothing is. That is what makes "and not before" answerable rather than merely unlikely.
    expect(level.packs[0]).not.toContain('splitter');
    expect(level.packs[1]).not.toContain('splitter');

    // Walk the pre-splitter window a tick at a time and note every tick that produced one.
    // Read the ring each tick rather than at the end, so an arrival cannot hide by being
    // overwritten, and clear it each tick, so a count is a count of bodies and not of readings.
    const f = createInputFrame();
    const slots: number[] = [];
    const landed: [number, number][] = [];
    const lastTick = Math.round(24 / DT);
    for (let t = 1; t <= lastTick; t++) {
      tick(w, t, f);
      const n = spawned(w, slots, spawnSlots(w, slots), 'splitter');
      if (n > 0) landed.push([t, n]);
      clearEvents(w);
    }

    // Exactly one delivery in twenty-four seconds, on the beat's own second, carrying the whole
    // pack: nothing earlier (the recipe never reaches a splitter this soon) and nothing later (a
    // pack that has to hunt for a landing point drifts past its second, which is the other half
    // of a set piece being a set piece).
    expect(landed, 'every tick that produced a splitter').toHaveLength(1);
    const [tickAt, n] = landed[0];
    expect(Math.abs(tickAt * DT - at.t), 'the pack landed on the second it was written for').toBeLessThan(DT * 2);
    expect(n).toBe(count);

    // Both beats timed inside the window (0:12 and 0:20) are spent by 0:24, and the only one of
    // them that carries a splitter is the 0:20 pack above. Nothing was given up on either: a
    // refused pack also spends the cursor, and that is the difference the counter is for.
    expect(w.wave.script, 'both beats timed inside the window landed').toBe(2);
    expect(w.wave.skips, 'no pack was given up on').toBe(0);
    expect(w.errors).toBe(0);
  });

  // One test per chapter, because what is being walked here is ten different rooms and a
  // failure in the pinwheel should not read as a failure in the queue.
  it.each(LEVELS.map((level, index) => ({ room: level.name, index })))(
    'keeps every body off cover and outside the eyeline in $room',
    ({ index }) => {
      const level = LEVELS[index];
      const w = chapter(index, 700 + index);
      const f = createInputFrame();
      const slots: number[] = [];
      const inCover: string[] = [];
      const inSight: string[] = [];
      let seen = 0;

      // The whole script phase: the longest stretch a chapter is played in, and the one where
      // the player has walked into every corner of the room by the end of it.
      const ticks = Math.round(level.duration / DT);
      for (let t = 1; t <= ticks; t++) {
        tick(w, t, f);
        const n = spawnSlots(w, slots);
        for (let k = 0; k < n; k++) {
          const slot = slots[k];
          const kind = w.events.b[slot];
          const r = ENEMIES[kind].radius;
          const x = w.events.x[slot];
          const y = w.events.y[slot];
          const where = `${level.id} at ${(t / 60).toFixed(1)}s: ${ENEMIES[kind].id} at ${x.toFixed(2)},${y.toFixed(2)}`;
          seen++;
          if (pointBlocked(w.props, x, y, r)) inCover.push(`${where} is inside cover`);
          if (OFFSPRING.has(ENEMIES[kind].id)) continue;
          const dx = Math.abs(x - w.player.x);
          const dy = Math.abs(y - w.player.y);
          if (dx <= TUNE.viewHalfX && dy <= TUNE.viewHalfY) inSight.push(`${where} is inside the view rect`);
        }
        clearEvents(w);
      }

      expect(inCover, 'bodies put down inside cover').toEqual([]);
      expect(inSight, "bodies put down inside the player's eyeline").toEqual([]);

      // The script ran to the end rather than being starved: every pack the chapter wrote
      // landed, which is the other half of the landing rule. `skips` counts the packs whose edge
      // found no clear floor after half a second of trying — a chapter quietly missing its own
      // set pieces, which nothing else here would notice.
      expect(w.wave.skips, `${level.id}: scripted packs given up on for want of floor`).toBe(0);
      expect(w.wave.script, `${level.id}: every scripted pack should have landed`).toBe(level.waves.length);

      // Not vacuous: all of the above only means something if a lot of bodies arrived.
      expect(seen, `${level.id}: bodies should have arrived`).toBeGreaterThan(300);
      expect(w.errors).toBe(0);
    },
  );

  it('lands a scripted pack in the variant the chapter wrote for it, priced at the chapter', () => {
    const w = chapter(1, 777); // Conveyor Yard: the chapter that introduces the bulwark
    const level = LEVELS[1];
    const index = level.waves.findIndex((b) => b.elite === 'bulwark');
    expect(index, 'the yard sends a bulwark pack').toBeGreaterThan(-1);
    const at = level.waves[index];
    const variant = eliteIndex('bulwark');
    expect(variant).toBeGreaterThanOrEqual(0);
    const pack = at.pack.reduce((n, g) => n + g[1], 0);

    // Run up to the tick the pack lands, watched off the script cursor rather than off a
    // division: `wave.elapsed` accumulates 1/60 sixty times a second and the sum is not exactly
    // the second it represents, which is a fact about the clock, not about the pack. The ring is
    // cleared at the start of each tick so the read below is that tick's arrivals — an event ring
    // holds a body's spawn position, not its current health, and a stale event's slot has since
    // been shot at, or handed to another body.
    const f = createInputFrame();
    let t = 0;
    while (w.wave.script <= index && t < 8000) {
      clearEvents(w);
      t++;
      tick(w, t, f);
    }
    expect(w.wave.script, 'the bulwark pack landed').toBe(index + 1);
    expect(Math.abs(t * DT - at.t)).toBeLessThan(DT * 2);

    const slots: number[] = [];
    const n = spawnSlots(w, slots);
    const marked: number[] = [];
    for (let i = 0; i < n; i++) {
      const slot = slots[i];
      // `a` is the pool slot the spawn wrote and the only right index for the pools. An event
      // slot and an enemy slot are both numbers into an array, and reading one with the other
      // answers a question about two unrelated bodies.
      const body = w.events.a[slot];
      const kind = w.events.b[slot];
      if (OFFSPRING.has(ENEMIES[kind].id)) continue;
      if (w.enemies.elite[body] !== variant + 1) continue;
      marked.push(body);
      // The chapter's price is on the body: archetype HP, times the variant, times the
      // chapter's hp scale — rebuilt from the archetype rather than multiplied off whatever the
      // pool held, so it reads the same whether the variant came from the script's flag or from
      // the per-body roll inside `spawnEnemy`.
      const want = ENEMIES[kind].hp * ELITES[variant].hp * level.difficulty.hp;
      expect(Math.abs(w.enemies.hp[body] - want), `body ${body} hp`).toBeLessThan(1e-3);
    }

    // Thirteen bodies arrived as bulwarks. The drumbeat's batch in the same tick is a few bodies
    // long and rolls the variant at 5%, so nothing but a scripted flag reaches the pack's own
    // size — and the kinds are the pack's own, not a crowd that happens to match.
    expect(marked.length, 'the pack arrived in its authored variant').toBeGreaterThanOrEqual(pack);
    const kinds = marked.map((body) => ENEMIES[w.enemies.kind[body]].id);
    expect(kinds.filter((k) => k === 'armored').length).toBeGreaterThanOrEqual(5);
    expect(kinds.filter((k) => k === 'chaser').length).toBeGreaterThanOrEqual(8);
    expect(w.errors).toBe(0);
  });
});

describe('chapter difficulty', () => {
  /** What a chapter costs the player: how often bodies arrive, times what they cost. */
  const price = (i: number) => LEVELS[i].difficulty.spawnRate * LEVELS[i].difficulty.hp;

  it('rises strictly from chapter 1 to 2 to 3, and on to the last', () => {
    // The three the task names, spelled out, because a loop over ten chapters reads as a
    // formality.
    expect(price(1)).toBeGreaterThan(price(0));
    expect(price(2)).toBeGreaterThan(price(1));
    expect(price(2)).toBeGreaterThan(price(0));

    for (let i = 1; i < LEVELS.length; i++) {
      expect(price(i), `${LEVELS[i].id} should cost more than ${LEVELS[i - 1].id}`).toBeGreaterThan(price(i - 1));
      // Both dials moved. A chapter that only shortened its spawn gap spawns the same bodies
      // faster; one that only raised HP takes longer to clear. Either alone reads as progress
      // in a table and does not in play.
      expect(LEVELS[i].difficulty.spawnRate).toBeGreaterThanOrEqual(1);
      expect(LEVELS[i].difficulty.hp).toBeGreaterThan(1);
    }
  });

  it('puts the chapter\'s hp scale on the bodies its script lands', () => {
    /**
     * Every archetype a chapter put down in its first `seconds`, with the HP it arrived at.
     *
     * Thirty seconds is long enough that both chapters have run several of their beats and a
     * few drumbeat batches, so the archetypes they have in common are on the floor in both
     * runs and the same body can be read at both prices.
     */
    const arrivals = (index: number, seconds: number) => {
      const w = chapter(index, 1234);
      const level = LEVELS[index];
      const f = createInputFrame();
      const slots: number[] = [];
      const out = new Map<string, number>();
      const ticks = Math.round(seconds / DT);

      for (let t = 1; t <= ticks; t++) {
        clearEvents(w);
        tick(w, t, f);
        const n = spawnSlots(w, slots);
        for (let i = 0; i < n; i++) {
          const slot = slots[i];
          const body = w.events.a[slot];
          const id = ENEMIES[w.events.b[slot]].id;
          if (OFFSPRING.has(id)) continue;
          if (w.enemies.elite[body] > 0) continue; // a rolled variant is priced differently
          if (!out.has(id)) out.set(id, w.enemies.hp[body]);
        }
      }

      expect(w.errors, `${level.id}: the run should stay clean`).toBe(0);
      return out;
    };

    const cheap = arrivals(0, 30);
    const dear = arrivals(2, 30);
    expect(cheap.size, 'the bay should have put bodies down').toBeGreaterThan(0);
    expect(dear.size, 'the canal should have put bodies down').toBeGreaterThan(0);

    // Every arrival costs its archetype's HP times its chapter's, both chapters. Read off the
    // archetype rather than off each other, so a chapter that quietly stopped scaling its
    // bodies is caught even if the two chapters happen to agree with each other.
    for (const [index, seen] of [[0, cheap], [2, dear]] as const) {
      const scale = LEVELS[index].difficulty.hp;
      for (const [id, hp] of seen) {
        const def = ENEMIES.find((d) => d.id === id);
        expect(def, `${id} is in the roster`).toBeDefined();
        expect(hp, `${id} in ${LEVELS[index].id}`).toBeCloseTo(def!.hp * scale, 3);
      }
    }

    // And the two runs really are two prices: a body the two chapters share costs more in the
    // canal, which is the sentence the difficulty table is supposed to turn into.
    expect(LEVELS[2].difficulty.hp).toBeGreaterThan(LEVELS[0].difficulty.hp);
    let shared = 0;
    for (const [id, hp] of dear) {
      const atHome = cheap.get(id);
      if (atHome === undefined) continue;
      shared++;
      expect(hp, `${id} should cost more in the canal`).toBeGreaterThan(atHome);
    }
    expect(shared, 'a body the two chapters both put down').toBeGreaterThan(0);
  });
});
