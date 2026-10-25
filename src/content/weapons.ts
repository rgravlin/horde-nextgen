/**
 * Weapon content: the WeaponDef schema plus the entries the sim reads.
 *
 * Content is data (ARCHITECTURE.md): the fields below are the whole contract
 * between a weapon and src/sim/systems/weapons.ts, so a new gun is an entry here
 * rather than a branch in the code. Only `fire: 'projectile'` has a firing path
 * in this build; the other kinds are declared so their fields have a home before
 * their systems land.
 */

export type WeaponFamily = 'guns' | 'medieval' | 'alien';

/** How a weapon delivers damage. */
export type FireKind = 'projectile' | 'hitscan' | 'beam' | 'arc' | 'melee' | 'chain' | 'orb';

export interface AmmoDef {
  /** Rounds per magazine. */
  readonly mag: number;
  /** Seconds a reload takes. Firing stays blocked until it finishes. */
  readonly reload: number;
}

/**
 * Damage falloff as [startRange, endRange, multiplier]: full damage up to
 * startRange, a linear ramp down to the multiplier at endRange, then the
 * multiplier held for the rest of the shot's life.
 */
export type FalloffDef = readonly [number, number, number];

export interface HeatDef {
  /** Heat added per shot. */
  readonly perShot: number;
  /** Heat shed per second while not firing. */
  readonly coolPerSec: number;
}

export interface EnergyDef {
  readonly capacity: number;
  readonly perShot: number;
  readonly regenPerSec: number;
}

export interface DotDef {
  readonly dps: number;
  readonly seconds: number;
}

export interface WeaponDef {
  readonly id: string;
  readonly family: WeaponFamily;
  readonly fire: FireKind;
  /** Shots per second at fireRate 1.0. */
  readonly rate: number;
  readonly dmg: number;
  /** Half-angle of the muzzle cone in radians, drawn from world.rng per shot. */
  readonly spread: number;
  /** Projectile speed in m/s. */
  readonly speed: number;
  /** Metres of travel before a shot retires. */
  readonly range: number;
  /** Enemies a shot passes through *after* the first one it hits. */
  readonly pierce: number;
  /** Backward shove in m/s applied to a hit enemy, which staggers it. */
  readonly knockback: number;
  readonly falloff: FalloffDef;
  readonly ammo: AmmoDef;
  readonly heat?: HeatDef;
  readonly energy?: EnergyDef;
  /** Splash radius in metres around the impact point. */
  readonly aoe?: number;
  readonly dot?: DotDef;
  /** Targets a hit chains to after the first. */
  readonly chain?: number;
  /** Turn rate in rad/s while homing. */
  readonly homing?: number;
  readonly mesh: string;
  readonly sfx: string;
}

export const WEAPONS: readonly WeaponDef[] = [
  {
    id: 'pistol',
    family: 'guns',
    fire: 'projectile',
    // Accurate, enough punch to open a lane, and never the wrong answer — which
    // is why it is the gun a run starts with rather than one you hunt for.
    // Two shots drop a chaser at any range inside its falloff.
    rate: 5,
    dmg: 14,
    spread: 0.035,
    speed: 55,
    range: 26,
    pierce: 1,
    knockback: 3,
    falloff: [12, 22, 0.6],
    ammo: { mag: 12, reload: 1.1 },
    mesh: 'pistol',
    sfx: 'gunLight',
  },
];