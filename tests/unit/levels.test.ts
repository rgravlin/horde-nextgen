import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../../src/content/enemies';
import { LEVELS, levelAt } from '../../src/content/levels';
import { WEAPONS } from '../../src/content/weapons';
import type { StatBlock } from '../../src/content/powerups';
import { createInputFrame, resetFrame, type InputFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { acidAt, blocked } from '../../src/sim/systems/obstacles';
import { killEnemy } from '../../src/sim/systems/enemies';
import { bossesAlive } from '../../src/sim/systems/boss';
import { Phase, startChapter } from '../../src/sim/systems/levels';
import { recomputeStats } from '../../src/sim/systems/powerups';
import { Ev, Tele, TUNE, clearEvents, createWorld, loadSlot, type World } from '../../src/sim/world';

/**
 * Chapter flow: the run as a sequence of rooms, and the door at the end of each one.
 *
 * The other two files that touch a chapter are about *objects*. `tests/unit/bosses.test.ts`
 * pins what an encounter body does once it is on the floor; `tests/unit/obstacles.test.ts` pins
 * what a floor does to the bodies standing on it. This file is about the ordering, because that
 * is the part a chapter can get wrong while every one of its pieces still passes on its own: an
 * encounter that walks in at second three instead of at the end of the script, a fight that
 * spends its damage before it shows its tell, a run that arrives in chapter 2 with its guns and
 * its power-ups gone, a campaign that never runs out of chapters.
 *
 * Three things shape the tests below.
 *
 * - **Everything runs through `step()`, tick by tick, with the event ring cleared first.** The
 *   ordering facts live *between* ticks — a tell on one tick and the hit it warned about 27
 *   ticks later — so a run sampled once at the end cannot tell a real telegraph from a one-tick
 *   flash, and cannot say which tick a body appeared on.
 * - **The chapter's own data is the expectation.** `duration`, `bosses`, `props` and `size` are
 *   read back out of `content/levels.ts` rather than written down again here: one source of
 *   truth (AGENTS.md), so a chapter that changes its script changes its test.
 * - **Health is topped up while the script runs, and the room is sometimes emptied at the
 *   encounter.** This file is not about whether a pistol survives a chapter — that is a balance
 *   question with a bench for it — so the runs stay alive deliberately. Where the room is
 *   emptied it is written down: it is emptied so the *only* thing able to spend the player's HP
 *   between a snapshot and its comparison is the chapter load itself, which is the claim.
 */

/** The bodies of the chapter's encounter that are still standing. */
function bossBodies(w: World): number[] {
  const out: number[] = [];
  const enemies = w.enemies;
  for (let i = 0; i < enemies.cap; i++) {
    if (enemies.alive[i] === 0 || enemies.hp[i] <= 0) continue;
    if (ENEMIES[enemies.kind[i]].boss) out.push(i);
  }
  return out;
}

/**
 * Take the crowd and its XP out of the room, leaving only the encounter.
 *
 * Not a convenience: a chapter ends with a floor full of bodies and a carpet of shards, and
 * both go on spending the player (hugs, bolts, and shards drifting into the magnet) for the
 * whole intermission. A state comparison across the chapter boundary would then be measuring
 * that crowd rather than the load, and it would pass or fail by luck.
 */
function clearRoom(w: World): void {
  const enemies = w.enemies;
  for (let i = 0; i < enemies.cap; i++) {
    if (enemies.alive[i] !== 0 && !ENEMIES[enemies.kind[i]].boss) enemies.alive[i] = 0;
  }
  const shards = w.shards;
  for (let i = 0; i < shards.cap; i++) shards.alive[i] = 0;
}

/** One tick at a time: ring cleared, one `step`, then the read-back for that tick. */
function eachTick(
  w: World,
  ticks: number,
  fill: (f: InputFrame, t: number) => void,
  watch: (t: number) => void,
): void {
  const f = createInputFrame();
  for (let t = 1; t <= ticks; t++) {
    resetFrame(f);
    fill(f, t);
    clearEvents(w);
    step(w, f);
    watch(t);
  }
}

/** The first Telegraph event of shape `kind` naming a boss body, or -1. */
function bossTell(w: World, kind: number): number {
  const e = w.events;
  for (let k = 0; k < e.count; k++) {
    const s = (e.head - e.count + k + e.cap * 2) % e.cap;
    if (e.type[s] !== Ev.Telegraph || e.b[s] !== kind) continue;
    const who = e.a[s];
    if (who >= 0 && ENEMIES[w.enemies.kind[who]].boss) return s;
  }
  return -1;
}

/** Whatever the run has earned, read as one block comparable across a chapter load. */
interface RunState {
  hp: number;
  level: number;
  xp: number;
  slots: number[];
  tiers: number[];
  stats: StatBlock;
}

function takeRun(w: World): RunState {
  return {
    hp: w.player.hp,
    level: w.player.level,
    xp: w.player.xp,
    slots: w.slots.map((s) => s.weapon),
    tiers: Array.from(w.powerTiers),
    stats: { ...w.stats },
  };
}

describe('the chapter door', () => {
  it('opens at the end of the script, and not one tick before', () => {
    /**
     * Drive a chapter to its encounter and report *when* it came, tick by tick.
     *
     * `early` counts ticks in which a boss body existed while the script was still running, and
     * that count is the half of the claim which has to be provable: a chapter whose encounter
     * walks in on tick 40 while the drumbeat keeps firing looks, from out here, exactly like a
     * chapter that works.
     */
    const drive = (chapter: number) => {
      const w = createWorld(700 + chapter);
      w.autoFire = true;
      const level = levelAt(chapter);
      startChapter(w, chapter);

      let firstTick = -1;
      let early = 0;
      let phaseAtArrival = -1;
      let kinds: string[] = [];
      let barLength = 0;

      eachTick(w, Math.ceil(level.duration * 60) + 8, (f) => {
        f.fire = true;
        w.player.hp = 1_000_000;
      }, (t) => {
        const bodies = bossBodies(w);
        if (bodies.length > 0 && firstTick < 0) {
          firstTick = t;
          phaseAtArrival = w.wave.phase;
          kinds = bodies.map((i) => ENEMIES[w.enemies.kind[i]].id);
          barLength = w.boss.maxHp;
        }
        if (w.wave.phase === Phase.Script && bodies.length > 0) early++;
      });

      return {
        w,
        level,
        firstTick,
        early,
        phaseAtArrival,
        kinds,
        barLength,
        /** Ticks the chapter's own script had to burn before its door could open. */
        scriptTicks: Math.ceil(level.duration * 60),
      };
    };

    const first = drive(0); // Loading Bay: 78 s of script, ends on a broodmother
    const last = drive(9); // Kill Floor: 96 s, ends on all three encounters

    // The door is the script's end, not a timer that happens to land near it: chapter 1's
    // encounter walked in at 4682 and chapter 10's at 5762, and the gap between the two is the
    // 18 s their durations differ by. That is what makes it the script rather than a clock.
    expect(first.firstTick, 'chapter 1 never reached its encounter').toBeGreaterThan(0);
    expect(first.early, 'a boss body existed while chapter 1 was still scripting').toBe(0);
    expect(first.firstTick).toBeGreaterThanOrEqual(first.scriptTicks);
    expect(first.firstTick).toBeLessThanOrEqual(first.scriptTicks + 4);

    expect(last.firstTick, 'the last chapter never reached its encounter').toBeGreaterThan(0);
    expect(last.early, 'a boss body existed while the last chapter was still scripting').toBe(0);
    expect(last.firstTick).toBeGreaterThanOrEqual(last.scriptTicks);
    const drift = Math.abs(last.firstTick - first.firstTick - (last.scriptTicks - first.scriptTicks));
    expect(drift, 'the door moved off the chapter duration').toBeLessThanOrEqual(4);

    // And it came as the data says it would, once each, with the bar knowing what it weighs. A
    // chapter may end on more than one body; it may not end on the same body twice.
    //
    // Compared as a set rather than in order, and that is deliberate: `bossBodies` walks the
    // enemy pool, so the order it reports is the order the three happened to take slots in,
    // which depends on which slots the escort had already handed back. What the chapter declares
    // is *which* bodies it ends on and that none of them repeats, and both of those survive
    // here; what it never claimed was a seat order.
    expect([...first.kinds].sort()).toEqual([...first.level.bosses].sort());
    expect([...last.kinds].sort()).toEqual([...last.level.bosses].sort());
    expect(last.kinds).toHaveLength(3);
    expect(first.phaseAtArrival).toBe(Phase.Encounter);
    expect(last.phaseAtArrival).toBe(Phase.Encounter);
    expect(bossesAlive(first.w), 'the flag and the floor disagree').toBe(true);
    expect(first.barLength).toBeGreaterThan(0);
    expect(first.w.boss.skips, 'chapter 1 found no floor for its encounter').toBe(0);
    expect(last.w.boss.skips, 'the last chapter found no floor for its encounter').toBe(0);
  });

  it('puts the encounter on floor the player can see and shoot from', () => {
    const level = levelAt(2); // Slag Canal: cover, three hazards, an atlas
    const w = createWorld(712);
    startChapter(w, 2);

    let landed: { id: string; x: number; y: number; r: number }[] = [];
    let arrived = false;
    eachTick(w, Math.ceil(level.duration * 60) + 4, () => {
      w.player.hp = 1_000_000;
    }, () => {
      if (arrived) return;
      const bodies = bossBodies(w);
      if (bodies.length === 0) return;
      arrived = true;
      landed = bodies.map((i) => {
        const def = ENEMIES[w.enemies.kind[i]];
        return { id: def.id, x: w.enemies.x[i], y: w.enemies.y[i], r: def.radius };
      });
    });

    expect(arrived, 'the chapter never reached its encounter').toBe(true);
    expect(landed.map((p) => p.id)).toEqual([...level.bosses]);

    // Where an encounter lands is searched rather than assumed, and the search owes two
    // promises: nobody walks in standing inside cover, and the fight does not begin standing in
    // a pool. Both are asserted rather than trusted, because a chapter can be rewritten
    // underneath this file with nothing else noticing.
    for (const p of landed) {
      expect(blocked(w.props, p.x, p.y, p.x, p.y, p.r), `${p.id} landed inside cover`).toBe(false);
      expect(acidAt(w.zones, p.x, p.y), `${p.id} landed in a hazard`).toBe(0);
      expect(Math.hypot(p.x - w.player.x, p.y - w.player.y), `${p.id} landed on the player`)
        .toBeGreaterThan(4);
    }
  });

  it('tells you about the slam before it spends it', () => {
    const atlas = ENEMIES[ENEMIES.findIndex((d) => d.id === 'atlas')];
    const w = createWorld(713);
    startChapter(w, 2);

    let stage = 'script' as 'script' | 'fight';
    let tellTick = -1;
    let told = '';
    let hurtTick = -1;
    let lost = 0;
    let acidAtHit = false;

    /**
     * The chapter runs itself until the encounter lands; then the player walks to the ring.
     *
     * Standing inside the circle is the mistake the tell exists to warn about, and closing to it
     * is the only input that brings the fight to a body which arrived twenty-odd metres out. The
     * room is emptied as the encounter lands and the player is held at 3.2 m rather than walked
     * into the body: a hug spends HP through contact damage first (16 of it, and on i-frames
     * besides), after which the number taken says nothing about whether a ring was ever drawn.
     * At 3.2 m the only thing on the floor that can still reach the player is the slam.
     */
    const f = createInputFrame();
    for (let t = 1; t <= 6600 && hurtTick < 0; t++) {
      resetFrame(f);
      // Topped on every tick, not only the script's, so "hp below a million" below means
      // *spent this tick* rather than "spent some time since the encounter landed".
      w.player.hp = 1_000_000;
      if (stage === 'script') {
        f.fire = true;
        if (w.wave.phase !== Phase.Encounter) {
          clearEvents(w);
          step(w, f);
          continue;
        }
        clearRoom(w);
        clearEvents(w);
        step(w, f);
        stage = 'fight';
        continue;
      }

      const bodies = bossBodies(w);
      if (bodies.length > 0) {
        const dx = w.enemies.x[bodies[0]] - w.player.x;
        const dy = w.enemies.y[bodies[0]] - w.player.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > 3.2) {
          f.moveX = dx / d;
          f.moveY = dy / d;
        }
      }
      clearEvents(w);
      step(w, f);

      const slot = bossTell(w, Tele.Ring);
      if (slot >= 0 && tellTick < 0) {
        tellTick = t;
        told = ENEMIES[w.enemies.kind[w.events.a[slot]]].id;
      }
      if (tellTick > 0 && w.player.hp < 1_000_000) {
        hurtTick = t;
        lost = 1_000_000 - w.player.hp;
        acidAtHit = acidAt(w.zones, w.player.x, w.player.y) > 0;
      }
    }

    // DESIGN.md's bar for a telegraph is 400 ms of warning the player can answer, and the shape
    // on the floor is the shape of the damage. A tell that lands in the same tick as the hit is
    // decoration, so the two are timed against each other rather than both trusted.
    expect(tellTick, 'the encounter never told anybody about a slam').toBeGreaterThan(0);
    expect(told).toBe('atlas');
    expect(hurtTick, 'the player was hit without ever being told').toBeGreaterThan(0);
    expect(hurtTick - tellTick).toBeGreaterThanOrEqual(24);
    expect((hurtTick - tellTick) / 60).toBeGreaterThanOrEqual(0.4);

    // And what it spent was the slam, at full price: the ring's own number, paid by a player who
    // was not standing in a hazard at the time, so the cost cannot have come off the floor.
    expect(acidAtHit, 'the player was standing in acid, which also costs HP').toBe(false);
    expect(lost).toBe(atlas.params.blastDamage);
    expect(w.errors).toBe(0);
  });
});

