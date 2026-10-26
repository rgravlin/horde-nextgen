/**
 * The bodies whose whole behaviour is a line at the player: the chaser's plain seek and the
 * weave the swarmling and the splitter share.
 */

import { ENEMIES } from '../../../content/enemies';
import { type World } from '../../world';
import { drive, seekDrive } from './shared';

/**
 * Seek the player through the crowd.
 *
 * The plain case: no wind-up, no fuse, nothing to read before it reaches you. It steers
 * at the player and shoves neighbours out of its personal space, so the pack presses as a
 * crowd with gaps instead of one overlapping blob (DESIGN.md: the horde has to stay
 * readable), and that is the whole behaviour — which is why the four bodies added beside it
 * did not need four copies of this (see `behaviours.ts` for which bodies share it).
 */
export function seekChaser(w: World, i: number): void {
  seekDrive(w, i, ENEMIES[w.enemies.kind[i]]);
}

/**
 * Seek with a weave across the line of approach: the swarmling's jittered seek, and the
 * splitter's slower and wider lurch.
 *
 * The swing is a sine on the body's own clock, offset by an angle its slot gave it, and it
 * is a rotation of the aim rather than noise added to it: a body still steers at the player
 * and drifts across that line, so it keeps closing instead of wandering off, and it costs
 * one `Math.sin` a tick with no random number and no state to age. That is the whole reason
 * a cloud of forty of them cannot be deleted by one shot fired down the middle.
 */
export function swaySeek(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const player = w.player;

  let vx = 0;
  let vy = 0;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;

  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    const nx = dx / d;
    const ny = dy / d;
    const amp = def.params.swayAmp ?? 0;
    const hz = def.params.swayHz ?? 0;
    let swing = 0;
    if (amp > 0 && hz > 0) {
      swing = Math.sin(enemies.age[i] * hz * Math.PI * 2 + enemies.timer[i]) * amp;
    }
    const c = Math.cos(swing);
    const s = Math.sin(swing);
    vx = (nx * c - ny * s) * def.speed;
    vy = (nx * s + ny * c) * def.speed;
  }

  drive(w, i, def, vx, vy);
}