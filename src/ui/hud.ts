/**
 * The HUD: a DOM overlay over the canvas (ARCHITECTURE.md "Module map").
 *
 * It reads the World and the scene and writes pixels into HTML; it decides nothing. The
 * layout is DESIGN.md's: a radar circle top-left, the chapter and wave clock top-centre, the
 * encounter's plate below it while one is on the floor, score and kills top-right, HP with
 * the shield over it plus the dash pip and the level bottom-left, the two hands bottom-right,
 * the power column up the right edge, XP along the very bottom edge and — the part a top-down
 * camera cannot show any other way — an arrow at the screen edge for every crate and a
 * chevron for every encounter body standing off the visible floor.
 *
 * Two rules the whole file is arranged around:
 *
 * - **Built once, then updated in place.** Every node here exists before the first frame.
 *   This runs once per rendered frame next to a thousand bodies, so a `createElement` per
 *   frame would show up as jank long before a triangle would.
 * - **Written only when it changed.** Text is compared before it is set, bar widths are
 *   quantised to half a percent and marker positions to whole pixels, so a steady frame costs
 *   a handful of compares. The two sweeps that do have to walk the pools (the radar's dot
 *   pass and the edge markers') run at 20 Hz rather than 60, and the radar skips even those
 *   when the world has not ticked.
 *
 * Nothing here imports the renderer. The radar and the edge arrows are both placed from world
 * coordinates, which works because the camera never yaws: world +x is screen right and world
 * +y is screen up, at one fixed foreshortening (see `FORESHORTEN`).
 */

import { ENEMIES } from '../content/enemies';
import { POWERUPS } from '../content/powerups';
import { WEAPONS, type WeaponDef } from '../content/weapons';
import { Phase } from '../sim/systems/levels';
import { xpProgress } from '../sim/systems/pickups';
import { TUNE, type Pool, type WeaponSlot, type World } from '../sim/world';
import { createCardPanel } from './levelup';
import { createRadar } from './radar';
import './styles.css';

/** What an HUD control asks the game to do. */
export type HudCommand =
  | 'start'
  | 'pause'
  | 'resume'
  | 'restart'
  | 'menu'
  | 'reroll'
  | 'save'
  | 'load';

/** The slice of the game the HUD reads. Kept structural so the HUD needs no import
 * from the layer that owns it. */
export interface HudView {
  readonly scene: string;
  readonly world: World;
  /** Take level-up card `index`, from a click. The keys go through the sampler. */
  pick(index: number): void;
  command(cmd: HudCommand): void;
  /**
   * Whether a run is waiting in storage. Asked once per scene change, which is the only
   * moment it matters: it decides whether the title offers Continue and whether the pause
   * menu offers Load, and a screen that cannot do a thing should not show a button for it.
   */
  hasSave(): boolean;
}

export interface Hud {
  /** Update the overlay from the game. Called once per rendered frame. */
  tick(view: HudView): void;
  /** The overlay's root, so the caller can take it back down. */
  readonly element: HTMLElement;
}

/**
 * How much the ground's depth axis is squeezed on the way to the screen.
 *
 * The camera looks 55° down (renderer.ts), so metres of world +y reach fewer pixels than
 * metres of +x: about `cos(55°)`, with a little given back to the perspective spread. It only
 * ever *aims* an edge marker rather than placing a fact, so it has to be near rather than
 * exact — and being an estimate, it is written down once instead of inside the maths.
 */
const FORESHORTEN = 0.62;

/**
 * How far inside the viewport the edge markers run.
 *
 * Not one inset but two: the top and bottom bands hold the wave panel, the encounter plate
 * and the radar, so a marker that hugs a rectangular edge ends up sitting on top of them.
 * The path is therefore a quarter-ellipse — full inset at the middle of each edge, pulled in
 * toward the corners, which is exactly where the corner panels are.
 */
const EDGE_INSET_X = 34;
const EDGE_INSET_Y = 76;

/** How many crates and encounter bodies get an arrow. Past that the edge is noise. */
const CHEST_MARKERS = 6;
const BOSS_MARKERS = 3;

