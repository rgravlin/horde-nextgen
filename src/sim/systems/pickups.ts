/**
 * XP shards, supply crates and the level-up offer.
 *
 * A shard drifts, then homes once the player's magnet field reaches it, and paying
 * one in is what drives XP. Crossing a threshold builds three cards out of the
 * power-ups still worth taking and leaves `pendingLevelUp` set: the sim does not
 * show a screen, it says one is owed, and only `playing` ticks (ARCHITECTURE.md
 * "Scene state machine"). Drawing, reroll and pick all read world.rng, so a replay
 * of the same seed and the same picks gets the same cards.
 *
 * A crate is the other half of how a run gets stronger, and it is *placed* by the wave
 * spawner rather than here (see `dropChest`): a crate only earns its keep where the
 * player has to walk somewhere on purpose, so it marks where a fresh pack is assembling
 * off-screen — away from the player and only once the arena is busy enough that the
 * detour has something to spend it on. What it pays is decided when it is opened rather
 * than when it is dropped — a crate that rolled its contents on the floor could roll
 * one the run had already maxed out, and a reward that cannot be spent is not one.
 */

import { ENEMIES } from '../../content/enemies';
import { POWERUPS } from '../../content/powerups';
import { WEAPONS } from '../../content/weapons';
import { nextInt } from '../rng';
import { DT, Ev, TUNE, alloc, loadSlot, pushEvent, release, type World } from '../world';
import { recomputeStats, startTime } from './powerups';

/** Scratch for the offer draw: allocated with the module, reused by every offer. */
const poolBuf = new Int32Array(POWERUPS.length);
const offerBuf = new Int32Array(TUNE.pickCount);
const prevBuf = new Int32Array(TUNE.pickCount);
const nextBuf = new Int32Array(TUNE.pickCount);

/** Scratch for a crate's gun draw. Kept apart from `poolBuf` so the two never overlap. */
const gunBuf = new Int32Array(WEAPONS.length);

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

/** XP the player has to be holding to reach `level`, summed from level 1 up. */
export function xpForLevel(level: number): number {
  let need = 0;
  for (let l = 1; l <= level; l++) need += TUNE.xpBase + (l - 1) * TUNE.xpStep;
  return need;
}

/**
 * How far through the current level the XP bar is, 0..1.
 *
 * The overlay asks for this instead of redoing the maths: the thresholds are a sim
 * rule, and a second copy of them in the HUD would drift away from the game.
 */
export function xpProgress(w: World): number {
  const low = xpForLevel(w.player.level - 1);
  const span = xpForLevel(w.player.level) - low;
  if (span <= 0) return 0;
  const progress = (w.player.xp - low) / span;
  return progress < 0 ? 0 : progress > 1 ? 1 : progress;
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
  if (w.player.xp < xpForLevel(w.player.level)) return;
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
 * than stacking forever. Both doors come through here — the level-up card and a supply
 * crate — so a card cannot be half-granted by whichever one picked it, and a timed dose
 * picked while an earlier dose is still running is *re-dosed* at the new tier rather
 * than adding a second copy of the same drug.
 */
export function grantPowerup(w: World, index: number): boolean {
  if (index < 0 || index >= POWERUPS.length) return false;
  const def = POWERUPS[index];
  const tier = w.powerTiers[index];
  if (tier >= def.maxTier) return false;

  w.powerTiers[index] = tier + 1;
  if (def.kind === 'timed' && def.duration !== undefined) startTime(w, index, def.duration);
  recomputeStats(w);
  return true;
}

/**
 * Put a supply crate on the floor at (x, y).
 *
 * Called from the wave spawner when a pack arrives, and only for a pack that is worth
 * walking to: `TUNE.chestMinDist` from the player and into an arena already holding at
 * least `TUNE.chestPackFloor` bodies. Both conditions matter. A crate at the player's
 * feet is a thing they walked past, and a crate in an empty stretch has nothing to spend
 * it on; between them they would turn the reward channel into noise.
 *
 * The crate carries no contents yet — `state` and `kind` are filled when it opens.
 */
export function dropChest(w: World, x: number, y: number): boolean {
  const i = alloc(w.chests);
  if (i < 0) return false;

  const chests = w.chests;
  chests.x[i] = x;
  chests.y[i] = y;
  chests.life[i] = TUNE.chestLife;
  return true;
}

/**
 * One tick of the crates: rot, then open.
 *
 * A crate opens on proximity rather than on a key because the answer it asks for is a
 * routing one — do I break left toward that crate or keep backing up? — and a prompt the
 * player has to stop to answer turns every reward into an interruption. It sits inside
 * the same walk-over radius a shard uses, so a pickup is one verb.
 */
export function updateChests(w: World): void {
  const chests = w.chests;
  if (chests.count === 0 || !w.player.alive) return;

  const open2 = TUNE.chestOpenRadius * TUNE.chestOpenRadius;

  for (let i = 0; i < chests.cap; i++) {
    if (chests.alive[i] === 0) continue;

    chests.life[i] -= DT;
    if (chests.life[i] <= 0) {
      release(chests, i);
      continue;
    }

    const dx = w.player.x - chests.x[i];
    const dy = w.player.y - chests.y[i];
    if (dx * dx + dy * dy > open2) continue;

    pushEvent(w, Ev.Pickup, i, chests.kind[i], chests.x[i], chests.y[i]);
    payChest(w);
    release(chests, i);
  }
}

/**
 * Hand out what the crate the player is standing on has decided to hold.
 *
 * Three payouts, in this order, and the order is the design: an empty second hand is
 * worth more than another tier of something they already run, so a crate fills a hand
 * first and only then upgrades. A run with two guns and everything maxed gets XP
 * instead, because a crate that pays nothing reads as a bug even when it is correct.
 *
 * The gun is drawn from the ones the run does not already hold, so a crate cannot hand
 * back a second copy of the pistol and feel like a letdown; the power-up is drawn from
 * the ones still below their cap, which is the same pool the level-up cards draw from.
 */
function payChest(w: World): void {
  const empty = w.slots.findIndex((hand) => hand.weapon < 0);
  const guns = listGuns(w);

  if (empty >= 0 && guns > 0) {
    const hand = w.slots[empty];
    loadSlot(hand, gunBuf[nextInt(w.rng, guns)]);
    // The crate's gun becomes the one in play: a reward you have to swap hands to feel
    // is a reward the player assumes never happened.
    w.activeSlot = empty;
    return;
  }

  const powers = listPowerups(w);
  if (powers > 0) {
    grantPowerup(w, poolBuf[nextInt(w.rng, powers)]);
    return;
  }

  awardXp(w, 4);
}

/** The guns the run is not already holding, into `gunBuf`; how many there were. */
function listGuns(w: World): number {
  let n = 0;
  for (let i = 0; i < WEAPONS.length; i++) {
    if (w.slots[0].weapon === i || w.slots[1].weapon === i) continue;
    gunBuf[n++] = i;
  }
  return n;
}

/** The power-ups still below their cap, into `poolBuf`; how many there were. */
function listPowerups(w: World): number {
  let n = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    if (w.powerTiers[i] < POWERUPS[i].maxTier) poolBuf[n++] = i;
  }
  return n;
}
