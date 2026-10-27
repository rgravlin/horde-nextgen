/**
 * Static floor geometry: what a body cannot walk through, what a round cannot fly
 * through, and the two floor hazards that hurt for standing still.
 *
 * This is the half of a level the sim can actually feel. A chapter's layout is a list of
 * boxes and circles in `content/levels/`; this file is the read path, built once when a
 * chapter is installed and then queried by the player's movement, by every enemy's travel
 * step, by every round in the air and by every place the spawner might put a body down.
 * Nothing here runs per tick beyond those queries, and none of them allocate.
 *
 * Two shapes, and only two: an axis-aligned box and a circle. Between them they cover
 * everything a layout needs (walls, cover, chokepoints, pillars, arena rims), they are both
 * exact against a swept segment in a handful of multiplies, and the renderer draws each one
 * as the shape that stops you. A third shape was not worth a second sweep, a second
 * push-out and a second test to be honest about it; a rotated box would have been that
 * second shape wearing a different hat.
 *
 * Why the checks are segment tests, not point tests: a dash covers 0.37 m in one tick and a
 * railgun round covers 3.3 m. A point test on the endpoint lets both tunnel through
 * anything thinner than that, which is why every prop a layout declares is at least
 * `MIN_THICK` across (refused at install, not documented) and why every query here is given
 * the tick's whole segment.
 *
 * Why a grid at all: a thousand bodies each take one or two travel steps a tick and every
 * step asks the question. A linear scan over twenty props is twenty tests per body per
 * tick; the grid reduces it to the two or three cells the body's own step crosses. Built as
 * a CSR pair (`start`/`entry`) in two passes, so a prop that straddles four cells is in all
 * four and nothing is dropped for a cell being full — a dropped entry is a wall corner that
 * rounds fly through. The cell index holds props by bounding box, so a circle is looked up
 * the same way as a box and only the final exact test differs.
 */

import { DT, type World } from '../world';

/**
 * What a prop is made of, for the renderer's material.
 *
 * Shape is *not* part of this list: `Pillar` is round because `r` says so, not because its
 * kind does, so adding a look never means touching a collision path.
 */
export const PropKind = {
  /** Factory wall: full height, stops sight lines. */
  Wall: 0,
  /** Low cover: stops bodies and rounds, reads as something you can shoot over. */
  Crate: 1,
  /** Vessel or pipe. Drawn as a box for the same reason as everything else. */
  Tank: 2,
  /** Column: round, and the only prop whose silhouette is not a box. */
  Pillar: 3,
} as const;

/** How many prop layers the renderer builds: one per `PropKind` above. */
export const PROP_KIND_COUNT = 4;

/** The two hazards a chapter can put on its floor. See `content/levels/`. */
export const ZoneKind = {
  /** Corrosion pool: damage over time while you stand in it, for both sides. */
  Acid: 0,
  /** Crusher: rests, tells, then hits everything inside. */
  Crusher: 1,
} as const;

/**
 * The thinnest prop accepted, across its short axis, in metres.
 *
 * A dash is 22 m/s for 0.18 s and a railgun round is 200 m/s, so one tick covers 0.37 m of
 * player and 3.3 m of round. A wall thinner than that can only be stopped by a swept test,
 * and a swept test is only worth having if the geometry is thick enough for the sweep to
 * land somewhere. 1.2 m clears the fastest body's step twice over. For a circle the
 * measurement is the diameter, which is the distance a body actually crosses.
 */
export const MIN_THICK = 1.2;

/** Above this many cells the arena is served by a scan instead; keeps the grid bounded. */
const MAX_CELLS = 4096;

/** Entries the pool holds. Sized for a whole arena of small props; overflow is counted. */
const ENTRY_CAP = 2048;

/** One shared cursor for building the grid, reused so the loader allocates nothing new. */
const CURSOR = new Int32Array(MAX_CELLS);

/**
 * The prop field, in struct-of-arrays form, with the cell index beside it.
 *
 * Empty by default: a World built by `createWorld` — and therefore every test fixture and
 * the idle arena — has no geometry until `installLayout` runs. That is deliberate. Layouts
 * are a chapter's property, and a world that never started a chapter should neither pay for
 * one nor inherit one it was not authored with.
 */
