/**
 * Key bindings: the one table a physical key is looked up in.
 *
 * ARCHITECTURE.md pins this file as the home of the bind map ("the bind map belongs to
 * `src/input/bindings.ts` when remapping lands, so that there is one table and the sampler
 * reads it"). The reason it is a file and not a `Record` inside the sampler is that two things
 * have to agree on it: the sampler, which turns a key into an `InputFrame`, and the Controls
 * tab, which shows and edits the same map. A copy in each is how a remap ends up appearing in
 * the menu and doing nothing.
 *
 * **What a "source" is.** A bind is a *source* — `KeyboardEvent.code` (`'KeyW'`, `'Space'`) or
 * `'Mouse0'`/`'Mouse1'` for a pointer button — rather than a character. `code` is physical, so
 * the defaults still work on a AZERTY layout or with Caps Lock on, and the Controls tab prints
 * what that key is for the layout the player is actually on (`describeSource`).
 *
 * **An action, not a key, is what the game means.** The sampler asks "which action does this
 * source drive" and switches on the answer (see `BIND_DEFS`' `kind`: a `move` adds a vector, a
 * `hold` is read every tick while it is down, a `press` is a one-shot latch). Rebinding is
 * therefore only ever about which *source* carries a meaning that already exists, which is what
 * keeps the whole feature to this file plus one table in the UI.
 *
 * **Nothing here is stateful and nothing here is DOM.** `buildBinds` compiles a map, `swapBinds`
 * returns a new override object; both are pure, so `tests/unit/settings.test.ts` pins the
 * conflict rule in plain Node and the sampler's own tests hand it a fake host.
 */

/** Everything a player can put on a key. */
export type BindAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'dash'
  | 'fire'
  | 'swap'
  | 'pause'
  | 'accept'
  | 'reroll'
  | 'pick1'
  | 'pick2'
  | 'pick3';

/**
 * How the sampler consumes an action once a source has been resolved to it.
 *
 * - `move` adds a vector to the frame's move pair, read from held state.
 * - `hold` is a frame flag that stays true while the source is down (dash, fire).
 * - `press` is a one-shot: one press is one tick of intent, however long the key is held.
 */
export type BindKind = 'move' | 'hold' | 'press';

/** One row of the table, and one row of the Controls tab. */
export interface BindDef {
  readonly action: BindAction;
  /** Caption in the Controls tab. */
  readonly label: string;
  /** The second line: what the key actually does, so the caption can stay short. */
  readonly hint: string;
  readonly kind: BindKind;
  /**
   * The sources that carry it on a fresh install, and the ones a reset goes back to.
   *
   * A list rather than one key because three of these are genuinely two-key affairs (WASD *and*
   * the arrows, Space *and* Shift, the number row *and* the numpad) and one is deliberately
   * empty-handed: `swap` also lives on the wheel, which is not a key and so cannot be a bind.
   */
  readonly defaults: readonly string[];
}

/**
 * The default map — `defaultSettings().binds` is an override *over* this, not a copy of it.
 *
 * Order is the order the Controls tab lists them in: hands first, then the things a fight is
 * made of, then the scene-level keys.
 */
export const BIND_DEFS: readonly BindDef[] = [
  { action: 'up', label: 'Move up', hint: 'north on the floor', kind: 'move', defaults: ['KeyW', 'ArrowUp'] },
  { action: 'down', label: 'Move down', hint: 'south on the floor', kind: 'move', defaults: ['KeyS', 'ArrowDown'] },
  { action: 'left', label: 'Move left', hint: 'west on the floor', kind: 'move', defaults: ['KeyA', 'ArrowLeft'] },
  { action: 'right', label: 'Move right', hint: 'east on the floor', kind: 'move', defaults: ['KeyD', 'ArrowRight'] },
  { action: 'dash', label: 'Dash', hint: 'hold to keep dashing while the gauge allows it', kind: 'hold', defaults: ['Space', 'ShiftLeft', 'ShiftRight'] },
  { action: 'fire', label: 'Fire', hint: 'fires when held; auto-fire does not need it', kind: 'hold', defaults: ['Mouse0'] },
  { action: 'swap', label: 'Swap hands', hint: 'also the mouse wheel', kind: 'press', defaults: ['KeyQ'] },
  { action: 'reroll', label: 'Reroll', hint: 'rerolls a level-up offer', kind: 'press', defaults: ['KeyR'] },
  { action: 'pause', label: 'Pause', hint: 'freeze and open the pause panel', kind: 'press', defaults: ['Escape', 'KeyP'] },
  { action: 'accept', label: 'Accept', hint: 'start, confirm, pick the highlighted card', kind: 'press', defaults: ['Enter', 'NumpadEnter'] },
  { action: 'pick1', label: 'Card 1', hint: 'take the left card at a level-up', kind: 'press', defaults: ['Digit1', 'Numpad1'] },
  { action: 'pick2', label: 'Card 2', hint: 'take the middle card', kind: 'press', defaults: ['Digit2', 'Numpad2'] },
  { action: 'pick3', label: 'Card 3', hint: 'take the right card', kind: 'press', defaults: ['Digit3', 'Numpad3'] },
];

