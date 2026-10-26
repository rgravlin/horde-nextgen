/**
 * The radar: DESIGN.md's 160px circle in the top-left corner, painted on one 2D canvas.
 *
 * It is a *map*, not a picture of what the camera shows: it draws every body within
 * listening range of the player, on-screen or not, which is the one piece of information
 * the top-down camera cannot give — a charger assembling four metres above the top edge of
 * the screen is exactly the kill this circle exists to prevent.
 *
 * Two axes it keeps straight:
 *
 * - **World-aligned, and therefore screen-aligned.** The camera never yaws (renderer.ts
 *   moves it without rotating it), so world +x is screen right and world +y is screen up.
 *   The map needs no camera and no projection, and imports nothing from `render`
 *   (ARCHITECTURE.md: `ui` reads state, never the engine).
 * - **Cheap, because it runs next to a thousand bodies.** The HUD calls it every frame and it
 *   answers most of those calls with two integer compares: it repaints at most every third
 *   call, skips a repaint even then when the world has not ticked (a frozen scene has nothing
 *   new to show), caps the dots it draws and paints squares rather than arcs. One `fillRect`
 *   per enemy at 60 Hz is the cost that would actually be visible, so the sweep is throttled
 *   here rather than by whatever happens to call it.
 *
 * Reach is a read rather than a shape: it opens from 34 m to 60 m while the Targeting Probe
 * is running. That card is this game's radar power-up — the only entry in
 * `content/powerups.ts` whose effect is "see further" — and the rim turns magenta for as
 * long as the dose lasts, so a wider map says why it is wider.
 */

import { ENEMIES } from '../content/enemies';
import { POWERUPS } from '../content/powerups';
import type { World } from '../sim/world';

/** CSS pixels across the circle; DESIGN.md pins the size. */
const SIZE = 160;

/** Metres the map reaches with no help, and with a Targeting Probe running. */
const BASE_RANGE = 34;
const PROBE_RANGE = 60;

/** Pixels of rim a dot may not paint over, so the ring stays a ring. */
const RIM = 5;

/** Dots drawn before the rest of the horde is given up on: a saturated map is still a map. */
const DOT_CAP = 900;

/** Calls between repaints. At one call per frame that is 20 Hz, continuous enough for
 * dots that crawl and a fifth of the fill work. */
const REFRESH = 3;

/** Palette from DESIGN.md, as literals because canvas cannot read a CSS variable. */
const BACKDROP = 'rgba(11, 13, 20, 0.72)';
const HAIRLINE = 'rgba(46, 242, 255, 0.34)';
const HAIRLINE_PROBE = 'rgba(255, 46, 151, 0.45)';
const GRID = 'rgba(232, 236, 245, 0.10)';
const CHEST = '#f2b233';
const BOSS = '#ff2e97';
const SELF = '#2ef2ff';
const AIM = 'rgba(46, 242, 255, 0.26)';

const TAU = Math.PI * 2;

/** The probe's index, looked up once. -1 (a rebuilt table) just leaves the reach at base. */
const PROBE = POWERUPS.findIndex((def) => def.id === 'targeting');

/** One dot colour per archetype, so the dots match the bodies the renderer draws. */
const DOT_COLOR: string[] = ENEMIES.map((def) => def.accent);

export interface Radar {
  /** The widget's root: the canvas and the range caption under it. */
  readonly element: HTMLElement;
  /**
   * Repaint from the World, if it is worth repainting.
   *
   * Called every rendered frame. The radar keeps its own beat and repaints at most every
   * third call, and skips a repaint even then when nothing moved — a paused scene has
   * nothing new on it. `force` is for a scene change, where the picture has been off screen
   * and what it last drew proves nothing.
   */
  draw(world: World, force: boolean): void;
}

/** Device pixels per CSS pixel, capped at 2: past that the map is 320 dots across. */
function deviceScale(): number {
  const d = globalThis.devicePixelRatio;
  return typeof d === 'number' && d > 1 ? Math.min(2, d) : 1;
}

/** Whether the probe's clock is running, which is the only thing that widens the map. */
function probeUp(world: World): boolean {
  return PROBE >= 0 && world.powerTiers[PROBE] > 0 && world.powerTime[PROBE] > 0;
}