export interface PropField {
  /** Props installed. 0 means every query here answers "clear" without looking. */
  n: number;
  readonly kind: Uint8Array;
  /**
   * Bounding box, not the shape: for a circle these are its extremes, which is what the
   * cell index and the cheap first test want.
   */
  readonly x0: Float32Array;
  readonly y0: Float32Array;
  readonly x1: Float32Array;
  readonly y1: Float32Array;
  /** 0 for a box; the radius in metres for a circle, which is the shape actually tested. */
  readonly rad: Float32Array;
  /** Grid edge in metres, and its size in cells. `gw === 0` means no grid was built. */
  cell: number;
  gw: number;
  gh: number;
  minX: number;
  minY: number;
  /** Cell `c`'s prop indices run `[start[c], start[c + 1])` into `entry`. */
  readonly start: Int32Array;
  readonly entry: Int32Array;
  /** Props that would not fit, counted rather than silently skipped. */
  dropped: number;
}

/**
 * The hazard field. A zone is a circle so the tell drawn on the floor and the damage it
 * warns about are the same shape; boxes were not chosen for hazards because a hazard you
 * cannot read the edge of is a trap rather than a hazard.
 */
export interface ZoneField {
  n: number;
  readonly kind: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly r: Float32Array;
  /** Damage per second for a pool, damage per strike for a crusher. */
  readonly dps: Float32Array;
  /** Crusher cycle length, and the last slice of it spent telling. */
  readonly gap: Float32Array;
  readonly warn: Float32Array;
  /** Seconds until that zone's next event. */
  readonly t: Float32Array;
  /** 1 while the tell is showing, so it is emitted once per cycle rather than per tick. */
  readonly armed: Uint8Array;
}

/** Scratch for `pushOut`, so a spawn check costs no allocation. */
let outX = 0;
let outY = 0;

export function createPropField(
  cap: number,
  cell: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): PropField {
  const gw = Math.ceil((maxX - minX) / cell);
  const gh = Math.ceil((maxY - minY) / cell);
  const cells = gw * gh;
  // An arena too large for the cell budget keeps no grid and the queries fall back to
  // scanning the props. Both branches are exact, so the choice is only what the same answer
  // costs, and a silent "geometry stopped existing" is the one wrong option.
  const built = cells > 0 && cells <= MAX_CELLS ? cells : 0;
  return {
    n: 0,
    kind: new Uint8Array(cap),
    x0: new Float32Array(cap),
    y0: new Float32Array(cap),
    x1: new Float32Array(cap),
    y1: new Float32Array(cap),
    rad: new Float32Array(cap),
    cell,
    gw: built > 0 ? gw : 0,
    gh: built > 0 ? gh : 0,
    minX,
    minY,
    start: new Int32Array(built + 1),
    entry: new Int32Array(ENTRY_CAP),
    dropped: 0,
  };
}

export function createZoneField(cap: number): ZoneField {
  return {
    n: 0,
    kind: new Uint8Array(cap),
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    r: new Float32Array(cap),
    dps: new Float32Array(cap),
    gap: new Float32Array(cap),
    warn: new Float32Array(cap),
    t: new Float32Array(cap),
    armed: new Uint8Array(cap),
  };
}

/**
 * One prop as authored: centre and size, because that is how a layout is written by hand.
 *
 * `r` is what makes it round; `w`/`h` stay filled in for a circle (the helper writes the
 * diameter into them) so the drawing pass has one set of numbers to read.
 */
export interface PropLike {
  readonly kind: number;
  readonly x: number;
  readonly y: number;
  /** Full width and height in metres, not half-extents. */
  readonly w: number;
  readonly h: number;
  /** Radius for a round prop. Nothing else sets it. */
  readonly r?: number;
}

/** How a hazard is authored, before it becomes a slot in `ZoneField`. */
export interface ZoneLike {
  readonly kind: number;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly dps: number;
  readonly gap?: number;
  readonly warn?: number;
}

/**
 * Put a layout on the floor, replacing whatever was there.
 *
 * Called once when a chapter starts, from `systems/levels.ts`. A prop thinner than
 * `MIN_THICK` through the middle is refused rather than accepted: it would read as solid and
 * be passable at speed, which is a layout bug, and the only honest place to catch it is
 * where the layout is read. Refusals are counted in `dropped` for the state dump.
 */
