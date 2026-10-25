/**
 * Save and restore: the whole World as one JSON-safe object.
 *
 * This is half of the persistence feature; the other half (`src/game/persist.ts`) owns
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

import { buildGrid, type PropField, type ZoneField } from './systems/obstacles';
import { createWorld, type Pool, type World } from './world';

/** The one snapshot shape this build writes, and the only one it reads. */
export const SAVE_VERSION = 'v1';

/**
 * Bits in `Snapshot.state`'s last entry, in the spirit of `InputBit`.
 *
 * Flags are a bitfield rather than six JSON booleans for the same reason the packed input
 * frame keeps its flags in bits: one number to check, and the shapes a run can be in read
 * off one field rather than six.
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

/** One pool: the two counters the fingerprint reads, then the bytes. */
export interface PoolBlob {
  /** Live slots (`pool.count`). */
  count: number;
  /** Depth of the free stack (`pool.freeCount`). */
  free: number;
  /** The pool's columns and its free stack, packed and base64'd. */
  data: string;
}

/** The chapter's floor: cover boxes and hazard circles, with the hazards' clocks. */
export interface FloorBlob {
  /** Cover boxes installed. */
  props: number;
  /** Hazards installed. */
  zones: number;
  /** Both fields' columns, packed and base64'd. */
  data: string;
}

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

/**
 * The pool columns, in the order `hashPool` folds them (see `hash.ts`).
 *
 * The order is the fingerprint's rather than an invention: read side by side, the two
 * lists are how "the snapshot carries everything the fingerprint reads" stays checkable.
 */
const POOL_COLS = [
  'alive', 'x', 'y', 'vx', 'vy', 'hp', 'age', 'life', 'kind', 'state',
  'dotT', 'dotDps', 'phase', 'timer', 'fx', 'fy', 'elite',
] as const;

/** The cover field's columns, then the hazard field's. */
const PROP_COLS = ['kind', 'x0', 'y0', 'x1', 'y1', 'rad'] as const;
const ZONE_COLS = ['kind', 'x', 'y', 'r', 'dps', 'gap', 'warn', 't', 'armed'] as const;

/** A column of a blob: one of the typed arrays the World is made of, at its width. */
export type Column = Uint8Array | Uint16Array | Uint32Array | Float32Array;

/** One column's element width, shared by both directions so they cannot drift apart. */
function columnWidth(col: Column): number {
  if (col instanceof Uint8Array) return 1;
  if (col instanceof Uint16Array) return 2;
  return 4;
}

function totalWidth(cols: readonly Column[]): number {
  let total = 0;
  for (const c of cols) total += c.length * columnWidth(c);
  return total;
}

/**
 * Write the columns into one little-endian byte stream.
 *
 * Little-endian and explicit rather than a copy of the arrays' backing bytes, so the
 * bytes mean the same thing on whatever machine opens the file — the same reasoning that
 * makes `hash.ts` fold floats at their 32-bit patterns.
 */
function packColumns(cols: readonly Column[], out: Uint8Array): void {
  const view = new DataView(out.buffer);
  let at = 0;
  for (const c of cols) {
    if (c instanceof Uint8Array) {
      out.set(c, at);
      at += c.length;
    } else if (c instanceof Uint16Array) {
      for (let i = 0; i < c.length; i++, at += 2) view.setUint16(at, c[i], true);
    } else if (c instanceof Uint32Array) {
      for (let i = 0; i < c.length; i++, at += 4) view.setUint32(at, c[i], true);
    } else {
      for (let i = 0; i < c.length; i++, at += 4) view.setFloat32(at, c[i], true);
    }
  }
}

/**
 * Read a byte stream back into the columns it came from.
 *
 * The length has to land exactly on the end of the stream: a blob that decodes short or
 * long is a blob that got truncated in storage, and that is a discarded save rather than
 * a partly restored one.
 */
function unpackColumns(bytes: Uint8Array, cols: readonly Column[]): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  for (const c of cols) {
    const width = columnWidth(c);
    if (at + c.length * width > bytes.length) return false;
    if (c instanceof Uint8Array) {
      c.set(bytes.subarray(at, at + c.length));
      at += c.length;
    } else if (width === 2) {
      const to = c as Uint16Array;
      for (let i = 0; i < to.length; i++, at += 2) to[i] = view.getUint16(at, true);
    } else if (c instanceof Uint32Array) {
      const to = c as Uint32Array;
      for (let i = 0; i < to.length; i++, at += 4) to[i] = view.getUint32(at, true);
    } else {
      const to = c as Float32Array;
      for (let i = 0; i < to.length; i++, at += 4) to[i] = view.getFloat32(at, true);
    }
  }
  return at === bytes.length;
}

