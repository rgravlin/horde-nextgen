/**
 * The shapes: one procedural low-poly geometry per enemy mesh id, the player's kit-bash,
 * the projectile shapes and the materials the horde is drawn with.
 *
 * Why procedural (DESIGN.md "Horde"): 1,000 bodies cannot be authored one at a time, and a
 * horde only reads as *silhouettes plus accent dots* — rather than as one glow smear — if
 * each archetype has a shape the eye can learn. So every body here is a handful of
 * primitives merged into one geometry of 40 to 300 triangles, and one instanced batch draws
 * every body of that shape (TECH.md "one `InstancedMesh` per enemy archetype mesh").
 *
 * Nothing in this folder reads the World: it hands out geometry and materials and knows
 * nothing about who uses them. The one caller that does is `instancing.ts`, which clones a
 * shape before it attaches a batch's per-instance buffers — see `materials.ts`.
 *
 * ## The files
 *
 * - `primitives.ts` — the toolkit: how parts merge into one faceted buffer, and how a
 *   triangle count is read back off the result.
 * - `shapes.ts` — the archetype recipes, keyed by mesh id, and the cache that hands them out.
 * - `props.ts` — the projectiles, the player's kit-bash and the flat shapes a telegraph uses.
 * - `materials.ts` — the three materials, and what the two per-instance attributes do to them.
 *
 * Outside the folder the public surface is what this file re-exports, and it is the same list
 * the single `meshes.ts` used to have: `instancing.ts`, `telegraphs.ts` and `renderer.ts` all
 * keep importing `./meshes`.
 */

export type { HordeMesh } from './primitives';
export { triangleCount } from './primitives';
export { hordeMesh } from './shapes';
export {
  arrowGeometry,
  discGeometry,
  ghostGeometry,
  grenadeGeometry,
  laserGeometry,
  orbGeometry,
  playerBody,
  playerTrim,
  quadGeometry,
  ringGeometry,
  shardGeometry,
  tracerGeometry,
  weaponKit,
} from './props';
export { accentMaterial, attachFx, glowMaterial, hordeBodyMaterial } from './materials';
