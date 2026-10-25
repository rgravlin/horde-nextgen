/**
 * XP shards and the level-up offer.
 *
 * A shard drifts, then homes once the player's magnet field reaches it, and paying
 * one in is what drives XP. Crossing a threshold builds three cards out of the
 * power-ups still worth taking and leaves `pendingLevelUp` set: the sim does not
 * show a screen, it says one is owed, and only `playing` ticks (ARCHITECTURE.md
 * "Scene state machine"). Drawing, reroll and pick all read world.rng, so a replay
 * of the same seed and the same picks gets the same cards.
 */

import { ENEMIES } from '../../content/enemies';
import { POWERUPS } from '../../content/powerups';
import { nextInt } from '../rng';
import { DT, Ev, TUNE, pushEvent, release, type World } from '../world';

/** Scratch for the offer draw: allocated with the module, reused by every offer. */
const poolBuf = new Int32Array(POWERUPS.length);
const offerBuf = new Int32Array(TUNE.pickCount);
const prevBuf = new Int32Array(TUNE.pickCount);
const nextBuf = new Int32Array(TUNE.pickCount);

/**
 * One tick of pickups: expire, magnet, collect.
 *
 * A shard outside the magnet field only skids, so distance is what decides whether
 * the player has to walk to it; walking over one still pays in wherever it is.
 */
export function updatePickups(w: World): void {
  const shards = w.shards;
  const player = w.player;
  if (!player.alive) return;

  const magnet = TUNE.magnetRadius + w.stats.magnet;
  const magnet2 = magnet * magnet;
  const collect2 = TUNE.collectRadius * TUNE.collectRadius;

  for (let i = 0; i < shards.cap; i++) {
    if (shards.alive[i] === 0) continue;

    shards.life[i] -= DT;
    if (shards.life[i] <= 0) {
      release(shards, i);
      continue;
    }

    const dx = player.x - shards.x[i];
    const dy = player.y - shards.y[i];
    const d2 = dx * dx + dy * dy;

    if (d2 <= collect2) {
      // The shard's `kind` is the archetype it came off, which is where its XP is.
      awardXp(w, ENEMIES[shards.kind[i]].xp);
      pushEvent(w, Ev.Pickup, i, shards.kind[i], shards.x[i], shards.y[i]);
      release(shards, i);
      continue;
    }

    let vx = shards.vx[i];
    let vy = shards.vy[i];
    if (d2 <= magnet2) {
      const d = Math.sqrt(d2);
      const inv = d > 1e-6 ? 1 / d : 0;
      vx += dx * inv * TUNE.shardAccel * DT;
      vy += dy * inv * TUNE.shardAccel * DT;
      const speed2 = vx * vx + vy * vy;
      const cap = TUNE.shardSpeed;
      if (speed2 > cap * cap) {
        const k = cap / Math.sqrt(speed2);
        vx *= k;
        vy *= k;
      }
    } else {
      vx *= TUNE.shardDrag;
      vy *= TUNE.shardDrag;
    }

    shards.vx[i] = vx;
    shards.vy[i] = vy;
    shards.x[i] += vx * DT;
    shards.y[i] += vy * DT;
  }
}

/**
 * Put XP on the player and check the threshold.
 *
 * Every XP source comes through here, including the debug `grantXp` hook, so the
 * level-up rule lives in one place.
 */
export function awardXp(w: World, xp: number): void {
  w.player.xp += xp;
  checkLevelUp(w);
}

/** XP that buys the next level: the per-level costs summed up to `level`. */
function xpForNext(level: number): number {
  let need = 0;
  for (let l = 1; l <= level; l++) need += TUNE.xpBase + (l - 1) * TUNE.xpStep;
  return need;
}

/**
 * Open an offer if one is owed.
 *
 * One offer at a time, and a threshold crossed while one is already up is offered
 * as soon as that one is taken. When nothing is left to offer, XP just keeps
 * accumulating instead of freezing the game on an empty screen.
 */
function checkLevelUp(w: World): void {
  if (w.pendingLevelUp) return;
  if (w.player.xp < xpForNext(w.player.level)) return;
  if (!buildChoices(w, false)) return;

  w.pendingLevelUp = true;
  w.rerollUsed = false;
  pushEvent(w, Ev.LevelUp, w.player.level, 0, w.player.x, w.player.y);
}

