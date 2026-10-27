import { describe, expect, it } from 'vitest';
import { ENEMIES, enemyIndex } from '../../src/content/enemies';
import { LEVELS, type LevelDef } from '../../src/content/levels';
import { FACTION_PACKS } from '../../src/content/levels/factions';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { Phase } from '../../src/sim/systems/enemies/shared';
import { startChapter } from '../../src/sim/systems/levels';
import { createWorld, type World } from '../../src/sim/world';

/**
 * Chapters 4 to 10, checked as data that has to survive contact with the room carrying it.
 *
 * The other three files that read a chapter check different things: `waves.test.ts` that every
 * scripted pack finds a landing point, `obstacles.test.ts` that a floor fits its own arena and
 * seals nobody in, `levels-split.test.ts` that a chapter replays the same twice. None of them
 * asks what this file exists to ask, which is whether a chapter's script and its floor agree:
 *
 * - **A shared pack is one family.** `factions.ts` composes the kits out of the roster's four
 *   factions and the renderer draws a faction in one colour, so a single-family pack arrives as
 *   one readable shape. A kit that quietly mixed families would still run and would arrive as
 *   confetti, so each part's family is read back off `content/enemies.ts` rather than taken from
 *   the kit's own declaration.
 * - **A body that cannot do its thing is not sent.** The five bodies written after chapter 3 all
 *   gate on the floor: the sniper and the orbiter spend a bolt down a painted line, the
 *   teleporter crosses eight metres of it in a tick, the burrower runs five metres of it under
 *   the floor, and the spawner's damage arrives as young that need room to land. A room of long
 *   walls can switch all four off without any of the three files above noticing, because none of
 *   them looks at what the bodies *do*.
 *
 * That is not hypothetical. The Long Room used to send a trench pack: over a full play-through
 * its burrowers spent four thousand ticks within digging range with their dig timer paid for, and
 * went under the floor zero times — every one of those ticks had a wall in the line. The chapter
 * now sends marks down its aisles instead, and the block that caught it is the second one below.
 * The last two pin the ramp across all ten chapters and the roster across the last four, each
 * with its own control, since a check that cannot fail is not one.
 */

/** The bodies written after the campaign's first three chapters were authored. */
const LATE = ['sniper', 'orbiter', 'teleporter', 'spawner', 'burrower'];

/** Chapters 4 to 10, the ones this file is about. */
const SECOND_HALF = [3, 4, 5, 6, 7, 8, 9];

interface Run {
  /** Every archetype that stood on the floor at some point during the run. */
  onFloor: Set<string>;
  /** Every `id p<phase>` pair seen, which is how a behaviour's existence is read. */
  worked: Set<string>;
  world: World;
}

/**
 * Play one chapter for its own length with the driver `levels-split.test.ts` uses: trigger held,
 * hero walks a square, dashes every ninety-seventh tick, HP topped up so the fixture is about the
 * chapter and not about the player dying.
 *
 * The run is a chapter long rather than a script long because a pack that lands at 1:14 of a
 * 1:28 floor still needs ten seconds to walk into its behaviour. The census runs every tick
 * rather than at the end: a teleporter's crossing is twelve ticks long, and a body that did its
 * thing at second forty and died at forty-one is the entire content of a beat.
 */
function playChapter(chapter: number, ticks: number): Run {
  const w = createWorld(0x2000 + chapter, { arenaHalf: 40 });
  w.autoFire = true;
  startChapter(w, chapter);

  const onFloor = new Set<string>();
  const worked = new Set<string>();
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

    const en = w.enemies;
    for (let i = 0; i < en.cap; i++) {
      if (en.alive[i] === 0) continue;
      const id = ENEMIES[en.kind[i]].id;
      onFloor.add(id);
      worked.add(`${id} p${en.phase[i]}`);
    }
  }
  return { onFloor, worked, world: w };
}

/**
 * Per body, the one observation that says the archetype happened rather than arrived.
 *
 * A sniper or an orbiter in `Windup` has a clear sight line and is inside the band it commits
 * inside — both refuse to spend a bolt over cover or at their own feet. A teleporter in `Dash` is
 * crossing its painted strip, which it only paints over eight metres of clear floor. A burrower
 * in `Burrowed` has passed its `canTravel` test on the whole trench. The spawner has no phase to
 * give away: everything it does is another body, and a spawnling on the floor came out of
 * exactly one kind of body, so its proof is a different kind and is read off the floor census.
 */
const PROVES: Record<string, (run: Run) => boolean> = {
  sniper: (r) => r.worked.has(`sniper p${Phase.Windup}`),
  orbiter: (r) => r.worked.has(`orbiter p${Phase.Windup}`),
  teleporter: (r) => r.worked.has(`teleporter p${Phase.Dash}`),
  burrower: (r) => r.worked.has(`burrower p${Phase.Burrowed}`),
  spawner: (r) => r.onFloor.has('spawnling'),
};

