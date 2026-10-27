/**
 * The two hands: what each gauge says, and the caption each weapon wears.
 *
 * Both halves are built to be *read* sixty times a second and to *change* a few times a run,
 * which is why the captions are cached in a map and the gauge readings are pure functions of
 * the slot and its definition. Kept apart from `paint.ts` because this is where the numbers
 * come from; `paint.ts` is only about getting a string onto the screen without rewriting it.
 */

import { WEAPONS, type WeaponDef } from '../../content/weapons';
import type { WeaponSlot } from '../../sim/world';

/**
 * The two lines a hand shows about its weapon: the name, and what family and firing
 * mode it is. Built once per weapon rather than once per frame — the hands change a
 * few times a run and are read sixty times a second.
 */
const handLabels = new Map<string, { name: string; tag: string }>();

/** What an empty hand says. One object, because the empty case is read every frame too. */
export const EMPTY_HAND = { name: 'empty hand', tag: '' };

/**
 * The name a hand shows for a weapon id.
 *
 * `weapons.ts` keys a gun by `plasmaRepeater` because an id is a key, not a caption;
 * `PLASMAREPEATER` on the slot is the same string read wrong. Splitting the camel case
 * is the whole trick, and it means a new weapon needs no caption written for it.
 */
export function handLabel(id: string): { name: string; tag: string } {
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
 * What a hand's gauge says.
 *
 * Three constraints, three readings, and each shows the number the player can act on:
 * a magazine counts rounds, a heat hand says `venting` while it is locked out (its
 * heat is already spent, so the number would be noise), and a charge hand counts the
 * charge left, because that is what decides whether the next shot happens.
 */
export function gaugeText(slot: WeaponSlot, def: WeaponDef): string {
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
export function gaugeFill(slot: WeaponSlot, def: WeaponDef): number {
  if (def.ammo) return def.ammo.mag > 0 ? slot.ammo / def.ammo.mag : 0;
  if (def.heat) return def.heat.max > 0 ? Math.max(0, 1 - slot.heat / def.heat.max) : 0;
  if (def.energy) return def.energy.capacity > 0 ? slot.energy / def.energy.capacity : 0;
  return 0;
}