/**
 * Fill world.levelUpChoices with `pickCount` cards.
 *
 * Returns false when it could not change the offer, which is how a reroll refuses
 * rather than showing the same three cards again.
 */
function buildChoices(w: World, mustDiffer: boolean): boolean {
  const cards = w.levelUpChoices;
  const count = cards.length;

  let poolSize = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    if (w.powerTiers[i] < POWERUPS[i].maxTier) poolBuf[poolSize++] = i;
  }
  if (poolSize === 0) return false;

  if (mustDiffer) sortInto(prevBuf, cards);

  for (let attempt = 0; attempt < TUNE.rerollTries; attempt++) {
    deal(w, count, poolSize);
    sortInto(nextBuf, offerBuf);
    if (!mustDiffer || !sameOffer(prevBuf, nextBuf)) {
      for (let k = 0; k < count; k++) cards[k] = offerBuf[k];
      return true;
    }
  }
  return false;
}

/**
 * Deal the cards out of the candidate pool.
 *
 * Each pick is swapped to the back of a shrinking room, so cards stay distinct
 * while the pool has space for three; once the room empties it refills, which is
 * the only way a repeat can reach the screen, and only while the run has fewer
 * than three power-ups left to take. (`room` rather than the obvious shorter word
 * because the purity gate reads that one as the DOM.)
 */
function deal(w: World, count: number, poolSize: number): void {
  let room = poolSize;
  for (let k = 0; k < count; k++) {
    if (room === 0) room = poolSize;
    const pick = nextInt(w.rng, room);
    offerBuf[k] = poolBuf[pick];
    const last = room - 1;
    const swap = poolBuf[pick];
    poolBuf[pick] = poolBuf[last];
    poolBuf[last] = swap;
    room = last;
  }
}

/** Ascending copy of one offer into scratch, so two offers compare as multisets. */
function sortInto(out: Int32Array, src: Int32Array): void {
  out.set(src);
  for (let i = 1; i < out.length; i++) {
    const value = out[i];
    let j = i - 1;
    while (j >= 0 && out[j] > value) {
      out[j + 1] = out[j];
      j--;
    }
    out[j + 1] = value;
  }
}

function sameOffer(a: Int32Array, b: Int32Array): boolean {
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Reroll the offer, once per level-up.
 *
 * False means it refused: the reroll is already spent, or the pool cannot offer
 * anything different. A spent reroll stays spent either way.
 */
export function reroll(w: World): boolean {
  if (!w.pendingLevelUp || w.rerollUsed) return false;
  w.rerollUsed = true;
  return buildChoices(w, true);
}

/**
 * Take card `index` (0 to pickCount - 1), from a key, a click or a replay frame.
 *
 * The power-up goes up a tier and the level goes up; if the XP already carried
 * another level, the next offer is built straight away.
 */
export function choosePick(w: World, index: number): boolean {
  if (!w.pendingLevelUp) return false;
  const pick = index >= 0 && index < w.levelUpChoices.length ? w.levelUpChoices[index] : -1;
  if (pick < 0) return false;

  grantPowerup(w, pick);
  w.pendingLevelUp = false;
  w.rerollUsed = false;
  w.player.level++;
  checkLevelUp(w);
  return true;
}

/**
 * Raise power-up `index` one tier and refold the stat block.
 *
 * Tier stops at the def's maxTier, so a sixth copy of anything does nothing rather
 * than stacking forever. Also the door chests and future drops come through.
 */
export function grantPowerup(w: World, index: number): boolean {
  if (index < 0 || index >= POWERUPS.length) return false;
  const def = POWERUPS[index];
  const tier = w.powerTiers[index];
  if (tier >= def.maxTier) return false;

  w.powerTiers[index] = tier + 1;
  recomputeStats(w);
  return true;
}

/**
 * Rebuild the multipliers from the tiers held, in content order.
 *
 * Reset-then-apply rather than multiply-on-grant: the result depends on which
 * power-ups are held and at what tier, never on the order they arrived or how many
 * ticks they have been held.
 */
export function recomputeStats(w: World): void {
  const stats = w.stats;
  stats.dmg = 1;
  stats.fireRate = 1;
  stats.magnet = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    const tier = w.powerTiers[i];
    if (tier > 0) POWERUPS[i].apply(stats, tier);
  }
}
