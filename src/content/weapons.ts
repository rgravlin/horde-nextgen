/**
 * Weapon content: the WeaponDef schema plus the entries the sim reads.
 *
 * Content is data (ARCHITECTURE.md): the fields below are the whole contract
 * between a weapon and src/sim/systems/{weapons,projectiles}.ts, so a new gun is
 * an entry here rather than a branch in the code. `fire` picks the delivery path
 * and the sim implements four of the seven kinds: `projectile`, `hitscan`, `melee`
 * and `arc`. A weapon naming a kind the sim has no path for simply does not shoot,
 * which is why the kinds are declared before they are used.
 */

export type WeaponFamily = 'guns' | 'medieval' | 'alien';

/** How a weapon delivers damage. */
export type FireKind = 'projectile' | 'hitscan' | 'beam' | 'arc' | 'melee' | 'chain' | 'orb';

export interface AmmoDef {
  /** Rounds per magazine. For `melee` and `arc` it is the number of swings or
   * loads before the weapon has to be recovered, which is what the HUD gauge
   * shows; a magazine is still spent one trigger pull at a time. */
  readonly mag: number;
  /** Seconds a reload takes. Firing stays blocked until it finishes. */
  readonly reload: number;
}

/**
 * Damage falloff as [startRange, endRange, multiplier]: full damage up to
 * startRange, a linear ramp down to the multiplier at endRange, then the
 * multiplier held for the rest of the shot's life. Distance is measured along the
 * line the damage travelled — from the muzzle for a projectile or a ray, from the
 * player for a melee sweep — and an `arc` burst takes no falloff, so its three
 * entries are equal.
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

/**
 * Hold-to-charge delivery, for weapons whose shot gets better the longer the
 * trigger is held (the longbow's draw). Both multipliers interpolate linearly from
 * 1.0 at a cold trigger to the given value at a full draw, and the shot is loosed
 * either when the draw completes or the moment the trigger comes up, so a panicked
 * tap still fires — just flatter and weaker.
 */
export interface ChargeDef {
  /** Seconds of held trigger that makes a full draw. */
  readonly time: number;
  /** Projectile speed multiplier at a full draw. */
  readonly speed: number;
  /** Damage multiplier at a full draw. */
  readonly dmg: number;
}

export interface WeaponDef {
  readonly id: string;
  readonly family: WeaponFamily;
  readonly fire: FireKind;
  /** Shots per second at fireRate 1.0: the cooldown between trigger pulls. */
  readonly rate: number;
  readonly dmg: number;
  /**
   * Half-angle of the muzzle cone in radians, drawn from world.rng per projectile.
   * For `melee` the same field is the half-angle of the sweep instead, and is
   * deterministic — a 300° flail is `spread: 2.6181` — because the arc is the
   * weapon's shape, not aim error.
   */
  readonly spread: number;
  /**
   * Projectile speed in m/s: the shot's own speed, not the def's, is what the
   * flight and the falloff are measured by, so a charged shot flies differently.
   * For `arc` it fixes the flight time, `range / speed`. `hitscan` and `melee`
   * resolve in one tick and read nothing from it, so they carry 0.
   */
  readonly speed: number;
  /**
   * Metres of travel before a shot retires. For `hitscan` it is the length of the
   * ray, for `melee` the reach of the sweep (measured to the target's body edge)
   * and for `arc` the distance the shell is lobbed down the aim line.
   */
  readonly range: number;
  /**
   * Enemies a shot passes through *after* the first one it hits, so `pierce + 1`
   * is how many bodies one trigger pull can hurt. For `melee` it is how many extra
   * bodies the sweep may clip.
   */
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
  /** Projectiles one trigger pull spawns; each gets its own spread draw. */
  readonly pellets?: number;
  /** Fraction of the target's armour ignored, 0..1 (1 pierces all of it). */
  readonly armorPen?: number;
  readonly charge?: ChargeDef;
  readonly mesh: string;
  readonly sfx: string;
}

