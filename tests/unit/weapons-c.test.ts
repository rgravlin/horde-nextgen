/**
 * Weapons part 3: the eight hands the roster was short of, and the one flight rule they
 * needed in the simulation to be honest about.
 *
 * The brief this file exists for is "at least ~15 weapons, each with a distinct feel and
 * a genuine use-case", so the tests are written against the *use-case* half of that
 * sentence: a table can always be made longer by adding numbers, and a longer table
 * proves nothing about whether the player has choices. What is pinned here is that each
 * hand's numbers mean something the simulation enforces.
 *
 * - the range test walks every weapon up to the distance its own `range` claims, at the
 *   worst aim it can be given (one frozen body, so nothing walks a shot closer), and
 *   fails if a delivery cannot cover the distance its data says it covers;
 * - the railgun, pike and axe tests count *bodies* rather than damage, because a
 *   pass-through budget and an arc width are only real if something outside them
 *   survives;
 * - the SMG test listens for silence, which is the only way to tell a magazine that runs
 *   out from a number that is merely large;
 * - the two hunt tests are paired with the singularity gun, the one hand that throws the
 *   same kind of orb without steering it, so a curve has to be the reason a crowd died
 *   rather than the aim having been lucky;
 * - the last block puts three hands on one crowd and one plate, because "the SMG is the
 *   crowd gun" is only a use-case if something else is better at the plate.
 *
 * Geometry freezes its bodies with `stand`, which leans on the stagger state: a
 * staggering body rides the shove it was given instead of steering, and a freshly placed
 * body has no shove, so it stays exactly where the test put it. The discs keep the hp the
 * archetype table gives them — those compare hands against each other and want the crowd
 * a chapter actually ships — while the mechanism tests set hp, so that a body left over
 * means "the shot missed" rather than "the shot was too weak to matter".
 */

