/**
 * Enemy content: the EnemyDef schema, the archetypes the sim can spawn and the wave
 * recipes that mix them into packs.
 *
 * `ai` names a behaviour in src/sim/systems/enemies/ and `params` are the numbers
 * that behaviour reads, so a new archetype is a data entry unless it genuinely needs
 * a new movement or attack pattern. The parameter names are documented where the
 * behaviour uses them, and a behaviour owns its keys rather than sharing one flat
 * namespace.
 */

export type Faction = 'swarm' | 'foundry' | 'reactor' | 'cult';

/**
 * Behaviour ids, in the order the `AI` record in systems/enemies/behaviours.ts lists
 * them. That record is keyed by this union, so an id without a behaviour is a
 * typecheck error instead of an enemy that quietly stands still.
 *
 * The last three are the end-of-level encounters. They are behaviours rather than
 * reskinned bodies because a boss has to ask the player to do something the trash
 * never did: dodge a volley of charges, kill it away from the crowd it keeps breeding,
 * or answer two mechanics at once.
 */
export const AI_IDS = [
  'chaser',
  'swarmling',
  'charger',
  'exploder',
  'splitter',
  'armored',
  'shooter',
  'grenadier',
  'healer',
  'brute',
  'brooder',
  'matron',
] as const;

export type AiId = (typeof AI_IDS)[number];

/**
 * What a body breaks into when it dies, named by id rather than by row number so
 * reordering the table cannot quietly point a splitter at the wrong child.
 */
export interface SplitDef {
  readonly def: string;
  /** Copies spawned. The pool's cap still applies; a full pool spawns none. */
  readonly count: number;
}

export interface EnemyDef {
  readonly id: string;
  readonly faction: Faction;
  readonly hp: number;
  /** Cruise speed in m/s. */
  readonly speed: number;
  /** Collision radius in m. */
  readonly radius: number;
  /**
   * Damage each hit loses to it, after falloff. A body with `armorSide` set only pays
   * that much inside its facing arc — see `armorAgainst` in systems/enemies/contact.ts.
   */
  readonly armor: number;
  /** XP its shard is worth. */
  readonly xp: number;
  readonly ai: AiId;
  /**
   * Which shape the render layer draws it with.
   *
   * Presentation, kept here because what a body looks like is part of how it is read: the
   * shapes are authored one per silhouette and shared by whoever needs them, so a new
   * archetype that looks like an existing one costs one word rather than a new mesh. An id the
   * render layer does not know falls back to the chaser's shape.
   */
  readonly mesh: string;
  /**
   * How much of that shape to use. 1 draws it at the size it was authored for; a smaller
   * archetype that shares a shape names the fraction it wants instead.
   */
  readonly fit?: number;
  /**
   * Numbers the behaviour reads. Keys are documented where the behaviour uses
   * them, and a behaviour owns its keys rather than sharing one flat namespace.
   */
  readonly params: Readonly<Record<string, number>>;
  /** Death split, for the bodies that come apart into smaller ones. */
  readonly splits?: SplitDef;
  /**
   * An end-of-level encounter rather than horde fodder.
   *
   * Two things read it: a boss never staggers (a shove that moved a 500 HP body would
   * be a better answer to it than any of its telegraphs, and a boss that got pushed
   * round the room by a shotgun teaches nothing), and the HUD draws a name plate and a
   * health bar for whichever body the chapter's script ends with.
   */
  readonly boss?: boolean;
  /** Emissive core colour. Bodies stay dark matte (DESIGN.md 'Palette'). */
  readonly accent: string;
}

/**
 * The pack each wave draws, as ids, walked in order rather than drawn from a bag.
 *
 * The spawner reads a batch straight down the recipe and starts the next batch where
 * this one stopped, so a pack is always mixed and what arrives is knowable: the fifth
 * body of wave 1 is a charger in every run. That is deliberate. A weighted bag would
 * make "does this chapter ever show you a charger" a matter of luck, and a browser
 * scenario has to be able to assert on it.
 *
 * The last row carries on for every wave past the end of the list. The first two rows
 * are what a chapter opens on and are pinned by the browser scenarios; the ranged trio
 * join from wave 3 on, so a player meets a shooter before a whole pack shoots back,
 * and meets a healer only once the pack already has wounded bodies worth mending.
 */
