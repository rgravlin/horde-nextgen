/**
 * Weapon content: the WeaponDef schema plus the entries the sim reads.
 *
 * Content is data (ARCHITECTURE.md): the fields below are the whole contract
 * between a weapon and src/sim/systems/{weapons,projectiles}.ts, so a new gun is
 * an entry here rather than a branch in the code. `fire` picks the delivery path
 * and every one of the seven kinds has one: `projectile`, `hitscan`, `beam`, `arc`,
 * `melee`, `chain` and `orb`, the last four in `projectiles.ts`. A weapon naming a
 * kind the sim has no path for would simply not shoot, which is why the kinds are
 * declared before they are used and pinned in tests/unit/weapons-a.test.ts.
 *
 * `homing` is the one field that is a flight modifier rather than a delivery path: it
 * bends the path a kind already has, so it needs no new branch in `fire` and no new
 * renderer batch. The eighteen entries below are what a run can find in a chest or on a
 * level-up card, and each one is written against a job — a crowd, a single fast body, a
 * plate, a lane at range — that at least one of the others does worse.
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

/**
 * A heat hand: what a trigger pull cooks, and how fast the gun cools.
 *
 * Heat is a rate, not a magazine. Every tick sheds `coolPerSec` of it and every
 * trigger pull adds `perShot`, so a weapon whose perShot x rate does not beat its
 * own cooling never locks up — that is the lever, not a hidden cap. At `max` the
 * hand vents: it will not fire again until the heat has fallen back to `recover`,
 * which is why the two numbers are both in content. A `beam` spends one charge per
 * tick it fires, so its `perShot` reads as heat per 1/60 s.
 */
export interface HeatDef {
  /** Heat units added per trigger pull (per firing tick for a `beam`). */
  readonly perShot: number;
  /** Heat units shed per second, whether or not the gun is firing. */
  readonly coolPerSec: number;
  /** Heat that puts the hand into vent. */
  readonly max: number;
  /** Heat the hand has to fall to before it fires again. */
  readonly recover: number;
}

/**
 * An energy hand: a charge pool that a trigger pull spends and that refills on the
 * ticks it does not. Unlike a magazine there is no reload pause — spend it down and
 * the gun dribbles until the pool recovers, which is the rhythm these weapons have.
 */
export interface EnergyDef {
  readonly capacity: number;
  /** Charge one trigger pull spends. */
  readonly perShot: number;
  /** Charge restored per second. */
  readonly regenPerSec: number;
}