export function createRadar(): Radar {
  const box = document.createElement('div');
  box.className = 'radar';

  const canvas = document.createElement('canvas');
  canvas.className = 'radar-map';
  const scale = deviceScale();
  canvas.width = Math.round(SIZE * scale);
  canvas.height = Math.round(SIZE * scale);

  const caption = document.createElement('span');
  caption.className = 'radar-range';
  caption.textContent = `Radar ${BASE_RANGE} m`;
  box.appendChild(canvas);
  box.appendChild(caption);

  const ctx = canvas.getContext('2d');
  /** Calls since the last paint, and the tick it painted. Together they make the beat. */
  let calls = 0;
  let lastTick = -1;
  let lastRange = BASE_RANGE;

  function paint(world: World, range: number): void {
    if (ctx === null) return;
    const c = SIZE / 2;
    const k = (c - RIM) / range;
    const reach2 = range * range;
    const player = world.player;
    const probe = probeUp(world);

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    // The disc, then everything inside it clipped to it: a dot a metre outside reach still
    // has a two-pixel body, and it should not sit on top of the rim.
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, TAU);
    ctx.fillStyle = BACKDROP;
    ctx.fill();
    ctx.clip();

    // The cross and the half-reach ring, so a dot's bearing and its distance are both
    // readable off the bare field.
    ctx.strokeStyle = probe ? HAIRLINE_PROBE : HAIRLINE;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c, 0);
    ctx.lineTo(c, SIZE);
    ctx.moveTo(0, c);
    ctx.lineTo(SIZE, c);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.arc(c, c, (c - RIM) * 0.5, 0, TAU);
    ctx.stroke();

    // The horde. Boss bodies get a ring instead of a dot: the shape has to differ, not only
    // the hue (DESIGN.md, "reliance on colour alone").
    const enemies = world.enemies;
    if (enemies.count > 0) {
      let drawn = 0;
      let color = '';
      for (let i = 0; i < enemies.cap && drawn < DOT_CAP; i++) {
        if (enemies.alive[i] === 0 || enemies.hp[i] <= 0) continue;
        const dx = enemies.x[i] - player.x;
        const dy = enemies.y[i] - player.y;
        if (dx * dx + dy * dy > reach2) continue;
        const kind = enemies.kind[i];
        const def = kind < ENEMIES.length ? ENEMIES[kind] : undefined;
        if (def === undefined) continue;
        drawn++;

        const sx = c + dx * k;
        const sy = c - dy * k;
        if (def.boss) {
          ctx.strokeStyle = BOSS;
          ctx.beginPath();
          ctx.arc(sx, sy, 4, 0, TAU);
          ctx.stroke();
          color = '';
          continue;
        }
        const dot = DOT_COLOR[kind];
        if (dot !== color) {
          ctx.fillStyle = dot;
          color = dot;
        }
        ctx.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }

    // The crates. Four pixels of Hazard, the same colour the edge arrows use: the dot says
    // "there is a crate over there", the arrow says "and it is that way".
    const chests = world.chests;
    if (chests.count > 0) {
      ctx.fillStyle = CHEST;
      for (let i = 0; i < chests.cap; i++) {
        if (chests.alive[i] === 0) continue;
        const dx = chests.x[i] - player.x;
        const dy = chests.y[i] - player.y;
        if (dx * dx + dy * dy > reach2) continue;
        ctx.fillRect(c + dx * k - 2, c - dy * k - 2, 4, 4);
      }
    }

    // The player: a three-pixel nose pointing where the gun points, and the aim line out to
    // the rim. One of the two is a reading aid; the aim line is the one the player reads.
    const ax = player.aimX;
    const ay = player.aimY;
    ctx.strokeStyle = AIM;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + ax * (c - RIM), c - ay * (c - RIM));
    ctx.stroke();

    ctx.fillStyle = SELF;
    ctx.beginPath();
    ctx.moveTo(c + ax * 5, c - ay * 5);
    ctx.lineTo(c - ax * 2 - ay * 2.6, c - ay * 2 + ax * 2.6);
    ctx.lineTo(c - ax * 2 + ay * 2.6, c - ay * 2 - ax * 2.6);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    // Rim last and unclipped, so it stays the crispest thing in the corner.
    ctx.strokeStyle = probe ? HAIRLINE_PROBE : HAIRLINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, TAU);
    ctx.stroke();
  }

  return {
    element: box,

    draw(world, force) {
      if (ctx === null) return;
      if (!force) {
        calls++;
        if (calls % REFRESH !== 0) return;
        // A world that has not ticked has nothing new on it: the dots and the rim are
        // already right, which is what keeps a paused or level-up scene cheap.
        if (world.tick === lastTick) return;
      }
      lastTick = world.tick;

      const range = probeUp(world) ? PROBE_RANGE : BASE_RANGE;
      paint(world, range);

      if (range !== lastRange) {
        lastRange = range;
        caption.textContent = `Radar ${range} m`;
        // `probe` is the caption's only job beyond the number: it retints the chip and the
        // rim, so a 60 m map looks different before the player has read anything on it.
        box.classList.toggle('probe', range > BASE_RANGE);
      }
    },
  };
}
