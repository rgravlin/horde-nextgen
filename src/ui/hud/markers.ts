/**
 * The screen edge: who gets an arrow, where it goes, and the scratch that finds it.
 *
 * Nothing here imports the renderer. Both sweeps are placed from world coordinates, which
 * works because the camera never yaws: world +x is screen right and world +y is screen up,
 * at one fixed foreshortening. "Off the visible floor" is read from `TUNE.viewHalfX/Y` —
 * the same 32x18 m rect the wave spawner drops bodies outside of — rather than a second
 * guess at what the camera covers: one rect, read by the two things that need it.
 *
 * The two pool sweeps (the radar's dot pass in `radar.ts` and this one) run at 20 Hz rather
 * than 60, on the shared beat `MAP_EVERY` sets, and the markers are fixed nodes that get
 * moved and shown rather than built — the same rule the rest of the overlay holds to.
 */

import { ENEMIES } from '../../content/enemies';
import { TUNE, type Pool, type World } from '../../sim/world';
import { make, type Marker } from './paint';

/**
 * How much the ground's depth axis is squeezed on the way to the screen.
 *
 * The camera looks 55° down (renderer.ts), so metres of world +y reach fewer pixels than
 * metres of +x: about `cos(55°)`, with a little given back to the perspective spread. It only
 * ever *aims* an edge marker rather than placing a fact, so it has to be near rather than
 * exact — and being an estimate, it is written down once instead of inside the maths.
 */
export const FORESHORTEN = 0.62;

/**
 * How far inside the viewport the edge markers run.
 *
 * Not one inset but two: the top and bottom bands hold the wave panel, the encounter plate
 * and the radar, so a marker that hugs a rectangular edge ends up sitting on top of them.
 * The path is therefore a quarter-ellipse — full inset at the middle of each edge, pulled in
 * toward the corners, which is exactly where the corner panels are.
 */
export const EDGE_INSET_X = 34;
export const EDGE_INSET_Y = 76;

/** How many crates and encounter bodies get an arrow. Past that the edge is noise. */
export const CHEST_MARKERS = 6;
export const BOSS_MARKERS = 3;

/** Frames between the two pool sweeps — the radar and the edge markers share the beat. */
export const MAP_EVERY = 3;

/**
 * The `nearestOutside` scratch: slot indices and squared distances, closest first.
 *
 * Module-level and reused because the sweep that fills it runs every third frame for the rest
 * of the run, and an array per sweep is an allocation per sweep for nothing.
 */
const pickIdx = new Int32Array(CHEST_MARKERS);
const pickD2 = new Float64Array(CHEST_MARKERS);

/**
 * The `limit` nearest live slots of `pool` that are off the visible floor, closest first,
 * written into the pick scratch. Returns how many were found (up to `limit`).
 *
 * The list is filled by insertion, so a full crate pool costs no sort and no allocation.
 */
export function nearestOutside(pool: Pool, world: World, limit: number, bossOnly: boolean): number {
  let n = 0;
  for (let i = 0; i < pool.cap; i++) {
    if (pool.alive[i] === 0) continue;
    if (bossOnly) {
      const kind = pool.kind[i];
      if (kind >= ENEMIES.length || ENEMIES[kind].boss !== true) continue;
    }
    const dx = pool.x[i] - world.player.x;
    const dy = pool.y[i] - world.player.y;
    if (Math.abs(dx) <= TUNE.viewHalfX && Math.abs(dy) <= TUNE.viewHalfY) continue;
    const d2 = dx * dx + dy * dy;
    if (n === limit && d2 >= pickD2[limit - 1]) continue;

    let at = n < limit ? n++ : limit - 1;
    while (at > 0 && pickD2[at - 1] > d2) {
      pickD2[at] = pickD2[at - 1];
      pickIdx[at] = pickIdx[at - 1];
      at--;
    }
    pickD2[at] = d2;
    pickIdx[at] = i;
  }
  return n;
}

/** The slot indices the last `nearestOutside` found, closest first. */
export { pickIdx };

/**
 * Put one marker on the edge of the play area, pointing at its body.
 *
 * The screen-space direction comes out of the world offset (with the depth squeeze above) and
 * is pushed out to the edge of an inset ellipse — a `halfW` x `halfH` oval rather than a
 * rectangle, so a body in a corner gets an arrow that curves in around the corner panels
 * instead of one that hides behind them. Quantised to whole pixels and two degrees, so a fast
 * walk rewrites a transform a few times a second rather than sixty.
 */
export function placeMarker(
  marker: Marker,
  dx: number,
  dy: number,
  halfW: number,
  halfH: number,
): void {
  const squeezed = dy * FORESHORTEN;
  const length = Math.sqrt(dx * dx + squeezed * squeezed);
  if (length <= 0) return;
  const sx = dx / length;
  const sy = -squeezed / length;

  const x = Math.round(sx * halfW);
  const y = Math.round(sy * halfH);
  const angle = (Math.round((Math.atan2(sx, -sy) * 180) / Math.PI / 2) * 2).toString();

  const at = `translate(${x}px, ${y}px) rotate(${angle}deg)`;
  if (marker.last !== at) {
    marker.last = at;
    marker.node.style.transform = at;
  }
}

/** Build a row of edge markers: fixed nodes that get shown and moved, never created. */
export function makeMarkers(parent: HTMLElement, className: string, count: number): Marker[] {
  const list: Marker[] = [];
  for (let i = 0; i < count; i++) {
    list.push({ node: make('i', `edge ${className}`, parent), last: '', shown: '0' });
  }
  return list;
}