export function installLayout(w: World, boxes: readonly PropLike[]): void {
  const f = w.props;
  f.n = 0;
  f.dropped = 0;

  for (const b of boxes) {
    if (f.n >= f.kind.length) {
      f.dropped++;
      continue;
    }
    const round = b.r ?? 0;
    const thin = round > 0 ? round * 2 : b.w < b.h ? b.w : b.h;
    if (thin < MIN_THICK) {
      f.dropped++;
      continue;
    }
    const i = f.n++;
    f.kind[i] = b.kind;
    if (round > 0) {
      f.rad[i] = round;
      f.x0[i] = b.x - round;
      f.y0[i] = b.y - round;
      f.x1[i] = b.x + round;
      f.y1[i] = b.y + round;
    } else {
      f.rad[i] = 0;
      f.x0[i] = b.x - b.w / 2;
      f.y0[i] = b.y - b.h / 2;
      f.x1[i] = b.x + b.w / 2;
      f.y1[i] = b.y + b.h / 2;
    }
  }

  buildGrid(f);
}

/** Put a chapter's hazards on the floor. */
export function installZones(w: World, zones: readonly ZoneLike[]): void {
  const z = w.zones;
  z.n = 0;
  for (const h of zones) {
    if (z.n >= z.kind.length) break;
    const i = z.n++;
    z.kind[i] = h.kind;
    z.x[i] = h.x;
    z.y[i] = h.y;
    z.r[i] = h.r;
    z.dps[i] = h.dps;
    z.gap[i] = h.gap ?? 0;
    z.warn[i] = h.warn ?? 0;
    // The first strike is staggered by the zone's own slot so a row of crushers does not
    // fire as one machine, and the offset comes from the index rather than world.rng for the
    // reason every other index-derived seed here does: it must not shift the random stream.
    // It is subtracted from a whole cycle rather than taken off the top of one, because a
    // clock that starts inside its own warning window drops the plate on the first tick it
    // is on the floor — no tell at all, which is the one thing a crusher may not be.
    const gap = h.gap ?? 0;
    z.t[i] = gap > 0 ? gap - ((i * 0.37) % gap) : 0;
    z.armed[i] = 0;
  }
}

/**
 * Fill the cell index for the props just installed: count, prefix-sum, scatter.
 *
 * The counts live in `start[c + 1]` while they are being counted so the prefix sum has
 * somewhere to happen without a second array, and the scatter reads each cell's count before
 * overwriting the slot beneath it.
 *
 * Exported for `serialize.ts`: a restored floor arrives as boxes, not as an index, and the
 * index is what every cover query walks, so a floor restored without it is an invisible one.
 */
export function buildGrid(f: PropField): void {
  if (f.gw === 0 || f.gh === 0) return;

  const gw = f.gw;
  const cells = gw * f.gh;
  const start = f.start;
  start.fill(0);
  const inv = 1 / f.cell;

  for (let i = 0; i < f.n; i++) {
    eachCell(f, inv, i, (c) => {
      start[c + 1]++;
    });
  }

  let run = 0;
  for (let c = 0; c < cells; c++) {
    const count = start[c + 1];
    start[c] = run;
    run += count;
  }
  start[cells] = run;
  if (run > ENTRY_CAP) f.dropped++;

  const cursor = CURSOR;
  cursor.fill(0, 0, cells);
  for (let i = 0; i < f.n; i++) {
    eachCell(f, inv, i, (c) => {
      const at = start[c] + cursor[c];
      if (at < ENTRY_CAP) {
        f.entry[at] = i;
        cursor[c]++;
      }
    });
  }
}

/** Visit every cell prop `i` overlaps, clamped into the grid. */
function eachCell(f: PropField, inv: number, i: number, visit: (cell: number) => void): void {
  const gw = f.gw;
  const gh = f.gh;
  let cx0 = Math.floor((f.x0[i] - f.minX) * inv);
  let cx1 = Math.floor((f.x1[i] - f.minX) * inv);
  let cy0 = Math.floor((f.y0[i] - f.minY) * inv);
  let cy1 = Math.floor((f.y1[i] - f.minY) * inv);
  if (cx0 < 0) cx0 = 0;
  if (cy0 < 0) cy0 = 0;
  if (cx1 >= gw) cx1 = gw - 1;
  if (cy1 >= gh) cy1 = gh - 1;
  if (cx0 > cx1 || cy0 > cy1) return;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) visit(cy * gw + cx);
  }
}

