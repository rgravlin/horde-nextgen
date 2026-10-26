/**
 * Shot physics: everything that resolves damage after the trigger decision.
 *
 * Seven delivery paths live in this folder, one per fire kind:
 *
 * - `projectile` — a round flies and is tested as the segment it swept this tick,
 *   because a 55 m/s round covers 0.92 m per tick, further than an enemy's radius,
 *   so a point test would tunnel straight through the front rank.
 * - `hitscan` — a ray resolved the tick the trigger went down, marched through the
 *   tick's spatial hash and stopped once its pierce budget was spent.
 * - `melee` — an arc sweep around the player.
 * - `arc` — a shell that flies the full length it was lobbed and bursts there.
 * - `beam` — the same march, every tick the trigger is held, for as long as the
 *   barrel has heat left. Damage is measured per second, so it goes through
 *   `throughArmor` on the tick's time base (see `systems/status.ts`), and it reports
 *   one `Hit` per body per tick like every other path: a continuous weapon that
 *   cannot light a hit flash has no presentation channel at all.
 * - `chain` — a bolt that takes the nearest body and then jumps to the next nearest
 *   body it has not already hurt, up to the def's jump count.
 * - `orb` — a singularity that drags bodies inside its radius toward itself for its
 *   whole flight and detonates inside the same circle.
 *
 * `homing` is a modifier rather than an eighth path: it applies to the three kinds that
 * spend ticks in the air, and `steer` (in `flyers.ts`) rotates a flying shot's velocity
 * toward the nearest live body inside its seek band, once a tick, before the segment it is
 * about to sweep is tested — so what the segment test sees is the line the round really
 * flew.
 *
 * The folder is cut along that same line rather than by length: `shared.ts` holds the one
 * way a hit lands and the padding every query uses, `ray.ts` the three paths resolved by
 * marching the hash, `melee.ts` the arc sweep, `flyers.ts` everything that happens to a
 * round spending ticks in the air.
 *
 * Nothing here allocates: candidates come out of the tick's shared `world.query`
 * buffer, the ray's march is a loop over probe windows rather than a list, the chain
 * remembers its own hit list in one module-scratch array, and the only events are the
 * fixed-shape ones the renderer and audio read later.
 */

export { updateProjectiles } from './flyers';
export { sweepMelee } from './melee';
export { castBeam, castRay, castChain } from './ray';