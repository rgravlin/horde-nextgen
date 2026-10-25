import { POWERUPS, baseStats, type PowerupDef } from '../content/powerups';
import { WEAPONS } from '../content/weapons';
import { xpProgress } from '../sim/systems/pickups';
import { TUNE, type World } from '../sim/world';
import './theme.css';

/**
 * The HUD: a DOM overlay over the canvas (ARCHITECTURE.md "Module map").
 *
 * It reads the World and the scene and writes pixels into HTML; it decides nothing.
 * Every element is built once when the run is created and then updated in place,
 * because this runs every rendered frame and a `document.createElement` per frame
 * would show up as jank long before a triangle would.
 *
 * Layout and palette come from DESIGN.md: panels in the corners, the middle 60% of
 * the screen clear, HP slim and bottom-left, XP along the very bottom edge, hairline
 * borders and no CSS glow (glow is the renderer's job).
 */

/** What an HUD control asks the game to do. */
export type HudCommand = 'start' | 'pause' | 'resume' | 'restart' | 'menu' | 'reroll';

/** The slice of the game the HUD reads. Kept structural so the HUD needs no import
 * from the layer that owns it. */
export interface HudView {
  readonly scene: string;
  readonly world: World;
  /** Take level-up card `index`, from a click. The keys go through the sampler. */
  pick(index: number): void;
  command(cmd: HudCommand): void;
}

export interface Hud {
  /** Update the overlay from the game. Called once per rendered frame. */
  tick(view: HudView): void;
  /** The overlay's root, so the caller can take it back down. */
  readonly element: HTMLElement;
}

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

