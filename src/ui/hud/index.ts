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
 * This file is the assembly: the layout built once, and the per-frame read of the World that
 * keeps it up to date. The three pieces it pulls in are the parts with a rule of their own —
 * `paint.ts` (write nothing twice), `markers.ts` (who gets an arrow, and where it goes) and
 * `hands.ts` (what a weapon's gauge says). Nothing here imports the renderer, and nothing
 * here decides a gameplay action: `HudCommand` below is a list of *scene* requests.
 */

import { POWERUPS } from '../../content/powerups';
import { WEAPONS } from '../../content/weapons';
import { Phase } from '../../sim/systems/levels';
import { xpProgress } from '../../sim/systems/pickups';
import { TUNE, type World } from '../../sim/world';
import type { BindAction, BindTable } from '../../input/bindings';
import type { Meta, Settings } from '../../game/persistence';
import { createCardPanel } from '../levelup';
import { createScreens } from '../menus';
import { createRadar } from '../radar';
import '../styles.css';
import { EMPTY_HAND, gaugeFill, gaugeText, handLabel } from './hands';
import {
  BOSS_MARKERS,
  CHEST_MARKERS,
  EDGE_INSET_X,
  EDGE_INSET_Y,
  MAP_EVERY,
  makeMarkers,
  nearestOutside,
  pickIdx,
  placeMarker,
} from './markers';
import { make, setArc, setFill, setHidden, setSpan, setText, type SlotNodes } from './paint';


/**
 * What an HUD control asks the game to do.
 *
 * All of them are *scene* requests: not one of them is a gameplay action. Moving, shooting,
 * dashing and picking a card go through the input sampler and land in an `InputFrame`, because
 * they belong to the simulation's clock; these belong to the shell's, and the shell decides what
 * each one means. `pause` and `resume` are one key read two ways, and `back` is the way out of a
 * panel that was opened from another panel. `arena` is the one of them with no key at all — see
 * the `arena` case in `game/app.ts`.
 */
export type HudCommand =
  | 'start'
  | 'arena'
  | 'pause'
  | 'resume'
  | 'restart'
  | 'restartLevel'
  | 'menu'
  | 'reroll'
  | 'save'
  | 'load'
  | 'levelselect'
  | 'settings'
  | 'history'
  | 'back';

/**
 * The slice of the game the overlay reads. Kept structural so the HUD needs no import from the
 * layer that owns it — the three types above are data shapes, not owners.
 *
 * Everything below `hasSave` exists so the panels can stay ignorant: the chapter grid asks
 * whether a chapter is open rather than working out what "open" means, the dials read and write
 * one settings object rather than keeping a copy of it, and the Controls tab reads and edits the
 * one key map the sampler also reads (`input/bindings.ts`).
 */
export interface HudView {
  readonly scene: string;
  readonly world: World;
  /** Take level-up card `index`, from a click. The keys go through the sampler. */
  pick(index: number): void;
  command(cmd: HudCommand): void;
  /**
   * Whether a run is waiting in storage. Asked when a screen changes, which is the only moment
   * it matters: it decides whether the title offers Continue and whether the pause panel offers
   * Load, and a screen that cannot do a thing should not show a button for it.
   */
  hasSave(): boolean;
  /** Take a chapter tile. `index` is the chapter's slot in `content/levels/`. */
  choose(index: number): void;
  /** The live settings, for the Settings panel. Read while that panel is up. */
  readonly settings: Settings;
  /** Change one, and write the file. A view that is not storage-backed can ignore it. */
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  /** Unlocks and history, for the chapter grid and the Runs table. */
  readonly meta: Meta;
  /** The live key map, which the Controls tab lists and edits. */
  readonly bindings: BindTable;
  /** Put `action` onto `source`, with the swap rule that lives in `input/bindings.ts`. */
  rebind(action: BindAction, source: string): void;
  /** Back to the shipped map. */
  resetBindings(): void;
}

export interface Hud {
  /** Update the overlay from the game. Called once per rendered frame. */
  tick(view: HudView): void;
  /** The overlay's root, so the caller can take it back down. */
  readonly element: HTMLElement;
}

/**
 * How many power-up rows the right column draws before it starts counting instead.
 *
 * Twelve rows is about half the column's height, which leaves room for a run that has picked
 * everything; the rest arrives as one "+N more" line rather than as clipped text.
 */
const POWER_ROWS = 12;

/** Frames between re-reads of the viewport size, which changes when the window does. */
const SIZE_EVERY = 45;

/**
 * The scenes that have a fight to read out.
 *
 * Everywhere else the readouts are hidden by CSS and there is nothing behind them: the title and
 * the four panel screens show an idle or frozen world, and painting a clock, a power column and
 * two map sweeps for a world nobody is playing is work spent on pixels that are not drawn.
 */
const PLAY_SCENES = new Set(['playing', 'levelup', 'paused', 'summary', 'victory']);

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

  // The screen panels — title, chapters, settings, history, pause, summary, victory — live in
  // `menus.ts` and are siblings of `.hud`, never children of it: `.hud` is `pointer-events:
  // none`, and a button that inherits that cannot be clicked. They are built after `.dim` so a
  // frozen playfield paints under them, and which one is up is CSS's job, keyed off the scene
  // written just below.
  const screens = createScreens(root, () => view!);

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
        // One attribute write moves every panel at once: `styles.css` shows the panel whose
        // `data-panel` matches the scene and hides the rest, and takes the readouts down with it
        // on the screens that have nothing to read out.
        root.dataset['scene'] = scene;
        last.scene = scene;

        // The cards have been hidden since the last time they were up, so they cannot trust what
        // they drew then (see `CardPanel.render`'s `force`).
        if (scene === 'levelup') cards.render(world, true);
        // A new screen is a new picture: the map and the arrows are stale by definition, and a
        // frozen scene would otherwise never be drawn again.
        radar.draw(world, true);
      }

      screens.sync(hudView);

      if (!PLAY_SCENES.has(scene)) return;

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