/** The move actions, in the order the sampler folds them into one move pair. */
const MOVE_VECTORS: Partial<Record<BindAction, readonly [number, number]>> = {
  up: [0, 1],
  down: [0, -1],
  left: [-1, 0],
  right: [1, 0],
};

/** The flag a `hold` action writes into the frame. */
const HELD_FLAGS: Partial<Record<BindAction, 'dash' | 'fire'>> = {
  dash: 'dash',
  fire: 'fire',
};

/** Which card a `pickN` press takes, 1-based; 0 for anything that is not a card key. */
const PICK_SLOT: Partial<Record<BindAction, number>> = {
  pick1: 1,
  pick2: 2,
  pick3: 3,
};

/** The eleven sources whose browser default has to be swallowed (scroll, caret, click-drag). */
const SWALLOW_DEFAULT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter']);

/**
 * What the player has changed. Only the differences are stored: a settings file that repeated
 * every default would have to be rewritten every time a default changed, and would silently
 * keep a returning player on the old one.
 *
 * An empty list means "this action has no key", which is a choice some players make.
 */
export type BindOverrides = Partial<Record<BindAction, readonly string[]>>;

/** The compiled form the sampler reads: one lookup per event, no scanning. */
export interface BindTable {
  /** Which action a source drives, or `undefined` when it drives nothing. */
  actionOf(source: string): BindAction | undefined;
  /** The sources currently bound to an action, in table order. */
  sourcesOf(action: BindAction): readonly string[];
  /** The table's own row for an action, for a UI that wants its label and kind. */
  defOf(action: BindAction): BindDef | undefined;
  /** Whether `preventDefault` is owed on this source while it is a game key. */
  swallows(source: string): boolean;
}

const DEFS_BY_ACTION = new Map<BindAction, BindDef>(BIND_DEFS.map((def) => [def.action, def]));

/** The table a run starts with: no overrides at all. */
export const NO_BINDS: BindOverrides = {};

/** The sources an action carries before any override, for a reset row or a conflict check. */
export function defaultSources(action: BindAction): readonly string[] {
  return DEFS_BY_ACTION.get(action)?.defaults ?? [];
}

/**
 * The move pair an action contributes, or `undefined` when it is not a move key.
 *
 * The three lookups below take "whatever this source drives", `undefined` included: the
 * sampler reads its table for every key it holds, and "no action" is the common answer rather
 * than the error one.
 */
export function moveVectorOf(action: BindAction | undefined): readonly [number, number] | undefined {
  return action === undefined ? undefined : MOVE_VECTORS[action];
}

/** The frame flag a held action writes, or `undefined` when the action is not a hold. */
export function heldFlagOf(action: BindAction | undefined): 'dash' | 'fire' | undefined {
  return action === undefined ? undefined : HELD_FLAGS[action];
}

/** The card a pick key takes, or 0 when the action is not a card key. */
export function pickSlotOf(action: BindAction | undefined): number {
  return action === undefined ? 0 : (PICK_SLOT[action] ?? 0);
}

/**
 * Compile a map out of the defaults plus whatever the player changed.
 *
 * Cheap and rebuilt whenever the settings change rather than patched in place: the sampler is
 * handed the *table*, so a key that stops meaning something mid-run stops meaning it on the
 * next key press, not on the next reload.
 */
