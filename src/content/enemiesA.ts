/**
 * Enemies part A: the two bodies that fight at range — the sniper and the orbiter.
 *
 * They are authored here rather than in `enemies.ts` because that file already carries the
 * twelve rows the chapter recipes were built around and a table reads better grouped by what
 * its rows *do* than by when they were typed. `enemies.ts` spreads this list into `ENEMIES`,
 * so everything downstream — `ENEMY_BY_ID`, the wave recipes, the bench, the renderer's batch
 * list and the hit query's padding — keeps reading one table rather than two.
 *
 * Both entries are data for one behaviour file (`systems/enemies/marksmen.ts`): each locks a
 * line, holds it for its `windup`, then spends what it locked. Their `params` are the numbers
 * that behaviour reads and they are documented there, where they are used.
 */

import { type EnemyDef } from './enemies';

export const ENEMIES_A: readonly EnemyDef[] = [
  {
    id: 'sniper',
    faction: 'cult',
    mesh: 'sniper',
    // The body that punishes standing in the open. It is slow, it is thin, and it does not
    // want to reach you: it wants to be sixteen metres away with its line already painted.
    // The answer is the same one every marksman in this game takes — move, and move *after*
    // the flash starts, since the bolt is aimed where your velocity says you will be and not
    // where you are. A player who keeps going in a straight line is a player who was hit by
    // a shot they could see.
    hp: 34,
    speed: 2.8,
    radius: 0.42,
    armor: 0,
    xp: 7,
    ai: 'sniper',
    // bandMin/bandMax: the range it works at — it closes from outside, gives ground inside,
    // and plants in between. windup: seconds of sight line before the bolt leaves (forty-five
    // ticks, long because the bolt is fast). shotGap: seconds between locks. boltSpeed,
    // boltDamage, boltLife: the round, which is aimed once and then flies.
    params: {
      sepRadius: 1.5,
      sepPush: 1.7,
      touchRange: 0.25,
      touchDamage: 5,
      faceLag: 10,
      bandMin: 8,
      bandMax: 16,
      windup: 0.75,
      shotGap: 2.4,
      boltSpeed: 32,
      boltDamage: 20,
      boltLife: 1.5,
    },
    accent: '#FF4D2E',
  },
  {
    id: 'orbiter',
    faction: 'cult',
    mesh: 'orbiter',
    // The one body that keeps its feet busy while it aims. It walks a circle around you at
    // its orbit radius and shoots from the circle, so the two answers a horde usually invites
    // — back away, or hold a corner — both stop working against it: backing away is chased,
    // and holding a corner means being shot at from a bearing you did not pick. Killing it
    // means turning and walking *through* the circle, which is the read this archetype exists
    // to teach before the chapters that stack six of them.
    hp: 26,
    speed: 5.0,
    radius: 0.45,
    armor: 0,
    xp: 6,
    ai: 'orbiter',
    // orbitRadius: the ring it holds. orbit: fraction of its cruise spent sideways, which is
    // what makes the ring a walk rather than a stand. spring: how hard it corrects back onto
    // the ring (per second, clamped, so a player who runs is chased rather than watched).
    // slack: how far outside the ring it will still shoot, and windup/shotGap/bolts/fan/
    // boltSpeed/boltDamage/boltLife the fan it spends at the end of each lock.
    params: {
      sepRadius: 1.3,
      sepPush: 2,
      touchRange: 0.25,
      touchDamage: 5,
      faceLag: 12,
      orbitRadius: 6.5,
      orbit: 0.78,
      spring: 2.2,
      slack: 1.2,
      windup: 0.45,
      shotGap: 2.2,
      bolts: 3,
      fan: 0.22,
      boltSpeed: 15,
      boltDamage: 6,
      boltLife: 1.4,
    },
    accent: '#FF4D2E',
  },
];