/** Frames between the two pool sweeps — the radar and the edge markers share the beat. */
const MAP_EVERY = 3;

/**
 * How many power-up rows the right column draws before it starts counting instead.
 *
 * Twelve rows is about half the column's height, which leaves room for a run that has picked
 * everything; the rest arrives as one "+N more" line rather than as clipped text.
 */
const POWER_ROWS = 12;

/** Frames between re-reads of the viewport size, which changes when the window does. */
const SIZE_EVERY = 45;

const el = document.createElement.bind(document);

function make(tag: string, className: string, parent: HTMLElement): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

/** Write text only when it changed: the DOM is slow and most frames change little. */
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** Quantised width write, for the bars. */
function setFill(node: HTMLElement, fraction: number): void {
  const steps = Math.max(0, Math.min(200, Math.round(fraction * 200)));
  const width = `${steps / 2}%`;
  if (node.style.width !== width) node.style.width = width;
}

/**
 * Quantised start-and-length write, for a track that carries two segments.
 *
 * Same half-percent grid as `setFill`, and the length is clamped to what is left of the
 * track so a full shield plus full health still fits inside the bar.
 */
function setSpan(node: HTMLElement, from: number, fraction: number): void {
  const start = Math.max(0, Math.min(200, Math.round(from * 200)));
  const steps = Math.max(0, Math.min(200 - start, Math.round(fraction * 200)));
  const left = `${start / 2}%`;
  const width = `${steps / 2}%`;
  if (node.style.left !== left) node.style.left = left;
  if (node.style.width !== width) node.style.width = width;
}

/**
 * How far round the reload dial to paint, in whole percents.
 *
 * A reload lasts between half a second and two, so a full one is a few dozen writes rather
 * than a hundred and twenty; the arc is 14px and reads at 2% granularity.
 */
function setArc(node: SlotNodes, fraction: number): void {
  const steps = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  if (node.arcValue === steps) return;
  node.arcValue = steps;
  node.arc.style.setProperty('--arc', String(steps));
}

/**
 * Show or hide one pooled marker.
 *
 * The last answer is remembered on the node itself, so a steady frame is one string compare
 * and touching `classList` is reserved for the frames that actually change the picture.
 */
function setHidden(marker: Marker, hidden: boolean): void {
  const wanted = hidden ? '0' : '1';
  if (marker.shown === wanted) return;
  marker.shown = wanted;
  marker.node.classList.toggle('on', !hidden);
}

/** One edge marker: a node, the transform last written to it, and whether it is up. */
interface Marker {
  node: HTMLElement;
  last: string;
  shown: string;
}

/** One weapon hand, with the two values already written to it. */
interface SlotNodes {
  slot: HTMLElement;
  arc: HTMLElement;
  name: HTMLElement;
  tag: HTMLElement;
  ammo: HTMLElement;
  gaugeFill: HTMLElement;
  /** The arc percentage already written; -1 so the first frame always writes. */
  arcValue: number;
  /**
   * The weapon already drawn here, or `null` before the first frame.
   *
   * `null` and not `''`: an empty hand's key is the empty string, and a fresh slot must
   * still be told it is empty. The name and the tag start out blank in the markup, so a
   * sentinel that could never be a weapon id is what makes the first frame write them.
   */
  drawn: string | null;
}

/**
 * The two lines a hand shows about its weapon: the name, and what family and firing
 * mode it is. Built once per weapon rather than once per frame — the hands change a
 * few times a run and are read sixty times a second.
 */
const handLabels = new Map<string, { name: string; tag: string }>();

/** What an empty hand says. One object, because the empty case is read every frame too. */
const EMPTY_HAND = { name: 'empty hand', tag: '' };

/**
 * The name a hand shows for a weapon id.
 *
 * `weapons.ts` keys a gun by `plasmaRepeater` because an id is a key, not a caption;
 * `PLASMAREPEATER` on the slot is the same string read wrong. Splitting the camel case
 * is the whole trick, and it means a new weapon needs no caption written for it.
 */
