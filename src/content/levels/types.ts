/**
 * The chapter schema: what a level is, in the three ways this sim can actually tell.
 *
 * A chapter here is a floor plan, a wave script and an elite roster, because those are the
 * things the simulation reads and therefore the things a player can feel and a test can pin.
 * The floor plan is boxes in world metres, installed into `sim/systems/obstacles.ts` when the
 * chapter starts and read back by the player's movement, every enemy's travel step, every
 * round in the air and the renderer's cover pass. The wave script is a list of timed packs
 * with a drumbeat fill underneath it, both read by `sim/systems/waves.ts`. The encounter at
 * the end is a body from `content/enemies.ts` marked `boss`.
 *
 * Every field below names the thing that reads it, and a field with no reader does not get
 * added: a `corridor` string nobody consults is the same kind of lie as a hazard that hurts
 * nobody.
 */

import type { EdgeId } from '../../sim/systems/waves';

/**
 * An elite variant: a modifier applied to an archetype, never an archetype of its own.
 *
 * That distinction is load-bearing. The scenarios and the unit tests count enemies *by
 * archetype* — `byType.charger === 6`, "every archetype the roster owns reached the horde" —
 * and a charger-with-a-red-tint entered as a new row would turn every one of those counts
 * into a coin flip. An elite is therefore a scale factor on a body that is still whatever it
 * was, which is also how it reads on screen: the same silhouette, bigger, faster or live,
 * with a tell you can see from across the room.
 */
export interface EliteDef {
  readonly id: string;
  readonly label: string;
  /** Multiplier on the archetype's HP. */
  readonly hp: number;
  /**
   * Multiplier on how far the body travels per tick.
   *
   * A scale on travel rather than on `speed`, because `speed` is read in a dozen places
   * (steering, the cap, the dash) and a variant that had to be threaded through all of them
   * would be a variant that quietly does nothing in half of them. One number at the single
   * travel tail every behaviour funnels through is the same effect, applied once.
   */
  readonly gait: number;
  /** Multiplier on the archetype's contact damage. */
  readonly touch: number;
  /** Flat armour added to whatever the archetype already pays. */
  readonly armor: number;
  /**
   * A burst the body leaves behind, which its archetype may not have had. Only the volatile
   * variant declares these, and the sim gives any body that carries them the same
   * fuse-and-blast behaviour an exploder has, so a variant never needs its own branch.
   */
  readonly blastRadius?: number;
  readonly blastDamage?: number;
  /** Emissive tint for the variant's outline (DESIGN.md: telegraphs are Threat Red). */
  readonly accent: string;
}

/**
 * One box or column of cover, authored as a centre and a size.
 *
 * `kind` is only ever a hint for the renderer — every kind collides the same way, which is
 * what keeps one code path instead of three, and `r` is what makes a kind round rather than
 * `kind` itself. A prop thinner than 1.2 m through the middle is refused when the chapter
 * loads (`sim/systems/obstacles.ts`), so the number is a constraint rather than a
 * suggestion: below that, a dashing body crosses the whole thing in one tick.
 */
export interface PropDef {
  readonly kind: number;
  readonly x: number;
  readonly y: number;
  /** Full width and height in metres, not half-extents. */
  readonly w: number;
  readonly h: number;
  /** Set for a round prop: its radius, which is the shape the sim actually tests. */
  readonly r?: number;
}

/**
 * One hazard on the floor.
 *
 * `dps` means damage per second on an acid pool and damage per blow on a crusher; `gap` and
 * `warn` are only read by a crusher, and `warn` is the seconds of tell it gets first, which
 * every one here sets above the 0.4 s DESIGN.md asks for. A hazard hurts whichever side is
 * standing in it, and that is the design rather than a detail: a pool you can bait a pack
 * into is a position, and a pool that only punishes the player is wallpaper with a tax.
 */
export interface HazardDef {
  readonly kind: number;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly dps: number;
  readonly gap?: number;
  readonly warn?: number;
}

/**
 * One chapter's air: what the fog and the one key light are tinted to.
 *
 * DESIGN.md's three chapter families (teal docks, amber foundry, violet reactor) are the
 * three entries in `builders.ts`, and they are tints rather than new palettes: the colour
 * *roles* the brief pins never change, so a chapter differs in the colour of its gloom, not
 * in what each colour means. Both values stay near Void so the horizon and the floor keep
 * agreeing.
 */
export interface PaletteDef {
  /** Fog and sky colour, read by the renderer when the chapter loads. */
  readonly fog: string;
  /** Tint on the shadow-casting key light. */
  readonly key: string;
}