/** Below this many equal bytes in a row it is cheaper to write them out than to say so. */
const MIN_RUN = 4;

/** The most literal bytes one chunk can carry. */
const MAX_LIT = 255;

/**
 * Run-length pack a byte stream.
 *
 * Equal runs of four or more become a three-byte chunk, which is the whole point: a pool
 * that is mostly zeros — every slot nothing was ever allocated in, and most of the ones
 * that have — comes back at a fraction of its size. Literals are buffered, so a stretch
 * of real numbers pays one header per 255 bytes rather than per byte.
 */
function packBytes(src: Uint8Array): Uint8Array {
  // Every chunk costs no more than the bytes it covers plus one header byte, and a
  // literal chunk either reaches 255 bytes or is the last thing written: hence the
  // ceiling rather than a guess.
  const out = new Uint8Array(src.length + Math.ceil(src.length / MAX_LIT) + 4);
  const lit = new Uint8Array(MAX_LIT);
  let at = 0;
  let lc = 0;

  const flush = (): void => {
    if (lc === 0) return;
    out[at++] = lc;
    out.set(lit.subarray(0, lc), at);
    at += lc;
    lc = 0;
  };

  let i = 0;
  while (i < src.length) {
    const b = src[i];
    let run = 1;
    while (i + run < src.length && src[i + run] === b && run < MAX_LIT) run++;

    if (run >= MIN_RUN) {
      flush();
      out[at++] = 0;
      out[at++] = run;
      out[at++] = b;
      i += run;
      continue;
    }

    lit[lc++] = b;
    if (lc === MAX_LIT) flush();
    i++;
  }
  flush();
  return out.subarray(0, at);
}

/**
 * Unpack a byte run, expecting exactly `expect` bytes out, or null if it does not add up.
 *
 * Every read is bounds-checked against both the input and the expected output, so a
 * corrupt blob comes back as "not a save" rather than as garbage written into a pool.
 */
function unpackBytes(src: Uint8Array, expect: number): Uint8Array | null {
  const out = new Uint8Array(expect);
  let at = 0;
  let i = 0;
  while (i < src.length) {
    const marker = src[i++];
    if (marker === 0) {
      if (i + 2 > src.length) return null;
      const count = src[i++];
      const value = src[i++];
      if (at + count > expect) return null;
      out.fill(value, at, at + count);
      at += count;
      continue;
    }
    if (i + marker > src.length || at + marker > expect) return null;
    for (let k = 0; k < marker; k++) out[at++] = src[i++];
  }
  return at === expect ? out : null;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 with padding, written out rather than reached for: no `btoa` in the core. */
function encodeBytes(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const rest = bytes.length - i;
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    text += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    text += rest > 1 ? B64[(n >> 6) & 63] : '=';
    text += rest > 2 ? B64[n & 63] : '=';
  }
  return text;
}

/** Undo it. Null for anything that is not padded base64 of a whole number of groups. */
function decodeBytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const groups = text.length / 4;
  let want = groups * 3;
  if (text.endsWith('==')) want -= 2;
  else if (text.endsWith('=')) want -= 1;

  const out = new Uint8Array(want);
  let at = 0;
  for (let g = 0; g < groups; g++) {
    const i = g * 4;
    // A group is four characters for three bytes; only the last one may be padded, and its
    // '=' says how many bytes it carries. The trailing characters of a short group are
    // padding, not data, so the byte shifts below count from the top of what was read.
    const chars = g === groups - 1 && text[i + 3] === '=' ? (text[i + 2] === '=' ? 2 : 3) : 4;

    let n = 0;
    for (let k = 0; k < chars; k++) {
      const v = B64.indexOf(text[i + k]);
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    for (let k = 0; k < chars - 1; k++) {
      out[at++] = (n >> (6 * chars - 8 * (k + 1))) & 0xff;
    }
  }
  return at === out.length ? out : null;
}

/**
 * A column list out as packed base64, and back.
 *
 * Exported because `replay.ts` stores a tick's worth of packed input the same way a pool
 * stores a body: one codec, two users, so the packing gets read once rather than twice.
 * `decodeBlob` writes straight into the arrays it was handed and answers false when the
 * text is not the shape it claims — a discarded save, never a partly restored one.
 */
export function encodeBlob(cols: readonly Column[]): string {
  const bytes = new Uint8Array(totalWidth(cols));
  packColumns(cols, bytes);
  return encodeBytes(packBytes(bytes));
}

