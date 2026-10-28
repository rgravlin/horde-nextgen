import { describe, expect, it } from 'vitest';
import {
  ELITES,
  ELITE_BY_ID,
  LEVELS,
  LEVEL_ELITES,
  eliteIndex,
  eliteRosterAt,
  levelAt,
  type PropDef,
} from '../../src/content/levels';
import { LEVELS_1_3 } from '../../src/content/levels/chapters-1-3';
import { LEVELS_4_6 } from '../../src/content/levels/chapters-4-6';
import { LEVELS_7_10 } from '../../src/content/levels/chapters-7-10';
import { PACKS, enemyIndex } from '../../src/content/enemies';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { hashWorld } from '../../src/sim/hash';
import { PropKind, installLayout } from '../../src/sim/systems/obstacles';
import { startChapter } from '../../src/sim/systems/levels';
import { EDGE_IDS } from '../../src/sim/systems/waves';
import { countAlive, createWorld, type World } from '../../src/sim/world';

/**
 * The chapter table after it moved out of one 929-line file into `src/content/levels/`.
 *
 * The brief for the move was "no behaviour change", so this file does not re-pin what
 * `levels.test.ts` (the chapter door and the run's end), `waves.test.ts` (scripts, variants and
 * the difficulty ramp) and `obstacles.test.ts` (cover, hazards and the thin-box refusal)
 * already pin. It checks the three things a folder of data modules can break that one file
 * could not:
 *
 * - **the wiring.** `index.ts` still has to hand out every name the sim, the renderer, the
 *   menus and four test files import, and the joined table still has to be the campaign *in
 *   play order* — a chapter dropped at the join or a range pasted in the wrong order compiles
 *   and ships a campaign that skips a floor.
 * - **the shared kit.** One elite table, one tint per chapter family, one set of floor
 *   shorthands, one recipe import for chapter 1. A tint or a shorthand copied into each chapter
 *   file compiles, reads plausibly, and drifts the first time somebody edits one of the copies,
 *   so what is asserted here is *identity* rather than equality: four chapters in the docks
 *   family read one object, and chapter 1's drumbeat is the array `content/enemies.ts` exports.
 * - **whole chapters.** Ten fixtures, one per chapter, fingerprinted with `hashWorld` after
 *   1,800 ticks and compared with the numbers the single file produced. A prop that did not
 *   survive the move, a pack timed a second out or a dial edited in the transfer all change a
 *   fingerprint, and the last test checks the fingerprint moves when the floor does — a pin
 *   that cannot fail is not a check.
 *
 * The pinned numbers were taken from `src/content/levels.ts` before it was split, by running
 * these fixtures against it, and they are exact on purpose. A failure here means a chapter
 * moved rather than that a tolerance needs widening: run the fixture against the code from
 * before your change and see which.
 */

/** 30 s of a chapter's own clock: deep enough to be inside the drumbeat, not at its top. */
const TICKS = 1_800;

/**
 * Play one chapter and fingerprint what it did.
 *
 * The trigger is held, the hero walks a square and dashes every ninety-seventh tick, and HP is
 * refilled on every tick: the fixture is about whether the chapter put its bodies down where it
 * said it would, and a run that died at second nine would only report that it died. All ten
 * fixtures reach wave 3 by the end, which is where a chapter's fill and its script are both
 * still landing bodies.
 *
 * `props` re-installs the cover before the clock starts, in the order `startChapter` uses
 * (floor first, then what stands in it, then the clock), and is only ever used to take cover
 * *out* — that is the control that says the pinned fingerprints are sensitive to the layout.
 */
function playChapter(
  chapter: number,
  ticks = TICKS,
  opts: { props?: readonly PropDef[] } = {},
): { hash: number; alive: number; kills: number; errors: number; dropped: number } {
  const w: World = createWorld(0x2000 + chapter, { arenaHalf: 40 });
  w.autoFire = true;
  startChapter(w, chapter);
  if (opts.props !== undefined) installLayout(w, opts.props);

  const f = createInputFrame();
  for (let t = 1; t <= ticks; t++) {
    resetFrame(f);
    f.fire = true;
    const leg = Math.floor(t / 90) % 4;
    f.moveX = leg === 0 ? 1 : leg === 1 ? -1 : leg === 2 ? -1 : 1;
    f.moveY = leg === 0 ? 1 : leg === 1 ? 1 : leg === 2 ? -1 : -1;
    if (t % 97 === 0) f.dash = true;
    w.player.hp = 1_000_000;
    step(w, f);
  }

  return {
    hash: hashWorld(w),
    alive: countAlive(w.enemies),
    kills: w.kills,
    errors: w.errors,
    dropped: w.props.dropped,
  };
}