/**
 * One scripted pack: what arrives, at what second, from which side, and — in the chapters that
 * roll variants — what it arrives wearing.
 *
 * `t` is seconds on the chapter's own clock, which `WaveState.elapsed` counts, rather than a
 * wave number. The set pieces of a level are timed and not counted: the armoured wedge at 0:52
 * lands in the same second at every seed, which is the property that makes a level authored
 * rather than drawn, and the property a test can pin.
 *
 * `edge` is a direction and not a position. `systems/waves.ts` picks a point on that side of the
 * view rect, keeps it off cover, and falls back to another side if the one it was handed has no
 * clear floor anywhere along it — so a chapter that wants a chokepoint to be the only way in
 * builds a chokepoint, and a pack that cannot fit is rerouted instead of dropped inside a wall.
 *
 * `elite` is applied to every body in the pack. It exists because a variant the player meets by
 * chance at 5% is texture, while a variant a chapter *sends* is a wave to be answered.
 */
export interface BeatDef {
  readonly t: number;
  /** `[archetype id, count]` pairs, in the order they are put down. */
  readonly pack: readonly (readonly [string, number])[];
  readonly edge: EdgeId;
  readonly elite?: string;
}

/**
 * The chapter's two dials, written down once instead of derived from which chapter it is.
 *
 * `spawnRate` divides the gap between drumbeat batches and `hp` multiplies the HP of every body
 * the chapter puts down. They stay two numbers because they are two different problems for the
 * player — a faster drumbeat asks where you are standing, tougher bodies ask what you are
 * holding — and because a pair is what a test can read: `tests/unit/waves.test.ts` checks the
 * product rises from chapter to chapter, which catches a dial edited to look like progress while
 * doing only half the job.
 */
export interface DifficultyDef {
  /** Divisor on the seconds between drumbeat batches. 1 is chapter 1's own curve. */
  readonly spawnRate: number;
  /** Multiplier on the HP of every body the chapter's script or fill puts down. */
  readonly hp: number;
}

export interface LevelDef {
  readonly id: string;
  /** Shown in the HUD's top-centre panel. */
  readonly name: string;
  /**
   * The drumbeat recipe: one row per wave, carried on past the end of the list by the last
   * row. A row is read straight down and the next wave starts where the last one stopped (see
   * `WaveState.cursor`), so the mix is a fact about the chapter rather than about the seed.
   *
   * This is what fills the gaps the script leaves below; `waves` is what marks them.
   */
  readonly packs: readonly (readonly string[])[];
  /**
   * The chapter's wave script: packs it authored, in seconds on the chapter's own clock.
   *
   * Read straight down by `systems/waves.ts` at the same seconds in every run, which is what
   * lets a scenario pin a chapter and a player learn one. A beat is a set piece; the recipe
   * above is the pressure between set pieces, and the two run beside each other.
   */
  readonly waves: readonly BeatDef[];
  /**
   * Seconds of drumbeat before the encounter walks in.
   *
   * The script lives inside this window — a beat timed after the duration would never land —
   * so a chapter's last beats are written just short of its own end.
   */
  readonly duration: number;
  /**
   * How hard this chapter is, in the two dials the spawner reads: how often it puts bodies
   * down and how much those bodies cost. Defined here, once, rather than derived from which
   * chapter number it is, so the ramp is readable on the page and testable as a product.
   */
  readonly difficulty: DifficultyDef;
  /** Elite variants this chapter rolls, by id. */
  readonly elites: readonly string[];
  /**
   * Chance a spawned body comes in elite, 0..1.
   *
   * Zero for the first two chapters, and that is not a gap in the data: the whole point of
   * the early chapters is a body you learn once and then recognise, and a charger is not a
   * lesson while half of them are also something else. It also keeps every seeded run that
   * predates the variants exactly the run it already was, since a chapter that rolls none
   * draws no random numbers at all.
   */
  readonly eliteChance: number;
  /**
   * The bodies the chapter ends on, by archetype id.
   *
   * They arrive together, with an escort from the chapter's last recipe row, once the script
   * is spent — see `systems/levels.ts`. A list rather than one id because a chapter is
   * allowed to end on more than one thing, and the last room ends on all three.
   */
  readonly bosses: readonly string[];
  /**
   * Half-edge of the chapter's arena in metres, clamped to the floor the World was built
   * with. It is the playable box rather than the drawn one: a chapter that wants to be
   * fought in a corridor says so here, and the spawner, the drops and the clamp all read it.
   */
  readonly size: number;
  /** Fog and key-light tint, applied when the chapter loads. */
  readonly palette: PaletteDef;
  /** Static cover. Installed once, at the same moment the wave clock starts. */
  readonly props: readonly PropDef[];
  /** Floor hazards. */
  readonly hazards: readonly HazardDef[];
}