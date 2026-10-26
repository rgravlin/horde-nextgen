/**
 * The screen panels: title, chapter select, settings, history, pause, summary and victory.
 *
 * Everything here is a *reader* and a *button* (ARCHITECTURE.md "Data flow"): it paints what the
 * shell says the scene is and hands back a command or a choice when a control is used. No rule is
 * decided in this file — a chapter tile does not know whether its chapter is unlocked, it asks —
 * and no gameplay value is ever touched, which is what lets the whole layer be driven without a
 * renderer by handing it an object.
 *
 * **Built once, updated in place**, like the HUD's corners: every panel exists before the first
 * frame and is shown by CSS keyed off `#ui[data-scene]` (see `styles.css`), so a scene change
 * costs one attribute write. Two panels would otherwise rebuild their contents every frame — the
 * chapter grid and the run-history table — so `sync` is told whether the scene just changed, and
 * they repaint only then. Anything that cannot move while a panel sits open (a dial, a key map)
 * is not repainted while it sits open either: the settings panel is up next to the live game, and
 * twenty-nine rows read every frame is twenty-nine string builds for values that only change when
 * a row is clicked.
 *
 * **Controls are buttons, all the way down.** A volume row is a button that steps through five
 * stops; a keybind row is a button that listens for the next key. DESIGN.md asks for
 * "left-aligned vertical button stacks", the scenario harness clicks `[data-action]`, and a row
 * that is one control rather than a slider plus a label plus a shortcut has one thing to test. A
 * row prints the value the player has *now*, never the one a click would give them: a panel that
 * opens showing the next rung down reads as a panel that is already off by one.
 *
 * **The rebind listener is capture-phase** on the window, so it sees a key before the input
 * sampler's own `keydown` listener does and can swallow it: a key pressed to *name* a binding must
 * not also be spent *as* that binding, which is how an Escape meant as "cancel this row" would
 * otherwise also close the panel it was cancelling out of.
 */

import { LEVELS } from '../content/levels';
import { BIND_DEFS, describeBinds, describeSource, type BindAction, type BindTable } from '../input/bindings';
import { NO_CLEAR, type Meta, type Settings } from '../game/persistence';
import type { HudCommand, HudView } from './hud';

/** What one built panel can do: repaint itself from the live view. */
interface Panel {
  readonly id: string;
  /** `fresh` is true on the frame the scene changed, which is when a table may be rebuilt. */
  sync(view: HudView, fresh: boolean): void;
}

const el = (tag: string, className: string, parent: HTMLElement): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
};

function text(tag: string, className: string, parent: HTMLElement, value: string): HTMLElement {
  const node = el(tag, className, parent);
  node.textContent = value;
  return node;
}

/**
 * A pool id's caption, for the two places that list weapons by what they are called.
 *
 * An id is a key (`plasmaRepeater`) and a caption is a caption (`Plasma Repeater`); splitting the
 * camel case is the same trick `handLabel` uses in `hud.ts`, and it means a new weapon needs no
 * caption written for it either.
 */