/** Everything a chapter can put on the floor: its drumbeat, its script, and the young of both. */
function covers(level: LevelDef): Set<string> {
  const named = new Set<string>();
  for (const row of level.packs) for (const id of row) named.add(id);
  for (const beat of level.waves) for (const [id] of beat.pack) named.add(id);
  for (const id of level.bosses) named.add(id);

  // Offspring are never named by a recipe or a script — they come out of their parent through
  // `spawnEnemy` — so a chapter covers one by sending the body that carries it.
  const seen = new Set(named);
  for (const def of ENEMIES) {
    const young = def.splits?.def ?? def.brood?.def;
    if (young !== undefined && named.has(def.id)) seen.add(young);
  }
  return seen;
}

describe('faction-composed packs', () => {
  it('composes every kit out of bodies the drumbeat is allowed to carry', () => {
    for (const pack of Object.values(FACTION_PACKS)) {
      for (const [id, count] of pack.parts) {
        const def = ENEMIES[enemyIndex(id)];
        expect(def, `${pack.id} names ${id}, which the roster does not own`).toBeDefined();
        expect(count).toBeGreaterThan(0);

        // Two things a pack may never send: an encounter body, which is met once at the end of a
        // chapter rather than twenty times in a pack, and a body that only ever arrives as
        // someone's young. A kit naming either would put it on the floor twice, once as a recipe
        // entry and once out of the parent that carries it.
        expect(def!.boss === true, `${pack.id} carries ${id}, an encounter body`).toBe(false);
        expect(['splinter', 'spawnling'], `${pack.id} sends ${id} directly`).not.toContain(id);
      }
    }

    // Control: the roster really does own the five bodies that check refuses, so the loop above
    // is not walking an empty set.
    expect(
      ENEMIES.filter((def) => def.boss === true || def.id === 'splinter' || def.id === 'spawnling').length,
    ).toBe(5);
  });
});

describe('the second half uses the bodies that came after chapter 3', () => {
  for (const index of SECOND_HALF) {
    const level = LEVELS[index]!;

    it(`plays '${level.name}' as written`, () => {
      const scripted = new Set(level.waves.flatMap((beat) => beat.pack.map(([id]) => id)));
      const sent = LATE.filter((id) => scripted.has(id));

      // The chapter's argument for existing: at least one of the five, in its script and in its
      // drumbeat. A chapter that only scripts one gets it for nine seconds of a ninety-second
      // floor, which is a cameo rather than a mix.
      expect(sent, `${level.id} scripts none of the late bodies`).not.toHaveLength(0);
      expect(level.packs.flat().filter((id) => LATE.includes(id)), `${level.id} drumbeats none of them`).not.toHaveLength(0);

      const run = playChapter(index, Math.round(level.duration * 60));
      expect(run.world.chapter, `${level.id} changed floor before its script was spent`).toBe(index);

      for (const id of sent) {
        expect(run.onFloor.has(id), `${level.id}: ${id} never reached the floor`).toBe(true);
        expect(PROVES[id]!(run), `${level.id}: ${id} arrived and never worked in this room`).toBe(true);
      }
    });
  }
});

describe('the ramp', () => {
  /** Where a difficulty table stops getting harder, as chapter indexes. */
  function breaks(pairs: readonly { spawnRate: number; hp: number }[]): number[] {
    const bad: number[] = [];
    for (let i = 1; i < pairs.length; i++) {
      const before = pairs[i - 1]!;
      const here = pairs[i]!;
      const harder =
        here.spawnRate > before.spawnRate &&
        here.hp > before.hp &&
        here.spawnRate * here.hp > before.spawnRate * before.hp;
      if (!harder) bad.push(i);
    }
    return bad;
  }

  it('raises both dials at every one of the nine steps', () => {
    expect(breaks(LEVELS.map((level) => level.difficulty))).toEqual([]);
  });

  it('has a ramp check that fails on a flat campaign', () => {
    // The control for the test above: chapter 3 here repeats chapter 2's dials, and a campaign
    // that stops getting harder has to be caught by the same call.
    expect(
      breaks([
        { spawnRate: 1, hp: 1 },
        { spawnRate: 1.1, hp: 1.08 },
        { spawnRate: 1.1, hp: 1.08 },
      ]),
    ).toEqual([2]);
  });
});

describe('the last four chapters', () => {
  it('cover every body the roster owns between them', () => {
    const last = [6, 7, 8, 9];
    const together = new Set<string>();
    for (const index of last) for (const id of covers(LEVELS[index]!)) together.add(id);

    const missing = ENEMIES.map((def) => def.id).filter((id) => !together.has(id));
    expect(missing, 'never sent by chapters 7 to 10').toEqual([]);

    // And no late body lives in only one room: each of the five appears in at least two of the
    // four chapters, so the union above is a campaign rather than one chapter carrying a body
    // nobody else has to answer. (The Kill Floor does cover all nineteen on its own — that is
    // its stated design — so the check is written the other way round.)
    for (const id of LATE) {
      const rooms = last.filter((index) => {
        const level = LEVELS[index]!;
        return (
          level.packs.some((row) => row.includes(id)) ||
          level.waves.some((beat) => beat.pack.some(([name]) => name === id))
        );
      });
      expect(rooms.length, `${id} is only sent by ${rooms.length} of the last four chapters`).toBeGreaterThanOrEqual(2);
    }
  });
});
