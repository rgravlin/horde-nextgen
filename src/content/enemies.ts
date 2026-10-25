/**
 * Enemy content: the EnemyDef schema and the archetypes the sim can spawn.
 *
 * `ai` names a behaviour in src/sim/systems/enemies.ts and `params` are the
 * numbers that behaviour reads, so a new archetype is a data entry unless it
 * genuinely needs a new movement or attack pattern.
 */

export type Faction = 'swarm' | 'foundry' | 'reactor' | 'cult';

/**
 * Behaviour ids, in the order the `AI` record in systems/enemies.ts lists them.
 * That record is keyed by this union, so an id without a behaviour is a
 * typecheck error instead of an enemy that quietly stands still.
 */
export const AI_IDS = ['chaser'] as const;

export type AiId = (typeof AI_IDS)[number];

export interface EnemyDef {
  readonly id: string;
  readonly faction: Faction;
  readonly hp: number;
  /** Cruise speed in m/s. */
  readonly speed: number;
  /** Collision radius in m. */
  readonly radius: number;
  /** Damage each hit loses to it, after falloff. */
  readonly armor: number;
  /** XP its shard is worth. */
  readonly xp: number;
  readonly ai: AiId;
  /**
   * Numbers the behaviour reads. Keys are documented where the behaviour uses
   * them, and a behaviour owns its keys rather than sharing one flat namespace.
   */
  readonly params: Readonly<Record<string, number>>;
  /** Emissive core colour. Bodies stay dark matte (DESIGN.md 'Palette'). */
  readonly accent: string;
}

export const ENEMIES: readonly EnemyDef[] = [
  {
    id: 'chaser',
    faction: 'swarm',
    hp: 20,
    speed: 3.4,
    radius: 0.45,
    armor: 0,
    xp: 1,
    ai: 'chaser',
    // sepRadius: personal space in m. sepPush: how hard a neighbour is shoved
    // aside. touchRange: reach beyond the two collision radii. touchDamage: HP
    // lost per contact, gated by the player's i-frames.
    params: { sepRadius: 1.1, sepPush: 1.6, touchRange: 0.3, touchDamage: 6 },
    accent: '#FF2E97',
  },
];

/** The only archetype the wave spawner draws until chapter scripts land (T8). */
export const DEFAULT_ENEMY = 0;