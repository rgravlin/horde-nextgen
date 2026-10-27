/**
 * Event id → sound.
 *
 * The presentation half of the sim's event feed: the sim writes what happened (a round landed,
 * a body came apart, a chamber went off) and this file decides whether that is worth hearing,
 * how loud, and where in the stereo field. `synth.ts` turns a recipe into oscillators; nothing
 * here touches WebAudio, which is what lets a test drive the whole mapping with a fake sink and
 * a hand-built World.
 *
 * Four rules, all of them about the horde rather than about the duel:
 *
 * - **A cap per frame, not a voice per event.** A shotgun into a packed lane is eight hits and
 *   one burst; a charging screen is hundreds of contacts a second. Sound arriving faster than
 *   about one per 45 ms stops being information and becomes a buzz, so the per-frame budget and
 *   the per-recipe gap below *are* the feature. `DESIGN.md` says the same thing about damage
 *   numbers ("numbers merge under a heavy horde so they never pile up into clutter").
 * - **Distance is a mute, not a curve.** Past a recipe's `reach` the sound is not played at
 *   all. The ring is a broadcast and a thousand bodies on the far side of the arena are not
 *   worth a hundred AudioNodes.
 * - **A hit sounds like a hit, not like the gun that made it.** The gun already sounded when it
 *   was fired (`Shot`), and it sounded where the muzzle was; the impact belongs to the body it
 *   reached, tens of metres away. `Ev.Hit` cannot name the weapon behind it anyway — a ray, a
 *   sweep or a beam has no projectile to point at — so one cheap tick covers all of them.
 * - **Nothing is read back.** The ring is consumed through this consumer's own cursor (see
 *   `EventRing` in `sim/world.ts`), so the particle field and the damage numbers keep their own
 *   view of the same events, and audio being late — or absent — changes no outcome.
 *
 * The one cue deliberately left out is a spawn sound. Bodies arrive off-screen continuously from
 * wave 3 onward, so a noise at every spawn is a constant hiss that says nothing; the telegraphs
 * have a cue (`warn`) and those are the ones a player can act on.
 */

import { ENEMIES } from '../content/enemies';
import { WEAPONS } from '../content/weapons';
import { Ev } from '../sim/world';
import { ShotKind } from '../sim/systems/enemyProjectiles';

/**
 * The sound recipes, in the order `synth.ts` builds them.
 *
 * Index 0 is `none`: a lookup that finds nothing returns it rather than -1, so the caller's
 * "is this worth a voice" test is one comparison against a real id.
 */
export const RECIPES = [
  'none',
  // The ten sounds `content/weapons.ts` names, by the id each weapon declares.
  'gunLight',
  'gunHeavy',
  'gunSniper',
  'bowDraw',
  'flailSwing',
  'catapultLob',
  'plasmaRepeater',
  'chainLightning',
  'lanceBeam',
  'singularity',
  // Everything that is not a gun the player is holding.
  'enemyBolt',
  'enemyGrenade',
  'impact',
  'killSmall',
  'killBig',
  'explosion',
  'pickup',
  'levelUp',
  'death',
  'hurt',
  'dash',
  'heal',
  'warn',
] as const;

export type RecipeId = (typeof RECIPES)[number];

export const RECIPE_COUNT = RECIPES.length;

/** Numbers, so a per-event lookup is an array read rather than a string search. */
const R: Record<RecipeId, number> = RECIPES.reduce(
  (out, id, index) => {
    out[id] = index;
    return out;
  },
  {} as Record<RecipeId, number>,
);

/** A body at or above this `EnemyDef.radius` earns the big death sound. */
const BIG_BODY_RADIUS = 1.05;

/**
 * How much attention each recipe is allowed, per frame and per second.
 *
 * `gap` is the shortest spacing between two plays of the *same* recipe, whatever else is
 * happening: it is what keeps three hundred hits a second down to about twenty audible ticks,
 * which read as one continuous crackle instead of a buzz. `gain` is the loudness at zero
 * distance and `reach` the metres beyond which the sound is not played at all.
 */
export interface RecipeTune {
  readonly gap: number;
  readonly gain: number;
  readonly reach: number;
  /** Send a little of it to the echo, for the sounds that want a tail. */
  readonly echo?: boolean;
}

