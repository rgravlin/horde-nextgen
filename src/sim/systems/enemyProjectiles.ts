/**
 * Enemy-side delivery: what the horde fires back, and the one gate every source
 * of damage on the player shares.
 *
 * Two shapes ride the `enemyShots` pool (cap 512, TECH.md "Pools with hard
 * caps"), told apart by the `kind` slot:
 *
 * - `Bolt` — the shooter's round. It is tested against the player's disc as the
 *   segment it swept this tick, the same tunnel-proof the weapon rounds use, and
 *   it dies on the player or when its life runs out. An invulnerable player is
 *   simply not there for the test: a bolt that crosses the disc inside the
 *   i-frame window passes through, because damage that arrives in an invulnerable
 *   window is damage that does not exist.
 * - `Grenade` — the grenadier's lob. It resolves nothing while it flies and
 *   bursts at the end of its flight, at the point its telegraph ring was drawn
 *   the tick the throw went up. The burst reaches the player's disc (radius +
 *   body) and pays through the same i-frame gate; it deliberately does not
 *   reconnoitre the hash for bodies to catch, so a lob spent on a dodged ring
 *   costs the horde nothing but the throw.
 *
 * `hurtPlayer` lives here rather than in `systems/enemies.ts` so the three
 * enemy-side damage sources — contact, blast and projectile — share one i-frame
 * rule written once, and the two files still only import in one direction:
 * `enemies.ts` triggers shots from this file, this file spends them.
 *
 * Nothing here allocates: shots come out of the pool, and the only reads of the
 * world are the pools and the player.
 */

import { DT, Ev, TUNE, alloc, pushEvent, release, type World } from '../world';

/** The two delivery shapes, in the `enemyShots` pool's `kind` slot. */
export const ShotKind = {
  /** A flat round that hits the player on the segment it swept. */
  Bolt: 0,
  /** A lobbed burst that resolves where it was aimed, at the end of its flight. */
  Grenade: 1,
} as const;

/** Below this length a projectile's velocity counts as zero, and the slot is spent. */
const EPS = 1e-6;

/** Screen-shake weight of a bolt hit, a grenade's own, and a hug's, times ten. */
const BOLT_TRAUMA = 4;
const GRENADE_TRAUMA = 8;

/**
 * Take a hit off the player, gated by i-frames.
 *
 * The first hit spends the player's invulnerability, so a volley that arrives all at
 * once costs one hit rather than one per round — which is what a dash's i-frames are
 * for: they buy the crossing, and a bolt tested against an invulnerable player is
 * ignored rather than absorbed, so it flies on past.
 *
 * `trauma` is screen shake times ten, which is how the camera turns a hit into a jolt.
 */
export function hurtPlayer(w: World, dmg: number, trauma: number): void {
  const player = w.player;
  if (!player.alive || player.iframes > 0) return;

  player.hp = player.hp > dmg ? player.hp - dmg : 0;
  player.iframes = TUNE.hurtIframes;
  // `a` is trauma x 10, which is how the camera turns this into shake.
  pushEvent(w, Ev.Shake, trauma, 0, player.x, player.y);

  if (player.hp <= 0) {
    player.alive = false;
    w.over = true;
    pushEvent(w, Ev.Death, 0, 0, player.x, player.y);
  }
}

/**
 * Put a bolt in the air at (ox, oy) travelling along the given unit direction.
 *
 * A full pool spends nothing: the behaviour asked for a shot, the pool said no, and
 * the second it waits does not come back. `Shot` carries -1 in `a` because there is
 * no gun behind an enemy round — the tracer is drawn from the event alone.
 */
export function launchBolt(
  w: World,
  ox: number,
  oy: number,
  dirx: number,
  diry: number,
  speed: number,
  dmg: number,
  life: number,
): void {
  const slot = alloc(w.enemyShots);
  if (slot < 0) return;

  const shots = w.enemyShots;
  shots.x[slot] = ox;
  shots.y[slot] = oy;
  shots.vx[slot] = dirx * speed;
  shots.vy[slot] = diry * speed;
  shots.hp[slot] = dmg;
  shots.life[slot] = life;
  shots.kind[slot] = ShotKind.Bolt;
  pushEvent(w, Ev.Shot, -1, slot, ox, oy);
}