export function buildBinds(overrides: BindOverrides = NO_BINDS): BindTable {
  const bySource = new Map<string, BindAction>();
  const byAction = new Map<BindAction, readonly string[]>();

  for (const def of BIND_DEFS) {
    // Later rows win over earlier ones only inside a single row's own list; across rows the
    // order is the table's, so an override never silently steals a default that is still
    // listed above it — `swapBinds` takes the old key away instead.
    const sources = overrides[def.action] ?? def.defaults;
    byAction.set(def.action, sources);
    for (const source of sources) {
      if (!bySource.has(source)) bySource.set(source, def.action);
    }
  }

  return {
    actionOf: (source) => bySource.get(source),
    sourcesOf: (action) => byAction.get(action) ?? [],
    defOf: (action) => DEFS_BY_ACTION.get(action),
    swallows: (source) => SWALLOW_DEFAULT.has(source) || bySource.has(source),
  };
}

/**
 * Rebind `action` to `source`, and take that source away from whatever had it.
 *
 * The displaced action does not just lose the key: it picks up the keys the rebound action was
 * holding. A one-way "steal" would leave the stolen action with nothing — rebind pause onto the
 * dash key and the game would have no pause and no way to find out — while a swap keeps every
 * action at least as bindable as it was. An action whose override is emptied has *no* key, which
 * is only reachable from the empty-list branch below and is what the reset button uses.
 */
export function swapBinds(overrides: BindOverrides, action: BindAction, source: string): BindOverrides {
  const table = buildBinds(overrides);
  const previous = table.sourcesOf(action);
  const holder = table.actionOf(source);

  const next: BindOverrides = { ...overrides };
  next[action] = [source];
  if (holder !== undefined && holder !== action) {
    if (previous.length > 0) {
      next[holder] = previous;
    } else {
      // Nothing to give back, so the displaced action keeps whatever else it had. With only the
      // stolen key it ends up unbound, which is the one way an action can lose its last key.
      const rest = table.sourcesOf(holder).filter((s) => s !== source);
      if (rest.length > 0) next[holder] = rest;
      else delete next[holder];
    }
  }
  return next;
}

/** Whether a whole bind map is something we are willing to read off disk. */
export function isBindOverrides(value: unknown): value is BindOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [key, sources] of Object.entries(value)) {
    const def = DEFS_BY_ACTION.get(key as BindAction);
    if (def === undefined) return false;
    if (!Array.isArray(sources)) return false;
    if (!sources.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 32)) return false;
  }
  return true;
}

/**
 * A source's caption, for a Controls tab that has to be readable on any layout.
 *
 * `code` is physical, so `'KeyW'` is the key in the W place. On a AZERTY keyboard that key is
 * labelled Z, and printing "W" there is a lie the player can check in a second — hence
 * `describeSource`, which prints what that key is for the layout the player is on.
 */
export function describeSource(source: string): string {
  if (source.startsWith('Mouse')) return `mouse ${source.slice(5)}`;
  if (source.startsWith('Key')) return source.slice(3).toLowerCase();
  if (source.startsWith('Digit')) return source.slice(5);
  if (source.startsWith('Numpad')) return `num ${source.slice(6)}`;
  if (source === 'ArrowUp') return 'up arrow';
  if (source === 'ArrowDown') return 'down arrow';
  if (source === 'ArrowLeft') return 'left arrow';
  if (source === 'ArrowRight') return 'right arrow';
  if (source === 'ShiftLeft') return 'left shift';
  if (source === 'ShiftRight') return 'right shift';
  if (source === 'ControlLeft') return 'left ctrl';
  if (source === 'ControlRight') return 'right ctrl';
  if (source === 'AltLeft') return 'left alt';
  if (source === 'AltRight') return 'right alt';
  if (source === 'Escape') return 'esc';
  return source.toLowerCase();
}

/**
 * One line saying what part of the map is, for a hint that has room for one line.
 *
 * The pause panel quotes the keys a player reaches for mid-fight, not all thirteen, and the
 * captions come from the table rather than from the panel: a hint that names its own keys is a
 * second bind map, and a second bind map is how a menu ends up teaching keys the game does not
 * use.
 */
export function describeBinds(table: BindTable, actions: readonly BindAction[]): string {
  const parts: string[] = [];
  for (const action of actions) {
    const def = DEFS_BY_ACTION.get(action);
    const sources = table.sourcesOf(action);
    if (def === undefined || sources.length === 0) continue;
    parts.push(`${def.label}: ${sources.map(describeSource).join(' / ')}`);
  }
  return parts.join(' · ');
}