export const PACKS: readonly (readonly string[])[] = [
  // Two bodies that walk at you, then the first thing that does not.
  ['chaser', 'swarmling', 'chaser', 'swarmling', 'charger'],
  ['swarmling', 'chaser', 'charger', 'exploder', 'chaser'],
  ['charger', 'swarmling', 'exploder', 'shooter', 'chaser', 'splitter'],
  ['charger', 'exploder', 'armored', 'shooter', 'splitter', 'grenadier'],
  ['exploder', 'armored', 'splitter', 'charger', 'grenadier', 'healer', 'exploder'],
  ['splitter', 'charger', 'armored', 'exploder', 'swarmling', 'charger', 'armored', 'shooter', 'grenadier', 'healer'],
];

/** The only archetype the wave spawner falls back to if a recipe names nothing else. */
export const DEFAULT_ENEMY = 0;

/**
 * Roles, so two archetypes are never the same answer.
 *
 * The three that arrive fast (chaser, swarmling, splinter) are cheap bodies meant to
 * be cleared by an area weapon; the charger and the armored are the ones that punish
 * standing still; the exploder and the splitter are the ones it is worth shooting
 * before they reach the crowd, because killing them somewhere other than on top of you
 * is the whole skill of the pair. The ranged trio then punishes *aiming at nothing*:
 * the shooter and the grenadier make standing still at range a losing trade, and the
 * healer is the reason the pack you are shooting takes longer to die than its HP says
 * — its 6 XP is priced for the kill-first answer.
 */
