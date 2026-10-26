/**
 * Enemy pass: behaviours, contact damage, deaths and what a death leaves behind.
 *
 * The pass is split by archetype rather than by length, so a behaviour is one page: the
 * bodies that only walk at you (`seekers.ts`), the ones that read a distance before they
 * commit (`rushers.ts`), the ranged trio that refuse to press in (`standoff.ts`), the
 * healer (`support.ts`) and the three encounters (`bosses.ts`). `shared.ts` holds the
 * travel tail and the phase ids they all use, `behaviours.ts` is the dispatch table, and
 * `update.ts` is the pass that runs it. Outside this folder the public surface is the five
 * functions at the bottom of this file.
 *
 * Three rules hold the folder together, because eight behaviours written eight ways read as
 * eight bugs rather than as a horde:
 *
 * - **Movement is a velocity plus `advance`,** never a jump. Separation, the speed cap, the
 *   facing and the arena clamp all hang off that one path, and the interpolation the renderer
 *   does between steps only means something if a body travelled through the space between its
 *   old position and its new one.
 * - **A tell is an event.** Anything the player is asked to answer — a charge line, a
 *   filling ring — announces itself the tick it starts and leaves a `timer` behind for as
 *   long as it lasts, so presentation never has to guess what a body is about to do.
 * - **Nothing detonates inside the kill.** A blast is queued where the death happens and paid
 *   out later in the tick by `resolveBlasts`, because the kill happens in the middle of a
 *   shot that is still walking the tick's one shared query buffer, and because a blast that
 *   kills a second bomber wants a stack to land on rather than recursion.
 *
 * The ranged trio also owes one rule of its own: a shot is *triggered* here and *delivered*
 * by `systems/enemyProjectiles.ts`, mirroring how the player's weapons hand their rounds to
 * `systems/projectiles.ts`. A behaviour that wants to shoot spends a pool slot and an event
 * and gets on with its movement; everything that happens after the trigger — the flight, the
 * hit test against the player, the burst — lives one file away.
 */

export { armorAgainst } from './contact';
export { killEnemy, queueBlast, resolveBlasts } from './deaths';
export { spawnEnemy } from './spawn';
export { updateEnemies } from './update';