/**
 * Lob a grenade from (ox, oy) along the given unit direction.
 *
 * The throw flies for `flight` seconds at `speed` and bursts where it gets to —
 * which is the point the throw was read at, within one step, because `flight` is
 * that distance divided by that speed. `state` holds the burst radius x 10 so the
 * filling ring and the burst read the same number from the same slot.
 */
export function lobGrenade(
  w: World,
  ox: number,
  oy: number,
  dirx: number,
  diry: number,
  speed: number,
  flight: number,
  dmg: number,
  radius: number,
): void {
  const slot = alloc(w.enemyShots);
  if (slot < 0) return;

  const shots = w.enemyShots;
  shots.x[slot] = ox;
  shots.y[slot] = oy;
  shots.vx[slot] = dirx * speed;
  shots.vy[slot] = diry * speed;
  shots.hp[slot] = dmg;
  shots.life[slot] = flight;
  shots.kind[slot] = ShotKind.Grenade;
  shots.state[slot] = Math.round(radius * 10);
  pushEvent(w, Ev.Shot, -1, slot, ox, oy);
}

/**
 * One tick of every live enemy projectile: fly, hit the player, or expire.
 *
 * The pass runs after the weapon rounds and the blast stack, so it shares the
 * tick's one query buffer with nothing (neither shape reads the hash) and sees the
 * i-frames that a hug or a blast may already have spent. A bolt that cannot land —
 * the player is invulnerable, or the segment never reaches the disc — flies on and
 * retires when its life runs out; a bolt that lands retires on the spot, because
 * one round gets exactly one hit.
 */
export function updateEnemyProjectiles(w: World): void {
  const shots = w.enemyShots;
  const player = w.player;
  const hitR = TUNE.shotRadius + TUNE.playerRadius;
  const hitR2 = hitR * hitR;

  for (let i = 0; i < shots.cap; i++) {
    if (shots.alive[i] === 0) continue;

    const vx = shots.vx[i];
    const vy = shots.vy[i];
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (!(speed > EPS)) {
      release(shots, i);
      continue;
    }

    shots.life[i] -= DT;
    const x0 = shots.x[i];
    const y0 = shots.y[i];
    const sweep = speed * DT;
    const x1 = x0 + vx * DT;
    const y1 = y0 + vy * DT;
    const dirx = vx / speed;
    const diry = vy / speed;

    if (shots.kind[i] === ShotKind.Grenade) {
      // Fly until the flight is spent, then burst where the arc got to — and the last
      // step is clamped to the distance the arc still owed, so the burst lands exactly
      // at the point the throw was read at rather than a step past it. The ring and
      // the burst are the same circle; the dodge is the difference between them.
      const owed = shots.life[i] > 0 ? sweep : speed * Math.max(0, shots.life[i] + DT);
      const lx = x0 + dirx * owed;
      const ly = y0 + diry * owed;

      if (shots.life[i] > 0) {
        shots.x[i] = lx;
        shots.y[i] = ly;
        continue;
      }

      // Landed: the burst is a circle, and the player counts all of it — reach is
      // the burst radius plus the body, so a runner clipped at the edge still pays.
      const r = shots.state[i] / 10;
      const reach = r + TUNE.playerRadius;
      const px = player.x - lx;
      const py = player.y - ly;
      if (px * px + py * py <= reach * reach) hurtPlayer(w, shots.hp[i], GRENADE_TRAUMA);
      pushEvent(w, Ev.Explosion, -1, shots.state[i], lx, ly);
      release(shots, i);
      continue;
    }

    // Bolt. A player with i-frames left is skipped rather than shielded, so the
    // round passes through and can only land on a later tick that is not covered.
    if (player.alive && player.iframes <= 0) {
      const sx = player.x - x0;
      const sy = player.y - y0;
      const along = sx * dirx + sy * diry;
      if (along > 0) {
        const t = along < sweep ? along : sweep;
        const ox = player.x - (x0 + dirx * t);
        const oy = player.y - (y0 + diry * t);
        if (ox * ox + oy * oy <= hitR2) {
          hurtPlayer(w, shots.hp[i], BOLT_TRAUMA);
          release(shots, i);
          continue;
        }
      }
    }

    if (shots.life[i] <= 0) release(shots, i);
    else {
      shots.x[i] = x1;
      shots.y[i] = y1;
    }
  }
}