/**
 * Damage over time a hit leaves on the body. One channel per body: a fresh hit
 * refreshes it, taking the stronger of the two `dps` and the longer of the two
 * durations, so a burn cannot stack into a second damage tick per application.
 * Armour is compared with `dps` on the same time base as the damage (per second),
 * so a burn is not free on an armoured body and never free entirely either.
 */
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
  /**
   * Shots per second at fireRate 1.0: the cooldown between trigger pulls. A `beam`
   * has no gap between pulls — it fires every tick it is able to and gates on heat
   * instead — so it carries 0.
   */
  readonly rate: number;
  /**
   * Damage, per trigger pull — except for a `beam`, which has no pulls, where it is
   * damage per second and lands 60 times a second while the beam is on.
   */
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
   * For `arc` and `orb` it fixes the flight time, `range / speed`. `hitscan`,
   * `melee`, `beam` and `chain` resolve in one tick and read nothing from it, so
   * they carry 0.
   */
  readonly speed: number;
  /**
   * Metres of travel before a shot retires. For `hitscan` and `beam` it is the
   * length of the ray, for `melee` the reach of the sweep (measured to the target's
   * body edge), for `arc` the distance the shell is lobbed down the aim line, for
   * `orb` how far the singularity drifts before it pops and for `chain` how far
   * from the player a bolt will go looking for a body at all.
   */
  readonly range: number;
  /**
   * Enemies a shot passes through *after* the first one it hits, so `pierce + 1`
   * is how many bodies one trigger pull can hurt. For `melee` and `beam` it is how
   * many extra bodies the sweep or the ray may clip, per tick. A `chain` bolt does
   * not pierce, it jumps, so it carries 0 and `chain` counts instead.
   */
  readonly pierce: number;
  /** Backward shove in m/s applied to a hit enemy, which staggers it. */
  readonly knockback: number;
  readonly falloff: FalloffDef;
  /**
   * The magazine, if the weapon has one. A weapon declares exactly one thing a
   * trigger pull spends: `ammo`, `heat` or `energy`. With no `ammo` there is no
   * magazine to reload and no empty hand — the constraint is the other gauge.
   */
  readonly ammo?: AmmoDef;
  readonly heat?: HeatDef;
  readonly energy?: EnergyDef;
  /**
   * Metres. For `arc` and `orb`, the burst radius around the impact point; for
   * `orb` the same circle is also the vacuum's reach, so what gets dragged in is
   * what gets popped.
   */
  readonly aoe?: number;
  readonly dot?: DotDef;
  /** Targets a hit chains to after the first. */
  readonly chain?: number;
  /** Metres a chain may jump from one body to the next. */
  readonly chainRadius?: number;
  /** m/s a singularity drags bodies inside `aoe` toward itself. */
  readonly pull?: number;
  /**
   * Turn rate in rad/s a flying shot may steer with while it hunts.
   *
   * Only the kinds that spend ticks in the air read it — `projectile`, `arc` and `orb` —
   * and what they hunt for is the nearest live body within the seek radius `projectiles.ts`
   * pins. A shot that never finds one flies the straight line the aim gave it and a shot
   * that finds one still has to reach it before its flight time runs out, so `homing`
   * buys a curve rather than a lock-on.
   */
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
 *
 * The eight entries added after those ten widen the same four jobs rather than
 * repeating them: the SMG, the rifle and the LMG are three different answers to "how
 * long is this fight going to be", the railgun and the crossbow are the long hard shot
 * at two different ranges, the pike is the flail's opposite (one lane, twice the
 * reach), the axes are a shotgun that keeps flying, and the disruptor follows the
 * crowd instead of arriving where it used to be.
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
    //
    // The pitch makes it a fire arrow: anything the shaft reaches keeps burning for
    // 2.5 s afterwards, which is the bow's second job. A body that walks the shot
    // still burns, and a body in armour burns slower but never for nothing, so the
    // bow stays an answer to the armoured pack the sniper was hired for.
    rate: 3.2,
    dmg: 34,
    spread: 0.02,
    speed: 62,
    range: 40,
    pierce: 2,
    knockback: 2,
    falloff: [14, 30, 0.75],
    ammo: { mag: 8, reload: 1.5 },
    dot: { dps: 16, seconds: 2.5 },
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
  {
    id: 'plasmaRepeater',
    family: 'alien',
    fire: 'projectile',
    // Twelve bolts a second that punch through three bodies and keep their speed out
    // to 20 m. It has no magazine — it has a heat gauge — and that is the whole
    // trade: no reload pause to be caught behind, but the barrel vents after about four
    // seconds of held trigger and sits out for 1.3 s. Aimed in short bursts it
    // out-damages anything else at mid range; held flat against a wall of bodies it
    // cooks itself out of the fight, which is the read the HUD gauge gives.
    //
    // perShot is set against what the gun actually does, not what `rate` says: on a
    // 1/60 s tick grid a cooldown of 1/11 s waits out six ticks, so the real cycle is
    // ten bolts a second and 0.07 cooked nothing but slow (6.2 s to vent, past the end
    // of the window that measures it). At 0.077 the measured curve is 4.2 s of fire,
    // 1.3 s of vent — the shape the weapon is designed around.
    rate: 11,
    dmg: 11,
    spread: 0.055,
    speed: 44,
    range: 22,
    pierce: 2,
    knockback: 1.2,
    falloff: [10, 20, 0.5],
    heat: { perShot: 0.077, coolPerSec: 0.55, max: 1, recover: 0.3 },
    mesh: 'plasma',
    sfx: 'plasmaRepeater',
  },
  {
    id: 'chainLightningWand',
    family: 'alien',
    fire: 'chain',
    // One bolt that walks off the body it found, up to five jumps of 6.5 m, and loses
    // edge along the way (the falloff is measured along the bolt's path, not the
    // crow's). It wants a packed lane: against a spread-out pack it spends its charge
    // on one body. No armour penetration either, so it is never the answer to a
    // shielded line — it is the answer to the two hundred things behind it.
    //
    // Charge rather than a magazine: 25 units a bolt out of 100, so four bolts and a
    // beat while the cell refills at 22/s, which reads as a weapon that thinks before
    // it fires again.
    rate: 2.4,
    dmg: 26,
    spread: 0,
    speed: 0,
    range: 9,
    pierce: 0,
    knockback: 0,
    falloff: [4, 22, 0.3],
    energy: { capacity: 100, perShot: 25, regenPerSec: 22 },
    chain: 5,
    chainRadius: 6.5,
    mesh: 'wand',
    sfx: 'chainLightning',
  },
  {
    id: 'laserLance',
    family: 'alien',
    fire: 'beam',
    // A continuous cut through four bodies at once, for as long as the barrel holds:
    // 46 damage a second, a quarter of the target's armour counted as gone, no travel
    // time and no cone, so what it wants is the thing that runs in straight lines and
    // the armoured thing nothing else can scratch. It pays for that with a short arm
    // (16 m) and with heat metered per tick — four seconds of beam, then 1.4 s of
    // venting — so it is a weapon of bursts that read as one long sound.
    rate: 0,
    dmg: 46,
    spread: 0,
    speed: 0,
    range: 16,
    pierce: 3,
    knockback: 0,
    falloff: [6, 16, 0.5],
    armorPen: 0.25,
    heat: { perShot: 0.0125, coolPerSec: 0.5, max: 1, recover: 0.3 },
    mesh: 'lance',
    sfx: 'lanceBeam',
  },
  {
    id: 'singularityGun',
    family: 'alien',
    fire: 'orb',
    // Throws a hole in the floor 13 m down the aim line. For 1.3 s it drags every
    // body within 3.2 m toward itself at 7 m/s — including bodies that were running
    // past — and then detonates inside the same circle for full damage and shoves
    // them back out. It is the catapult's answer one step earlier: it gathers the
    // crowd instead of waiting for one, and it is deliberately awful at a single fast
    // target, because the pop happens where the orb got to and not where it was
    // aimed. Charge-fed: three orbs, then a beat.
    rate: 0.9,
    dmg: 34,
    spread: 0,
    speed: 10,
    range: 13,
    pierce: 0,
    knockback: 5,
    falloff: [13, 13, 1],
    energy: { capacity: 100, perShot: 36, regenPerSec: 24 },
    aoe: 3.2,
    pull: 7,
    mesh: 'gravGun',
    sfx: 'singularity',
  },
  {
    id: 'smg',
    family: 'guns',
    fire: 'projectile',
    // The 5/s pistol fires too slowly to keep a cloud off you, and the shotgun that
    // can is out of reach past 20 m. The SMG is the volume in between: rate 15 waits
    // out five ticks per trigger pull, which on a 1/60 s grid is twelve rounds a
    // second, and eleven damage a round is a hundred and thirty-two raw downrange of
    // the muzzle with a pass-through on top, so a swarmling disc 13 m out is dead in a
    // second and a half where the pistol needs three and a half. What that buys is
    // honest: 0.06 of cone means a round at 15 m is more luck than aim, the falloff is
    // over by 19 m, and against plate the same gun runs at half the rifle's speed —
    // volume spends itself on soft bodies. A 40-round belt is three and a third seconds
    // of trigger, and 1.6 s is short enough to survive.
    rate: 15,
    dmg: 11,
    spread: 0.06,
    speed: 52,
    range: 19,
    pierce: 1,
    knockback: 1.2,
    falloff: [10, 19, 0.55],
    ammo: { mag: 40, reload: 1.6 },
    mesh: 'smg',
    sfx: 'gunLight',
  },
  {
    id: 'assaultRifle',
    family: 'guns',
    fire: 'projectile',
    // The generalist: nineteen damage at eight rounds a second, a cone tight enough to
    // spend at range and two pass-throughs, which is what makes a file of bodies walking
    // at you one problem instead of four. Measured, it is neither the family's fastest
    // crowd answer nor its fastest plate answer, and that is what the entry is for — the
    // gun whose numbers are never wrong. Inside 10 m the SMG puts more lead at a disc,
    // and over a chapter the LMG's 120-round belt outlasts a 30-round magazine; what the
    // rifle takes is everything in between, and it is the one belt gun that ends an
    // armored before it closes, which is the duel the other two lose.
    rate: 8,
    dmg: 19,
    spread: 0.04,
    speed: 66,
    range: 30,
    pierce: 2,
    knockback: 2,
    falloff: [13, 30, 0.55],
    ammo: { mag: 30, reload: 2.1 },
    mesh: 'rifle',
    sfx: 'gunHeavy',
  },
  {
    id: 'lmg',
    family: 'guns',
    fire: 'projectile',
    // Suppression, and the only gun here whose constraint is how long you are willing
    // to stop moving for. A hundred and twenty rounds at ten a second is twelve seconds
    // of continuous fire and a thousand five hundred and sixty raw damage, with three
    // pass-throughs and reach out to 38 m: the fastest thing in the family at a crowd,
    // and the answer to a chapter that simply does not stop coming. The price is a 5 s
    // reload — longer than any wave — and the widest cone of any gun that claims to
    // shoot at range, so past the 19 m where its falloff starts the last third of the
    // belt is area denial rather than aim, and against a single armored body the same
    // belt loses to the rifle. Reload it behind cover or do not start the fight.
    rate: 10,
    dmg: 13,
    spread: 0.09,
    speed: 70,
    range: 38,
    pierce: 3,
    knockback: 1.2,
    falloff: [19, 38, 0.55],
    armorPen: 0.2,
    ammo: { mag: 120, reload: 5.0 },
    mesh: 'lmg',
    sfx: 'gunHeavy',
  },
  {
    id: 'railgun',
    family: 'guns',
    fire: 'hitscan',
    // The sniper's job, taken further and paid for differently. Two hundred and forty
    // damage with three quarters of a body's plate ignored is enough to end an armored
    // with one shot through the front, which no other weapon here does, and nine
    // bodies on one line die to the same trigger pull. Everything else about it is
    // slow: half a shot a second, four in the tube, 3.4 s to find another four, and
    // the round is gone at 55 m. Against a ring that has already closed it is the
    // wrong gun, because there is no second shot to buy the space with.
    rate: 0.5,
    dmg: 240,
    spread: 0,
    speed: 0,
    range: 70,
    pierce: 8,
    knockback: 3,
    falloff: [24, 55, 0.55],
    ammo: { mag: 4, reload: 3.4 },
    armorPen: 0.75,
    mesh: 'railgun',
    sfx: 'gunSniper',
  },
  {
    id: 'crossbow',
    family: 'medieval',
    fire: 'projectile',
    // A heavier arrow: slower to cock than the longbow and twice as rude to a body
    // that arrived wearing something. Fifty-two damage through 40% of a plate, four
    // bodies on a line, a cone of 0.012 rad and a bolt that reaches 42 m means a lane
    // laid out ahead of the player is one decision rather than four. It loses to the
    // longbow everywhere the answer is burn, and to the sniper everywhere the answer is
    // 60 m; what it owns is the 20-35 m band where a bolt that keeps flying through
    // bodies is worth more than one that sets them alight.
    rate: 1.7,
    dmg: 52,
    spread: 0.012,
    speed: 74,
    range: 42,
    pierce: 3,
    knockback: 3,
    falloff: [20, 42, 0.62],
    ammo: { mag: 5, reload: 2.3 },
    armorPen: 0.4,
    mesh: 'crossbow',
    sfx: 'bowDraw',
  },
  {
    id: 'pike',
    family: 'medieval',
    fire: 'melee',
    // The flail is a 300° answer to a ring; a pike is a 37° answer to a lane, and
    // that is the whole trade. 5.2 m of reach is four times the flail's and longer
    // than anything that can touch the player, so a charger coming in gets met in its
    // wind-up, and 12 m/s of shove staggers it for three ticks on top of the push.
    // Up to six bodies on a line take it. What it cannot do is clean a ring — bodies
    // to the sides and behind are outside the arc and free to walk in — so it is the
    // gun for the corridor and the last stand in a doorway, and the wrong one for the
    // open floor a flail was drawn for.
    rate: 1.7,
    dmg: 68,
    spread: 0.32,
    speed: 0,
    range: 5.2,
    pierce: 5,
    knockback: 12,
    falloff: [2.2, 5.2, 0.72],
    ammo: { mag: 12, reload: 1.4 },
    mesh: 'pike',
    sfx: 'flailSwing',
  },
  {
    id: 'throwingAxes',
    family: 'medieval',
    fire: 'projectile',
    // Three axes per throw, each of which keeps going through two more bodies after
    // the one it caught, on a cone wide enough to be honest about at 14 m. Damage does
    // not fall off at all — a boarding axe is thrown the same way at 3 m and at 13 —
    // and the 4 m/s shove plus the spread is what buys the space to wind up the next
    // throw. It is the flail's range and none of its reliability: nine weapons' worth
    // of damage in a 2.2 s reload, nothing that pierces plate, and past 14 m there is
    // nothing to hit. Take it when the ring is closing and you would rather open a gap
    // than fill one.
    rate: 1.4,
    dmg: 26,
    spread: 0.16,
    speed: 26,
    range: 14,
    pierce: 2,
    knockback: 4,
    falloff: [14, 14, 1],
    ammo: { mag: 9, reload: 2.2 },
    pellets: 3,
    mesh: 'axes',
    sfx: 'flailSwing',
  },
  {
    id: 'disruptorOrb',
    family: 'alien',
    fire: 'orb',
    // The singularity gun's flaw is in its own comment: it pops where it got to, not
    // where the crowd is going. The disruptor is that flaw removed and paid for in
    // size — a smaller burst (2.7 m), a weaker pull (5 m/s), and less damage per pop —
    // plus the two things that make it a weapon rather than a smarter gravity well: it
    // hunts, turning 2.4 rad/s toward whatever is nearest, and it eats armour, so the
    // pop lands at 45% through a plate. Slow, and short-ranged, and three orbs leaves
    // the cell dry; it wants a crowd it can lose itself in, and it is bad at anything
    // fast enough to step aside before the orb finds out where it went.
    rate: 0.85,
    dmg: 44,
    spread: 0,
    speed: 18,
    range: 17,
    pierce: 0,
    knockback: 4,
    falloff: [17, 17, 1],
    energy: { capacity: 100, perShot: 30, regenPerSec: 21 },
    aoe: 3.0,
    pull: 5,
    armorPen: 0.45,
    homing: 2.4,
    mesh: 'disruptor',
    sfx: 'singularity',
  },
];
