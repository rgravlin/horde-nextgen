/**
 * The archetypes added after the chapter recipes were set: the two marks (the sniper and the
 * orbiter) and the two that break the walking default (the teleporter and the spawner), plus
 * the one body the spawner puts down.
 *
 * They are authored here rather than in `enemies.ts` because that file already carries the
 * twelve rows the chapter recipes were built around and a table reads better grouped by what
 * its rows *do* than by when they were typed. `enemies.ts` spreads this list into `ENEMIES`,
 * so everything downstream — `ENEMY_BY_ID`, the wave recipes, the bench, the renderer's batch
 * list and the hit query's padding — keeps reading one table rather than two.
 *
 * The marks are data for one behaviour file (`systems/enemies/marksmen.ts`): each locks a
 * line, holds it for its `windup`, then spends what it locked. The teleporter spends a line
 * too, but it crosses it in a tick rather than walking it (`systems/enemies/phaser.ts`), and
 * the spawner never aims at the player at all — its damage arrives as bodies
 * (`systems/enemies/nursery.ts`). Their `params` are the numbers those behaviours read and
 * they are documented there, where they are used.
 *
 * The spawnling is the last row because it is not a body the recipes send. It arrives out of
 * a spawner and out of nothing else, which is why it is a row of its own rather than a smaller
 * swarmling: an archetype that only ever comes from a body on the floor is read as that body's
 * doing, both by the player and by the wave spawner's rule about where a new arrival may land.
 * The splinter works the same way, for the same reason.
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
  {
    id: 'teleporter',
    faction: 'cult',
    // The shard-and-spur silhouette the swarmling cloud wears, at four fifths again the
    // radius: the shape is the one the eye already reads as "several of something, arriving
    // fast", and it is drawn a full head taller than the cloud so a single one of these in
    // the middle of a swarmling sweep does not read as one more mote. Its tell is a charge
    // strip like the charger's, which is the reason it borrows the runner's own
    // `dashReach`/`phaseSpeed` names — see `systems/enemies/phaser.ts`.
    mesh: 'mote',
    fit: 1.4,
    // Thin, fast and gone before the second gun turns: 28 HP with no plate is less than a
    // chaser's, because a body that crosses eight metres of floor in two moves has to be
    // dead the tick it is seen or the fight stops being about where you stand.
    hp: 28,
    speed: 4.3,
    radius: 0.42,
    armor: 0,
    xp: 6,
    ai: 'teleporter',
    // The one line it spends, read as three numbers that have to add up: `dashReach` is the
    // strip painted on the floor (and what `render/telegraphs.ts` draws), `phaseSkip` is the
    // part of it crossed in the tick the tell ends and `phaseTime` is the rest, run at
    // `phaseSpeed`. 5 + 15 × 0.2 = 8 = the painted line, pinned in `enemies-d.test.ts`.
    //
    // `windup` is how long that strip lies on the floor before it is spent — thirty ticks,
    // past DESIGN.md's 400 ms floor, and spent standing still: the promise is that the strip
    // you were shown is the floor it lands on, so it cannot be drawn by a body on the move.
    //
    // `phaseMin`/`armRange` are the band it commits inside: below `phaseMin` there is no
    // room to paint the line it is about to run, and above `armRange` the line stops short
    // of you and the phase is only a shortcut. `recover` is the window it stands in once the
    // line is spent, and `phaseGap` the cooldown before it will draw another.
    params: {
      sepRadius: 1.25,
      sepPush: 2.4,
      touchRange: 0.28,
      touchDamage: 7,
      faceLag: 16,
      phaseMin: 6,
      armRange: 12,
      dashReach: 8,
      windup: 0.5,
      phaseSkip: 5,
      phaseSpeed: 15,
      phaseTime: 0.2,
      recover: 0.35,
      phaseGap: 1.5,
    },
    accent: '#FF4D2E',
  },
  {
    id: 'spawner',
    faction: 'reactor',
    // The broodmother's silhouette at half its size, on purpose: the sac that glows with
    // young is the one shape in the game that already means "this is making bodies over
    // there", and a player who met it at the chapter-1 finisher reads this one the same way
    // from across the room. It is a support body, so it wears the support accent.
    mesh: 'sac',
    fit: 0.48,
    // 0.68 rather than the 0.72 the silhouette wants: the hit queries pad for the widest
    // body in the table, and the roster test keeps a non-boss under 0.7 so no trash body
    // widens every shot in the game. The sac reads at this size anyway, and it is a support
    // body meant to be picked out across a room, not a wall.
    hp: 70,
    speed: 3.6,
    radius: 0.68,
    armor: 1,
    xp: 8,
    ai: 'spawner',
    // `keepMin` is the distance it tries to hold while it still has a brood left, and
    // `brawlerSpeed` is what it trades that for once the faucet is dry (a multiplier on its
    // own cruise, applied to the walk rather than to a dash). `spawnGap` is the beat — wound
    // at spawn, like the broodmother's, so it never opens fire the tick it arrives — and
    // `spawnBroods` how many it pays out before it turns into a body that only walks at you.
    // `spawnCount` is per brood and `spawnSpread` how far behind itself they land.
    params: {
      sepRadius: 1.8,
      sepPush: 2.2,
      touchRange: 0.3,
      touchDamage: 9,
      faceLag: 8,
      keepMin: 5,
      brawlerSpeed: 1.15,
      spawnGap: 2.8,
      spawnBroods: 3,
      spawnCount: 3,
      spawnSpread: 2.2,
    },
    // What it emits, and nothing more: a death split here would tax the answer the body
    // exists to teach, which is to shut the faucet first. The young land behind it while it
    // runs, so a chase turns into a walk through the trail it laid.
    brood: { def: 'spawnling', count: 3 },
    accent: '#9B5CFF',
  },
  {
    id: 'spawnling',
    faction: 'reactor',
    // The mote silhouette again, at ninety-three hundredths of the size it was drawn for —
    // three quarters of the swarmling's own body — because three of them arrive out of a sac
    // and they have to read as one event rather than as three new bodies. Its own accent is
    // its parent's: the trail and the faucet are one thing to look at.
    mesh: 'mote',
    fit: 0.93,
    // Weaker than a swarmling and worth a sixth of its XP. Nine of them arrive over eight
    // seconds and the fight is with the sac, never with the trail; the trail is what stops
    // the player turning their back on it.
    hp: 6,
    // Faster than the parent that drops them, which is what makes the trail a trail: they
    // overtake a retreating sac and arrive while the player is still walking at it.
    speed: 4.9,
    radius: 0.28,
    armor: 0,
    xp: 1,
    // The swarmling's weave, and deliberately so: this body only ever exists in threes, and
    // three bodies that travelled in one file would be one lane to clear rather than a fan.
    // A wider, quicker swing than the cloud's own, at a third of the mass behind it.
    ai: 'swarmling',
    params: {
      sepRadius: 0.7,
      sepPush: 2.1,
      touchRange: 0.22,
      touchDamage: 3,
      faceLag: 14,
      swayAmp: 0.42,
      swayHz: 6.2,
    },
    accent: '#9B5CFF',
  },
];