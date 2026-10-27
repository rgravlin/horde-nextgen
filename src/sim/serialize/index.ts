/**
 * Save and restore: the whole World as one JSON-safe object.
 *
 * This is half of the persistence feature; the other half (`src/game/persistence.ts`) owns
 * the localStorage read and write through the `StorageLike` port. Nothing here touches
 * storage, a clock or the DOM: `serialize` turns a World into plain JSON and
 * `deserialize` builds a World from plain JSON, so a unit test in Node and the game in a
 * browser read and write the same file (ARCHITECTURE.md "One shared core, two runtimes").
 *
 * **What counts as "the state of the run".** The rule is: everything the fingerprint
 * reads, plus the floor the fight stands on, plus the sizes the World was built with.
 * That is deliberately not "the fields a save screen shows". Two facts drive it:
 *
 * - `hashWorld` folds every slot of every pool, and a dead slot is not empty. `alloc`
 *   clears a slot on the way *in*, so a released one keeps the position, damage and
 *   pierce count of the round that died in it. Copying only the living bodies would
 *   restore a fight that looks identical and fingerprints differently — and a save that
 *   keeps the fingerprint intact is what lets a corrupted resume get noticed at all.
 * - A pool's *free stack* decides where the next body lands, because `alloc` pops it and
 *   everything else iterates pool slots lowest index first. Allocation order is iteration
 *   order, and iteration order is what a piercing shot hits first. The fingerprint only
 *   reads `freeCount`; the continuation needs the order, so the order travels.
 *
 * **Two shapes of payload.** The scalars — the player, both hands, the wave clock, the
 * hazard clocks, the stat block — go out as JSON numbers, because a save a person can
 * read is a save that can be debugged when a resume goes wrong, and because these are
 * doubles (XP and score especially): taking them through 32 bits would round them, which
 * changes what the run does next and not merely how it fingerprints. The bulk arrays go
 * out as base64, because a pool is thousands of Float32 and decimal text would cost about
 * ten times the bytes to say the same thing — and because a byte carries a float's bit
 * pattern exactly, including the `-0` that bodies' facing and velocity pick up on any
 * axis that came out flat, which the fingerprint reads as a different number.
 *
 * **Why the bytes are run-length packed.** A quiet pool is 2,048 slots of zeros, and a
 * busy one is a hundred-odd slots of numbers scattered through them. Packing each blob
 * takes a full-capacity World from a few hundred kilobytes of text to a few tens, which
 * matters because this is written to storage every 30 s and at every chapter end.
 *
 * **What is left out, and why that is not an omission.** The event ring, the particle and
 * light field, and the two cached indexes: the broad-phase grid, which `step` rebuilds at the
 * top of every tick, and the prop field's cell index, which `deserialize` rebuilds from the
 * boxes it restored. None of them carries across a tick: the ring is a broadcast that its
 * consumers drain once per rendered frame, and nothing in the sim reads `fx` (see `fx.ts`). A
 * resumed run starts those empty, which is what it should — a resume that spent its first
 * frame re-drawing last chapter's sparks would be a resume with a visual lie in it. Also left
 * out: the loss counters (`props.dropped`, `blasts.dropped`, `fx.dropped`,
 * `hash.queryOverflow`), which record what a previous build of a field could not hold, and the
 * blast stack's contents, which are empty between ticks by construction.
 *
 * **Blob layout.** One blob is the concatenation of its columns, little-endian, then
 * run-length packed, then base64'd. A packed stream is a sequence of chunks: a `0` byte
 * begins a repeat (next byte = count 1..255, one after = the byte to repeat) and any
 * other byte is the length of the literal run that follows it. The column lists are the
 * tables below, read in the same order both ways, so the format is written down once.
 *
 * **One limit.** Pool slot numbers travel in sixteen bits, so a World built with a pool
 * of more than 65,536 slots does not round-trip and is refused on the way in — the same
 * check bounds what a corrupt save can ask the allocator for. The caps in `POOL_CAPS` top
 * out at 2,048, and `createWorld` is the only other door to a pool size.
 */

import { createWorld, type Pool, type World } from '../world';
import { decodeBlob, encodeBlob } from './blobs';
import { packFloor, packPool, unpackFloor, unpackPool } from './pools';
import { copyRecord, list } from './record';
import type { FloorBlob, PoolBlob } from './pools';

// The three pieces this file joins: `blobs.ts` is the byte codec, `pools.ts` the World's
// bulk and `record.ts` the shape checks a restore runs. The public surface below is the one
// `src/sim/serialize.ts` had, so `replay.ts` and the tests keep coming through the same door.
export { decodeBlob, encodeBlob, type Column } from './blobs';

/** The one snapshot shape this build writes, and the only one it reads. */
export const SAVE_VERSION = 'v1';

/**
 * Bits in `Snapshot.state`'s last entry, in the spirit of `InputBit`.
 *
 * Flags are a bitfield rather than a fistful of JSON booleans for the same reason the packed
 * input frame keeps its flags in bits: one number to check, and the shapes a run can be in read
 * off one field rather than several. The bound in `deserialize` is the width of this field — add
 * a bit there and raise it there, or a payload that carries the new bit is refused as corrupt.
 */
