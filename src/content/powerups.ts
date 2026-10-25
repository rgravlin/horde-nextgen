/**
 * Power-up content.
 *
 * `apply` folds a tier into the run's StatBlock instead of each power-up being a
 * branch in the sim: granting one resets the block and replays every owned entry
 * at its current tier, so a multiplier never depends on the order they arrived
 * in and never compounds by itself across ticks.
 *
 * All three entries are 'stat' (permanent, stackable to tier 5). 'timed' and
 * 'curse' stay in the union for the entries that need them; nothing reads
 * `duration` yet.
 */

export type PowerupKind = 'stat' | 'timed' | 'curse';

/** The multipliers the sim reads. 1 / 0 means "no power-up effect". */
export interface StatBlock {
  /** Multiplier on weapon damage. */
  dmg: number;
  /** Divisor on the fire cooldown: 1.5 fires 50% faster. */
  fireRate: number;
  /** Metres added to the base pickup radius. */
  magnet: number;
}

export function baseStats(): StatBlock {
  return { dmg: 1, fireRate: 1, magnet: 0 };
}

export interface PowerupDef {
  readonly id: string;
  /** Label the HUD and the level-up card show. */
  readonly label: string;
  readonly kind: PowerupKind;
  /** Highest tier this reaches, whether by picks or by repeated chests. */
  readonly maxTier: number;
  /** Seconds a 'timed' grant lasts before it expires. */
  readonly duration?: number;
  /** Fold `tier` copies of this power-up into the run's stat block. */
  readonly apply: (stats: StatBlock, tier: number) => void;
}

export const POWERUPS: readonly PowerupDef[] = [
  {
    id: 'damage',
    label: 'Damage Boost',
    kind: 'stat',
    maxTier: 5,
    apply: (stats, tier) => {
      stats.dmg *= 1 + 0.25 * tier;
    },
  },
  {
    id: 'fireRate',
    label: 'Fire Rate',
    kind: 'stat',
    maxTier: 5,
    apply: (stats, tier) => {
      stats.fireRate *= 1 + 0.18 * tier;
    },
  },
  {
    id: 'magnet',
    label: 'Magnet Field',
    kind: 'stat',
    maxTier: 5,
    apply: (stats, tier) => {
      stats.magnet += 1.2 * tier;
    },
  },
];