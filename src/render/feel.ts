/**
 * The feel feed: this frame's events turned into a shove and a colour smear.
 *
 * Two feeds, both read once per rendered frame through a cursor of this layer's own — the event
 * ring is a broadcast that nothing drains (see `EventRing`), so the spark field, the audio and
 * here each keep a separate place in `written`. Whatever it adds goes through `Shake.addTrauma`,
 * which caps at 1, so a frame of eight detonations and two bolts is one big jolt rather than
 * eight small ones.
 *
 * What counts as a jolt is the part worth arguing about, and it is all here:
 *
 * - A `Ev.Shake` is a hit on the player, already weighed by the simulation — `a` is trauma times
 *   ten, which is how `hurtPlayer` writes one — so it goes straight in.
 * - A `Ev.Explosion` is a position plus a blast, and whether it is felt depends on where the
 *   player is standing: nothing inside `BLAST_FEEL` metres of the player's ears goes unnoticed,
 *   and a grenade two screens away is somebody else's problem. The falloff is linear on the
 *   distance rather than squared: a blast's *sound* falls off with the area, but what a jolt is
 *   worth is how near it felt, and squared would have a grenade at four metres already down to
 *   nothing.
 *
 * Read-only and cosmetic, like the rest of `render`: it moves a camera and one uniform, and no
 * game value anywhere.
 */

import { Ev, type World } from '../sim/world';

import type { PostChain } from './post';
import type { Shake } from './shake';

/** How far from the player a blast still moves the camera, in metres. */
const BLAST_FEEL = 14;

/** How much trauma one blast lands at the player's feet with, at zero distance. */
const BLAST_TRAUMA = 0.22;

export interface FeelFeed {
  /** Start a World's ring at its end: a fresh run does not back-fill old detonations. */
  reset(world: World): void;
  /** Turn whatever happened since the last read into trauma and punch. */
  feed(world: World): void;
}

/**
 * Bring the feed up.
 *
 * One per view, like the shake it feeds: it holds one number, so a restart only has to rewind the
 * cursor rather than rebuild anything.
 */
export function createFeel(shake: Shake, post: PostChain, chromaPunch: number): FeelFeed {
  /** This view's cursor into the ring, as an absolute event index. */
  let at = 0;

  return {
    reset(world) {
      at = world.events.written;
    },

    feed(world) {
      const ring = world.events;
      let cursor = at;
      const oldest = ring.written - ring.count;
      if (cursor < oldest) cursor = oldest;
      if (cursor >= ring.written) {
        at = ring.written;
        return;
      }

      const px = world.player.x;
      const py = world.player.y;
      for (; cursor < ring.written; cursor++) {
        const i = cursor % ring.cap;
        const type = ring.type[i];
        if (type === Ev.Shake) {
          // `a` is trauma x 10, which is how the sim writes a hit that was big enough to shake
          // the camera (see `hurtPlayer`).
          shake.addTrauma(ring.a[i] / 10);
          post.punch(chromaPunch * 0.7);
        } else if (type === Ev.Explosion) {
          const dx = ring.x[i] - px;
          const dy = ring.y[i] - py;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d >= BLAST_FEEL) continue;
          const feel = 1 - d / BLAST_FEEL;
          shake.addTrauma(BLAST_TRAUMA * feel);
          post.punch(chromaPunch * feel);
        }
      }
      at = ring.written;
    },
  };
}
