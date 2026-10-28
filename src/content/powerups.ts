/**
 * Power-up content.
 *
 * `apply` folds a tier into the run's StatBlock instead of each power-up being a
 * branch in the sim: granting one resets the block and replays every owned entry
 * at its current tier, so a multiplier never depends on the order they arrived in
 * and never compounds by itself across ticks.
 *
 * Three kinds, and the kind is what decides how the effect is worn:
 *
 * - `stat` — permanent, stacks to `maxTier`. The bulk of the table.
 * - `timed` — a buff that runs out. The tier is what a *further* pick raises (a
 *   second pick of a tier-1 Adrenaline is a tier-2 dose, stronger and no longer), and
 *   the clock in `systems/powerups.ts` decides whether it is currently being counted
 *   at all. An expired one stops counting rather than sitting on the stat block
 *   forever, which is what makes "spend it now" a real decision.
 * - `curse` — offered occasionally, and it buys a number with a worse one. Curses cap
 *   at one or two tiers so a run cannot be buried in them, and the downside is
 *   something the player can act on (take more damage, move slower) rather than
 *   flavour text.
 *
 * Every entry here has a read point in the sim. An entry with no read point would be
 * a card that lies, so `tests/unit/powerups.test.ts` walks the table and fails if a
 * grant leaves no stat changed.
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

  /** Chance a hit crits, 0..1. One rng draw per hit while above 0. */
  crit: number;
  /** Multiplier on a critting hit. */
  critMult: number;

  /** Fraction of incoming damage taken off the top, before the shield. */
  armor: number;
  /** Extra fraction of incoming damage taken. Only curses write it. */
  fragile: number;
  /** Flat absorb pool, drained before HP. Refilled when the run's tiers change. */
  shield: number;
  /** HP mended per second, up to maxHp. */
  regen: number;
  /** Fraction of damage dealt that comes back as HP, capped per hit. */
  lifesteal: number;
  /** Damage paid back to whatever touches the player. */
  thorns: number;

  /** Multiplier on walking speed. */
  speed: number;
  /** Multiplier on the dash cooldown: 0.75 dashes a third more often. */
  dashCd: number;

  /** Multiplier on a weapon's spread: below 1 is tighter. */
  spread: number;
  /** Extra bodies one round may pass through. */
  pierce: number;
  /** Extra projectiles a single trigger pull looses. */
  extraShots: number;
  /** Radians per tick a round may turn toward the nearest body. */
  homing: number;
  /** Extra jumps a chain bolt takes. */
  chain: number;

  /** Metres of burst a killing round leaves behind, and a fraction of the hit in it. */
  sabot: number;

  /** Fraction bodies inside `slowRadius` are slowed by. */
  slowField: number;
  /** Metres around the player that field reaches. */
  slowRadius: number;

  /**
   * Shots a companion drone may loose a volley, 0 when the run owns none. Read by
   * `systems/drone.ts`, which fires the pistol def at the nearest body with no input
   * behind it — the only power-up here that acts on the world rather than folding a
   * multiplier the weapons read.
   */
  drone: number;
}