function handLabel(id: string): { name: string; tag: string } {
  let labels = handLabels.get(id);
  if (labels === undefined) {
    const def = WEAPONS.find((w) => w.id === id);
    const name = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    labels = { name, tag: def ? `${def.family} \u00b7 ${def.fire}` : '' };
    handLabels.set(id, labels);
  }
  return labels;
}

/**
 * One control.
 *
 * `action` is what the button *means* to anything reading the overlay from the outside —
 * a scenario clicks `[data-action='save']` — and defaults to the command. They differ once:
 * the title's Continue and the pause menu's Load are both `load`, but only the first is
 * Continue, and a selector that cannot tell two buttons apart cannot click one of them.
 */
function button(
  parent: HTMLElement,
  label: string,
  command: HudCommand,
  view: () => HudView,
  action: string = command,
): HTMLButtonElement {
  const b = el('button');
  b.className = 'btn';
  b.type = 'button';
  b.dataset['action'] = action;
  b.textContent = label;
  b.addEventListener('click', () => {
    // Focus has to go back to the page or the next Space press re-activates the
    // button instead of dashing.
    b.blur();
    view().command(command);
  });
  parent.appendChild(b);
  return b;
}

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
 * "Off the visible floor" is `TUNE.viewHalfX/Y` — the same 32x18 m rect the wave spawner
 * drops bodies outside of — rather than a second guess at what the camera covers. One rect,
 * read by the two things that need it: the spawner places a pack outside it, the HUD points
 * at it from inside it.
 *
 * The list is filled by insertion, so a full crate pool costs no sort and no allocation.
 */
