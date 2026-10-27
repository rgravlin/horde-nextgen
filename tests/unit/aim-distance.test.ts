/**
 * The aim *distance*: the third aim number, and the two weapons that need it.
 *
 * Split out of `gamepad.test.ts` and `weapons-c.test.ts` because both hosts were getting too
 * large to read in one pass, not because the two halves are unrelated — they are the same
 * feature seen from the device side and the simulation side:
 *
 * - a cursor and a right stick both point at a *place*. The sampler projects the pointer onto
 *   the floor and the pad reads its stick's own length; both write the metres into the frame
 *   (`sampler.test.ts` pins the pointer half).
 * - `arc` and `orb` resolve their damage where the shot lands, so they read that number and put
 *   the burst there. Everything whose round travels needs only the line.
 *
 * The room is a pack 6–12 m ahead with the trigger held, which is how a retreating player is
 * actually fought. Measured before the distance existed, all three landing hands spent every
 * shell at the top of their range and killed nothing there; the paired column in the last test
 * is that measurement kept as an assertion, so a regression reads as a failure rather than as a
 * slightly weaker weapon. Auto-fire is deliberately not the fixture: it leads the nearest body,
 * so it has always landed somewhere and could not show the flaw.
 */

import { describe, expect, it } from 'vitest';

import { GamepadReader, PAD_AIM_RANGE, PAD_DEAD } from '../../src/input/gamepad';
import { WEAPONS } from '../../src/content/weapons';
import { enemyIndex } from '../../src/content/enemies';
import { createInputFrame, resetFrame } from '../../src/sim/input';
import { step } from '../../src/sim/step';
import { spawnEnemy } from '../../src/sim/systems/enemies';
import { countAlive, createWorld, loadSlot, type World } from '../../src/sim/world';

/** A standard-mapping pad with the four stick axes at the given readings. */
type PadStub = { connected: boolean; mapping: string; id: string; axes: number[]; buttons: Array<{ pressed: boolean }> };

function pad(axes: readonly [number, number, number, number]): PadStub {
  return {
    connected: true,
    mapping: 'standard',
    id: 'pad-a',
    axes: [...axes],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false })),
  };
}

/** A world holding one hand, a room to shoot across, and a player who cannot die. */
function arena(seed: number, id: string): World {
  const w = createWorld(seed, { arenaHalf: 90 });
  loadSlot(w.slots[0], WEAPONS.findIndex((d) => d.id === id));
  w.slots[1].weapon = -1;
  w.activeSlot = 0;
  w.player.hp = 100_000;
  w.autoFire = false;
  return w;
}

/** Twenty live swarmlings in a disc centred 9 m straight ahead, nothing frozen. */
function pack(w: World): void {
  for (let k = 0; k < 20; k++) {
    const a = k * 2.399_6;
    const r = (k % 4) * 0.55;
    spawnEnemy(w, enemyIndex('swarmling'), 9 + Math.cos(a) * r, Math.sin(a) * r);
  }
}

/**
 * Held trigger aimed along +x at `dist` metres, counting ticks until the pack is gone.
 * Returning the budget unchanged means it never cleared.
 */
function steeredIn(w: World, budget: number, dist: number): number {
  const f = createInputFrame();
  for (let t = 0; t < budget; t++) {
    resetFrame(f);
    f.fire = true;
    f.aimX = 1;
    f.aimY = 0;
    f.aimDist = dist;
    step(w, f);
    if (countAlive(w.enemies) === 0) return t + 1;
  }
  return budget;
}

/** The same fight on three seeds, so a claim is about the hand and not about a draw. */
function onSeeds(fight: (seed: number) => number): number[] {
  return [777, 503, 521].map(fight);
}

describe('a device that points at a place', () => {
  it('turns the right stick\'s own length into a throw distance', () => {
    // A stick carries no distance, so this is a convention rather than a reading: a full push
    // means the weapon's full reach and a pulled-back thumb means that much of it. Without the
    // distance the two hands whose damage resolves where they land could only ever be thrown at
    // the top of their range from a pad, which is a gun that cannot be aimed.
    const full = new GamepadReader({ pads: () => [pad([0, 0, 1, 0])] });
    const frame = createInputFrame();
    full.read('play', frame, { pause: false, accept: false, reroll: false });
    expect(frame.aimDist).toBeCloseTo(PAD_AIM_RANGE, 6);

    // The rescale that keeps a stick clearing its dead zone from jumping to a quarter speed is
    // reused here, so the distance is the stick's rescaled length rather than its raw one.
    const half = new GamepadReader({ pads: () => [pad([0, 0, 0.6, 0])] });
    const frame2 = createInputFrame();
    half.read('play', frame2, { pause: false, accept: false, reroll: false });
    expect(frame2.aimDist).toBeCloseTo(((0.6 - PAD_DEAD) / (1 - PAD_DEAD)) * PAD_AIM_RANGE, 6);

    // A resting stick writes nothing, so a mouse distance already in the frame survives it — the
    // same merge rule that keeps a resting stick from taking the aim line away.
    const resting = createInputFrame();
    resting.aimDist = 7;
    new GamepadReader({ pads: () => [pad([0, 0, 0.05, 0])] }).read('play', resting, {
      pause: false,
      accept: false,
      reroll: false,
    });
    expect(resting.aimDist).toBe(7);
  });
});

describe('a steered lob lands where it was aimed', () => {
  it('ends the pack it was aimed at, on all three landing hands', () => {
    // Paired on every seed: the same room, the same aim line, the only difference being whether
    // the frame knew how far the cursor was. Aimed at the pack all three clear it inside a
    // second; flown blind none of them clears it in three and a third seconds, which is what
    // makes the distance a verb rather than a number.
    //
    // The pack stays live on purpose. Held still, the singularity's pull reaches back from a
    // blind burst and clears the disc anyway, and a test written on frozen bodies would have
    // passed with the flaw in it.
    for (const id of ['catapult', 'singularityGun', 'disruptorOrb']) {
      const aimed = onSeeds((s) => {
        const w = arena(s, id);
        pack(w);
        return steeredIn(w, 200, 9);
      });
      const blind = onSeeds((s) => {
        const w = arena(s, id);
        pack(w);
        return steeredIn(w, 200, 0);
      });

      expect(Math.max(...aimed), `${id} aimed at the pack`).toBeLessThan(60);
      expect(Math.min(...blind), `${id} flown blind spent its shots past the pack`).toBe(200);
    }
  });

  it('leaves the hands that do not land to a distance alone', () => {
    // The distance is read by two fire kinds out of seven. Everything whose damage travels with
    // the round, the beam, the bolt or the sweep has to come out of this change exactly as it
    // went in, on the same room and the same seeds; a table-wide buff would mean the branch is
    // not scoped to the kinds that need it.
    const others = ['smg', 'lmg', 'sniper', 'flail', 'laserLance', 'chainLightningWand'];
    for (const id of others) {
      const withDist = onSeeds((s) => {
        const w = arena(s, id);
        pack(w);
        return steeredIn(w, 300, 9);
      });
      const without = onSeeds((s) => {
        const w = arena(s, id);
        pack(w);
        return steeredIn(w, 300, 0);
      });
      expect(withDist, `${id} read a distance it has no use for`).toEqual(without);
    }
  });

});