/**
 * Whether a segment of travel crosses a prop, a body of radius `r` included.
 *
 * Props are widened by `r` for the test, so one function answers both questions the game
 * asks: "can this round fly it" and "can this body walk it". The first test is a slab clip
 * on the bounding box, so a segment that *starts* inside a prop (a body shoved into cover,
 * a round spawned inside it) counts as blocked — the safe direction for both. For a circle
 * the box is only a cheap reject: it is bigger than the shape, so a hit on it is followed by
 * the exact distance test rather than an answer.
 *
 * `f.n === 0` answers immediately: that is the state every existing test fixture is in, and
 * it has to cost one compare rather than a scan.
 */
export function blocked(f: PropField, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (f.n === 0) return false;

  const dx = x1 - x0;
  const dy = y1 - y0;

  if (f.gw > 0) {
    const inv = 1 / f.cell;
    let cx0 = Math.floor((Math.min(x0, x1) - r - f.minX) * inv);
    let cx1 = Math.floor((Math.max(x0, x1) + r - f.minX) * inv);
    let cy0 = Math.floor((Math.min(y0, y1) - r - f.minY) * inv);
    let cy1 = Math.floor((Math.max(y0, y1) + r - f.minY) * inv);
    if (cx1 < 0 || cx0 >= f.gw || cy1 < 0 || cy0 >= f.gh) return false;
    if (cx0 < 0) cx0 = 0;
    if (cy0 < 0) cy0 = 0;
    if (cx1 >= f.gw) cx1 = f.gw - 1;
    if (cy1 >= f.gh) cy1 = f.gh - 1;

    const span = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    // A long round can cross more cells than it would cost to try every prop. Both branches
    // are exact, so 24 cells is only the point where the grid stops being the cheap answer.
    if (span <= 24) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cy * f.gw + cx;
          const end = f.start[c + 1];
          for (let k = f.start[c]; k < end; k++) {
            if (hits(f, f.entry[k], x0, y0, dx, dy, r)) return true;
          }
        }
      }
      return false;
    }
  }

  for (let i = 0; i < f.n; i++) {
    if (hits(f, i, x0, y0, dx, dy, r)) return true;
  }
  return false;
}

/** One prop's two tests: the bounding box, then the circle if that box is a circle's. */
function hits(f: PropField, i: number, x0: number, y0: number, dx: number, dy: number, r: number): boolean {
  if (!clip(x0, y0, dx, dy, f.x0[i] - r, f.y0[i] - r, f.x1[i] + r, f.y1[i] + r)) return false;
  const cr = f.rad[i];
  if (cr <= 0) return true;
  return near(x0, y0, dx, dy, (f.x0[i] + f.x1[i]) * 0.5, (f.y0[i] + f.y1[i]) * 0.5, cr + r);
}

/** Segment/box overlap by slab clipping. `dx`/`dy` are the segment's length, not a step. */
function clip(px: number, py: number, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number): boolean {
  let tEnter = 0;
  let tExit = 1;

  if (dx === 0) {
    if (px < x0 || px > x1) return false;
  } else {
    const inv = 1 / dx;
    let t1 = (x0 - px) * inv;
    let t2 = (x1 - px) * inv;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tEnter) tEnter = t1;
    if (t2 < tExit) tExit = t2;
    if (tEnter > tExit) return false;
  }

  if (dy === 0) {
    if (py < y0 || py > y1) return false;
  } else {
    const inv = 1 / dy;
    let t1 = (y0 - py) * inv;
    let t2 = (y1 - py) * inv;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tEnter) tEnter = t1;
    if (t2 < tExit) tExit = t2;
    if (tEnter > tExit) return false;
  }

  return true;
}

/**
 * Whether the segment reaches within `rr` of (cx, cy): the exact circle test.
 *
 * The same rules the box obeys, so the two shapes cannot disagree about a body's footprint:
 * a zero-length segment is a point test, which is why a body standing in a pool of corrosion
 * and a body shoved into a column are both "blocked", and a body that starts inside is
 * judged from its own centre outward.
 */
