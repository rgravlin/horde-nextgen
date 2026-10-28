/**
 * The authoring kit the chapter files share: one tint per chapter family and one shorthand per
 * kind of thing a floor is made of.
 *
 * These exist so a chapter stays data. A chapter written out as raw object literals would put
 * the same four numbers — a crusher's `gap`, a column's diameter — in forty places, and the
 * rules they carry (a tell must be readable, a prop must be thick enough to matter) would stop
 * being rules and become habits. Written as calls, each rule is stated once here, next to the
 * number it prices, and a chapter that wants something meaner than the default has to say so
 * with an argument.
 *
 * Nothing in this file knows what a chapter is: the shorthands return the shapes `types.ts`
 * defines and the chapter files (`chapters-1-3.ts` and its two siblings) fill a floor with.
 */

import { PropKind, ZoneKind } from '../../sim/systems/obstacles';
import type { EdgeId } from '../../sim/systems/waves';
import type { BeatDef, HazardDef, PaletteDef, PropDef, SupplyDef } from './types';

/**
 * The three chapter families, as fog and key-light tints.
 *
 * Tints rather than palettes: DESIGN.md's colour *roles* never change, so a chapter differs in
 * the colour of its gloom and not in what each colour means. Each is one object shared by every
 * chapter of that family, so "same air as the docks" is a reference rather than four characters
 * copied again.
 */
export const DOCKS: PaletteDef = { fog: '#0B1D20', key: '#9FD9E4' };
export const FOUNDRY: PaletteDef = { fog: '#1A1206', key: '#F2B233' };
export const REACTOR: PaletteDef = { fog: '#150C22', key: '#B48CFF' };

/** Acid shorthand: a pool that costs `dps` a second while anything stands in it. */
export function acid(x: number, y: number, r: number, dps: number): HazardDef {
  return { kind: ZoneKind.Acid, x, y, r, dps };
}

/**
 * Crusher shorthand: a plate that tells for `warn` seconds and then hits for `dps`, every
 * `gap` seconds. The two defaults are the chapter-5 numbers and are only ever overridden to
 * make a room meaner, never to shorten the tell below what a player can read.
 */
export function crusher(x: number, y: number, r: number, dps: number, gap = 3.2, warn = 0.45): HazardDef {
  return { kind: ZoneKind.Crusher, x, y, r, dps, gap, warn };
}

/** Wall shorthand. */
export function wall(x: number, y: number, w: number, h: number): PropDef {
  return { kind: PropKind.Wall, x, y, w, h };
}

/** Cover shorthand: the same box, drawn as a crate. */
export function crate(x: number, y: number, s = 2): PropDef {
  return { kind: PropKind.Crate, x, y, w: s, h: s };
}

/** Vessel shorthand. */
export function tank(x: number, y: number, s = 3): PropDef {
  return { kind: PropKind.Tank, x, y, w: s, h: s };
}

/**
 * Column shorthand: the one round prop.
 *
 * `w`/`h` carry the diameter so the drawing pass reads one set of numbers for every prop,
 * and the radius goes in beside them because that is the shape the collision tests — the box
 * around a column is not the column.
 */
export function pillar(x: number, y: number, r = 1.25): PropDef {
  return { kind: PropKind.Pillar, x, y, w: r * 2, h: r * 2, r };
}

/**
 * Supply shorthand: a crate holding one named card, at a place the player has to walk to.
 *
 * Not the same thing as `crate`, which is cover you shoot over. A crate written here is a
 * pickup put down when the floor loads, so its position is a route rather than a roll —
 * `TUNE.chestChance` decides whether a spawner marks a pack with one, and a chapter that means
 * to hand something out cannot be left to that. The card is named by id and read back through
 * `powerupIndex`; a name the table does not hold leaves a rolled crate rather than nothing.
 */
export function supply(x: number, y: number, powerup: string): SupplyDef {
  return { x, y, powerup };
}

/**
 * Script shorthand: `count` of each named archetype, landing at second `t` off `edge`.
 *
 * Written as a call rather than an object literal so a chapter's script reads as a timetable
 * down the page — eight beats a chapter is a lot of rows, and the rows are the point.
 */
export function beat(t: number, edge: EdgeId, ...pack: (readonly [string, number])[]): BeatDef {
  return { t, edge, pack };
}

/** Script shorthand for a pack the chapter *sends* in one named variant. */
export function eliteBeat(t: number, edge: EdgeId, elite: string, ...pack: (readonly [string, number])[]): BeatDef {
  return { t, edge, elite, pack };
}