/** Parallel to `RECIPES`; the test pins the two against each other. */
export const RECIPE_TUNE: readonly RecipeTune[] = [
  { gap: 0, gain: 0, reach: 0 }, // none
  { gap: 0.03, gain: 0.5, reach: 30 }, // gunLight
  { gap: 0.02, gain: 0.72, reach: 30 }, // gunHeavy
  { gap: 0.05, gain: 0.85, reach: 44, echo: true }, // gunSniper
  { gap: 0.04, gain: 0.45, reach: 30 }, // bowDraw
  { gap: 0.03, gain: 0.4, reach: 14 }, // flailSwing
  { gap: 0.05, gain: 0.5, reach: 34, echo: true }, // catapultLob
  { gap: 0.03, gain: 0.42, reach: 30, echo: true }, // plasmaRepeater
  { gap: 0.04, gain: 0.5, reach: 26, echo: true }, // chainLightning
  { gap: 0.1, gain: 0.34, reach: 26, echo: true }, // lanceBeam
  { gap: 0.06, gain: 0.55, reach: 30, echo: true }, // singularity
  { gap: 0.05, gain: 0.34, reach: 34 }, // enemyBolt
  { gap: 0.06, gain: 0.4, reach: 34, echo: true }, // enemyGrenade
  { gap: 0.045, gain: 0.26, reach: 26 }, // impact
  { gap: 0.04, gain: 0.34, reach: 26 }, // killSmall
  { gap: 0.06, gain: 0.6, reach: 34, echo: true }, // killBig
  { gap: 0.03, gain: 0.8, reach: 40, echo: true }, // explosion
  { gap: 0.06, gain: 0.2, reach: 22 }, // pickup
  { gap: 0.4, gain: 0.8, reach: 200, echo: true }, // levelUp
  { gap: 1.5, gain: 1, reach: 200, echo: true }, // death
  { gap: 0.18, gain: 0.55, reach: 200 }, // hurt
  { gap: 0.12, gain: 0.4, reach: 200 }, // dash
  { gap: 0.15, gain: 0.3, reach: 30, echo: true }, // heal
  { gap: 0.07, gain: 0.36, reach: 30 }, // warn,
];

/** The weapon sound each entry in `content/weapons.ts` asked for, resolved once. */
const WEAPON_RECIPE: Int8Array = buildWeaponRecipes();

function buildWeaponRecipes(): Int8Array {
  const table = new Int8Array(WEAPONS.length);
  for (let i = 0; i < WEAPONS.length; i++) {
    const named = (RECIPES as readonly string[]).indexOf(WEAPONS[i].sfx);
    // A weapon that names a sound nobody built falls back to the light gun rather than to
    // silence: a silent gun reads as a broken build, not as a quiet weapon.
    table[i] = named > 0 ? named : R.gunLight;
  }
  return table;
}

/**
 * The slice of `World` the mapping reads.
 *
 * Declared here instead of importing `World` so the mapping can be driven from a plain object in
 * a test, and so the dependency stays what ARCHITECTURE.md calls it — read-only *events*, not the
 * sim. The real `World` satisfies it structurally (the pools' `kind` slot is a `Uint16Array` and
 * `events` is `EventRing`), and nothing in this file can write to it.
 */
export interface SfxView {
  readonly player: { x: number; y: number };
  readonly shots: { readonly cap: number; readonly kind: Uint16Array };
  readonly enemyShots: { readonly cap: number; readonly kind: Uint16Array };
  readonly events: {
    readonly cap: number;
    readonly type: Int32Array;
    readonly a: Int32Array;
    readonly b: Int32Array;
    readonly x: Float32Array;
    readonly y: Float32Array;
    readonly written: number;
    count: number;
  };
}

/**
 * The one table that answers "what sound is this event", as a recipe index.
 *
 * Kept apart from the mixer below so that "does a grenade sound like a grenade" has one place to
 * be checked. `a` and `b` are decoded per `Ev` in `sim/world.ts`: a `Shot` carries the weapon
 * index, or -1 for a round the floor loosed with the shooter's slot beside it; a `Kill` carries
 * the archetype; an `Explosion` carries the burst radius times ten.
 */
export function recipeForEvent(view: SfxView, type: number, a: number, b: number): number {
  switch (type) {
    case Ev.Shot: {
      if (a >= 0) return WEAPON_RECIPE[a] ?? 0;
      const kind = a < 0 && b >= 0 && b < view.enemyShots.cap ? view.enemyShots.kind[b] : 0;
      return kind === ShotKind.Grenade ? R.enemyGrenade : R.enemyBolt;
    }
    case Ev.Hit:
      return R.impact;
    case Ev.Kill: {
      const def = ENEMIES[b];
      if (def === undefined) return R.killSmall;
      return def.boss === true || def.radius >= BIG_BODY_RADIUS ? R.killBig : R.killSmall;
    }
    case Ev.Explosion:
      return R.explosion;
    case Ev.Pickup:
      return R.pickup;
    case Ev.LevelUp:
      return R.levelUp;
    case Ev.Death:
      return R.death;
    case Ev.Shake:
      return R.hurt;
    case Ev.Dash:
      return R.dash;
    case Ev.Heal:
      return R.heal;
    case Ev.Telegraph:
      return R.warn;
    default:
      // Spawn, Damage and Error get no sound: the first is weather, the second is the same hit
      // as `Hit` told twice, and the third is a bug that the run's error count already records.
      return 0;
  }
}