/** One line per chapter: what it is called and what a run of it did. */
function fingerprintChapters(): string[] {
  return LEVELS.map((level) => {
    const run = playChapter(LEVELS.indexOf(level));
    return `${level.id} ${run.hash} ${run.alive} ${run.kills}`;
  });
}

describe('what the folder hands out', () => {
  it('still hands out every name the rest of the campaign comes through', () => {
    // The import above names the directory, and it resolves only because `levels/index.ts`
    // answers it. What the callers ask for, read straight off their import lines:
    // `systems/{waves,boss,levels,powerups}.ts` want `levelAt` (plus `ELITES`, `eliteIndex`,
    // `LevelDef`/`BeatDef`), `systems/enemies/{spawn,shared}.ts` want `ELITES`/`EliteDef`,
    // `game/{app,persistence}.ts` and `ui/menus.ts` want `LEVELS`, and the renderer and the
    // unit tests want `levelAt` and `eliteRosterAt`.
    expect(Array.isArray(LEVELS)).toBe(true);
    expect(Array.isArray(LEVEL_ELITES)).toBe(true);
    expect(Array.isArray(ELITES)).toBe(true);
    expect(typeof levelAt).toBe('function');
    expect(typeof eliteRosterAt).toBe('function');
    expect(typeof eliteIndex).toBe('function');

    // The two lookups that need the whole campaign at once still see all ten chapters: the
    // roster table is built by mapping over the joined `LEVELS`, so a chapter that went missing
    // at the join would shorten it before anything else noticed.
    expect(LEVEL_ELITES.length).toBe(LEVELS.length);
    expect(LEVELS.length).toBe(10);
    expect(LEVELS.every((l) => l.props.length > 0 && l.waves.length > 0)).toBe(true);
  });

  it('joins the three chapter files in play order', () => {
    // Pinned rather than rebuilt from the chapter files: rebuilding it from
    // `[...LEVELS_1_3, ...LEVELS_4_6, ...LEVELS_7_10]` would pass however `index.ts` chose to
    // order or drop them, which is the one thing a three-file split can get wrong silently.
    expect(LEVELS.map((l) => l.id)).toEqual([
      'loading-bay',
      'conveyor-yard',
      'slag-canal',
      'coolant-deck',
      'reactor-rim',
      'thread-floor',
      'cinder-vault',
      'long-room',
      'dry-dock',
      'kill-floor',
    ]);

    // Three files, and each one holds the range its name says, so a chapter added to the wrong
    // page is a failure rather than a campaign that plays 1, 2, 3, 8, 4, ...
    expect(LEVELS_1_3.map((l) => l.id)).toEqual(['loading-bay', 'conveyor-yard', 'slag-canal']);
    expect(LEVELS_4_6.map((l) => l.id)).toEqual(['coolant-deck', 'reactor-rim', 'thread-floor']);
    expect(LEVELS_7_10.map((l) => l.id)).toEqual(['cinder-vault', 'long-room', 'dry-dock', 'kill-floor']);
    expect(LEVELS_1_3.length + LEVELS_4_6.length + LEVELS_7_10.length).toBe(LEVELS.length);

    // And the join shares the objects rather than copying them: `levelAt` hands back the row the
    // chapter file wrote, which is what lets `levels.test.ts` read a chapter's own data as its
    // own expectation.
    expect(LEVELS.map((l) => l.name)).toEqual([
      'Loading Bay',
      'Conveyor Yard',
      'Slag Canal',
      'Coolant Deck',
      'Reactor Rim',
      'Thread Floor',
      'Cinder Vault',
      'The Long Room',
      'Dry Dock',
      'Kill Floor',
    ]);
  });

  it('clamps both lookups, so a long run never falls off the end', () => {
    // `boss.ts` and `powerups.ts` call these with whatever `w.chapter` holds and a run that wins
    // keeps asking for chapter eleven.
    expect(levelAt(-1)).toBe(levelAt(0));
    expect(levelAt(99)).toBe(levelAt(9));
    expect(levelAt(4)).toBe(LEVELS[4]);
    expect(eliteRosterAt(-1)).toEqual(eliteRosterAt(0));
    expect(eliteRosterAt(99)).toEqual(eliteRosterAt(9));
    expect(eliteRosterAt(9)).toEqual([0, 1, 2]);
  });
});