import { describe, expect, it } from 'vitest';
import { enemyIndex } from '../../src/content/enemies';
import { WEAPONS, type WeaponDef } from '../../src/content/weapons';
import { createInputFrame, resetFrame, type InputFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { hashWorld } from '../../src/sim/hash';
import {
  Ev,
  clearEvents,
  countAlive,
  countEvents,
  createWorld,
  loadSlot,
  type World,
} from '../../src/sim/world';

/**
 * Ticks a hand gets to end a body standing at the range it claims.
 *
 * Ten seconds, generous on purpose: the slowest hand in the table takes 218 ticks (the
 * shotgun, whose cone has opened past 4 m by then exactly as its own falloff says it
 * will), so a failure here is a delivery that stopped working rather than a balance
 * tweak. Read the other way, that is the contract: a weapon that cannot kill at the
 * range it prints is a weapon whose numbers lie.
 */
const RANGE_BUDGET = 600;

/** Hand the first slot `id`'s weapon, loaded, so the test is about the gun. */
function arm(w: World, id: string): WeaponDef {
  const index = WEAPONS.findIndex((d) => d.id === id);
  expect(index, `the table should hold a '${id}'`).toBeGreaterThanOrEqual(0);
  loadSlot(w.slots[0], index);
  return WEAPONS[index];
}

/** Put archetype `id` down at (x, y) with `hp` health. */
function place(w: World, id: string, x: number, y: number, hp = 20): number {
  const i = spawnEnemy(w, enemyIndex(id), x, y);
  w.enemies.hp[i] = hp;
  return i;
}

/** Hold every body in place for the rest of the test. */
function stand(w: World): void {
  for (let i = 0; i < w.enemies.cap; i++) {
    if (w.enemies.alive[i] === 1) w.enemies.state[i] = 4096;
  }
}

/** Run ticks with one reused frame. */
function run(w: World, ticks: number, fill?: (f: InputFrame) => void): void {
  const f = createInputFrame();
  for (let t = 0; t < ticks; t++) {
    resetFrame(f);
    if (fill) fill(f);
    step(w, f);
  }
}

/** Held trigger, aimed straight down +x. */
const shoot: (f: InputFrame) => void = (f) => {
  f.fire = true;
  f.aimX = 1;
  f.aimY = 0;
};

/** A world with one hand, a room to shoot across, and a player who cannot die. */
function arena(seed: number, id: string, auto = false): World {
  const w = createWorld(seed, { arenaHalf: 90 });
  arm(w, id);
  w.slots[1].weapon = -1;
  w.activeSlot = 0;
  w.player.hp = 100_000;
  w.autoFire = auto;
  return w;
}

/**
 * Ticks until the room is empty, counted with the trigger released. With `autoFire` on
 * that means the game aims and fires by itself — the mode the HUD's auto-fire option runs
 * in, and the one a horde actually gets shot at — and with it off nothing is fired at
 * all, which is why every caller here passes the first. A crowd still standing when the
 * budget runs out reads as the budget, so a slow hand and a stuck one stay comparable.
 */
function clearIn(w: World, budget = 500): number {
  const f = createInputFrame();
  for (let t = 0; t < budget; t++) {
    resetFrame(f);
    f.aimX = 1;
    f.aimY = 0;
    step(w, f);
    if (countAlive(w.enemies) === 0) return t + 1;
  }
  return budget;
}

/** The same fight on three seeds, so a claim is about the hand and not about a draw. */
function onSeeds(fight: (seed: number) => number): number[] {
  return [777, 503, 521].map(fight);
}

/** How many metres a second the live shots carry across the aim line, largest first. */
function crossSpeed(w: World): number {
  let max = 0;
  for (let i = 0; i < w.shots.cap; i++) {
    if (w.shots.alive[i] !== 1) continue;
    const v = Math.abs(w.shots.vy[i]);
    if (v > max) max = v;
  }
  return max;
}

/** Eight swarmlings in a disc whose middle sits 4.5 m off the +x aim line. */
function cloud(w: World, cx = 11, cy = 4.5): void {
  for (let k = 0; k < 8; k++) {
    const a = k * 2.399_96;
    const r = (k % 3) * 0.7;
    place(w, 'swarmling', cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
}

/**
 * `n` swarmlings packed into a disc of about `spread` metres with its middle at
 * (cx, cy), each on the hp its archetype gives it, and held still.
 */
function disc(w: World, cx: number, cy: number, n: number, spread: number): void {
  for (let k = 0; k < n; k++) {
    const a = k * 2.399_6;
    const r = (k % 4) * spread;
    spawnEnemy(w, enemyIndex('swarmling'), cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  stand(w);
}

describe('the weapon table', () => {
  it('has eighteen hands across three families, and none of them is a duplicate', () => {
    // Sixteen was the brief and eighteen is what the table holds; the number is the part
    // a later task could quietly walk back, so it is pinned rather than narrated.
    expect(WEAPONS.length).toBe(18);

    const families = new Map<string, number>();
    for (const def of WEAPONS) families.set(def.family, (families.get(def.family) ?? 0) + 1);

    // Five is the floor per family, not a distribution: each family has to be able to
    // carry a run on its own, which is what makes "guns, medieval or alien" a choice
    // rather than three skins on the same decision.
    expect([...families.entries()].sort()).toEqual([
      ['alien', 5],
      ['guns', 7],
      ['medieval', 6],
    ]);

    const ids = WEAPONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every hand a delivery path, a body to draw and exactly one thing to run on', () => {
    const paths = ['projectile', 'hitscan', 'beam', 'arc', 'melee', 'chain', 'orb'];

    for (const def of WEAPONS) {
      expect(paths, `${def.id} fires with an unknown kind`).toContain(def.fire);
      expect(def.mesh, `${def.id} has nothing to draw`).not.toBe('');
      expect(def.sfx, `${def.id} has nothing to hear`).not.toBe('');
      expect(def.dmg, def.id).toBeGreaterThan(0);
      expect(def.range, def.id).toBeGreaterThan(0);

      // One constraint per hand. The HUD gauge, the hand's rhythm and every "why this gun
      // and not the other one" in the game come from there being exactly one, so a hand
      // with two is a design bug hiding as a data field and a hand with none is a gun
      // that can be held down forever.
      const spent = [def.ammo, def.heat, def.energy].filter((h) => h !== undefined);
      expect(spent, `${def.id} spends ${spent.length} constraints`).toHaveLength(1);

      if (def.ammo) {
        expect(def.ammo.mag, def.id).toBeGreaterThan(0);
        expect(def.ammo.reload, def.id).toBeGreaterThan(0);
      }
      if (def.heat) {
        expect(def.heat.max, def.id).toBeGreaterThan(0);
        expect(def.heat.coolPerSec, def.id).toBeGreaterThan(0);
      }
      if (def.energy) {
        expect(def.energy.capacity, def.id).toBeGreaterThan(def.energy.perShot);
        expect(def.energy.regenPerSec, def.id).toBeGreaterThan(0);
      }
    }
  });

  it('kills a body standing at the range each weapon claims', () => {
    // One body, at the distance the def prints, frozen so it cannot walk the shot
    // closer: the worst honest case for a long weapon and the only case a short one
    // needs. A melee reach is measured to the body's edge, so a chaser stood at 5.2 m
    // is being thrust at through 4.75 m of it, which is what the pike's number buys.
    for (const def of WEAPONS) {
      const w = arena(4242, def.id);
      const dummy = place(w, 'chaser', def.range, 0);
      stand(w);

      run(w, RANGE_BUDGET, shoot);

      expect(
        w.enemies.alive[dummy],
        `${def.id} never ended a body standing ${def.range} m away`,
      ).toBe(0);
    }
  });
});

describe('homing flight', () => {
  it('bends an orb toward a crowd the aim sailed past', () => {
    // Nothing in the disc is on the line the trigger was aimed along, and the burst is
    // aimed past all of it: a round that flies straight never meets the cloud, and a
    // round that steers does. The singularity gun is the control because it throws the
    // same kind of orb at a similar speed and has no `homing` to spend — one difference
    // between the two runs, which is the difference being measured.
    const hunting = arena(501, 'disruptorOrb');
    cloud(hunting);
    stand(hunting);

    // The curve, read where it has to be read: the cross-axis part of each shot's own
    // velocity, tick by tick, while anything is still in the air.
    const curve: number[] = [];
    run(hunting, 400, (f) => {
      shoot(f);
      curve.push(crossSpeed(hunting));
    });

    expect(Math.max(...curve), 'the orb never turned').toBeGreaterThan(5);
    expect(countAlive(hunting.enemies), 'the crowd the aim missed survived').toBe(0);

    const straight = arena(501, 'singularityGun');
    cloud(straight);
    stand(straight);

    const flat: number[] = [];
    run(straight, 400, (f) => {
      shoot(f);
      flat.push(crossSpeed(straight));
    });

    // Not that the control is weak: it pops 3.2 m around a line that passes 4.5 m clear
    // of every mote it was meant to punish, and one of the eight still died to a pull
    // that caught the edge of the disc. Seven of eight is the sound of a weapon firing at
    // empty floor, which is the flaw the hunt exists to remove.
    expect(Math.max(...flat), 'the control orb steered too').toBe(0);
    expect(countAlive(straight.enemies)).toBe(7);
  });

  it('ends the same pack under auto-fire, sooner than the unsteered orb does', () => {
    // The trigger released and the line left to the game, which is how a horde actually
    // gets shot at: auto-fire picks a body and shortens a lob to its distance, so the
    // burst lands in the pack instead of at the floor behind it. What still separates the
    // two hands is whether the round can turn on the way. Twenty motes, 4.5 m clear of
    // the +x line, at the crowd hp a chapter ships, on three seeds; the pair runs to
    // completion on all three, which is the point — the control is not useless here, it
    // is second, and only the curve separates them.
    const hunted = onSeeds((s) => {
      const w = arena(s, 'disruptorOrb', true);
      disc(w, 11, 4.5, 20, 0.55);
      return clearIn(w, 400);
    });
    const flat = onSeeds((s) => {
      const w = arena(s, 'singularityGun', true);
      disc(w, 11, 4.5, 20, 0.55);
      return clearIn(w, 400);
    });

    expect(Math.max(...hunted), 'the hunting orb was not faster on every seed').toBeLessThan(
      Math.min(...flat),
    );
  });

  it('leaves the line straight when there is nothing inside its seek band', () => {
    // One body twenty metres behind the player, so it is outside the band a hunting
    // round looks around in and gets further away every tick. The only thing that could
    // bend this flight is a rule that hunts anything anywhere, which would be a lock-on
    // rather than the aim modifier a `homing` number is.
    const w = arena(502, 'disruptorOrb');
    const behind = place(w, 'chaser', -20, 0);
    stand(w);

    const curve: number[] = [];
    run(w, 90, (f) => {
      shoot(f);
      curve.push(crossSpeed(w));
    });

    expect(Math.max(...curve)).toBe(0);
    expect(w.enemies.alive[behind], 'the orb went hunting behind the player').toBe(1);
  });
});

describe('the eight new hands', () => {
  it('runs a railgun shot through nine bodies and stops at the tenth', () => {
    const w = arena(511, 'railgun');

    // Ten chasers 0.9 m apart on the aim line at 20 HP each: cheap enough that any shot
    // which reaches them kills them, so a body left over is the pass-through budget
    // running out rather than the damage running short.
    const line: number[] = [];
    for (let k = 0; k < 10; k++) line.push(place(w, 'chaser', 22 + k * 0.9, 0));
    stand(w);

    // Six ticks is one trigger pull — a railgun cycle is two seconds — so nothing that
    // dies in this window was finished by a second shot.
    run(w, 6, shoot);

    expect(countAlive(w.enemies)).toBe(1);
    expect(w.enemies.alive[line[9]], 'the tenth body was inside the budget').toBe(1);
    // Nine bodies from one pull means the ray went through eight and stopped, which is
    // what `pierce: 8` is a budget of.
    expect(countEvents(w, Ev.Hit)).toBe(9);

    // The same layout against the sniper: four pass-throughs, five bodies, five untouched.
    // Two rays, two budgets, one measurement, so a railgun that quietly spent its eight
    // pass-throughs on bodies it had already hurt has nowhere to hide.
    const control = arena(511, 'sniper');
    const other: number[] = [];
    for (let k = 0; k < 10; k++) other.push(place(control, 'chaser', 22 + k * 0.9, 0));
    stand(control);

    run(control, 6, shoot);

    expect(countAlive(control.enemies)).toBe(5);
    expect(control.enemies.alive[other[5]]).toBe(1);
  });

  it('thrusts a pike down a lane and leaves the flanks free', () => {
    // Five bodies on the aim line and two 3 m to the side, every one of them inside the
    // 5.2 m of reach the pike claims. A sweep that ignored its own arc would take all
    // seven, and the flail — 150° either side of the aim, which is what the pike gives up
    // for its reach — is here to show the flankers were reachable by something.
    const lane = (id: string): [World, number[], number[]] => {
      const w = arena(512, id);
      const straight: number[] = [];
      for (let k = 1; k <= 5; k++) straight.push(place(w, 'chaser', k, 0));
      const flank = [place(w, 'chaser', 2, 3), place(w, 'chaser', 3, -3)];
      stand(w);
      return [w, straight, flank];
    };
    const dead = (w: World, list: number[]): number =>
      list.filter((i) => w.enemies.alive[i] === 0).length;

    const [pike, pikeLane, pikeFlank] = lane('pike');
    run(pike, 90, shoot);

    expect(dead(pike, pikeLane)).toBe(5);
    expect(dead(pike, pikeFlank), 'the 37° arc let its flanks go').toBe(0);

    const [flail, flailLane, flailFlank] = lane('flail');
    run(flail, 90, shoot);

    // The flail cannot reach the far end of the lane — 3.4 m against bodies at 4 and 5 m
    // — but it does pay the body 3 m to the side, which is the whole difference between
    // a ring-cleaning sweep and a lane-poking thrust.
    expect(dead(flail, flailFlank)).toBe(1);
    expect(dead(flail, flailLane)).toBeLessThan(5);
  });

  it('throws three axes per volley, each of which goes through two more bodies', () => {
    const w = arena(513, 'throwingAxes');
    for (let k = 0; k < 9; k++) {
      place(w, 'chaser', 5.5 + (k % 3) * 0.9, Math.floor(k / 3) * 0.9 - 0.9);
    }
    stand(w);

    // One tick, so this reads the shape of a single throw rather than a rate: three axes
    // came out of the pull, and each carries itself plus two pass-throughs.
    run(w, 1, shoot);

    expect(countAlive(w.shots)).toBe(3);
    for (let i = 0; i < w.shots.cap; i++) {
      if (w.shots.alive[i] === 1) expect(w.shots.state[i]).toBe(3);
    }

    // A round that stopped at the first body it found could take three of the nine, and
    // only on a throw where all three axes happened to line up on a file. The block is
    // gone inside a second and a third of held trigger because the axes keep going.
    run(w, 60, shoot);
    expect(countAlive(w.enemies)).toBe(0);
  });

  it('runs the SMG belt to dry, goes silent through the reload, and comes back', () => {
    const w = arena(514, 'smg');
    place(w, 'chaser', 12, 0);
    stand(w);
    const slot = w.slots[0];

    // Three and a third seconds of held trigger: forty rounds at twelve a second, which
    // on a 1/60 s grid is five ticks a round.
    run(w, 210, shoot);
    expect(slot.ammo).toBe(0);
    expect(slot.reload, 'an empty magazine should have started a reload').toBeGreaterThan(0);

    // The reload is 1.6 s, and a pause on the trigger is not the same weapon: the next
    // second of held button looses nothing at all.
    clearEvents(w);
    run(w, 60, shoot);
    expect(slot.reload).toBeGreaterThan(0);
    expect(countEvents(w, Ev.Shot)).toBe(0);

    // Then the belt is back and the gun speaks again — and it came back at forty rounds
    // and spent some of them, rather than trickling.
    run(w, 60, shoot);
    expect(slot.reload).toBe(0);
    expect(countEvents(w, Ev.Shot)).toBeGreaterThan(0);
    expect(slot.ammo).toBeLessThan(40);
  });
});

describe('a hand is chosen for the room it is in', () => {
  it('splits the gun family between the crowd and the plate', () => {
    // Twenty swarmlings 13 m straight ahead, fired the way the game fires when the
    // player is not picking the line, on three seeds. Three of the seven guns clear this
    // disc in about a second and a half; the two that do not are the two whose numbers
    // say they should not, and that is the whole of what a weapon roster has to prove —
    // not that every hand is strong, that each one is strong somewhere.
    const crowd = (id: string): number[] =>
      onSeeds((s) => {
        const w = arena(s, id, true);
        disc(w, 13, 0, 20, 0.55);
        return clearIn(w);
      });

    // The LMG, the rifle and the SMG are within fourteen ticks of each other here,
    // which is why they are not three copies of one answer: what separates them is
    // everything else, and the plate below is where it shows.
    expect(Math.max(...crowd('lmg')), 'lmg crowd').toBeLessThan(130);
    expect(Math.max(...crowd('assaultRifle')), 'rifle crowd').toBeLessThan(130);
    expect(Math.max(...crowd('smg')), 'smg crowd').toBeLessThan(130);

    // The pistol takes three and a half seconds, every seed, against the SMG's one and a
    // half: the SMG exists because the pistol cannot keep a disc off the player, and the
    // gap is measured rather than asserted. The shotgun is last on every seed — at 13 m
    // its cone has opened wider than the disc, exactly as the falloff says it has, and on
    // two seeds of three it never finishes.
    expect(Math.min(...crowd('pistol')), 'pistol crowd').toBeGreaterThan(190);
    expect(Math.min(...crowd('shotgun')), 'shotgun crowd').toBeGreaterThan(190);

    // One armored at its own 80 hp and 7 of plate, 12 m out: the other half of the
    // choice, and the order turns over. A ray that ignores half a body's plate ends it
    // the tick the trigger goes down; the rifle takes under a second; the belt that beat
    // the disc is a third slower here, because thirteen damage through a fifth of a plate
    // is not the weapon it was against soft bodies; and the SMG is slower again than the
    // belt. Each pairing is read against the next one's worst seed, so none of them is
    // one lucky draw.
    const plate = (id: string): number[] =>
      onSeeds((s) => {
        const w = arena(s, id, true);
        place(w, 'armored', 12, 0, 80);
        stand(w);
        return clearIn(w);
      });

    expect(Math.max(...plate('sniper')), 'sniper plate').toBe(1);
    expect(Math.max(...plate('assaultRifle')), 'rifle plate').toBeLessThan(
      Math.min(...plate('lmg')),
    );
    expect(Math.max(...plate('lmg')), 'lmg plate').toBeLessThan(Math.min(...plate('smg')));
  });
});

describe('the hunt is deterministic', () => {
  it('runs the same fight twice and lands the same twice', () => {
    // The steering reads the tick's shared query buffer, which every other damage pass in
    // the tick also reads, so what is being pinned is that it does that in a fixed order:
    // same seed and same inputs, same world, bodies and all.
    const fight = (id: string): number => {
      const w = arena(517, id);
      cloud(w);
      stand(w);
      run(w, 300, shoot);
      return hashWorld(w);
    };

    expect(fight('disruptorOrb')).toBe(fight('disruptorOrb'));
    // The same fight without the steering is a different world, which is the same fact
    // from the other side: the modifier does work the harness can see, so the line above
    // could not have passed by measuring nothing.
    expect(fight('disruptorOrb')).not.toBe(fight('singularityGun'));
  });
});