export const StateBit = {
  /** The player is dead, so the run is showing its summary. */
  Over: 1,
  /** The chapter's encounter is down and its floor has not been replaced yet. */
  ChapterComplete: 2,
  /** Every chapter has fallen. */
  Victory: 4,
  /** Auto-fire is on. */
  AutoFire: 8,
  /** A level-up offer is waiting. */
  PendingLevelUp: 16,
  /** The run's one reroll has been spent. */
  RerollUsed: 32,
  /** The run is an Endless Arena run, which decides the floor and the ladder (see `layoutOf`). */
  Endless: 64,
} as const;

/**
 * `state` is `[tick, time, chapter, errors, kills, score, enemyNear, nearest,
 * activeSlot, flags]`.
 *
 * `enemyNear` is `null` where the arena is empty: it lives as `Infinity` in the World,
 * which JSON has no spelling for, and a bare `0` read back would mean "an enemy is
 * touching me", which is what switches auto-fire on.
 */
const STATE_LEN = 10;

/** The most slots this format can carry, because slot numbers travel in sixteen bits. */
const MAX_SLOTS = 65536;

/** The most broad-phase cells a save may ask for. See `deserialize`. */
const MAX_GRID_CELLS = 65536;

/** A saved run, as it sits in `neonhorde.save.v1`. */
export interface Snapshot {
  v: string;
  seed: number;
  /** The run-level scalars, in the order documented above. */
  state: (number | null)[];
  /** `[minX, minY, maxX, maxY]`: the box the run is being played in right now. */
  arena: number[];
  /** The five pool caps, the blast stack, then the event ring and query buffer sizes. */
  size: number[];
  /** `[broad-phase cell edge, built arena half-edge]`: what the two grids were sized from. */
  grid: number[];
  rng: number[];
  player: Record<string, unknown>;
  hands: Record<string, unknown>[];
  /** The three cards on the waiting offer, `-1` for an empty slot. */
  cards: number[];
  /** Power-up tiers, one byte per `POWERUPS` entry. */
  tiers: string;
  /** The timed buffs' clocks, one Float32 per `POWERUPS` entry. */
  clocks: string;
  stats: Record<string, unknown>;
  wave: Record<string, unknown>;
  boss: Record<string, unknown>;
  floor: FloorBlob;
  pools: Record<string, PoolBlob>;
}

/** Write the run out. Every value in the result is plain JSON. */
export function serialize(w: World): Snapshot {
  const flags =
    (w.over ? StateBit.Over : 0) |
    (w.chapterComplete ? StateBit.ChapterComplete : 0) |
    (w.victory ? StateBit.Victory : 0) |
    (w.autoFire ? StateBit.AutoFire : 0) |
    (w.pendingLevelUp ? StateBit.PendingLevelUp : 0) |
    (w.rerollUsed ? StateBit.RerollUsed : 0) |
    (w.endless ? StateBit.Endless : 0);

  return {
    v: SAVE_VERSION,
    seed: w.seed,
    state: [
      w.tick, w.time, w.chapter, w.errors, w.kills, w.score,
      Number.isFinite(w.enemyNear) ? w.enemyNear : null, w.nearest, w.activeSlot, flags,
    ],
    arena: [w.minX, w.minY, w.maxX, w.maxY],
    size: [
      w.enemies.cap, w.shots.cap, w.enemyShots.cap, w.shards.cap, w.chests.cap,
      w.blasts.cap, w.events.cap, w.query.length,
    ],
    grid: [w.props.cell, -w.props.minX],
    rng: [w.rng.s[0], w.rng.s[1], w.rng.s[2], w.rng.s[3]],
    player: { ...w.player },
    hands: w.slots.map((slot) => ({ ...slot })),
    cards: [...w.levelUpChoices],
    tiers: encodeBlob([w.powerTiers]),
    clocks: encodeBlob([w.powerTime]),
    stats: { ...w.stats },
    wave: { ...w.wave },
    boss: { ...w.boss },
    floor: { props: w.props.n, zones: w.zones.n, data: packFloor(w.props, w.zones) },
    pools: {
      enemies: { count: w.enemies.count, free: w.enemies.freeCount, data: packPool(w.enemies) },
      shots: { count: w.shots.count, free: w.shots.freeCount, data: packPool(w.shots) },
      enemyShots: { count: w.enemyShots.count, free: w.enemyShots.freeCount, data: packPool(w.enemyShots) },
      shards: { count: w.shards.count, free: w.shards.freeCount, data: packPool(w.shards) },
      chests: { count: w.chests.count, free: w.chests.freeCount, data: packPool(w.chests) },
    },
  };
}

/**
 * Build a World from a saved run, or return null if what was handed over is not one.
 *
 * Null rather than an exception or a half-filled World: a bad save is discarded, and the
 * caller counts it. Nothing here throws, so a save truncated in storage cannot take the
 * game down with it.
 *
 * The World is rebuilt from `createWorld` first, at the sizes the save says it was built
 * at — the pool lengths are part of the fingerprint, and the two grid sizes decide which
 * walls a body can hide behind — and then the values are copied over it.
 */