export const ENEMIES: readonly EnemyDef[] = [
  {
    id: 'chaser',
    faction: 'swarm',
    mesh: 'chaser',
    hp: 20,
    speed: 3.4,
    radius: 0.45,
    armor: 0,
    xp: 1,
    ai: 'chaser',
    // sepRadius: personal space in m. sepPush: how hard a neighbour is shoved
    // aside. touchRange: reach beyond the two collision radii. touchDamage: HP
    // lost per contact, gated by the player's i-frames. faceLag: how fast the
    // body's facing catches up with where it is actually going, in fractions of a
    // second (high = instant).
    params: { sepRadius: 1.1, sepPush: 1.6, touchRange: 0.3, touchDamage: 6, faceLag: 12 },
    accent: '#FF2E97',
  },
  {
    id: 'swarmling',
    faction: 'swarm',
    mesh: 'mote',
    // Fast, cheap and useless alone: it arrives in a cloud of twenty and its whole
    // job is to make the player spend an area weapon or give up ground.
    hp: 9,
    speed: 4.6,
    radius: 0.3,
    armor: 0,
    xp: 1,
    ai: 'swarmling',
    // swayAmp: half-width of the weave, in radians. swayHz: how many weaves a second.
    // The cloud spreads across its own approach instead of marching in one file, which
    // is what stops a pack of twenty arriving as one lane that any gun deletes.
    params: {
      sepRadius: 0.75,
      sepPush: 2.2,
      touchRange: 0.25,
      touchDamage: 4,
      faceLag: 14,
      swayAmp: 0.34,
      swayHz: 5.5,
    },
    accent: '#FF2E97',
  },
  {
    id: 'charger',
    faction: 'swarm',
    mesh: 'lancer',
    hp: 46,
    // Stalks slower than a chaser so the charge reads, and pays for the 13 m/s of it
    // with a wind-up long enough to step out of (DESIGN.md: at least 0.4 s of
    // telegraph) and a recover long enough to punish missing.
    speed: 3.1,
    radius: 0.5,
    armor: 1,
    xp: 4,
    ai: 'charger',
    // armRange: how close it has to get to commit. nearRange: inside this it just
    // walks, because a charge from arm's length is not a charge. windup, dashTime,
    // recover: seconds in each phase. dashSpeed: m/s during the dash. stalk: seconds
    // of stalking before it will commit again.
    params: {
      sepRadius: 1.2,
      sepPush: 1.8,
      touchRange: 0.3,
      touchDamage: 9,
      faceLag: 10,
      armRange: 9,
      nearRange: 2.5,
      windup: 0.5,
      dashTime: 0.5,
      dashSpeed: 13,
      recover: 0.4,
      stalk: 0.6,
    },
    accent: '#FF2E97',
  },
  {
    id: 'exploder',
    faction: 'reactor',
    mesh: 'blister',
    // A bomb with legs. Slow and squishy; the danger is the 26 HP it pays out when it
    // goes, which it will do on death if nobody shoots it early.
    hp: 18,
    speed: 2.9,
    radius: 0.5,
    armor: 0,
    xp: 3,
    ai: 'exploder',
    // armRange: distance at which it starts the fuse. fuseTime: seconds of flashing
    // before it bursts. blastRadius, blastDamage: the burst, which hurts the player
    // and other bodies alike.
    params: {
      sepRadius: 1.3,
      sepPush: 1.4,
      touchRange: 0.3,
      touchDamage: 5,
      faceLag: 10,
      armRange: 3.6,
      fuseTime: 0.5,
      blastRadius: 3.2,
      blastDamage: 26,
    },
    accent: '#9B5CFF',
  },
  {
    id: 'splitter',
    faction: 'reactor',
    mesh: 'shell',
    // Heavy, slow and lurching: readable at a distance, and worth killing away from
    // the crowd, because the four bodies it leaves behind are faster than it is.
    hp: 44,
    speed: 2.6,
    radius: 0.62,
    armor: 1,
    xp: 4,
    ai: 'splitter',
    params: {
      sepRadius: 1.4,
      sepPush: 1.5,
      touchRange: 0.3,
      touchDamage: 7,
      faceLag: 8,
      swayAmp: 0.5,
      swayHz: 1.6,
    },
    splits: { def: 'splinter', count: 3 },
    accent: '#9B5CFF',
  },
  {
    id: 'splinter',
    faction: 'reactor',
    mesh: 'mote',
    fit: 0.8,
    // What a splitter leaves behind: half the body, most of the speed, and no split of
    // its own, so a run cannot cascade into an infinite crowd.
    hp: 7,
    speed: 4.4,
    radius: 0.24,
    armor: 0,
    xp: 1,
    ai: 'swarmling',
    params: {
      sepRadius: 0.7,
      sepPush: 2.4,
      touchRange: 0.2,
      touchDamage: 3,
      faceLag: 16,
      swayAmp: 0.45,
      swayHz: 7,
    },
    accent: '#9B5CFF',
  },
  {
    id: 'armored',
    faction: 'foundry',
    mesh: 'plate',
    // The wall. Its 7 of armour only counts inside ±60° of its facing, and its facing
    // follows where it is going rather than where you are, so walking past it — or
    // knocking it sideways and shooting the flat side — is what makes the armour a
    // positioning puzzle instead of a tax.
    hp: 80,
    speed: 2.5,
    radius: 0.62,
    armor: 7,
    xp: 6,
    ai: 'armored',
    // standoff: the ring size it holds once it arrives. orbit: fraction of its speed
    // it spends circling rather than closing. turnTime: seconds per side of that
    // circle. armorArc: cosine of the half-angle the plate covers (0.5 is 60°).
    // armorSide: fraction of the plate kept outside that arc.
    params: {
      sepRadius: 1.5,
      sepPush: 2,
      touchRange: 0.3,
      touchDamage: 11,
      faceLag: 2.6,
      standoff: 4,
      orbit: 0.8,
      turnTime: 2.4,
      armorArc: 0.5,
      armorSide: 0,
    },
    accent: '#F2B233',
  },
  {
    id: 'shooter',
    faction: 'cult',
    mesh: 'stalk',
    // The first body that shoots back, and it is built to be read: a quarter-second
    // red flash before a bolt slow enough to walk out of, at a band it holds rather
    // than presses. Two pistol rounds kill it at that band, so the trade it forces is
    // "spend the two shots now or eat the volley" — which is the decision every ranged
    // pack later makes again, taught here at four XP.
    hp: 26,
    speed: 3.0,
    radius: 0.42,
    armor: 0,
    xp: 4,
    ai: 'shooter',
    // The band, the flash and the bolt are all documented where the behaviour reads
    // them (standoffShoot in systems/enemies/standoff.ts): the band it works at, the seconds of
    // wind-up and cooldown, and the bolt's speed, damage and life.
    params: {
      sepRadius: 1.3,
      sepPush: 1.6,
      touchRange: 0.25,
      touchDamage: 4,
      faceLag: 10,
      standMin: 4.5,
      standMax: 8,
      windup: 0.4,
      shotGap: 1.2,
      boltSpeed: 13,
      boltDamage: 8,
      boltLife: 1.4,
    },
    accent: '#FF4D2E',
  },
  {
    id: 'grenadier',
    faction: 'reactor',
    mesh: 'hopper',
    // A bomber that kills the floor rather than the body: it rings the landing point
    // while the lob is in the air, so its damage is a place, announced, that you are
    // asked to leave. It pays a little less than the exploder's 26 because the lob
    // arrives where you *were* — standing still is what buys it. Squishy and slow;
    // shooting it early spends the throw.
    hp: 30,
    speed: 2.8,
    radius: 0.45,
    armor: 1,
    xp: 5,
    ai: 'grenadier',
    // lobMin/lobRange bound the throw, arcSpeed sets the flight (and with lobMin the
    // guaranteed ring fill), and the burst numbers are the ring's, documented where
    // lobRunner reads them.
    params: {
      sepRadius: 1.4,
      sepPush: 1.5,
      touchRange: 0.3,
      touchDamage: 6,
      faceLag: 8,
      lobMin: 4,
      lobRange: 14,
      lobGap: 2.2,
      arcSpeed: 10,
      blastRadius: 3,
      blastDamage: 22,
    },
    accent: '#9B5CFF',
  },
  {
    id: 'healer',
    faction: 'cult',
    mesh: 'censer',
    // The support body, and deliberately the thinnest one in the file: no attack, a
    // leash it kites at, and a two-second pulse that undoes a magazine of player
    // damage if it is left beside a wounded pack. Everything about it asks to be
    // answered with prioritisation rather than with kite-around, which is why the
    // recipe only pairs it with bodies worth mending.
    hp: 24,
    speed: 4.2,
    radius: 0.4,
    armor: 0,
    xp: 6,
    ai: 'healer',
    // healRange/healGap/healAmount/fleeRadius, documented where supportRunner reads
    // them. The 5 m pulse is DESIGN.md's Heal Green aura.
    params: {
      sepRadius: 1.2,
      sepPush: 2,
      touchRange: 0.25,
      touchDamage: 3,
      faceLag: 14,
      healRange: 5,
      healGap: 2,
      healAmount: 10,
      fleeRadius: 8,
    },
    accent: '#3DFF8A',
  },

  // ── End-of-level encounters ───────────────────────────────────────────────────────
  // Three bodies a chapter ends on rather than opens with, so the first thing a player
  // has to work out at a boss is not "what is this" but "what does it want from me
  // that the last hundred bodies did not". Each one is answered by a skill the trash
  // already taught, turned up: kill it away from the crowd, step out of a ring, or
  // prioritise two things at once.
  //
  // Their collision radii stay near 1.5 m on purpose. The hit queries pad for the widest
  // body in the table (see HIT_PAD in systems/projectiles.ts), so a 3 m body makes every
  // shot in the game query a wider circle, and a boss that slowed down every weapon
  // to pay for its size would be a bad trade.

  {
    id: 'broodmother',
    faction: 'reactor',
    mesh: 'sac',
    // The chapter-1 finisher: slow, and it does not hit you at all. Its damage is the
    // brood it keeps putting down — five broods of three splinters, then it runs out and
    // is just a fat body to shoot — so the answer is the same one the splitter taught,
    // spent on a body that teaches it again: kill it away from the crowd, and do it
    // before the brood arrives. Dying in a ring of its own children is the trap.
    hp: 220,
    speed: 2.4,
    radius: 1.5,
    armor: 2,
    xp: 25,
    ai: 'brooder',
    boss: true,
    // spawnGap: seconds between broods. spawnBroods: how many it looses before it stops.
    // spawnCount: splinters per brood. spawnSpread: how far outside its own body they
    // land. blastRadius/blastDamage: what it leaves behind, which is the second half of
    // the same lesson.
    params: {
      sepRadius: 2.6,
      sepPush: 2.8,
      touchRange: 0.3,
      touchDamage: 10,
      faceLag: 6,
      spawnGap: 3.2,
      spawnBroods: 5,
      spawnCount: 3,
      spawnSpread: 1.4,
      blastRadius: 3.6,
      blastDamage: 30,
    },
    splits: { def: 'splinter', count: 4 },
    accent: '#9B5CFF',
  },
  {
    id: 'matron',
    faction: 'cult',
    mesh: 'matron',
    // Two mechanics at once, which is the whole point of a mid-run boss: it holds the
    // shooter's band and mends the pack that arrives with it, so the player has to
    // answer the fan AND kill the support before the pack stops dying. The fan is three
    // bolts 7.5° apart, wide enough that a step taken *after* the flash still crosses
    // another bolt's line: the fan covers the corridor you would flee down. What lands is
    // one hit rather than three, because the i-frame gate collapses a volley that arrives
    // together — the width is there to deny the dodge, not to stack the damage.
    hp: 300,
    speed: 3.1,
    radius: 1.25,
    armor: 3,
    xp: 30,
    ai: 'matron',
    boss: true,
    // standMin/standMax: the band it works at, wider than the shooter's so it cannot be
    // walked down. fan: radians between bolts. healRange/healGap/healAmount: the same
    // aura the healer runs, at over twice the reach and half again the price.
    params: {
      sepRadius: 2.2,
      sepPush: 2.2,
      touchRange: 0.3,
      touchDamage: 8,
      faceLag: 8,
      standMin: 6,
      standMax: 11,
      windup: 0.45,
      shotGap: 1.8,
      bolts: 3,
      fan: 0.13,
      boltSpeed: 15,
      boltDamage: 9,
      boltLife: 1.6,
      healRange: 7,
      healGap: 3,
      healAmount: 14,
    },
    accent: '#3DFF8A',
  },
  {
    id: 'atlas',
    faction: 'foundry',
    mesh: 'atlas',
    // The last answer for a run that has learned everything: it takes the armored's
    // plate and its circling, and adds a slam. It presses to a 5.5 m ring and walks it
    // fast, so its shield is always sideways and always moving; every two and a half
    // seconds it stops, flashes for 450 ms, and drops a 4.6 m burst centred on itself.
    // Both halves are the same lesson: the way through a wall is round it. Standing in
    // front of it is answered by the plate, and standing inside the ring is answered by
    // the slam.
    hp: 520,
    // Faster than its cruise while it orbits (the ring's sideways drift adds to it),
    // which is why the flank has to be *walked* rather than reached by one step.
    speed: 3.4,
    radius: 1.5,
    armor: 12,
    xp: 40,
    ai: 'brute',
    boss: true,
    // standoff: the ring it holds. orbit: fraction of its speed spent sideways.
    // slamGap: seconds between slams, slamWindup: the flash before one lands.
    // blastRadius/blastDamage: the slam, which hurts its own pack as much as the player.
    // armorArc/armorSide: the plate, wider and thinner than the armored's — 0.25 of it
    // stays on the flank, so flanking is worth doing and is not free.
    params: {
      sepRadius: 2.6,
      sepPush: 2.6,
      touchRange: 0.35,
      touchDamage: 16,
      faceLag: 3,
      standoff: 5.5,
      orbit: 0.9,
      slamGap: 2.5,
      slamWindup: 0.45,
      blastRadius: 4.6,
      blastDamage: 24,
      armorArc: 0.55,
      armorSide: 0.25,
    },
    accent: '#F2B233',
  },
];

/** Id to table index, built once so a recipe or a split can name an archetype. */
export const ENEMY_BY_ID: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < ENEMIES.length; i++) map[ENEMIES[i].id] = i;
  return map;
})();

/** Index of `id`, or -1 when nothing answers to that name. */
export function enemyIndex(id: string): number {
  const i = ENEMY_BY_ID[id];
  return i === undefined ? -1 : i;
}