describe('one kit, not three copies', () => {
  it('imports chapter 1 drumbeat recipe instead of copying it', () => {
    // The recipes Loading Bay uses are the ones `content/enemies.ts` shipped with and the
    // browser scenarios assert against, so the chapter file imports them (AGENTS.md: one source
    // of truth). A copy pasted in here would keep the scenarios green while the two drifted.
    expect(levelAt(0).packs).toBe(PACKS);
  });

  it('tints a chapter family from one object, shared by reference', () => {
    const docks = levelAt(0).palette;
    const foundry = levelAt(1).palette;
    const reactor = levelAt(4).palette;

    // Three tints for ten chapters, each one read by four, three and three chapters. The
    // sharing is the claim: `obstacles.test.ts` already counts the distinct fog strings, and
    // three chapters that each carried their own copy of the same string would pass that.
    for (const i of [3, 5, 8]) expect(levelAt(i).palette).toBe(docks);
    for (const i of [2, 6]) expect(levelAt(i).palette).toBe(foundry);
    for (const i of [7, 9]) expect(levelAt(i).palette).toBe(reactor);
    expect(new Set(LEVELS.map((l) => l.palette)).size).toBe(3);
  });

  it('builds every floor out of the shorthands rather than hand-typed shapes', () => {
    // `pillar` carries its radius next to its diameter because the box around a column is not
    // the column, and `crusher` gives its tell a default above the 0.4 s DESIGN.md asks for.
    // Both are rules about every chapter, which is why they live in `builders.ts` — so they are
    // read back off the ten floors that used them.
    for (const level of LEVELS) {
      for (const p of level.props) {
        if (p.kind !== PropKind.Pillar) continue;
        expect(p.r, `${level.id} authored a pillar that carries no radius`).toBeGreaterThan(0);
        expect(p.w, `${level.id}: a pillar's diameter has to agree with its radius`).toBe(p.r! * 2);
        expect(p.h).toBe(p.r! * 2);
      }
      for (const h of level.hazards) {
        if (h.warn === undefined) continue;
        expect(h.warn, `${level.id} gave a crusher a tell a player cannot read`).toBeGreaterThanOrEqual(0.4);
      }
    }
  });

  it('keeps every script inside the chapter that wrote it', () => {
    // Three things a chapter's script can get wrong while still looking like a script: a beat
    // timed past its own `duration`, which can never land; an edge that is not one of the nine
    // `EDGE_IDS`, which leaves the spawner with no side to spread a pack along; and an
    // archetype the roster does not own, which the spawner would quietly turn into something
    // else. None of the three is legal data, and none of them is visible in a diff.
    for (const level of LEVELS) {
      for (const b of level.waves) {
        expect(b.t, `${level.id} scripted a beat at ${b.t} s, past its ${level.duration} s`).toBeLessThan(level.duration);
        expect(EDGE_IDS, `${level.id} scripted an edge called ${b.edge}`).toContain(b.edge);
        for (const [id, count] of b.pack) {
          expect(enemyIndex(id), `${level.id} scripts ${id}, which the roster does not own`).toBeGreaterThanOrEqual(0);
          expect(count).toBeGreaterThan(0);
        }
      }
    }
  });

  it('rolls variants out of the one elite table', () => {
    // The roster a chapter declares by name is resolved against `elites.ts` once, here, and a
    // name that resolves to nothing is dropped. That is only worth having while there is one
    // table: three copies, one per chapter file, and the same variant means three numbers.
    expect(Object.keys(ELITE_BY_ID).sort()).toEqual([...ELITES.map((e) => e.id)].sort());
    for (const [i, elite] of ELITES.entries()) {
      expect(ELITE_BY_ID[elite.id]).toBe(i);
      expect(eliteIndex(elite.id)).toBe(i);
    }
    expect(eliteIndex('bulwark')).toBe(0);
    expect(eliteIndex('no such variant')).toBe(-1);

    for (const level of LEVELS) {
      const want = [...new Set(level.elites.map(eliteIndex))];
      expect(want, `${level.id} names a variant the elite table does not own`).not.toContain(-1);
      expect(eliteRosterAt(LEVELS.indexOf(level))).toEqual(want);

      // And a pack that arrives wearing a variant wears one this chapter also rolls: a variant
      // the script sends but the chapter does not roll is a thing a player meets exactly once,
      // at a second, and cannot learn from.
      for (const b of level.waves) {
        if (b.elite === undefined) continue;
        expect(level.elites, `${level.id} sends ${b.elite} without rolling it`).toContain(b.elite);
      }
    }
  });
});

