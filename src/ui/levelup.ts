/**
 * The level-up cards (DESIGN.md: "the game freezes, the playfield dims, three cards sit
 * centred, each with the family colour along its top edge, the name, the tier pips and
 * stat deltas in mono").
 *
 * Its own file for two reasons. The first is size: a card is a component, and the HUD has
 * eleven other things to draw every frame. The second is the rule the cards are built on —
 * **a card may not promise a number the sim will not give.** The deltas are read by running
 * the power-up's own `apply` twice against a fresh `StatBlock` (what it does at the tier you
 * have, against what it does one tier higher), so a card cannot drift out of date when a
 * number in `content/powerups.ts` moves, and a card for a power-up that changes two things
 * shows both. Hand-written copy would go stale on the first rebalance and read as a lie.
 *
 * Colour per card is the power-up's *kind* rather than a weapon family — permanent cyan,
 * timed violet, curse magenta — which is the power table's own three-way split and the thing
 * a player is actually choosing between: a number that lasts, a number that runs out, and a
 * number bought with a worse one.
 *
 * The down-arrow stays magenta rather than Threat Red. DESIGN.md reserves that hue for
 * telegraphs, and a card is the opposite of a telegraph.
 */

import { baseStats, POWERUPS, type PowerupKind, type StatBlock } from '../content/powerups';
import type { World } from '../sim/world';

/** How many stat lines a card may show before it stops being readable in two seconds. */
const MAX_LINES = 5;

export interface CardPanel {
  /** The panel's root, which the caller hangs off the overlay. */
  readonly element: HTMLElement;
  /**
   * Re-draw the three cards when the offer changed. Cheap when it did not: one string
   * compare against the offer already drawn. `force` is for a scene change, where the panel
   * has been hidden and cannot trust what it drew last time it was up.
   */
  render(world: World, force: boolean): void;
}

/**
 * How one stat is read back as words.
 *
 * `mode` says what the number *is*, which is the only way to print it honestly: `dmg` is a
 * multiplier (a ratio of it is the percentage the player thinks in), `crit` is a chance
 * written as a fraction (`pp` = percentage points), and `sabot` is a distance in metres
 * (`num`). `betterUp` is which direction is the good one, so `spread` and `dashCd` — where
 * smaller is better — print as a win instead of a loss.
 */
interface StatRead {
  readonly key: keyof StatBlock;
  readonly label: string;
  readonly mode: 'pct' | 'pp' | 'num';
  readonly betterUp: boolean;
  /** Between the number and the label; empty when the label already carries the unit. */
  readonly unit: string;
}

/** Every field a card can move, in the order the block lists them. */
const READS: readonly StatRead[] = [
  { key: 'dmg', label: 'damage', mode: 'pct', betterUp: true, unit: '' },
  { key: 'fireRate', label: 'fire rate', mode: 'pct', betterUp: true, unit: '' },
  { key: 'magnet', label: 'pickup range', mode: 'num', betterUp: true, unit: ' m' },
  { key: 'crit', label: 'crit chance', mode: 'pp', betterUp: true, unit: '' },
  { key: 'critMult', label: 'crit damage', mode: 'pct', betterUp: true, unit: '' },
  { key: 'armor', label: 'damage soaked', mode: 'pp', betterUp: true, unit: '' },
  { key: 'fragile', label: 'damage taken', mode: 'pp', betterUp: false, unit: '' },
  { key: 'shield', label: 'shield pool', mode: 'num', betterUp: true, unit: '' },
  { key: 'regen', label: 'hp per second', mode: 'num', betterUp: true, unit: '' },
  { key: 'lifesteal', label: 'life steal', mode: 'pp', betterUp: true, unit: '' },
  { key: 'thorns', label: 'thorns', mode: 'num', betterUp: true, unit: '' },
  { key: 'speed', label: 'walk speed', mode: 'pct', betterUp: true, unit: '' },
  { key: 'dashCd', label: 'dash cooldown', mode: 'pct', betterUp: false, unit: '' },
  { key: 'spread', label: 'spread', mode: 'pct', betterUp: false, unit: '' },
  { key: 'pierce', label: 'bodies pierced', mode: 'num', betterUp: true, unit: '' },
  { key: 'extraShots', label: 'extra projectiles', mode: 'num', betterUp: true, unit: '' },
  { key: 'homing', label: 'homing turn', mode: 'num', betterUp: true, unit: ' rad' },
  { key: 'chain', label: 'chain jumps', mode: 'num', betterUp: true, unit: '' },
  { key: 'sabot', label: 'burst radius', mode: 'num', betterUp: true, unit: ' m' },
  { key: 'slowField', label: 'slow in field', mode: 'pp', betterUp: true, unit: '' },
  { key: 'slowRadius', label: 'field radius', mode: 'num', betterUp: true, unit: ' m' },
  { key: 'drone', label: 'drone shots', mode: 'num', betterUp: true, unit: '' },
];

