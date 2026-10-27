/**
 * The elite variants, written once for the whole campaign.
 *
 * A chapter does not own a variant and does not copy one: it names the ids it rolls in its own
 * `elites` roster (`types.ts`) and the spawner looks them up here. That is why this is a table
 * plus a lookup rather than three objects pasted into each chapter file — a variant tuned in
 * one place is the same variant in every room, and `index.ts` resolves each chapter's roster
 * against these rows once, at load, rather than sixty times a second while it spawns.
 *
 * The three are deliberately not three sizes of the same thing. A bulwark is a body that costs
 * more to kill, a frenzy is a body that reaches you sooner and pays less for the privilege, and
 * a volatile is a body you have to kill somewhere other than where you are standing.
 */

import type { EliteDef } from './types';

export const ELITES: readonly EliteDef[] = [
  {
    id: 'bulwark',
    label: 'Bulwark',
    hp: 1.75,
    gait: 1,
    touch: 1,
    armor: 3,
    accent: '#F2B233',
  },
  {
    id: 'frenzy',
    label: 'Frenzy',
    // Thinner and meaner: it trades a quarter of its body for a third more speed and half
    // again the hug, which is the opposite trade to a bulwark rather than a bigger version
    // of one.
    hp: 0.75,
    gait: 1.3,
    touch: 1.35,
    armor: 0,
    accent: '#FF2A3C',
  },
  {
    id: 'volatile',
    label: 'Volatile',
    // Carries a burst it did not start with. Squishier than its archetype on purpose: the
    // answer is to shoot it away from the crowd, which is the same skill the exploder
    // teaches, priced higher because now it is a modifier on anything.
    hp: 0.8,
    gait: 1,
    touch: 1,
    armor: 0,
    blastRadius: 2.2,
    blastDamage: 18,
    accent: '#9B5CFF',
  },
];

/** Id to table index, built once so a chapter names a variant rather than a row. */
export const ELITE_BY_ID: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < ELITES.length; i++) map[ELITES[i].id] = i;
  return map;
})();

/** Index of `id`, or -1 when nothing answers to that name. */
export function eliteIndex(id: string): number {
  const i = ELITE_BY_ID[id];
  return i === undefined ? -1 : i;
}
