/**
 * Run fingerprinting: FNV-1a over the pools and the player.
 *
 * hashWorld is what determinism is measured with — the same seed plus the same
 * input log must give the same number (TECH.md "Determinism") — so it covers
 * every field a divergence could show up in, including the rng state and the
 * free-list shape, and it reads only, never writes.
 *
 * Floats are hashed as their stored 32-bit patterns: values go through
 * Float32Array, so two runs that agree bit for bit agree on any machine that
 * runs this code.
 */

import type { Pool, World } from './world';

const FNV_OFFSET = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

/** One shared 4-byte scratch, so hashing a float costs one write and one read. */
const fbytes = new Float32Array(1);
const fwords = new Uint32Array(fbytes.buffer);

export function fnv32Init(): number {
  return FNV_OFFSET;
}

/** Mix one byte into the running hash. */
export function fnv32Byte(h: number, b: number): number {
  return Math.imul(h ^ (b & 0xff), FNV_PRIME) >>> 0;
}

/** Mix four bytes at once. */
export function fnv32Word(h: number, w: number): number {
  h = Math.imul(h ^ (w & 0xff), FNV_PRIME) >>> 0;
  h = Math.imul(h ^ ((w >>> 8) & 0xff), FNV_PRIME) >>> 0;
  h = Math.imul(h ^ ((w >>> 16) & 0xff), FNV_PRIME) >>> 0;
  h = Math.imul(h ^ ((w >>> 24) & 0xff), FNV_PRIME) >>> 0;
  return h;
}

function mixFloats(h: number, a: Float32Array): number {
  for (let i = 0; i < a.length; i++) {
    fbytes[0] = a[i];
    h = fnv32Word(h, fwords[0]);
  }
  return h;
}

/** Fold a single scalar field in, at its Float32 precision. */
function mixScalar(h: number, v: number): number {
  fbytes[0] = v;
  return fnv32Word(h, fwords[0]);
}

function mixU16s(h: number, a: Uint16Array): number {
  for (let i = 0; i < a.length; i += 2) {
    const w = i + 1 < a.length ? (a[i] | (a[i + 1] << 16)) >>> 0 : a[i];
    h = fnv32Word(h, w);
  }
  return h;
}

function mixU8s(h: number, a: Uint8Array): number {
  for (let i = 0; i < a.length; i += 4) {
    let w = a[i];
    if (i + 1 < a.length) w |= a[i + 1] << 8;
    if (i + 2 < a.length) w |= a[i + 2] << 16;
    if (i + 3 < a.length) w |= a[i + 3] << 24;
    h = fnv32Word(h, w);
  }
  return h;
}

/** Fold one pool into the hash: live count, free-list shape, then every slot. */
export function hashPool(h: number, p: Pool): number {
  h = fnv32Word(h, p.count);
  h = fnv32Word(h, p.freeCount);
  h = mixU8s(h, p.alive);
  h = mixFloats(h, p.x);
  h = mixFloats(h, p.y);
  h = mixFloats(h, p.vx);
  h = mixFloats(h, p.vy);
  h = mixFloats(h, p.hp);
  h = mixFloats(h, p.age);
  h = mixFloats(h, p.life);
  h = mixU16s(h, p.kind);
  h = mixU16s(h, p.state);
  h = mixFloats(h, p.dotT);
  h = mixFloats(h, p.dotDps);
  // The behaviour slots. A divergence in a state machine is exactly the kind of thing this
  // fingerprint exists to catch — a charger that winds up a tick late has the same
  // positions as one that does not, for a while — so they are covered, not just the health.
  h = mixU8s(h, p.phase);
  h = mixFloats(h, p.timer);
  h = mixFloats(h, p.fx);
  h = mixFloats(h, p.fy);
  // The elite variant. Same reasoning as the behaviour slots above: two runs whose
  // bodies differ only in which of them arrived as a bulwark are two different hordes,
  // and the whole value of this fingerprint is that it notices.
  h = mixU8s(h, p.elite);
  return h;
}

/** FNV-1a fingerprint of the whole World, as an unsigned 32-bit integer. */
export function hashWorld(world: World): number {
  let h = FNV_OFFSET;

  h = fnv32Word(h, world.tick);
  h = fnv32Word(h, world.chapter);
  h = fnv32Word(h, world.errors);
  h = mixScalar(h, world.score);
  h = fnv32Word(h, world.kills);

  for (let i = 0; i < 4; i++) h = fnv32Word(h, world.rng.s[i]);

  const p = world.player;
  h = mixScalar(h, p.x);
  h = mixScalar(h, p.y);
  h = mixScalar(h, p.vx);
  h = mixScalar(h, p.vy);
  h = mixScalar(h, p.hp);
  h = mixScalar(h, p.shield);
  h = mixScalar(h, p.xp);
  h = fnv32Word(h, p.level);
  h = mixScalar(h, p.dashCd);
  h = mixScalar(h, p.dashTime);
  h = mixScalar(h, p.iframes);
  h = mixScalar(h, p.aimX);
  h = mixScalar(h, p.aimY);
  h = fnv32Byte(h, p.alive ? 1 : 0);

  // The run's own combat state, not just the pools: a magazine that drained a tick
  // late, a wave timer that drifted or a power-up tier that double-counted would
  // otherwise fingerprint the same as a clean run.
  h = fnv32Byte(h, world.over ? 1 : 0);
  h = mixScalar(h, world.enemyNear);
  for (let i = 0; i < world.slots.length; i++) {
    const slot = world.slots[i];
    h = fnv32Word(h, slot.weapon);
    h = fnv32Word(h, slot.ammo);
    h = mixScalar(h, slot.cooldown);
    h = mixScalar(h, slot.reload);
    h = mixScalar(h, slot.charge);
    h = mixScalar(h, slot.heat);
    h = fnv32Byte(h, slot.venting ? 1 : 0);
    h = mixScalar(h, slot.energy);
    h = mixScalar(h, slot.beam);
  }
  h = fnv32Byte(h, world.activeSlot);
  h = mixU8s(h, world.powerTiers);
  // The timed buffs' clocks, not just which ones are owned: a run that spent its
  // Adrenaline three seconds ago and one that still has it are one tier array apart and
  // a different game, so the clock has to be in the fingerprint for the difference to
  // show up anywhere.
  h = mixFloats(h, world.powerTime);
  h = fnv32Byte(h, world.pendingLevelUp ? 1 : 0);
  h = fnv32Byte(h, world.rerollUsed ? 1 : 0);
  for (let i = 0; i < world.levelUpChoices.length; i++) h = fnv32Word(h, world.levelUpChoices[i]);
  h = fnv32Byte(h, world.wave.running ? 1 : 0);
  h = fnv32Word(h, world.wave.index);
  h = mixScalar(h, world.wave.timeLeft);
  h = mixScalar(h, world.wave.timer);
  // Where the wave's pack recipe has got to. It decides what the next batch is, so two
  // runs that disagree here are spawning different enemies from here on.
  h = fnv32Word(h, world.wave.cursor);
  // `blasts` is deliberately not covered: the stack is drained every tick, so between
  // ticks it is always empty and hashing it would cost four scans for one constant.

  h = hashPool(h, world.enemies);
  h = hashPool(h, world.shots);
  h = hashPool(h, world.enemyShots);
  h = hashPool(h, world.shards);
  // A crate is state that outlives the tick it was made on, unlike the blast stack, so
  // it is covered rather than skipped.
  h = hashPool(h, world.chests);

  return h >>> 0;
}