describe('chapter flow', () => {
  it('ends when the encounter dies, and hands the run to the next floor intact', () => {
    const first = levelAt(0);
    const second = levelAt(1);
    const w = createWorld(714);
    w.autoFire = true;
    startChapter(w, 0);

    // Give the run something a careless chapter load could clobber: a second hand it did not
    // start with, a power-up at tier 2 folded into the stat block, and a level and a pile of XP
    // earned before this tick.
    const longbow = WEAPONS.findIndex((d) => d.id === 'longbow');
    expect(longbow, 'no longbow in the weapon table').toBeGreaterThan(0);
    const DAMAGE = 0; // POWERUPS[0] is the damage boost, and it moves `stats.dmg`

    let stage = 'run' as 'run' | 'quiet';
    let killedAt = -1;
    let completeAt = -1;
    let loadAt = -1;
    let before: RunState | null = null;
    let carried: RunState | null = null;

    /**
     * The run is driven hot until the encounter falls, then put on ice for the intermission.
     *
     * The cold gun (both the trigger and `autoFire`, which otherwise fires on its own at anything
     * inside 18 m) and the i-frames are the isolation, not a convenience, and both are needed. A
     * chapter's crushers keep firing at an empty room — measured on this seed, the floor spent 22
     * of the player's 47 HP between the encounter's death and the load, with no body on the floor
     * to blame — and a hero who lost HP to a crusher is not evidence about whether the chapter
     * load kept what it was given. Whether a chapter's hazards are aimed at the player is a
     * layout question with its own file; this one is about the handover, so the handover is the
     * only thing left able to move a number.
     */
    const f = createInputFrame();
    for (let t = 1; t <= 5600 && loadAt < 0; t++) {
      resetFrame(f);
      f.fire = stage === 'run';
      w.autoFire = stage === 'run';
      if (stage === 'run') {
        w.player.hp = 1_000_000;
        const bodies = bossBodies(w);
        if (bodies.length > 0) {
          clearRoom(w);
          w.player.hp = 47;
          w.player.level = 6;
          w.player.xp = 123;
          loadSlot(w.slots[1], longbow);
          w.powerTiers[DAMAGE] = 2;
          recomputeStats(w);
          expect(w.stats.dmg).toBeGreaterThan(1);
          stage = 'quiet';
          // The real death path rather than a slot switched off, so whatever the body leaves
          // behind (brood, burst) is paid out on this tick, before the snapshot below.
          for (const i of bodies) killEnemy(w, i);
          killedAt = t;
        }
      } else {
        // Held at eight seconds, which outlasts the four-second gap: a hit taken here would
        // otherwise be counted as damage the chapter load did.
        w.player.iframes = 8;
      }

      clearEvents(w);
      step(w, f);

      if (stage === 'quiet') {
        if (before === null) {
          before = takeRun(w);
          completeAt = t;
          expect(w.chapterComplete, 'the chapter did not end with its encounter').toBe(true);
          expect(w.wave.phase).toBe(Phase.Intermission);
          expect(bossesAlive(w), 'the encounter is still on the floor').toBe(false);
        }
        if (w.chapter !== 0) {
          loadAt = t;
          carried = takeRun(w);
        }
      }
    }

    expect(killedAt, 'chapter 1 never put its encounter down').toBeGreaterThan(0);
    expect(completeAt).toBe(killedAt);
    expect(loadAt, 'the next chapter never loaded').toBeGreaterThan(0);
    // Four seconds of quiet between rooms, long enough to reload and to walk somewhere better
    // rather than to arrive straight back into a crowd.
    expect(loadAt - completeAt).toBeGreaterThanOrEqual(4 * 60);

    // A different room: the next chapter's cover, its hazards, its box, and its own clock back
    // at the top of its own recipe rather than carrying chapter 1's drumbeat over.
    expect(w.chapter).toBe(1);
    expect(w.wave.phase).toBe(Phase.Script);
    expect(w.wave.running).toBe(true);
    expect(w.wave.index).toBe(1);
    expect(w.wave.elapsed).toBeLessThan(1);
    expect(w.props.n).toBe(second.props.length);
    expect(w.props.n).not.toBe(first.props.length);
    expect(w.zones.n).toBe(second.hazards.length);
    expect(w.maxX).toBe(second.size);
    expect(w.maxX).not.toBe(first.size);
    expect(w.chapterComplete, 'the flag outlived the chapter it described').toBe(false);
    expect(w.victory, 'a chapter in the middle of the run is not the end of it').toBe(false);

    // The player is inside the new room and on clear floor, not sealed inside its cover.
    expect(Math.abs(w.player.x) < w.maxX && Math.abs(w.player.y) < w.maxY).toBe(true);
    expect(
      blocked(w.props, w.player.x, w.player.y, w.player.x, w.player.y, TUNE.playerRadius),
      'the run arrived inside the next chapter wall',
    ).toBe(false);

    // And the run itself came across unchanged: HP, level, XP, both hands, the power-up and the
    // stat block folded from it. Nothing between the two reads could have spent any of it except
    // the chapter load, which is why the room was emptied first.
    expect(carried).not.toBeNull();
    expect(carried!).toEqual(before!);
    expect(carried!.level).toBe(6);
    expect(carried!.hp).toBe(47);
    expect(carried!.slots[1]).toBe(longbow);
    expect(carried!.tiers[DAMAGE]).toBe(2);
    expect(w.errors).toBe(0);
  });
});