function near(px: number, py: number, dx: number, dy: number, cx: number, cy: number, rr: number): boolean {
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((cx - px) * dx + (cy - py) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const nx = px + dx * t - cx;
  const ny = py + dy * t - cy;
  return nx * nx + ny * ny <= rr * rr;
}

/**
 * Whether a body of radius `r` fits at (x, y) without overlapping cover — the shape test
 * every spawn check asks before it puts a body down.
 *
 * Named for the question rather than for the answer the way the other queries here are,
 * because it is the one callers outside the sim read: a spawner, a drop, or a scenario that
 * wants to know whether a point is floor.
 */
export function pointBlocked(level: PropField, x: number, y: number, r: number): boolean {
  return blocked(level, x, y, x, y, r);
}

/**
 * Whether a body of radius `r` may travel one step from (x, y) by (dx, dy).
 *
 * Two rules, and the second is why this is a function rather than a `blocked` call at each
 * site. Normally the whole segment is tested, so nothing crosses a wall in one step. A body
 * that is *already* inside cover — left there when a new chapter's floor loaded under it —
 * is judged on its destination only: segment-testing a body that starts inside a box refuses
 * every move it can make, which is not shelter but a seal. Judging the destination keeps the
 * way out open without opening a tunnel, because a 0.37 m step still needs four ticks to
 * cross the thinnest authored wall and every point in between is refused.
 */
export function canTravel(f: PropField, x: number, y: number, dx: number, dy: number, r: number): boolean {
  if (f.n === 0) return true;
  if (!pointBlocked(f, x, y, r)) return !blocked(f, x, y, x + dx, y + dy, r);
  return !pointBlocked(f, x + dx, y + dy, r);
}

/**
 * Find room for a body of radius `r` near (x, y), leaving it in `pushedX`/`pushedY`.
 *
 * Used where a body is *put down* rather than where it travels: the wave spawner's landing
 * point, a splitter's children, a brood. Dropping a body inside a wall is worse than not
 * dropping it — it would come out the far side, which is the one thing a telegraph exists to
 * prevent. This is a search over eight directions at eight step lengths, not a solver:
 * layouts are written with gaps in them, so a point inside a prop is a few metres from open
 * floor, and a point with no room nearby has none, which is reported rather than guessed.
 */
export function pushOut(f: PropField, r: number, x: number, y: number): boolean {
  outX = x;
  outY = y;
  if (f.n === 0) return true;
  if (!pointBlocked(f, x, y, r)) return true;

  const step = f.cell === 0 ? 1 : f.cell * 0.5;
  for (let n = 1; n <= 8; n++) {
    const d = step * n;
    for (let dir = 0; dir < 8; dir++) {
      const a = dir * (Math.PI / 4) + n * (Math.PI / 32);
      const tx = x + Math.cos(a) * d;
      const ty = y + Math.sin(a) * d;
      if (!pointBlocked(f, tx, ty, r)) {
        outX = tx;
        outY = ty;
        return true;
      }
    }
  }
  return false;
}

/** Where `pushOut` left the last point, after it returned true. */
export function pushedX(): number {
  return outX;
}

/** Where `pushOut` left the last point, after it returned true. */
export function pushedY(): number {
  return outY;
}

/**
 * One tick of the crusher clocks, oldest cycle first.
 *
 * A zone tells for `warn` seconds and then strikes, and the tell is emitted once per cycle
 * rather than once per tick: the shape on the floor is drawn from the zone's own `t`, so the
 * event only has to say that a shape opened. `armed` is what keeps the two halves apart — a
 * clock that merely crossed zero would fire again the moment it was refilled.
 *
 * `warn` is authored, not derived, and every crusher in `content/levels/` sets it above
 * 0.4 s, which is DESIGN.md's floor for a tell a player is asked to answer.
 */
export function tickZones(
  w: World,
  onTell: (w: World, x: number, y: number, r: number) => void,
  onStrike: (w: World, x: number, y: number, r: number, dmg: number) => void,
): void {
  const z = w.zones;
  for (let i = 0; i < z.n; i++) {
    if (z.kind[i] !== ZoneKind.Crusher) continue;
    const gap = z.gap[i];
    if (gap <= 0) continue;

    z.t[i] -= DT;
    if (z.t[i] > z.warn[i]) continue;

    if (z.armed[i] === 0) {
      z.armed[i] = 1;
      onTell(w, z.x[i], z.y[i], z.r[i]);
    }
    if (z.t[i] > 0) continue;

    onStrike(w, z.x[i], z.y[i], z.r[i], z.dps[i]);
    z.armed[i] = 0;
    z.t[i] += gap;
    if (z.t[i] <= 0) z.t[i] = gap;
  }
}

/** What a corrosion pool at (x, y) costs per second, or 0 for dry floor. */
export function acidAt(z: ZoneField, x: number, y: number): number {
  for (let i = 0; i < z.n; i++) {
    if (z.kind[i] !== ZoneKind.Acid) continue;
    const dx = x - z.x[i];
    const dy = y - z.y[i];
    const r = z.r[i];
    if (dx * dx + dy * dy <= r * r) return z.dps[i];
  }
  return 0;
}