function nearestOutside(pool: Pool, world: World, limit: number, bossOnly: boolean): number {
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

/**
 * Put one marker on the edge of the play area, pointing at its body.
 *
 * The screen-space direction comes out of the world offset (with the depth squeeze above) and
 * is pushed out to the edge of an inset ellipse — a `halfW` x `halfH` oval rather than a
 * rectangle, so a body in a corner gets an arrow that curves in around the corner panels
 * instead of one that hides behind them. Quantised to whole pixels and two degrees, so a fast
 * walk rewrites a transform a few times a second rather than sixty.
 */
function placeMarker(
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
function makeMarkers(parent: HTMLElement, className: string, count: number): Marker[] {
  const list: Marker[] = [];
  for (let i = 0; i < count; i++) {
    list.push({ node: make('i', `edge ${className}`, parent), last: '', shown: '0' });
  }
  return list;
}

export function createHud(root: HTMLElement): Hud {
  /** The view, filled in by the caller on the first tick. */
  let view: HudView | null = null;

  // The freeze dim, created before the HUD so it paints under it: a level-up stops
  // the world and says so, without taking the readouts down with it (DESIGN.md).
  make('div', 'dim', root);

  const overlay = make('div', 'hud', root);
  overlay.setAttribute('aria-hidden', 'true');

  // Top left: the map of everything within reach, on screen or not.
  const radar = createRadar();
  overlay.appendChild(radar.element);

  // Top centre: where the run is, and what the chapter is doing about it.
  const wavePanel = make('div', 'panel wave', overlay);
  const waveText = make('span', 'wave-label', wavePanel);
  const waveClock = make('b', 'wave-clock num', wavePanel);
  const waveBar = make('div', 'bar', wavePanel);
  const waveFill = make('i', 'fill warn', waveBar);

  // Under it: the encounter's plate, up only while one of them is on the floor. Thin, half
  // the screen wide, with the name along it — DESIGN.md's boss bar.
  const bossPanel = make('div', 'boss', overlay);
  const bossName = make('b', 'boss-name', bossPanel);
  const bossBar = make('div', 'bar boss-bar', bossPanel);
  const bossFill = make('i', 'fill boss-fill', bossBar);

  // Top right: score and kills, the only numbers that need reading while moving.
  const scorePanel = make('div', 'panel score', overlay);
  const scoreRows = ['score', 'kills'].map((key) => {
    const row = make('div', 'stat', scorePanel);
    make('span', 'key', row).textContent = key;
    return make('b', 'num', row);
  });

  // Bottom left: HP, shield on top of it, the dash pip and the level. Slim, never centred.
  const vitals = make('div', 'vitals', overlay);
  const hp = make('div', 'hp', vitals);
  const hpFill = make('i', 'fill hp-fill', hp);
  const shieldFill = make('i', 'fill shield-fill', hp);
  const dashPip = make('i', 'pip', vitals);
  const levelText = make('b', 'level num', vitals);

  // Bottom right: the two hands, the active one brighter, each bordered in its family's
  // colour and showing what that hand spends. The arc is a dial: it fills as a reload runs,
  // which is the one thing the ammo number cannot say on its own.
  const slots = make('div', 'slots', overlay);
  const slotNodes: SlotNodes[] = [0, 1].map(() => {
    const slot = make('div', 'slot', slots);
    const arc = make('i', 'reload-arc', slot);
    const name = make('span', 'slot-name', slot);
    const meta = make('div', 'slot-meta', slot);
    const tag = make('span', 'slot-tag', meta);
    const ammo = make('span', 'slot-ammo', meta);
    const gauge = make('div', 'bar', slot);
    const gaugeFill = make('i', 'fill ammo-fill', gauge);
    return { slot, arc, name, tag, ammo, gaugeFill, arcValue: -1, drawn: null };
  });

  // Right edge: power-ups with tier pips, and the clock on the ones that run out.
  const powers = make('div', 'powers', overlay);

  // The very bottom edge: XP, 4px, full width.
  const xpBar = make('div', 'xp', overlay);
  const xpFill = make('i', 'fill xp-fill', xpBar);

  // The screen edge. Both rows are absolutely placed over the whole overlay, so a marker's
  // transform starts from the middle of the screen and its own 24x24 box is centred on the
  // point `placeMarker` picked.
  const chestMarkers = makeMarkers(overlay, 'chest', CHEST_MARKERS);
  const bossMarkers = makeMarkers(overlay, 'boss-marker', BOSS_MARKERS);

  // Level-up: three cards, a heading and a reroll, centred over the frozen playfield.
  const cards = createCardPanel(
    (index) => view?.pick(index),
    () => view?.command('reroll'),
  );
  root.appendChild(cards.element);

  // Title menu: the scene machine's entry point, so Start has to be reachable. Continue
  // sits above it and starts hidden — it is only ever offered when there is a run in
  // storage to come back to, and the game that decides is the shell, not this file.
  const menu = make('div', 'menu', root);
  make('h1', 'title', menu).textContent = 'Neon Horde';
  make('p', 'subtitle', menu).textContent = 'A factory floor, a thousand bodies, one pistol.';
  const menuButtons = make('div', 'stack', menu);
  const continueBtn = button(menuButtons, 'Continue', 'load', () => view!, 'continue');
  continueBtn.hidden = true;
  button(menuButtons, 'Start  [Enter]', 'start', () => view!);

  const pausePanel = make('div', 'panel pause', root);
  make('h2', 'head', pausePanel).textContent = 'Paused';
  make('p', 'hint', pausePanel).textContent = 'WASD move · Space or Shift dash · Q swap hands · Esc resume';
  const pauseButtons = make('div', 'stack', pausePanel);
  button(pauseButtons, 'Resume  [Esc]', 'resume', () => view!);
  button(pauseButtons, 'Save run', 'save', () => view!, 'save');
  const loadBtn = button(pauseButtons, 'Load saved run', 'load', () => view!, 'load');
  loadBtn.hidden = true;
  button(pauseButtons, 'Restart run', 'restart', () => view!);
  button(pauseButtons, 'Menu', 'menu', () => view!);

  const summary = make('div', 'panel summary', root);
  const summaryHead = make('h2', 'head', summary);
  const summaryStats = make('div', 'stats', summary);
  const summaryRows = ['score', 'kills', 'time', 'level'].map((key) => {
    const row = make('div', 'stat', summaryStats);
    make('span', 'key', row).textContent = key;
    const value = make('b', 'num', row);
    return { key, value };
  });
  const summaryButtons = make('div', 'stack', summary);
  button(summaryButtons, 'Restart  [Enter]', 'restart', () => view!);
  button(summaryButtons, 'Menu', 'menu', () => view!);

  /** Values already written, so a steady frame costs nothing. */
  const last = { scene: '', powers: '', boss: '', bossOn: false };

  /** The power column's live rows, rebuilt only when the set of tiers moves. */
  let powerRows: Array<{ index: number; time: HTMLElement | null; text: string }> = [];

  /** The indices the column is about to draw. Reused for the same reason as `pickIdx`. */
  const shownPowers: number[] = [];

  /**
   * Rebuild the power column.
   *
   * Timed effects go first, because a clock is the only thing in the column that runs out and
   * a row with a countdown on it is never allowed to be the one that is hidden. Permanent
   * ones follow in table order.
   *
   * Twelve rows, then a count. A full table is thirty-four effects and a late run really can
   * hold twenty of them; drawn in full the column runs off both ends of the screen with the
   * clipped rows silently missing, which is the worst of both. Counted instead, the column
   * says what it left out and the last thing picked is still on screen.
   */
  function renderPowers(world: World): void {
    let signature = '';
    for (let i = 0; i < POWERUPS.length; i++) {
      const tier = world.powerTiers[i];
      if (tier > 0) signature += `${i}:${tier}${world.powerTime[i] > 0 ? 't' : ''};`;
    }
    if (signature === last.powers) return;
    last.powers = signature;

    const live = shownPowers;
    live.length = 0;
    for (let pass = 0; pass < 2; pass++) {
      const wantTimed = pass === 0;
      for (let i = 0; i < POWERUPS.length; i++) {
        if (world.powerTiers[i] === 0) continue;
        if ((world.powerTime[i] > 0) !== wantTimed) continue;
        live.push(i);
      }
    }

    while (powers.firstChild) powers.removeChild(powers.firstChild);
    powerRows = [];
    const shown = Math.min(live.length, POWER_ROWS);
    for (let at = 0; at < shown; at++) {
      const i = live[at];
      const tier = world.powerTiers[i];
      const def = POWERUPS[i];
      const item = make('div', 'power', powers);
      item.dataset['power'] = def.id;
      make('span', 'power-label', item).textContent = def.label;

      const pips = make('span', 'pips', item);
      for (let t = 0; t < def.maxTier; t++) {
        make('i', t < tier ? 'pip on' : 'pip', pips);
      }

      // A timed card is a thing to spend, so it says how much of it is left. The clock runs
      // out to zero and the row comes back down with the next signature change, which is the
      // same moment the stat stops counting in the sim.
      let time: HTMLElement | null = null;
      if (def.kind === 'timed') {
        time = make('b', 'power-time num', item);
        time.textContent = '';
      }
      powerRows.push({ index: i, time, text: '' });
    }

    if (live.length > shown) {
      make('div', 'power more', powers).textContent = `+${live.length - shown} more`;
    }
  }

  /** Write the clocks. Whole seconds, so a row is rewritten at most once a second. */
  function renderPowerTimes(world: World): void {
    for (let r = 0; r < powerRows.length; r++) {
      const row = powerRows[r];
      if (row.time === null) continue;
      const left = world.powerTime[row.index];
      const text = left > 0 ? `${Math.ceil(left)}s` : '';
      if (row.text !== text) {
        row.text = text;
        row.time.textContent = text;
      }
    }
  }

  /**
   * Move the edge markers, both kinds, on the map beat.
   *
   * Each kind is one `nearestOutside` sweep and a walk over a handful of nodes, so twenty-four
   * crates and three encounter bodies cost a dozen writes rather than a rebuild.
   */
  function renderMarkers(world: World, halfW: number, halfH: number): void {
    const player = world.player;

    let n = nearestOutside(world.chests, world, chestMarkers.length, false);
    for (let m = 0; m < chestMarkers.length; m++) {
      const marker = chestMarkers[m];
      if (m >= n) {
        setHidden(marker, true);
        continue;
      }
      const slot = pickIdx[m];
      placeMarker(
        marker,
        world.chests.x[slot] - player.x,
        world.chests.y[slot] - player.y,
        halfW,
        halfH,
      );
      setHidden(marker, false);
    }

    if (!world.boss.alive) {
      for (let m = 0; m < bossMarkers.length; m++) setHidden(bossMarkers[m], true);
      return;
    }
    n = nearestOutside(world.enemies, world, bossMarkers.length, true);
    for (let m = 0; m < bossMarkers.length; m++) {
      const marker = bossMarkers[m];
      if (m >= n) {
        setHidden(marker, true);
        continue;
      }
      const slot = pickIdx[m];
      placeMarker(
        marker,
        world.enemies.x[slot] - player.x,
        world.enemies.y[slot] - player.y,
        halfW,
        halfH,
      );
      setHidden(marker, false);
    }
  }

  /** Half the viewport, which is what the marker maths works in. Re-read, never per frame. */
  let halfW = 480;
  let halfH = 270;

  /** Frame counter, driving both throttles. */
  let frame = 0;

  return {
    element: overlay,

    tick(hudView) {
      view = hudView;
      const world = hudView.world;
      const scene = hudView.scene;
      const beat = frame % MAP_EVERY === 0;
      const resize = frame % SIZE_EVERY === 0;
      frame++;

      if (scene !== last.scene) {
        root.dataset['scene'] = scene;
        last.scene = scene;

        // The two ways back into a saved run, offered only while one exists. Re-read on
        // every screen change rather than every frame: the answer only moves when a run
        // ends or is written, and both happen across a screen change.
        const resumable = hudView.hasSave();
        continueBtn.hidden = !resumable;
        loadBtn.hidden = !resumable;

        if (scene === 'levelup') cards.render(world, true);
        if (scene === 'summary') {
          setText(summaryHead, world.player.alive ? 'Run over' : 'You died');
          setText(summaryRows[0].value, String(world.score));
          setText(summaryRows[1].value, String(world.kills));
          setText(summaryRows[2].value, `${world.time.toFixed(1)} s`);
          setText(summaryRows[3].value, String(world.player.level));
        }
        // A new screen is a new picture: the map and the arrows are stale by definition, and
        // a frozen scene would otherwise never be drawn again.
        radar.draw(world, true);
      }

      if (scene === 'levelup') cards.render(world, false);
      renderPowers(world);
      renderPowerTimes(world);

      const player = world.player;
      const health = player.maxHp > 0 ? Math.max(0, Math.min(1, player.hp / player.maxHp)) : 0;
      setFill(hpFill, health);
      // The shield is a second segment past the end of the health, not a copy laid over it:
      // on one track, where the bar stops is how much flesh is left and the cyan beyond it is
      // what has to be eaten first. Overlaid from the left, the two would hide each other and
      // the bar would read as less health than there is.
      setSpan(
        shieldFill,
        health,
        player.maxHp > 0 ? Math.min(1 - health, Math.max(0, player.shield / player.maxHp)) : 0,
      );
      dashPip.classList.toggle('ready', player.dashCd <= 0);
      setText(levelText, `LV ${player.level}`);

      setText(scoreRows[0], String(world.score));
      setText(scoreRows[1], String(world.kills));

      setText(waveText, `Chapter ${world.chapter + 1} \u00b7 Wave ${world.wave.index}`);
      // The clock says what the chapter is doing rather than counting down a wave that the
      // encounter has already replaced: the script's timer is only worth reading while the
      // script is what is left (see `Phase` in systems/levels.ts).
      const phase = world.wave.phase;
      setText(
        waveClock,
        phase === Phase.Encounter
          ? 'Encounter'
          : phase === Phase.Intermission
            ? 'Chapter clear'
            : `${Math.max(0, Math.ceil(world.wave.timeLeft))}s`,
      );
      setFill(waveFill, 1 - Math.max(0, Math.min(1, world.wave.timeLeft / TUNE.waveLength)));

      // The encounter's plate: the same combined HP the chapter machine waits on, so the bar
      // that empties is the bar that ends the chapter. `bossOn` is remembered beside the name
      // so the plate comes back down on the frame the last one falls, and a second encounter
      // in one chapter gets its own plate even if it shares the first one's name and HP.
      const boss = world.boss;
      if (boss.alive) {
        const key = `${boss.name}|${Math.round(boss.maxHp)}`;
        if (key !== last.boss) {
          last.boss = key;
          setText(bossName, boss.name);
        }
        if (!last.bossOn) {
          last.bossOn = true;
          bossPanel.classList.add('on');
        }
        setFill(bossFill, boss.maxHp > 0 ? Math.max(0, boss.hp / boss.maxHp) : 0);
      } else if (last.bossOn) {
        last.bossOn = false;
        last.boss = '';
        bossPanel.classList.remove('on');
      }

      setFill(xpFill, xpProgress(world));

      for (let i = 0; i < slotNodes.length; i++) {
        const node = slotNodes[i];
        const slot = world.slots[i];
        const def = slot && slot.weapon >= 0 ? WEAPONS[slot.weapon] : undefined;
        // The name, the family tag and the border colour are all facts about the weapon, so
        // they move together: one key decides all three and a steady hand writes none of them.
        const key = def ? def.id : '';
        if (node.drawn !== key) {
          node.drawn = key;
          const labels = def ? handLabel(def.id) : EMPTY_HAND;
          setText(node.name, labels.name);
          setText(node.tag, labels.tag);
          node.slot.dataset['family'] = def ? def.family : 'none';
        }
        setText(node.ammo, def && slot ? gaugeText(slot, def) : '');
        setFill(node.gaugeFill, def && slot ? gaugeFill(slot, def) : 0);
        node.slot.classList.toggle('active', i === world.activeSlot);
        node.slot.classList.toggle('reloading', (slot?.reload ?? 0) > 0);
        // The dial fills as the reload runs. Only a magazine hand has one: heat and charge
        // already say what they are on the gauge, and there is no honest fraction to draw
        // for a vent that has no pinned length.
        const total = def?.ammo?.reload ?? 0;
        const left = slot?.reload ?? 0;
        setArc(node, total > 0 && left > 0 ? 1 - left / total : 0);
      }

      // The two map sweeps, each on its own beat: the radar repaints 20 times a second and
      // decides for itself, the arrows walk the pools every third frame.
      radar.draw(world, false);
      if (beat) {
        if (resize) {
          halfW = Math.max(80, root.clientWidth / 2);
          halfH = Math.max(80, root.clientHeight / 2);
        }
        renderMarkers(world, halfW - EDGE_INSET_X, halfH - EDGE_INSET_Y);
      }
    },
  };
}

/**
 * What a hand's gauge says.
 *
 * Three constraints, three readings, and each shows the number the player can act on:
 * a magazine counts rounds, a heat hand says `venting` while it is locked out (its
 * heat is already spent, so the number would be noise), and a charge hand counts the
 * charge left, because that is what decides whether the next shot happens.
 */
function gaugeText(slot: WeaponSlot, def: WeaponDef): string {
  if (slot.reload > 0) return 'reloading';
  if (def.ammo) return `${slot.ammo}/${def.ammo.mag}`;
  if (def.heat) return slot.venting ? 'venting' : 'heat';
  if (def.energy) return `${Math.round(slot.energy)}`;
  return '';
}

/**
 * How full that gauge is, 0..1: the constraint that is left, not the one that is gone,
 * so every hand reads the same way — a full bar means ready.
 */
function gaugeFill(slot: WeaponSlot, def: WeaponDef): number {
  if (def.ammo) return def.ammo.mag > 0 ? slot.ammo / def.ammo.mag : 0;
  if (def.heat) return def.heat.max > 0 ? Math.max(0, 1 - slot.heat / def.heat.max) : 0;
  if (def.energy) return def.energy.capacity > 0 ? slot.energy / def.energy.capacity : 0;
  return 0;
}