export function deserialize(data: unknown): World | null {
  if (typeof data !== 'object' || data === null) return null;
  const s = data as Record<string, unknown>;
  if (s.v !== SAVE_VERSION) return null;
  if (typeof s.seed !== 'number' || !Number.isFinite(s.seed)) return null;

  const state = list(s.state, STATE_LEN);
  const arena = list(s.arena, 4);
  const size = list(s.size, 8);
  const grid = list(s.grid, 2);
  const rng = list(s.rng, 4);
  const cards = list(s.cards, 3);
  if (state === null || arena === null || size === null || grid === null) return null;
  if (rng === null || cards === null) return null;

  // The generator's words are 32-bit. Writing something else into a Uint32Array wraps it
  // silently, which is a restored run with a quietly different random stream.
  for (const v of rng) {
    if (typeof v !== 'number' || !(v >= 0 && v < 0x1_0000_0000)) return null;
  }

  const cell = grid[0] as number;
  const half = grid[1] as number;
  if (cell <= 0 || half <= 0) return null;

  // Both of those numbers size an allocation rather than hold a value: the broad phase is one
  // Int32Array per cell, so a save that claimed a ten-kilometre arena at a tenth-of-a-metre
  // cell would ask for a quarter of a billion cells before anything looked at whether its
  // shape made sense. The bound sits above every arena the game ships (a 200 m room at 2 m
  // cells is 10,000 cells) and below anything that can run the browser out of memory.
  const cells = Math.ceil((2 * half) / cell);
  if (cells * cells > MAX_GRID_CELLS) return null;

  for (const v of size) {
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_SLOTS) return null;
  }
  const flags = state[9] as number;
  if (!Number.isInteger(flags) || flags < 0 || flags > 127) return null;

  const w = createWorld(s.seed, {
    enemies: size[0] as number,
    projectiles: size[1] as number,
    enemyProjectiles: size[2] as number,
    shards: size[3] as number,
    chests: size[4] as number,
    blasts: size[5] as number,
    eventCap: size[6] as number,
    queryCap: size[7] as number,
    hashCell: cell,
    arenaHalf: half,
  });

  w.tick = state[0] as number;
  w.time = state[1] as number;
  w.chapter = state[2] as number;
  w.errors = state[3] as number;
  w.kills = state[4] as number;
  w.score = state[5] as number;
  w.enemyNear = state[6] === null ? Infinity : (state[6] as number);
  w.nearest = state[7] as number;
  w.activeSlot = state[8] as number;
  if (w.activeSlot < 0 || w.activeSlot >= w.slots.length) return null;
  w.over = (flags & StateBit.Over) !== 0;
  w.chapterComplete = (flags & StateBit.ChapterComplete) !== 0;
  w.victory = (flags & StateBit.Victory) !== 0;
  w.autoFire = (flags & StateBit.AutoFire) !== 0;
  w.pendingLevelUp = (flags & StateBit.PendingLevelUp) !== 0;
  w.rerollUsed = (flags & StateBit.RerollUsed) !== 0;
  // Before the floor is unpacked: `layoutOf` is how the renderer, the soundtrack and the
  // fingerprint decide which room this is, and an arena run restored as a chapter-0 run would
  // keep whatever air the page was already wearing.
  w.endless = (flags & StateBit.Endless) !== 0;

  w.minX = arena[0] as number;
  w.minY = arena[1] as number;
  w.maxX = arena[2] as number;
  w.maxY = arena[3] as number;
  for (let i = 0; i < 4; i++) w.rng.s[i] = rng[i] as number;
  for (let i = 0; i < 3; i++) w.levelUpChoices[i] = cards[i] as number;

  const records: Array<[unknown, object]> = [
    [s.player, w.player],
    [s.stats, w.stats],
    [s.wave, w.wave],
    [s.boss, w.boss],
  ];
  if (!Array.isArray(s.hands) || s.hands.length !== w.slots.length) return null;
  for (let i = 0; i < w.slots.length; i++) records.push([s.hands[i], w.slots[i]]);
  for (const [src, dest] of records) {
    if (!copyRecord(src, dest)) return null;
  }

  if (typeof s.tiers !== 'string' || typeof s.clocks !== 'string') return null;
  if (!decodeBlob(s.tiers, [w.powerTiers])) return null;
  if (!decodeBlob(s.clocks, [w.powerTime])) return null;

  if (typeof s.floor !== 'object' || s.floor === null) return null;
  if (!unpackFloor(s.floor as FloorBlob, w.props, w.zones)) return null;

  if (typeof s.pools !== 'object' || s.pools === null) return null;
  const saved = s.pools as Record<string, PoolBlob>;
  const live: Array<[PoolBlob | undefined, Pool]> = [
    [saved.enemies, w.enemies],
    [saved.shots, w.shots],
    [saved.enemyShots, w.enemyShots],
    [saved.shards, w.shards],
    [saved.chests, w.chests],
  ];
  for (const [src, dest] of live) {
    if (src === undefined || !unpackPool(src, dest)) return null;
  }

  return w;
}