/** The kind tag, which is the choice the card is asking for. */
function kindTag(kind: PowerupKind, duration: number | undefined): string {
  if (kind === 'curse') return 'Curse';
  if (kind === 'timed') return `${duration ?? 0}s buff`;
  return 'Permanent';
}

/** Trim a difference to two decimals at most, and never print `1.00` for `1`. */
function trim(value: number): string {
  const text = Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(2);
  const cut = text.endsWith('0') ? text.replace(/0+$/, '') : text;
  return cut.endsWith('.') ? cut.slice(0, -1) : cut;
}

/**
 * What the next tier of this power-up changes, as far as the player is concerned.
 *
 * Two fresh blocks, three calls: the block on its own, the block at the tier already held,
 * and the block one tier higher. The difference between the last two is exactly what picking
 * the card would do, whatever order the run collected its power-ups in — which is the
 * property a per-card copy string could never keep.
 */
function deltaLines(def: (typeof POWERUPS)[number], tier: number): Array<{ text: string; good: boolean }> {
  const held = baseStats();
  def.apply(held, tier);
  const next = baseStats();
  def.apply(next, tier + 1);

  const lines: Array<{ text: string; good: boolean }> = [];
  for (const read of READS) {
    const before = held[read.key];
    const after = next[read.key];
    if (after === before) continue;

    const up = after > before;
    let amount = '';
    if (read.mode === 'pct') {
      if (before === 0) continue;
      const pct = (after / before - 1) * 100;
      if (Math.abs(pct) < 0.5) continue;
      amount = `${Math.abs(pct) >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
    } else if (read.mode === 'pp') {
      amount = `${((after - before) * 100).toFixed(0)}%`;
    } else {
      amount = trim(after - before);
    }

    const magnitude = amount.replace('-', '');
    const sign = amount.startsWith('-') ? '-' : '+';
    lines.push({
      // The arrow is the direction the number moves, the colour is whether that helps. They
      // disagree on purpose for the three stats where smaller is better: a dash cooldown that
      // drops is a win printed with a down arrow.
      text: `${up ? '\u2191' : '\u2193'} ${sign}${magnitude}${read.unit} ${read.label}`,
      good: up === read.betterUp,
    });
    if (lines.length === MAX_LINES) break;
  }
  return lines;
}

/**
 * The line along the bottom of the card: how far this power-up has already been taken and
 * how far it goes. Derived from the tier and the cap, so it cannot disagree with the pips
 * above it, and it carries the part the pips cannot say in words.
 */
function tierText(tier: number, maxTier: number): string {
  if (tier === 0) return `New \u00b7 up to ${maxTier}`;
  return `Tier ${tier} \u2192 ${tier + 1} of ${maxTier}`;
}

export function createCardPanel(
  choose: (index: number) => void,
  reroll: () => void,
): CardPanel {
  const panel = document.createElement('div');
  panel.className = 'cards';

  const head = document.createElement('div');
  head.className = 'cards-head';
  const heading = document.createElement('b');
  heading.className = 'cards-title';
  const hint = document.createElement('span');
  hint.className = 'cards-hint';
  hint.textContent = '1 / 2 / 3, click a card or A / X / Y on a pad \u00b7 R rerolls';
  head.appendChild(heading);
  head.appendChild(hint);

  const row = document.createElement('div');
  row.className = 'card-row';

  const cards: Array<{
    node: HTMLButtonElement;
    kind: HTMLElement;
    key: HTMLElement;
    title: HTMLElement;
    pips: HTMLElement;
    stats: HTMLElement;
    tier: HTMLElement;
  }> = [];

  for (let index = 0; index < 3; index++) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset['card'] = String(index);
    card.addEventListener('click', () => {
      // Focus has to go back to the page or the next key press re-activates the card.
      card.blur();
      choose(index);
    });

    // The key that takes this card, named on the card. The hint line above the row says
    // "1 / 2 / 3" and this says which of the three is which.
    const key = document.createElement('b');
    key.className = 'card-key';
    key.textContent = String(index + 1);

    const kind = document.createElement('span');
    kind.className = 'card-kind';
    const title = document.createElement('span');
    title.className = 'card-title';
    const pips = document.createElement('span');
    pips.className = 'card-pips';
    const stats = document.createElement('span');
    stats.className = 'card-stats';
    const tier = document.createElement('span');
    tier.className = 'card-tier';

    card.appendChild(key);
    card.appendChild(kind);
    card.appendChild(title);
    card.appendChild(pips);
    card.appendChild(stats);
    card.appendChild(tier);
    row.appendChild(card);
    cards.push({ node: card, kind, key, title, pips, stats, tier });
  }

  const foot = document.createElement('div');
  foot.className = 'cards-foot';
  const rerollBtn = document.createElement('button');
  rerollBtn.type = 'button';
  rerollBtn.className = 'btn';
  rerollBtn.dataset['action'] = 'reroll';
  rerollBtn.textContent = 'Reroll  [R]';
  rerollBtn.addEventListener('click', () => {
    rerollBtn.blur();
    reroll();
  });
  foot.appendChild(rerollBtn);

  panel.appendChild(head);
  panel.appendChild(row);
  panel.appendChild(foot);

  /** The offer already drawn, so a steady frame costs one string compare. */
  let last = '';

  /** Fill one card's pip row: owned tiers, the tier being gained, then the rest. */
  function drawPips(node: HTMLElement, tier: number, maxTier: number): void {
    while (node.firstChild) node.removeChild(node.firstChild);
    for (let t = 0; t < maxTier; t++) {
      // Boxes, not glyphs: `.pip` is a 6px square in styles.css, the same mark the power
      // column uses, so the two pip rows in the game read as one language.
      const pip = document.createElement('i');
      pip.className = t < tier ? 'pip on' : t === tier ? 'pip next' : 'pip';
      node.appendChild(pip);
    }
  }

  function drawCard(entry: (typeof cards)[number], world: World, index: number): void {
    const id = world.levelUpChoices[index];
    const def = id >= 0 && id < POWERUPS.length ? POWERUPS[id] : undefined;

    entry.node.className = def === undefined ? 'card empty' : `card ${def.kind}`;
    if (def === undefined) {
      entry.kind.textContent = '';
      entry.title.textContent = '\u2014';
      entry.pips.textContent = '';
      entry.stats.textContent = 'nothing left to offer';
      entry.tier.textContent = '';
      return;
    }

    const tier = world.powerTiers[id];
    entry.kind.textContent = kindTag(def.kind, def.duration);
    entry.title.textContent = def.label;
    drawPips(entry.pips, tier, def.maxTier);
    entry.tier.textContent = tierText(tier, def.maxTier);

    while (entry.stats.firstChild) entry.stats.removeChild(entry.stats.firstChild);
    for (const line of deltaLines(def, tier)) {
      const row2 = document.createElement('i');
      row2.className = line.good ? 'up' : 'down';
      row2.textContent = line.text;
      entry.stats.appendChild(row2);
    }
  }

  return {
    element: panel,

    render(world, force) {
      const offer = `${world.player.level}|${world.levelUpChoices.join(',')}|${world.rerollUsed ? 1 : 0}`;
      if (!force && offer === last) return;
      last = offer;

      heading.textContent = `Level ${world.player.level} \u2014 choose one`;
      for (let index = 0; index < cards.length; index++) drawCard(cards[index], world, index);
      rerollBtn.disabled = world.rerollUsed;
    },
  };
}