describe('the end of the run', () => {
  it('clears the last chapter into victory, and stops simulating', () => {
    const last = LEVELS.length - 1;
    const level = levelAt(last);
    const w = createWorld(715);
    w.autoFire = true;
    expect(level.bosses).toHaveLength(3);
    startChapter(w, last);

    let stage = 'watch' as 'watch' | 'one down' | 'all down';
    let halfAt = -1;
    let killAt = -1;
    let completeAt = -1;
    let victoryAt = -1;
    let twoUp = 0;

    /**
     * Three acts, because a chapter is allowed to end on three bodies.
     *
     * Act one waits for all three to be on the floor and kills one of them; act two spends a
     * second of the fight with two of them still standing; act three is the rest of them and the
     * four seconds that carry the run out of the campaign. Act two exists because a fight made
     * of three bodies cannot be lost to a player who has killed two, or the whole ending of the
     * campaign would hang on whichever body happened to fall first — so every tick with any of
     * the three still standing is asserted to be a tick the chapter has not ended on.
     */
    const f = createInputFrame();
    for (let t = 1; t <= 6600 && victoryAt < 0; t++) {
      resetFrame(f);
      f.fire = true;
      w.player.hp = 1_000_000;

      const bodies = bossBodies(w);
      if (stage === 'watch' && bodies.length === 3) {
        killEnemy(w, bodies[0]);
        halfAt = t;
        stage = 'one down';
      } else if (stage === 'one down' && t > halfAt + 60) {
        // A second of trading shots, then whatever is left of the encounter goes at once. If the
        // player's own gun already spent the other two, the arc is let run on its own.
        for (const i of bodies) killEnemy(w, i);
        killAt = t;
        stage = 'all down';
      }

      clearEvents(w);
      step(w, f);

      const left = bossBodies(w).length;
      if (stage !== 'watch') {
        if (left === 2) twoUp++;
        if (left > 0) {
          expect(w.chapterComplete, 'the chapter ended with part of its encounter alive').toBe(false);
          expect(bossesAlive(w), 'the bar and the floor disagree about the encounter').toBe(true);
        }
      }
      if (stage === 'all down' && completeAt < 0 && w.chapterComplete) completeAt = t;
      if (w.victory) victoryAt = t;
    }

    expect(halfAt, 'the last chapter never put all three encounters down').toBeGreaterThan(0);
    expect(twoUp, 'no tick of the fight was ever spent with two of the three still up').toBeGreaterThan(0);
    expect(killAt, 'the chapter never finished the encounter').toBeGreaterThan(halfAt);
    expect(completeAt, 'the chapter never ended once all three were dead').toBeGreaterThan(0);
    expect(victoryAt, 'clearing the last chapter never won the run').toBeGreaterThan(0);

    // Victory is an ending rather than a loop: the drumbeat is off for good, the chapter index
    // stays where the campaign ran out, and the flag that carried the run here is cleared with
    // it, so nothing keeps asserting a chapter that has finished.
    expect(w.victory).toBe(true);
    expect(w.wave.phase).toBe(Phase.Cleared);
    expect(w.wave.running).toBe(false);
    expect(w.chapter).toBe(last);
    expect(w.chapterComplete).toBe(false);
    expect(bossesAlive(w), 'the encounter is still counted after the run was won').toBe(false);
    expect(w.errors).toBe(0);
  });
});