/**
 * Roles, so two weapons are never the same answer: the shotgun clears a crowd at
 * arm's length, the sniper and the longbow take the long shot and the armoured one,
 * the flail is the panic button once the ring closes, and the catapult breaks a
 * packed lane. DESIGN.md's family colours (Gun Orange, Ember/Oak) key off `family`.
 */
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
  {
    id: 'shotgun',
    family: 'guns',
    fire: 'projectile',
    // Eight pellets out of one shell. Every pellet that reaches a body does nine
    // damage and any two of them end a chaser, so at close range the answer is
    // always the shotgun — and past 20 m it is never, which is the trade. The wide
    // cone plus 7 m/s knockback means a volley buys space as much as it takes lives.
    rate: 1.3,
    dmg: 9,
    spread: 0.2,
    speed: 30,
    range: 22,
    pierce: 0,
    knockback: 7,
    falloff: [9, 20, 0.35],
    ammo: { mag: 6, reload: 2.1 },
    pellets: 8,
    mesh: 'shotgun',
    sfx: 'gunHeavy',
  },
  {
    id: 'sniper',
    family: 'guns',
    fire: 'hitscan',
    // No travel time and no cone: the ray resolves the tick the trigger goes down,
    // so this is the gun for something fast and far. Half the target's armour is
    // ignored, which is the whole reason to carry it into an armoured pack. Four
    // pass-throughs, so five bodies standing on one line, and the ray stops there.
    rate: 0.75,
    dmg: 95,
    spread: 0,
    speed: 0,
    range: 60,
    pierce: 4,
    knockback: 2,
    falloff: [14, 40, 0.45],
    ammo: { mag: 5, reload: 2.4 },
    armorPen: 0.5,
    mesh: 'sniper',
    sfx: 'gunSniper',
  },
  {
    id: 'longbow',
    family: 'medieval',
    fire: 'projectile',
    // Draw it and the arrow leaves flat and hard: a full draw is 1.5x the speed and
    // 1.6x the damage of a cold one, and it pierces three bodies either way. The
    // cooldown is shorter than the 0.55 s draw on purpose, so the draw — not the
    // rate — is what sets the rhythm of the bow.
    rate: 3.2,
    dmg: 34,
    spread: 0.02,
    speed: 62,
    range: 40,
    pierce: 2,
    knockback: 2,
    falloff: [14, 30, 0.75],
    ammo: { mag: 8, reload: 1.5 },
    charge: { time: 0.55, speed: 1.5, dmg: 1.6 },
    mesh: 'longbow',
    sfx: 'bowDraw',
  },
  {
    id: 'flail',
    family: 'medieval',
    fire: 'melee',
    // A 300° sweep, 150° either side of the aim, so it cleans out everything except
    // a notch directly behind the player. Reach is short and the knockback is not:
    // 9 m/s staggers a charger for three ticks, which is how it survives a swarm
    // that has already closed. Clips up to 25 bodies a swing.
    rate: 1.1,
    dmg: 45,
    spread: 2.6181,
    speed: 0,
    range: 3.4,
    pierce: 24,
    knockback: 9,
    falloff: [1.6, 3.4, 0.7],
    ammo: { mag: 8, reload: 1.3 },
    mesh: 'flail',
    sfx: 'flailSwing',
  },
  {
    id: 'catapult',
    family: 'medieval',
    fire: 'arc',
    // Lobbed: the shell flies 18 m down the aim line in 1.2 s and bursts in a 3 m
    // circle, damaging every body inside it for full damage and shoving them clear.
    // It cannot be aimed at one running target, so its job is the packed lane and
    // the chokepoint — fired where the horde is going, not where it is.
    rate: 0.55,
    dmg: 70,
    spread: 0,
    speed: 15,
    range: 18,
    pierce: 0,
    knockback: 6,
    falloff: [18, 18, 1],
    ammo: { mag: 4, reload: 2.6 },
    aoe: 3,
    mesh: 'catapult',
    sfx: 'catapultLob',
  },
];