function readable(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** `0:43` for a chapter time, `--` for one that has never happened. */
function clockTime(seconds: number): string {
  if (seconds === NO_CLEAR || !(seconds >= 0)) return '--';
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Percent, for the four rows that are a gain or a scale. */
function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** A dial's five stops, ending where it started. */
const LEVELS_STOPS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

/** Resolution has finer stops because its floor is 0.5 rather than 0. */
const SCALE_STOPS: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9, 1];

const QUALITY_STOPS = ['auto', 'low', 'medium', 'high', 'ultra'] as const;

const PARTICLE_STOPS = ['off', 'low', 'medium', 'full'] as const;

/** The four tabs, in the order DESIGN.md lists them. */
const TABS = ['audio', 'video', 'controls', 'gameplay'] as const;
type Tab = (typeof TABS)[number];

/**
 * One row of the Settings panel.
 *
 * `stops` is the whole ladder the row walks and `at` says where the player currently sits on it,
 * so a click can step *from* there. `at` may point at a rung the value is not: `shake` ships at
 * 0.7, which sits between two of the dial's stops, and the row prints the real number while the
 * click moves to the next stop up.
 */
interface SettingRow {
  readonly key: keyof Settings;
  readonly label: string;
  readonly hint: string;
  readonly tab: Tab;
  readonly stops: readonly (string | number | boolean)[];
  at(settings: Settings): number;
  /** What the row prints: the current value, never the next one. */
  current(settings: Settings): string;
}

/** Where a value sits on a ladder, or the nearest rung when it is between two. */
function nearest(stops: readonly number[], v: number): number {
  let best = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < stops.length; i++) {
    const gap = Math.abs(stops[i] - v);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

function nextStop(row: SettingRow, s: Settings): string | number | boolean {
  return row.stops[(row.at(s) + 1) % row.stops.length];
}

/** A gain dial: five stops, read back as a percent. */
function dial(
  key: keyof Settings,
  label: string,
  hint: string,
  tab: Tab,
  stops: readonly number[] = LEVELS_STOPS,
): SettingRow {
  return {
    key,
    label,
    hint,
    tab,
    stops,
    at: (s) => nearest(stops, s[key] as number),
    current: (s) => percent(s[key] as number),
  };
}

function toggle(key: keyof Settings, label: string, hint: string, tab: Tab): SettingRow {
  return {
    key,
    label,
    hint,
    tab,
    stops: [false, true],
    at: (s) => (s[key] as boolean ? 1 : 0),
    current: (s) => (s[key] as boolean ? 'on' : 'off'),
  };
}

function ladder(
  key: keyof Settings,
  label: string,
  hint: string,
  tab: Tab,
  stops: readonly string[],
): SettingRow {
  return {
    key,
    label,
    hint,
    tab,
    stops,
    at: (s) => {
      const at = stops.indexOf(s[key] as never);
      return at >= 0 ? at : 0;
    },
    current: (s) => String(s[key]),
  };
}

/** Every row the Settings panel shows, in tab order. */
const SETTING_ROWS: readonly SettingRow[] = [
  toggle('muted', 'mute', 'silence every gain at once', 'audio'),
  dial('master', 'master', 'everything, after the mute', 'audio'),
  dial('sfx', 'gunfire', 'weapons, impacts, the blast on a big one', 'audio'),
  dial('music', 'music', 'the bed the gunfire sits on', 'audio'),
  ladder('quality', 'quality', 'what the machine picked, or the tier you picked over it', 'video', QUALITY_STOPS),
  {
    key: 'resolutionScale',
    label: 'resolution',
    hint: "of native, under the tier's own ceiling",
    tab: 'video',
    stops: SCALE_STOPS,
    at: (s) => nearest(SCALE_STOPS, s.resolutionScale),
    current: (s) => percent(s.resolutionScale),
  },
  toggle('shadows', 'shadows', 'needs a tier that has them', 'video'),
  toggle('bloom', 'bloom + chromatic', 'the glow, and the punch on a big hit', 'video'),
  ladder('particles', 'particles', 'of the tier\u2019s spark budget', 'video', PARTICLE_STOPS),
  toggle('damageNumbers', 'damage numbers', 'the floating mono numbers', 'video'),
  toggle('autoFire', 'auto-fire', 'shoots on its own when something is close', 'gameplay'),
  dial('shake', 'screen shake', 'this shipped at 70%', 'gameplay'),
];

/** The binds the Controls tab offers, in `BIND_DEFS` order. */
const BIND_ROWS: readonly BindAction[] = BIND_DEFS.map((def) => def.action);

/**
 * The keys the pause panel quotes.
 *
 * Six of the thirteen, because the panel is 380px wide and seven buttons tall and the rest are
 * not used during a fight. DESIGN.md's "one-line hint", read from the live map so a rebind shows
 * up here too.
 */
const PAUSE_HINT: readonly BindAction[] = ['up', 'left', 'dash', 'fire', 'swap', 'pause'];

/** The caption each bind row shows, from the table rather than written out here. */
const BIND_LABELS = new Map<BindAction, string>(BIND_DEFS.map((def) => [def.action, def.label]));

/** The columns of the run-history table. */
const HISTORY_HEADS = ['time', 'kills', 'score', 'chapter', 'carried'] as const;

export interface Screens {
  /** Repaint whatever the scene currently shows. Called once per rendered frame. */
  sync(view: HudView): void;
}

/**
 * Build every screen panel once, under `root` (which is `#ui`).
 *
 * `view` is read at the moment a control is used rather than closed over, because the shell that
 * owns the view is built after the panels are: `createHud` has to know what a panel will be
 * pointed at before it knows what it will be pointed *at*.
 */
export function createScreens(root: HTMLElement, view: () => HudView): Screens {
  const panels: Panel[] = [];

  /** The last text written to a node, so a steady frame writes nothing. */
  const written = new Map<HTMLElement, string>();

  function set(node: HTMLElement, value: string): void {
    if (written.get(node) === value) return;
    written.set(node, value);
    if (node.textContent !== value) node.textContent = value;
  }

  /**
   * One control.
   *
   * `action` is what the button *means* to anything reading the overlay from outside — a scenario
   * clicks `[data-action='save']` — and the four tab buttons are the reason it is not simply the
   * command: a tab changes what the panel shows and asks nothing of the game.
   */
  function control(parent: HTMLElement, label: string, action: string, use: () => void): HTMLElement {
    const b = document.createElement('button');
    b.className = 'btn';
    b.type = 'button';
    b.dataset['action'] = action;
    b.textContent = label;
    b.addEventListener('click', () => {
      // Focus goes back to the page or the next Space press re-activates the button instead of
      // dashing, which is the one way a menu can eat a player's inputs after they left it.
      b.blur();
      use();
    });
    parent.appendChild(b);
    return b;
  }

  function panel(id: string): HTMLElement {
    const node = el('div', 'screen', root);
    node.dataset['panel'] = id;
    return node;
  }

  function stack(parent: HTMLElement): HTMLElement {
    return el('div', 'stack', parent);
  }

  // ── Title ────────────────────────────────────────────────────────────────────────────
  const title = panel('title');
  text('h1', 'title', title, 'Neon Horde');
  text('p', 'subtitle', title, 'A factory floor at the end of the world. One pistol, to start with.');
  const titleStack = stack(title);
  const continueBtn = control(titleStack, 'Continue', 'continue', () => view().command('load'));
  continueBtn.hidden = true;
  control(titleStack, 'Start  [Enter]', 'start', () => view().command('start'));
  control(titleStack, 'Chapters', 'chapters', () => view().command('levelselect'));
  control(titleStack, 'Settings', 'settings', () => view().command('settings'));
  control(titleStack, 'History', 'history', () => view().command('history'));

  panels.push({
    id: 'menu',
    sync(v) {
      // The one thing here that can move while the title sits open: a save gets written by the
      // run the player is watching end, and when the machine goes back to the title.
      const hide = !v.hasSave();
      if (continueBtn.hidden !== hide) continueBtn.hidden = hide;
    },
  });

  // ── Chapter select ───────────────────────────────────────────────────────────────────
  const chapters = panel('chapters');
  text('h2', 'head', chapters, 'Chapters');
  text('p', 'hint', chapters, 'Clearing a chapter opens the next one. The number is your best time through it.');
  const grid = el('div', 'tiles', chapters);
  const chapterStack = stack(chapters);
  control(chapterStack, 'Back  [Esc]', 'back', () => view().command('back'));

  const tiles = LEVELS.map((def, index) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.dataset['chapter'] = String(index);
    text('b', 'tile-num num', tile, `${index + 1}`);
    text('span', 'tile-name', tile, def.name);
    const time = text('b', 'tile-time num', tile, '--');
    tile.addEventListener('click', () => {
      tile.blur();
      view().choose(index);
    });
    grid.appendChild(tile);
    return { tile, time, index };
  });

  panels.push({
    id: 'levelselect',
    sync(v, fresh) {
      if (!fresh) return;
      const meta: Meta = v.meta;
      for (const t of tiles) {
        const open = t.index < meta.unlockedChapters;
        // The lock is a word rather than a glyph: DESIGN.md asks for a tile that reads as locked
        // at a glance, and a padlock missing from the font reads as a box instead.
        set(t.time, open ? clockTime(meta.bestTimes[t.index] ?? NO_CLEAR) : 'locked');
        t.tile.classList.toggle('locked', !open);
        // Disabled rather than a click that does nothing, so the keyboard skips a locked chapter
        // too and the grid cannot be walked into a fight that has not been earned.
        t.tile.disabled = !open;
      }
    },
  });

  // ── Settings ─────────────────────────────────────────────────────────────────────────
  const settings = panel('settings');
  text('h2', 'head', settings, 'Settings');
  const tabs = el('div', 'tabs', settings);

  /** Which tab is up. The only state this file keeps, and it is not a rule. */
  let tab: Tab = 'audio';
  let tabDirty = true;

  const tabNodes = TABS.map((id) => {
    const b = control(tabs, id === 'controls' ? 'Controls' : `${id[0].toUpperCase()}${id.slice(1)}`, `tab:${id}`, () => {
      if (tab === id) return;
      tab = id;
      tabDirty = true;
    });
    b.dataset['tab'] = id;
    return { id, node: b };
  });

  const back = control(settings, 'Back  [Esc]', 'back', () => view().command('back'));
  back.classList.add('under');

  /** The four row lists, kept apart so a tab change hides three of them rather than rows. */
  const lists = {} as Record<Tab, HTMLElement>;
  for (const id of TABS) {
    const list = el('div', 'rows', settings);
    list.dataset['tab'] = id;
    lists[id] = list;
  }

  const built: Array<{ row: SettingRow; value: HTMLElement; list: HTMLElement }> = [];

  for (const row of SETTING_ROWS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'row';
    b.dataset['setting'] = row.key;
    text('span', 'row-key', b, row.label);
    const value = text('b', 'row-value num', b, '');
    text('span', 'row-hint', b, row.hint);
    b.addEventListener('click', () => {
      b.blur();
      const v = view();
      // The row and its next value come off the same entry in `SETTING_ROWS`, so the key and the
      // value do match; the table is not generic, which is what this one cast stands in for.
      v.setSetting(row.key, nextStop(row, v.settings) as never);
    });
    lists[row.tab].appendChild(b);
    built.push({ row, value, list: lists[row.tab] });
  }

  /** One row per bind: the action, its keys, and whether it is waiting for a new one. */
  const bindRows: Array<{ action: BindAction; node: HTMLElement; value: HTMLElement }> = [];

  const controlNote = text('p', 'hint', lists.controls, 'Click a row, then press the key you want. It moves here from wherever it was.');
  controlNote.classList.add('note');

  for (const action of BIND_ROWS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'row';
    b.dataset['bind'] = action;
    text('span', 'row-key', b, BIND_LABELS.get(action) ?? action);
    const value = text('b', 'row-value num', b, '');
    lists.controls.appendChild(b);
    bindRows.push({ action, node: b, value });
  }

  const resetB = control(lists.controls, 'Reset keys', 'reset-keys', () => view().resetBindings());
  resetB.classList.add('small');

  /** The row currently waiting for a key, and the way to stop it waiting. */
  let listening: { action: BindAction; node: HTMLElement; value: HTMLElement } | null = null;
  let cancel: (() => void) | null = null;

  function stopListening(): void {
    const last = listening;
    listening = null;
    if (last !== null) {
      last.node.classList.remove('listening');
      // Blank it, so the next repaint of the row writes the new keys rather than being told
      // they are what the row already said.
      set(last.value, '');
    }
    if (cancel !== null) {
      const off = cancel;
      cancel = null;
      off();
    }
  }

  for (const b of bindRows) {
    b.node.addEventListener('click', () => {
      b.node.blur();
      if (listening?.action === b.action) {
        // A second click on the waiting row means "not this one".
        stopListening();
        return;
      }
      stopListening();
      listening = { action: b.action, node: b.node, value: b.value };
      b.node.classList.add('listening');
      set(b.value, 'press a key');
      cancel = listenForSource((source) => {
        if (source === 'Escape') {
          stopListening();
          return;
        }
        view().rebind(b.action, source);
        stopListening();
      });
    });
  }

  function currentBinds(table: BindTable, action: BindAction): string {
    const sources = table.sourcesOf(action);
    if (sources.length === 0) return 'unbound';
    return sources.map(describeSource).join(' / ');
  }

  panels.push({
    id: 'settings',
    sync(v, fresh) {
      if (fresh) {
        // A panel that closes takes its listener down with it, or the next key pressed anywhere
        // on the page is spent naming a binding nobody was editing.
        stopListening();
        tab = 'audio';
        tabDirty = true;
      }
      if (tabDirty) {
        tabDirty = false;
        for (const t of tabNodes) t.node.classList.toggle('on', t.id === tab);
        for (const b of built) b.list.classList.toggle('hide', b.list.dataset['tab'] !== tab);
      }
      for (const b of built) {
        if (b.list.dataset['tab'] !== tab) continue;
        set(b.value, b.row.current(v.settings));
      }
      if (tab === 'controls') {
        const table = v.bindings;
        for (const b of bindRows) {
          if (listening?.action === b.action) continue;
          set(b.value, currentBinds(table, b.action));
        }
      }
    },
  });

  // ── Run history ──────────────────────────────────────────────────────────────────────
  const history = panel('history');
  text('h2', 'head', history, 'Runs');
  text('p', 'hint', history, 'The last runs on this machine, newest first.');
  const table = el('div', 'table', history);
  const historyStack = stack(history);
  control(historyStack, 'Back  [Esc]', 'back', () => view().command('back'));

  panels.push({
    id: 'history',
    sync(v, fresh) {
      if (!fresh) return;
      // Rebuilt rather than patched in place: it holds a dozen rows, it opens a handful of times
      // a session, and its source is one storage read done once at boot.
      while (table.firstChild) table.removeChild(table.firstChild);
      const head = el('div', 'trow heads', table);
      for (const h of HISTORY_HEADS) text('span', 'tcell', head, h);
      const rows = v.meta.history.slice(-12).reverse();
      if (rows.length === 0) {
        text('p', 'hint', table, 'Nothing yet. A run you die in, or finish, gets written here.');
        return;
      }
      for (const row of rows) {
        const line = el('div', 'trow', table);
        text('span', 'tcell', line, clockTime(row.time));
        text('span', 'tcell', line, String(row.kills));
        text('span', 'tcell', line, String(row.score));
        text('span', 'tcell', line, `C${row.chapter + 1}`);
        text('span', 'tcell wide', line, row.weapons.map(readable).join(', ') || 'nothing');
      }
    },
  });

  // ── Pause ────────────────────────────────────────────────────────────────────────────
  const pause = panel('pause');
  text('h2', 'head', pause, 'Paused');
  // DESIGN.md: one hint line on the pause screen. It is the live key map rather than a printed
  // legend, so it stays true after a rebind instead of teaching the wrong keys.
  const pauseHint = text('p', 'hint', pause, '');
  const pauseStack = stack(pause);
  control(pauseStack, 'Resume  [Esc]', 'resume', () => view().command('resume'));
  control(pauseStack, 'Save run', 'save', () => view().command('save'));
  const loadPaused = control(pauseStack, 'Load saved run', 'load', () => view().command('load'));
  loadPaused.hidden = true;
  control(pauseStack, 'Settings', 'settings', () => view().command('settings'));
  control(pauseStack, 'History', 'history', () => view().command('history'));
  control(pauseStack, 'Restart run  [Enter]', 'restart', () => view().command('restart'));
  control(pauseStack, 'Chapters', 'chapters', () => view().command('levelselect'));
  control(pauseStack, 'Quit to menu', 'menu', () => view().command('menu'));

  panels.push({
    id: 'paused',
    sync(v, fresh) {
      const hide = !v.hasSave();
      if (loadPaused.hidden !== hide) loadPaused.hidden = hide;
      if (!fresh) return;
      set(pauseHint, describeBinds(v.bindings, PAUSE_HINT));
    },
  });

  // ── Summary and victory ──────────────────────────────────────────────────────────────
  /**
   * The two end-of-run panels: the same five numbers, different ways back in.
   *
   * Victory gets the magenta→cyan sweep DESIGN.md asks for; the death panel keeps the plain
   * hairline, because a screen that says you lost should not be the louder of the two.
   */
  function statsPanel(
    id: string,
    keys: readonly string[],
    buttons: ReadonlyArray<readonly [string, string, HudCommand]>,
  ): void {
    const node = panel(id);
    if (id === 'victory') node.classList.add('sweep');
    const head = text('h2', 'head', node, '');
    const stats = el('div', 'stats', node);
    const cells = keys.map((key) => {
      const row = el('div', 'stat', stats);
      text('span', 'key', row, key);
      return text('b', 'num', row, '');
    });
    const buttons7 = stack(node);
    for (const [label, action, cmd] of buttons) control(buttons7, label, action, () => view().command(cmd));
    panels.push({
      id,
      sync(v, fresh) {
        if (!fresh) return;
        const w = v.world;
        set(head, id === 'victory' ? 'The floor is yours' : w.player.alive ? 'Run over' : 'You died');
        set(cells[0], String(w.score));
        set(cells[1], String(w.kills));
        set(cells[2], `${w.time.toFixed(1)} s`);
        set(cells[3], `LV ${w.player.level}`);
        const at = Math.min(LEVELS.length - 1, Math.max(0, w.chapter));
        set(cells[4], id === 'victory' ? 'all ten chapters' : `Chapter ${w.chapter + 1} \u2014 ${LEVELS[at].name}`);
      },
    });
  }

  statsPanel('summary', ['score', 'kills', 'time', 'level', 'where'], [
    ['Restart level', 'restart-level', 'restartLevel'],
    ['Restart run  [Enter]', 'restart', 'restart'],
    ['Chapters', 'chapters', 'levelselect'],
    ['Menu', 'menu', 'menu'],
  ]);

  statsPanel('victory', ['score', 'kills', 'time', 'level', 'where'], [
    ['Restart run  [Enter]', 'restart', 'restart'],
    ['Chapters', 'chapters', 'levelselect'],
    ['Menu', 'menu', 'menu'],
  ]);

  let lastScene = '';

  return {
    sync(v) {
      const fresh = v.scene !== lastScene;
      if (fresh) stopListening();
      lastScene = v.scene;
      for (const p of panels) {
        // Only the panel the scene is showing gets painted. Five of the seven are not even on
        // screen, and the two that rebuild tables would do it sixty times a second.
        if (p.id === v.scene) p.sync(v, fresh);
      }
    },
  };
}

/**
 * Listen for the next key or pointer button, for the rebind rows.
 *
 * Capture phase and `stopImmediatePropagation`: the sampler listens on the same window, and
 * without both a rebind spends the key twice — once as a name, once as the action. Returning a
 * cancel matches the sampler's own `InputHost` rule that a listener is handed back rather than
 * leaked.
 */
export function listenForSource(onSource: (source: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const key = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code) onSource(e.code);
  };
  const down = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
    onSource(`Mouse${e.button}`);
  };

  window.addEventListener('keydown', key, true);
  window.addEventListener('pointerdown', down, true);
  return () => {
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('pointerdown', down, true);
  };
}