export function decodeBlob(text: string, cols: readonly Column[]): boolean {
  const bytes = decodeBytes(text);
  if (bytes === null) return false;
  const packed = unpackBytes(bytes, totalWidth(cols));
  return packed !== null && unpackColumns(packed, cols);
}

/** Pack one pool: its seventeen columns, then its free stack. */
function packPool(p: Pool): string {
  const cols: Column[] = POOL_COLS.map((name) => p[name] as Column);
  // Slot numbers at sixteen bits: see the limit at the top of the file.
  cols.push(Uint16Array.from(p.freeList.subarray(0, p.freeCount)));
  return encodeBlob(cols);
}

function unpackPool(blobOf: PoolBlob, dest: Pool): boolean {
  if (typeof blobOf.data !== 'string') return false;
  if (!Number.isInteger(blobOf.count) || blobOf.count < 0 || blobOf.count > dest.cap) return false;
  if (!Number.isInteger(blobOf.free) || blobOf.free < 0 || blobOf.free > dest.cap) return false;

  // The free stack decodes into a scratch of its own width before it goes into the
  // pool's Int32Array, which is four bytes an entry and would be read short otherwise.
  const free = new Uint16Array(blobOf.free);
  const cols: Column[] = POOL_COLS.map((name) => dest[name] as Column);
  cols.push(free);
  if (!decodeBlob(blobOf.data, cols)) return false;

  dest.count = blobOf.count;
  dest.freeCount = blobOf.free;
  for (let i = 0; i < blobOf.free; i++) dest.freeList[i] = free[i];
  return true;
}

/** Pack the floor: six columns per cover box, nine per hazard. */
function packFloor(props: PropField, zones: ZoneField): string {
  return encodeBlob([
    ...PROP_COLS.map((name) => (props[name] as Column).subarray(0, props.n)),
    ...ZONE_COLS.map((name) => (zones[name] as Column).subarray(0, zones.n)),
  ]);
}

function unpackFloor(blobOf: FloorBlob, props: PropField, zones: ZoneField): boolean {
  if (typeof blobOf.data !== 'string') return false;
  if (!Number.isInteger(blobOf.props) || blobOf.props < 0 || blobOf.props > props.kind.length) return false;
  if (!Number.isInteger(blobOf.zones) || blobOf.zones < 0 || blobOf.zones > zones.kind.length) return false;

  const cols: Column[] = [
    ...PROP_COLS.map((name) => (props[name] as Column).subarray(0, blobOf.props)),
    ...ZONE_COLS.map((name) => (zones[name] as Column).subarray(0, blobOf.zones)),
  ];
  if (!decodeBlob(blobOf.data, cols)) return false;

  props.n = blobOf.props;
  zones.n = blobOf.zones;
  // The cell index is a cache of the boxes rather than a fact about them, and it is what
  // every cover query walks. Restored without it, the floor would be invisible.
  buildGrid(props);
  return true;
}

/**
 * Copy a saved record onto a fresh one of the same shape.
 *
 * The World's own objects are the schema, so the check is by shape: the same keys, all of
 * them known, nothing extra, every value a finite number, a boolean or a string. That is
 * what makes a save written against a different build a discarded game rather than a
 * corrupt one, which is the failure TECH.md asks for.
 */
function copyRecord(src: unknown, dest: object): boolean {
  if (typeof src !== 'object' || src === null || Array.isArray(src)) return false;
  const from = src as Record<string, unknown>;
  const to = dest as Record<string, unknown>;
  const mine = Object.keys(dest);
  const theirs = Object.keys(from);
  if (theirs.length !== mine.length) return false;
  for (const key of theirs) {
    if (!(key in dest)) return false;
    const v = from[key];
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isFinite(v)) return false;
    } else if (t !== 'boolean' && t !== 'string') {
      return false;
    }
    to[key] = v;
  }
  return true;
}

/** A saved fixed-length list, each entry a finite number or `null`. */
function list(src: unknown, n: number): (number | null)[] | null {
  if (!Array.isArray(src) || src.length !== n) return null;
  for (const v of src) {
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  return src as (number | null)[];
}

/** Write the run out. Every value in the result is plain JSON. */
export function serialize(w: World): Snapshot {
  const flags =
    (w.over ? StateBit.Over : 0) |
    (w.chapterComplete ? StateBit.ChapterComplete : 0) |
    (w.victory ? StateBit.Victory : 0) |
    (w.autoFire ? StateBit.AutoFire : 0) |
    (w.pendingLevelUp ? StateBit.PendingLevelUp : 0) |
    (w.rerollUsed ? StateBit.RerollUsed : 0);

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
  if (!Number.isInteger(flags) || flags < 0 || flags > 63) return null;

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