describe('the frozen chapters', () => {
  /**
   * One line per chapter: `id`, its `hashWorld` fingerprint, the bodies left on the floor and
   * the kills it cost, all after 1,800 ticks.
   *
   * `hashWorld` covers positions, velocities, HP, phase and timer slots, the elite variants,
   * both projectile pools, the rng state and the free lists, so one line says the whole chapter
   * put the same bodies on the same floor and charged the same price for standing in the same
   * pools. The count and the kill total ride along because a number alone is hard to read: if
   * this fails, the two numbers say whether the chapter lost bodies or merely rearranged them.
   *
   * `loading-bay` was re-taken when the chapter gained a declared supply crate, which is a fact
   * about the floor and therefore belongs in the fingerprint: `hashWorld` folds the crate pool,
   * the same way it folds the hazard pools. Its two counts are unchanged — the fixture walks a
   * square and never detours for a crate, so the crate sat unopened and only its position moved
   * the number. `tests/unit/droneChest.test.ts` is the file that walks it.
   */
  const FROZEN = [
    'loading-bay 3551655721 34 22',
    'conveyor-yard 2382950176 33 44',
    'slag-canal 3057312166 57 20',
    // Chapters four to ten below were rewritten after the seven above were taken: each now
    // ships its own archetype packs and its own hazards, so these seven lines are the new
    // floors, re-taken from the sim rather than kept because they were written first. The
    // control test at the bottom still fails if a fingerprint stops moving with the floor.
    'coolant-deck 1792346936 73 78',
    'reactor-rim 673783569 53 80',
    'thread-floor 3583792853 72 50',
    'cinder-vault 1941808262 67 7',
    'long-room 2714332097 59 20',
    'dry-dock 4123668115 61 53',
    'kill-floor 2155952435 66 51',
  ];

  it('plays every chapter exactly as the single file did', () => {
    expect(fingerprintChapters()).toEqual(FROZEN);
  });

  it('runs every chapter without a single error or a refused prop', () => {
    // A cover box under 1.2 m is refused when the floor loads, and a chapter that lost its
    // hazards in the move would say so here rather than in the fingerprint alone. `errors`
    // counts caught errors, so a nonzero one is a real fault, not a swallow.
    for (const level of LEVELS) {
      const run = playChapter(LEVELS.indexOf(level));
      expect(run.errors, `${level.id} threw while it ran`).toBe(0);
      expect(run.dropped, `${level.id} authored cover too thin to install`).toBe(0);
    }
  });

  it('is a fingerprint that moves when the floor under it moves', () => {
    // The control for the two tests above: a pin that cannot fail is not a check, and a fixture
    // that ignores what a chapter declares would pass a split, a bad merge and a redesign alike.
    const first = playChapter(9);
    const again = playChapter(9);
    expect(again.hash, 'the same chapter on the same seed is not reproducible').toBe(first.hash);

    // The same thirty seconds with the Kill Floor's cross of walls taken out — the two 34 m
    // boxes are the only cover in the room, and the chapter's own comment says it is playable at
    // its spawn rate because of them.
    const stripped = playChapter(9, TICKS, { props: levelAt(9).props.filter((p) => p.w !== 34 && p.h !== 34) });
    expect(stripped.hash, 'the fixture does not read the cover it was given').not.toBe(first.hash);

    // And its neighbour, same seed and same input: two chapters that fingerprint the same way
    // would mean the fixture ran the arena rather than the chapter.
    const neighbour = playChapter(8);
    expect(neighbour.hash).not.toBe(first.hash);
  });
});