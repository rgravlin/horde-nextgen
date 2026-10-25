/**
 * Broad-phase: a uniform grid over the arena bounds, cell edge 2 world units.
 *
 * Sized for the busiest moment in TECH.md (2,048 enemies over a 120x120 m arena
 * at 2 m cells = 3,600 cells), the four Int32Arrays come to about 45 KB,
 * allocated once here and rebuilt every tick by a counting sort. Neither rebuild
 * nor query allocates, which is what lets step() stay allocation-free
 * (TECH.md "Simulation and rendering").
 *
 * The grid stores pool indices, not coordinates: positions stay in the pools and
 * are passed in, so this file does not need to know what a Pool is.
 *
 * `capacity` is how many entities one rebuild can index and `slotCount` how many
 * pool slots it may look at; `slotCount` must cover every slot index of the pool
 * being indexed, because itemCell is addressed by slot.
 */

export interface SpatialHash {
  /** Cell edge in world units. */
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly minX: number;
  readonly minY: number;
  /** Cell index per pool slot, cached by rebuild so the scatter pass skips cellOf.
   * -1 marks a slot the grid had no room for. */
  readonly itemCell: Int32Array;
  /** Items of cell c are items[cellStart[c] .. cellStart[c + 1] - 1]. */
  readonly cellStart: Int32Array;
  /** Per-cell occupancy, then reused as the scatter cursor. */
  readonly cellCount: Int32Array;
  readonly items: Int32Array;
  /** Items placed by the last rebuild. */
  count: number;
  /** Entities skipped because the grid was full. */
  overflow: number;
  /** Hits dropped because the query output array was full. */
  queryOverflow: number;
}

export function createSpatialHash(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  cellSize: number,
  capacity: number,
  slotCount = capacity,
): SpatialHash {
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cellSize));
  const cells = cols * rows;
  return {
    cellSize,
    cols,
    rows,
    minX,
    minY,
    itemCell: new Int32Array(slotCount),
    cellStart: new Int32Array(cells + 1),
    cellCount: new Int32Array(cells),
    items: new Int32Array(capacity),
    count: 0,
    overflow: 0,
    queryOverflow: 0,
  };
}

function cellOf(h: SpatialHash, x: number, y: number): number {
  let cx = (x - h.minX) / h.cellSize;
  let cy = (y - h.minY) / h.cellSize;
  cx = cx < 0 ? 0 : cx >= h.cols ? h.cols - 1 : cx | 0;
  cy = cy < 0 ? 0 : cy >= h.rows ? h.rows - 1 : cy | 0;
  return cy * h.cols + cx;
}

/**
 * Rebuild the grid from the positions in `x`/`y`, walking slots 0 .. n-1.
 *
 * A slot counts as live unless `alive` says otherwise, which is how the
 * projectile and shard pools get indexed for free. Callers must not move
 * entities between a rebuild and the queries that use it.
 */
export function rebuild(
  h: SpatialHash,
  x: Float32Array,
  y: Float32Array,
  alive: Uint8Array | null,
  n: number,
): void {
  const cnt = h.cellCount;
  const start = h.cellStart;
  const items = h.items;
  const cells = h.cols * h.rows;
  const cap = items.length;
  cnt.fill(0, 0, cells);
  h.count = 0;
  h.overflow = 0;
  h.queryOverflow = 0;

  // Pass 1: which cell each live slot sits in, and how many per cell. A slot
  // past the grid capacity is marked -1 rather than left at its old cell, so
  // pass 3 cannot scatter it into a run it does not belong to.
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (alive !== null && alive[i] === 0) continue;
    if (count >= cap) {
      h.itemCell[i] = -1;
      h.overflow++;
      continue;
    }
    const c = cellOf(h, x[i], y[i]);
    h.itemCell[i] = c;
    cnt[c]++;
    count++;
  }

  // Pass 2: turn the counts into offsets, and keep them as write cursors.
  let acc = 0;
  for (let c = 0; c < cells; c++) {
    start[c] = acc;
    acc += cnt[c];
  }
  start[cells] = acc;
  for (let c = 0; c < cells; c++) cnt[c] = start[c];

  // Pass 3: scatter the slot indices into their cell's run. Slots the grid had no
  // room for carry -1 and are skipped, so they cannot land in another cell's run.
  for (let i = 0; i < n; i++) {
    if (alive !== null && alive[i] === 0) continue;
    const c = h.itemCell[i];
    if (c < 0) continue;
    items[cnt[c]++] = i;
  }
  h.count = count;
}

/**
 * Indices of live entities within `r` of (px, py), written into `out`; returns
 * how many were written. Hits past `out.length` are dropped and counted in
 * `queryOverflow`, so a full output buffer stays observable.
 *
 * The distance test is exact rather than cell-broad: callers pass the distance
 * they care about (sum of radii, weapon range) and get no far-away misses. That
 * is what the hash-query test checks.
 */
export function queryRadius(
  h: SpatialHash,
  x: Float32Array,
  y: Float32Array,
  alive: Uint8Array | null,
  px: number,
  py: number,
  r: number,
  out: Int32Array,
): number {
  const r2 = r * r;
  if (!(r2 > 0)) return 0;

  // Floor the cell bounds: without this a query whose centre is not on a cell
  // edge walks a fractional cell index and finds nothing.
  let cx0 = Math.floor((px - r - h.minX) / h.cellSize);
  let cy0 = Math.floor((py - r - h.minY) / h.cellSize);
  let cx1 = Math.floor((px + r - h.minX) / h.cellSize);
  let cy1 = Math.floor((py + r - h.minY) / h.cellSize);
  if (cx0 < 0) cx0 = 0;
  if (cy0 < 0) cy0 = 0;
  if (cx1 >= h.cols) cx1 = h.cols - 1;
  if (cy1 >= h.rows) cy1 = h.rows - 1;

  let found = 0;
  for (let cy = cy0; cy <= cy1; cy++) {
    const rowBase = cy * h.cols;
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = rowBase + cx;
      const to = h.cellStart[c + 1];
      for (let k = h.cellStart[c]; k < to; k++) {
        const i = h.items[k];
        if (alive !== null && alive[i] === 0) continue;
        const dx = x[i] - px;
        const dy = y[i] - py;
        if (dx * dx + dy * dy > r2) continue;
        if (found >= out.length) {
          h.queryOverflow++;
          return found;
        }
        out[found++] = i;
      }
    }
  }
  return found;
}