export function baseStats(): StatBlock {
  return {
    dmg: 1,
    fireRate: 1,
    magnet: 0,
    crit: 0,
    critMult: 1,
    armor: 0,
    fragile: 0,
    shield: 0,
    regen: 0,
    lifesteal: 0,
    thorns: 0,
    speed: 1,
    dashCd: 1,
    spread: 1,
    pierce: 0,
    extraShots: 0,
    homing: 0,
    chain: 0,
    sabot: 0,
    slowField: 0,
    slowRadius: 0,
    drone: 0,
  };
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

/** A plate stops a fifth of a hit per tier, and four tiers is already a different game. */
const armorCap = (tier: number): number => Math.min(0.22, 0.055 * tier);

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
  {
    id: 'crit',
    label: 'Weak Spot',
    kind: 'stat',
    maxTier: 5,
    apply: (stats, tier) => {
      stats.crit = Math.min(0.6, 0.08 * tier);
      stats.critMult = 1.75;
    },
  },
  {
    id: 'precision',
    label: 'Match Grade',
    kind: 'stat',
    maxTier: 4,
    // Worth taking on a shotgun or an SMG and dead weight on a hitscan rifle, which is
    // the point of a spread multiplier rather than a flat accuracy bonus: the weapons
    // that already shoot straight have nothing here to buy.
    apply: (stats, tier) => {
      stats.spread *= 1 - 0.13 * tier;
    },
  },
  {
    id: 'pierce',
    label: 'Penetrator',
    kind: 'stat',
    maxTier: 3,
    apply: (stats, tier) => {
      stats.pierce = tier;
    },
  },
  {
    id: 'multishot',
    label: 'Split Rounds',
    kind: 'stat',
    maxTier: 2,
    // Two extra bodies at tier 2, paid for with a wider cone: more pellets, less of a
    // line. A shotgun and a flail get wider; a sniper, which has no spread to widen,
    // just gets two more barrels.
    apply: (stats, tier) => {
      stats.extraShots = tier;
      stats.spread *= 1 + 0.1 * tier;
    },
  },
  {
    id: 'seeker',
    label: 'Seeker Chips',
    kind: 'stat',
    maxTier: 3,
    apply: (stats, tier) => {
      stats.homing = 0.05 * tier;
    },
  },
  {
    id: 'chain',
    label: 'Arc Linkage',
    kind: 'stat',
    maxTier: 3,
    apply: (stats, tier) => {
      stats.chain = tier;
    },
  },
  {
    id: 'sabot',
    label: 'Explosive Rounds',
    kind: 'stat',
    maxTier: 3,
    // Only spends its burst on a kill, so it is a crowd weapon rather than a damage
    // aura: 1.8 m at tier 1 clears a clump, and the burst is a third of the hit that
    // made it.
    apply: (stats, tier) => {
      stats.sabot = 1.8 + 0.6 * (tier - 1);
    },
  },
  {
    id: 'speed',
    label: 'Light Feet',
    kind: 'stat',
    maxTier: 4,
    apply: (stats, tier) => {
      stats.speed *= 1 + 0.07 * tier;
    },
  },
  {
    id: 'dashflow',
    label: 'Second Wind',
    kind: 'stat',
    maxTier: 3,
    apply: (stats, tier) => {
      stats.dashCd *= 1 - 0.12 * tier;
    },
  },
  {
    id: 'siphon',
    label: 'Life Tap',
    kind: 'stat',
    maxTier: 4,
    // Capped per hit in the sim: 4% of a railgun's 140 damage is a lot of HP, and an
    // uncapped lifesteal turns a sniper into immortality.
    apply: (stats, tier) => {
      stats.lifesteal = 0.03 * tier;
    },
  },
  {
    id: 'thorns',
    label: 'Hot Plate',
    kind: 'stat',
    maxTier: 4,
    apply: (stats, tier) => {
      stats.thorns = 3 * tier;
    },
  },
  {
    id: 'plate',
    label: 'Ablative Plate',
    kind: 'stat',
    maxTier: 4,
    apply: (stats, tier) => {
      stats.armor += armorCap(tier);
    },
  },
  {
    id: 'barrier',
    label: 'Barrier Cell',
    kind: 'stat',
    maxTier: 4,
    // A pool, not a rate: it soaks what lands and does not come back between picks.
    apply: (stats, tier) => {
      stats.shield = 15 * tier;
    },
  },
  {
    id: 'regen',
    label: 'Nanite Mend',
    kind: 'stat',
    maxTier: 3,
    apply: (stats, tier) => {
      stats.regen = 0.5 * tier;
    },
  },
  {
    id: 'stasis',
    label: 'Stasis Field',
    kind: 'stat',
    maxTier: 3,
    apply: (stats, tier) => {
      stats.slowField = 0.13 * tier;
      stats.slowRadius = 5.5 + 0.8 * (tier - 1);
    },
  },
  {
    id: 'drone',
    label: 'Ward Drone',
    kind: 'stat',
    maxTier: 5,
    // A companion that fires the pistol def on its own; `drone` is how many shots a
    // volley may loose, read by `systems/drone.ts` at the nearest body with no trigger
    // behind it. Worth taking while a hand is still weak, and dead weight once a
    // hitscan clears the room faster than the drone can, which is the read the tier pips
    // are there to give.
    apply: (stats, tier) => {
      stats.drone = tier;
    },
  },
  {
    id: 'gale',
    label: 'Tailwind',
    kind: 'stat',
    maxTier: 4,
    // A kiter's card: it pays for backing up in a straight line and vacuuming shards
    // on the way, not for holding ground. Worth taking before the run has a shield, and
    // weak once a Stasis Field does the slowing for you.
    apply: (stats, tier) => {
      stats.speed *= 1 + 0.05 * tier;
      stats.dashCd *= 1 - 0.08 * tier;
      stats.magnet += 1.0 * tier;
    },
  },
  {
    id: 'graveTide',
    label: 'Grave Tide',
    kind: 'stat',
    maxTier: 3,
    // Sustain as a bundle: it mends between fights and mends inside them, so it wants a
    // gun that stays in a fight (a beam, a repeater) rather than a burst weapon that
    // never hits enough to pay the lifesteal back. Thinner than Hot Plate at what it
    // does — it does not kill you back, it keeps you standing.
    apply: (stats, tier) => {
      stats.lifesteal = 0.02 * tier;
      stats.regen = 0.4 * tier;
      stats.armor += 0.03 * tier;
    },
  },
  {
    id: 'bramble',
    label: 'Bramble Coat',
    kind: 'stat',
    maxTier: 3,
    // The hug answers back and costs a little less each time. A combined defensive card:
    // weaker than taking Hot Plate and an Ablative Plate apart, but it is one pick and it
    // is for the run that plans to be touched.
    apply: (stats, tier) => {
      stats.thorns = 2 * tier;
      stats.armor += 0.03 * tier;
    },
  },
  {
    id: 'longArm',
    label: 'Longshot Rig',
    kind: 'stat',
    maxTier: 3,
    // Punches through bodies and shoots straight, at the cost of a slower run: the
    // long-range card, dead weight the moment something is in your face. It pays to
    // take it with a hitscan or a railgun and to leave it for anything that wants to be
    // walked.
    apply: (stats, tier) => {
      stats.spread *= 1 - 0.1 * tier;
      stats.pierce = tier;
      stats.speed *= 1 - 0.04 * tier;
    },
  },

  // --- Timed: strong, and spent. ----
  {
    id: 'adrenaline',
    label: 'Adrenaline',
    kind: 'timed',
    maxTier: 2,
    duration: 20,
    apply: (stats, tier) => {
      const dose = 1 + 0.45 * tier;
      stats.dmg *= dose;
      stats.speed *= 1 + 0.15 * tier;
      stats.fireRate *= 1 + 0.25 * tier;
    },
  },
  {
    id: 'targeting',
    label: 'Targeting Probe',
    kind: 'timed',
    maxTier: 2,
    duration: 25,
    apply: (stats, tier) => {
      stats.crit = Math.max(stats.crit, 0.3 + 0.05 * tier);
      if (stats.critMult < 2) stats.critMult = 2;
      stats.homing += 0.04 * tier;
    },
  },
  {
    id: 'frenzy',
    label: 'Frenzy',
    kind: 'timed',
    maxTier: 2,
    duration: 15,
    // Fire faster and hit harder while the spread opens up: a dump-your-magazine window
    // for a shotgun or an SMG, paid for with accuracy at range. The trade is the point —
    // a weapon that was already tight gets sloppier, and one you spray with barely cares.
    apply: (stats, tier) => {
      stats.fireRate *= 1 + 0.3 * tier;
      stats.dmg *= 1 + 0.15 * tier;
      stats.spread *= 1 + 0.12 * tier;
    },
  },
  {
    id: 'focus',
    label: 'Steady Aim',
    kind: 'timed',
    maxTier: 2,
    duration: 18,
    // The opposite window to Frenzy: tighter, more crits, bigger crits. Bought for a
    // sniper or a railgun to burst something large, and worth nothing on a weapon with
    // no crit line to feed.
    apply: (stats, tier) => {
      stats.spread *= 1 - 0.18 * tier;
      stats.crit = Math.max(stats.crit, 0.25 + 0.05 * tier);
      if (stats.critMult < 2.1) stats.critMult = 2.1;
    },
  },

  // --- Curses: a number bought with a worse one. ----
  {
    id: 'glass',
    label: 'Glass Cannon',
    kind: 'curse',
    maxTier: 2,
    // Half again the damage out and half again the damage in. It reads as a straight
    // upgrade until the first thing that touches you, which is the trade.
    apply: (stats, tier) => {
      stats.dmg *= 1 + 0.45 * tier;
      stats.fragile += 0.45 * tier;
    },
  },
  {
    id: 'leaden',
    label: 'Heavy Ammunition',
    kind: 'curse',
    maxTier: 1,
    // More gun, less leg: it pays for itself at range and costs a life in a corridor.
    apply: (stats) => {
      stats.dmg *= 1.3;
      stats.pierce += 1;
      stats.speed *= 0.86;
      stats.dashCd *= 1.3;
    },
  },
  {
    id: 'juggernaut',
    label: 'Ballast',
    kind: 'curse',
    maxTier: 1,
    // Soaks more and carries a shield, paid for with a slower walk, a slower trigger
    // pull and a wider cone — it turns "kite and shoot" into "stand and trade". Take it
    // when the run would rather soak a mistake than outrun one, and leave it in a level
    // built on distance.
    apply: (stats) => {
      stats.armor += 0.12;
      stats.shield = Math.max(stats.shield, 20);
      stats.speed *= 0.82;
      stats.fireRate *= 0.88;
      stats.spread *= 1.12;
    },
  },
];

/** id → index, built once, in table order. See `powerupIndex`. */
const POWERUP_BY_ID = new Map<string, number>(POWERUPS.map((def, i) => [def.id, i]));

/**
 * The table index of a card by id, or -1 when no card is called that.
 *
 * Chapter data names a card the way its script names an archetype — by id, read back through
 * the table it came out of — so a level that hands out the ward drone writes `'drone'` rather
 * than a number that means nothing beside it and drifts the first time the table is reordered.
 * A name that matches nothing comes back -1 and the caller decides what a typo costs;
 * `tests/unit/droneChest.test.ts` requires every id a chapter declares to resolve.
 */
export function powerupIndex(id: string): number {
  const at = POWERUP_BY_ID.get(id);
  return at === undefined ? -1 : at;
}