/** How far a ping's pitch is lifted per pickup kind, in semitones. */
function pickupPitch(kind: number): number {
  return ((kind < 0 ? 0 : kind) % 8) * 2;
}

/**
 * Where a sound goes. One implementation per engine, reused every frame.
 *
 * `play` returns false when it refuses the voice — the frame's budget is spent, the gain is
 * under the floor, the context is gone — so the mixer counts what it lost instead of assuming
 * every request became a sound.
 */
export interface SfxSink {
  play(recipe: number, gain: number, pan: number, pitch: number): boolean;
}

/**
 * The mixer's per-frame state, allocated once.
 *
 * `cursor` is this consumer's place in the event stream, `budget` the voices it still owes this
 * frame, and `last` the audio-clock time at which each recipe last sounded.
 */
export interface SfxState {
  cursor: number;
  budget: number;
  /** Audio-clock seconds for the frame being drained; the throttle's clock. */
  now: number;
  played: number;
  dropped: number;
  throttled: number;
  readonly last: Float64Array;
}

export function createSfxState(): SfxState {
  return {
    cursor: 0,
    budget: 0,
    now: 0,
    played: 0,
    dropped: 0,
    throttled: 0,
    last: new Float64Array(RECIPE_COUNT),
  };
}

/**
 * Forget the past: a new World's ring is a new stream.
 *
 * `written` restarts at zero when a World is built, so a cursor carried over from the run that
 * just ended would sit *ahead* of the new stream and swallow its first seconds. Starting at the
 * stream's end rather than at zero handles both cases: a fresh ring starts at its only position,
 * and a *loaded* run — whose ring still holds the seconds before it was saved — does not replay
 * them on resume, which is the same refusal `sequencer.ts`'s `CATCH_UP` makes about music.
 */
export function resetSfx(state: SfxState, view: { events: { written: number } }): void {
  state.cursor = view.events.written;
  state.budget = 0;
  state.played = 0;
  state.dropped = 0;
  state.throttled = 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Metres of world x that count as full left/right. */
const PAN_SPREAD = 9;

/** Anything quieter than this is inaudible under the gunfire and is not worth a voice. */
const GAIN_FLOOR = 0.02;

/**
 * Drain this frame's events into voices.
 *
 * Called once per browser frame, after the sim has stepped however many times that frame was
 * owed, so one pass covers up to five ticks of events. Order is the order the events were
 * written, which is the order they happened.
 */
export function drainSfx(view: SfxView, sink: SfxSink, state: SfxState): void {
  const ring = view.events;
  const cap = ring.cap;
  const written = ring.written;
  const px = view.player.x;
  const py = view.player.y;

  // The readable window is `[written - count, written)`. A cursor inside it resumes exactly
  // where the last frame stopped; one behind it — the ring wrapped while audio was not looking,
  // or a new World whose counter restarted — starts at the oldest event still in there.
  let from = state.cursor;
  const oldest = written - ring.count;
  if (from < oldest) from = oldest;
  if (from > written) from = written;

  let budget = state.budget;
  const now = state.now;

  for (let i = from; i < written; i++) {
    const slot = i % cap;
    const type = ring.type[slot];
    const a = ring.a[slot];
    const b = ring.b[slot];
    const recipe = recipeForEvent(view, type, a, b);
    if (recipe === 0) continue;

    if (budget <= 0) {
      state.dropped++;
      continue;
    }

    const tune = RECIPE_TUNE[recipe];
    if (state.now - state.last[recipe] < tune.gap) {
      state.throttled++;
      continue;
    }

    const x = ring.x[slot];
    const y = ring.y[slot];
    const dx = x - px;
    const dy = y - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > tune.reach) continue;

    // Loudness: the recipe's own level faded by distance, with a floor so a sound at the edge of
    // hearing is still a sound rather than a click. A burst also gets louder with its own
    // radius, read out of `b`, and a jolt with its trauma.
    const fade = 1 - dist / tune.reach;
    let gain = tune.gain * (0.3 + 0.7 * fade);
    if (type === Ev.Explosion) gain *= clamp(b / 60, 0.45, 1.4);
    if (type === Ev.Shake) gain *= clamp(a / 8, 0.5, 1.2);
    if (gain < GAIN_FLOOR) continue;

    const pan = clamp(dx / PAN_SPREAD, -1, 1);
    const pitch = type === Ev.Pickup ? pickupPitch(b) : 0;
    if (sink.play(recipe, gain, pan, pitch)) {
      state.last[recipe] = now;
      state.played++;
      budget--;
    } else {
      state.dropped++;
    }
  }

  state.budget = budget;
  state.cursor = written;
}