function button(parent: HTMLElement, label: string, command: HudCommand, view: () => HudView): HTMLButtonElement {
  const b = el('button');
  b.className = 'btn';
  b.type = 'button';
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
 * The stat lines a card shows, derived from the power-up's own `apply` rather than
 * from hand-written copy, so a card cannot promise a number the sim will not give.
 */
function statLines(def: PowerupDef, tier: number): string {
  const before = baseStats();
  def.apply(before, tier);
  const after = baseStats();
  def.apply(after, tier + 1);

  const lines: string[] = [];
  if (after.dmg !== before.dmg) lines.push(`+${Math.round((after.dmg / before.dmg - 1) * 100)}% damage`);
  if (after.fireRate !== before.fireRate) {
    lines.push(`+${Math.round((after.fireRate / before.fireRate - 1) * 100)}% fire rate`);
  }
  if (after.magnet !== before.magnet) lines.push(`+${(after.magnet - before.magnet).toFixed(1)} m pickup range`);
  return lines.join('\n');
}

export function createHud(root: HTMLElement): Hud {
  /** The view, filled in by the caller on the first tick. */
  let view: HudView | null = null;

  // The freeze dim, created before the HUD so it paints under it: a level-up stops
  // the world and says so, without taking the readouts down with it (DESIGN.md).
  make('div', 'dim', root);

  const overlay = make('div', 'hud', root);
  overlay.setAttribute('aria-hidden', 'true');

  // Top centre: where the run is. The thin bar is the wave clock.
  const wavePanel = make('div', 'panel wave', overlay);
  const waveText = make('span', 'wave-label', wavePanel);
  const waveBar = make('div', 'bar', wavePanel);
  const waveFill = make('i', 'fill warn', waveBar);

  // Top right: score and kills, the only numbers that need to be read while moving.
  const scorePanel = make('div', 'panel score', overlay);
  const scoreText = make('b', 'num', scorePanel);
  const killText = make('b', 'num', scorePanel);
  make('span', 'label', scorePanel).textContent = 'SCORE';

  // Bottom left: HP, shield on top of it, and the dash pip. Slim, never centred.
  const vitals = make('div', 'vitals', overlay);
  const hp = make('div', 'hp', vitals);
  const hpFill = make('i', 'fill hp-fill', hp);
  const shieldFill = make('i', 'fill shield-fill', hp);
  const dashPip = make('i', 'pip', vitals);

  // Bottom right: the two hands.
  const slots = make('div', 'slots', overlay);
  const slotNodes = [0, 1].map(() => {
    const slot = make('div', 'slot', slots);
    const name = make('span', 'slot-name', slot);
    const ammo = make('span', 'slot-ammo', slot);
    const gauge = make('div', 'bar', slot);
    const gaugeFill = make('i', 'fill ammo-fill', gauge);
    return { slot, name, ammo, gaugeFill };
  });

  // Right edge: power-ups with tier pips.
  const powers = make('div', 'powers', overlay);

  // The very bottom edge: XP, 4px, full width.
  const xpBar = make('div', 'xp', overlay);
  const xpFill = make('i', 'fill xp-fill', xpBar);

  // Level-up: three cards and a reroll, centred over the frozen playfield.
  const cardPanel = make('div', 'cards', root);
  const cards = [0, 1, 2].map((index) => {
    const card = el('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset['card'] = String(index);
    card.addEventListener('click', () => {
      card.blur();
      view?.pick(index);
    });
    cardPanel.appendChild(card);
    const title = make('span', 'card-title', card);
    const pips = make('span', 'card-pips', card);
    const stats = make('span', 'card-stats', card);
    return { card, title, pips, stats };
  });
  const reroll = button(cardPanel, 'Reroll  [R]', 'reroll', () => view!);

  // Title menu: the scene machine's entry point, so Start has to be reachable.
  const menu = make('div', 'menu', root);
  make('h1', 'title', menu).textContent = 'Neon Horde';
  make('p', 'subtitle', menu).textContent = 'A factory floor, a thousand bodies, one pistol.';
  const menuButtons = make('div', 'stack', menu);
  button(menuButtons, 'Start  [Enter]', 'start', () => view!);

  const pausePanel = make('div', 'panel pause', root);
  make('h2', 'head', pausePanel).textContent = 'Paused';
  make('p', 'hint', pausePanel).textContent = 'WASD move · Space or Shift dash · Q swap hands · Esc resume';
  const pauseButtons = make('div', 'stack', pausePanel);
  button(pauseButtons, 'Resume  [Esc]', 'resume', () => view!);
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
  const last = {
    scene: '',
    powers: '',
    cards: '',
    hp: -1,
    shield: -1,
  };

  function renderPowers(world: World): void {
    let signature = '';
    for (let i = 0; i < POWERUPS.length; i++) {
      const tier = world.powerTiers[i];
      if (tier > 0) signature += `${i}:${tier};`;
    }
    if (signature === last.powers) return;
    last.powers = signature;

    while (powers.firstChild) powers.removeChild(powers.firstChild);
    for (let i = 0; i < POWERUPS.length; i++) {
      const tier = world.powerTiers[i];
      if (tier === 0) continue;
      const item = make('div', 'power', powers);
      make('span', 'power-label', item).textContent = POWERUPS[i].label;
      const pips = make('span', 'pips', item);
      for (let t = 0; t < POWERUPS[i].maxTier; t++) {
        make('i', t < tier ? 'pip on' : 'pip', pips);
      }
    }
  }

  function renderCards(world: World): void {
    const offer = `${world.levelUpChoices.join(',')}|${world.rerollUsed ? 1 : 0}`;
    if (offer === last.cards) return;
    last.cards = offer;

    for (let index = 0; index < cards.length; index++) {
      const entry = cards[index];
      const id = world.levelUpChoices[index];
      const def = id >= 0 && id < POWERUPS.length ? POWERUPS[id] : undefined;
      entry.card.classList.toggle('empty', def === undefined);
      entry.card.classList.toggle('curse', def?.kind === 'curse');
      if (!def) {
        setText(entry.title, '—');
        setText(entry.pips, '');
        setText(entry.stats, 'nothing left to offer');
        continue;
      }
      const tier = world.powerTiers[id];
      setText(entry.title, def.label);
      setText(entry.pips, `\u25CF`.repeat(tier) + `\u25CB`.repeat(Math.max(0, def.maxTier - tier - 1)));
      setText(entry.stats, statLines(def, tier));
    }
    reroll.disabled = world.rerollUsed;
  }

  return {
    element: overlay,

    tick(hudView) {
      view = hudView;
      const world = hudView.world;
      const scene = hudView.scene;

      if (scene !== last.scene) {
        root.dataset['scene'] = scene;
        last.scene = scene;
        last.cards = '';
        if (scene === 'levelup') renderCards(world);
        if (scene === 'summary') {
          setText(summaryHead, world.player.alive ? 'Run over' : 'You died');
          setText(summaryRows[0].value, String(world.score));
          setText(summaryRows[1].value, String(world.kills));
          setText(summaryRows[2].value, `${world.time.toFixed(1)} s`);
          setText(summaryRows[3].value, String(world.player.level));
        }
      }

      if (scene === 'levelup') renderCards(world);
      renderPowers(world);

      const player = world.player;
      setFill(hpFill, player.maxHp > 0 ? player.hp / player.maxHp : 0);
      setFill(shieldFill, player.maxHp > 0 ? Math.min(1, player.shield / player.maxHp) : 0);
      dashPip.classList.toggle('ready', player.dashCd <= 0);

      setText(scoreText, String(world.score));
      setText(killText, String(world.kills));

      setText(waveText, `Chapter ${world.chapter + 1} \u00b7 Wave ${world.wave.index}`);
      setFill(waveFill, 1 - Math.max(0, Math.min(1, world.wave.timeLeft / TUNE.waveLength)));

      setFill(xpFill, xpProgress(world));

      for (let i = 0; i < slotNodes.length; i++) {
        const node = slotNodes[i];
        const slot = world.slots[i];
        const def = slot && slot.weapon >= 0 ? WEAPONS[slot.weapon] : undefined;
        setText(node.name, def ? def.id : 'empty hand');
        setText(node.ammo, def ? (slot.reload > 0 ? 'reloading' : `${slot.ammo}/${def.ammo.mag}`) : '');
        setFill(node.gaugeFill, def && slot ? slot.ammo / def.ammo.mag : 0);
        node.slot.classList.toggle('active', i === world.activeSlot);
        node.slot.classList.toggle('reloading', (slot?.reload ?? 0) > 0);
      }
    },
  };
}