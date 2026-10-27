/**
 * The enemy pass: every live body's behaviour, then its touch.
 *
 * This is the only place in the folder that knows about all the others; the behaviours are
 * reached through `behaviours.ts` and the travel tail through `shared.ts`, which is what
 * keeps one behaviour readable without making it responsible for the horde.
 */

import { ENEMIES } from '../../../content/enemies';
import { DT, type World } from '../../world';
import { travelScale } from '../powerups';
import { AI } from './behaviours';
import { contact } from './contact';
import { advance, eliteOf, scratch, underground } from './shared';

/**
 * Run every live enemy's behaviour, then let it hit the player.
 *
 * Also leaves `enemyNear` and `nearest` behind: the closest enemy measured before anything
 * moved, which is what the auto-fire decision reads and where it points. Enemies already
 * at 0 HP are skipped — the damage pass that killed them has already dropped their shard
 * and given the slot back — and so are the ones under the floor, which are neither
 * targetable nor allowed to touch.
 *
 * A staggering body skips its behaviour and rides the shove it was given, which is what
 * makes knockback a positioning tool as well as a number: three ticks of not-steering is
 * enough to spoil a charger's line and to turn an armored's shield aside.
 */
export function updateEnemies(w: World): void {
  const enemies = w.enemies;
  const player = w.player;
  let nearest2 = Infinity;
  let nearestSlot = -1;

  for (let i = 0; i < enemies.cap; i++) {
    if (enemies.alive[i] === 0) continue;
    if (enemies.hp[i] <= 0) continue;

    // Under the floor, which costs this body two things. It is not the auto-fire's target,
    // because a gun that woke for something it cannot hit spends its ammo on a hole in the
    // floor; and it gets no touch, because the alternative is damage with no tell in front of
    // it. Both read the same `underground` the broad phase's mask is built from.
    const hidden = underground(enemies.phase[i]);

    const dx = player.x - enemies.x[i];
    const dy = player.y - enemies.y[i];
    const d2 = dx * dx + dy * dy;
    if (!hidden && d2 < nearest2) {
      nearest2 = d2;
      nearestSlot = i;
    }

    const def = ENEMIES[enemies.kind[i]];
    // The body's own clock, which is what the weave swings on: a body that arrives late is
    // already mid-swing rather than starting its sway from zero like a clone.
    enemies.age[i] += DT;

    // How far this body may get this tick, written once here for every travel step it
    // takes (a staggering body takes one, a behaviour that steers and drives takes one, a
    // charger's dash takes one and its follow-up walk another). Measured before anything
    // moved, for the same reason `d2` above is: the stasis field asks where the body *was*
    // relative to the player, and answering it after the walk is a field that reaches half
    // a metre short of where it looks like it does.
    scratch.travel = travelScale(w, enemies.x[i], enemies.y[i], eliteOf(w, i)?.gait ?? 1);

    if (enemies.state[i] > 0) {
      enemies.state[i]--;
      advance(w, i, def);
    } else {
      AI[def.ai](w, i);
      // A behaviour may spend its own body: an exploder that finishes its fuse takes
      // itself with it, and a slot already back in the free list has no contact to make.
      // Tested on `alive` rather than `hp` because the question is the slot, not the health.
      if (enemies.alive[i] === 0) continue;
    }

    if (!hidden) contact(w, def, d2);
  }

  if (nearestSlot === -1) {
    w.enemyNear = Infinity;
    w.nearest = -1;
  } else {
    w.enemyNear = Math.sqrt(nearest2);
    w.nearest = nearestSlot;
  }
}