/**
 * The World's bulk: one pool, and one floor, as a blob.
 *
 * The column lists are the fingerprint's column lists (see `hash.ts`), read in the same order
 * both ways, so "the snapshot carries everything the fingerprint reads" stays checkable by
 * reading two lists side by side. A pool's free stack travels with it because `alloc` pops it
 * and allocation order is iteration order: a resume that lost it would fight the same fight in a
 * different order.
 */

import { buildGrid, type PropField, type ZoneField } from '../systems/obstacles';
import type { Pool } from '../world';
import { decodeBlob, encodeBlob, type Column } from './blobs';

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

/** Pack one pool: its seventeen columns, then its free stack. */
export function packPool(p: Pool): string {
  const cols: Column[] = POOL_COLS.map((name) => p[name] as Column);
  // Slot numbers at sixteen bits: see the limit at the top of the file.
  cols.push(Uint16Array.from(p.freeList.subarray(0, p.freeCount)));
  return encodeBlob(cols);
}

export function unpackPool(blobOf: PoolBlob, dest: Pool): boolean {
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
export function packFloor(props: PropField, zones: ZoneField): string {
  return encodeBlob([
    ...PROP_COLS.map((name) => (props[name] as Column).subarray(0, props.n)),
    ...ZONE_COLS.map((name) => (zones[name] as Column).subarray(0, zones.n)),
  ]);
}

export function unpackFloor(blobOf: FloorBlob, props: PropField, zones: ZoneField): boolean {
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
