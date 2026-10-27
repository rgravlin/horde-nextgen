/**
 * The kit: everything drawn out of one World's pools.
 *
 * The horde, the rounds, the shards, the hazard discs, the cover and the warning shapes are
 * built together here because they share one lifetime. A restart builds a new World with new
 * pools, so the layers have to be rebuilt against it — and the old set has to leave the scene
 * and give its buffers back, because a run restarted twenty times should not pay for twenty
 * arenas. That pair of facts is why this file exists rather than six calls scattered through
 * `renderer.ts`: build and dispose are one decision, and only one of them has an obvious place
 * to live.
 *
 * Order inside the kit is load-bearing and lives here for that reason: cover before the horde so
 * the crowd reads against it, and the two flat layers (hazard discs, telegraphs) last, because a
 * warning drawn under a body is a warning nobody sees.
 *
 * Everything in here reads the pools and writes geometry. It never writes a game value back
 * (ARCHITECTURE.md "Data flow").
 */

import { Group, type Scene } from 'three/webgpu';

import type { World } from '../sim/world';

import { createPropView, type Assets, type PropView } from './assets';
import { createBatches, type Batches } from './instancing';
import { createParticles, type ParticleMode, type ParticleView } from './particles';
import type { Quality, TierProfile } from './quality';
import { createSceneryView, type SceneryView } from './scenery';
import { createTelegraphView, type TelegraphView } from './telegraphs';

/** One World's draw layers, plus the two numbers that say what it has already been shown. */
export interface Kit {
  /** The World these layers read; changing it is what a restart looks like from here. */
  readonly world: World;
  /** What they were added to, so the whole set can leave in one move. */
  readonly group: Group;
  readonly props: PropView;
  readonly hazards: SceneryView;
  readonly batches: Batches;
  readonly telegraphs: TelegraphView;
  /** Null when the budget is nil, which is a setting rather than a tier. */
  readonly particles: ParticleView | null;
  /** The tick the last frame drew, which is how a held frame is spotted. */
  lastTick: number;
}

/**
 * Build one World's layers under `parent`.
 *
 * `particleMode` comes from the caller because it is a backend fact, not a per-World one: the
 * instance-record path needs the compute-capable backend (TECH.md "Compute"), and WebGL2 does not
 * have one, so the fallback there is not a fallback at all but the only path.
 */
export function buildKit(
  parent: Scene,
  assets: Assets,
  quality: Quality,
  profile: TierProfile,
  particleMode: ParticleMode,
  world: World,
): Kit {
  const group = new Group();
  parent.add(group);
  return {
    world,
    // Cover before the horde so the crowd reads against it, and the two flat layers last: a
    // warning drawn under a body is a warning nobody sees.
    props: createPropView(group, assets, quality),
    hazards: createSceneryView(group, world),
    batches: createBatches(group, world, quality),
    telegraphs: createTelegraphView(group),
    // A nil budget leaves the field unbuilt rather than built empty: four batches of zero
    // instances are four buffers and four draw calls paid for nothing.
    particles: profile.particles > 0 ? createParticles(group, profile, particleMode) : null,
    group,
    lastTick: -1,
  };
}

/**
 * Take a kit out of the scene and hand its buffers back.
 *
 * The traverse is the whole point: a kit holds dozens of geometries and materials, and disposing
 * only the group would leak one arena's worth of VRAM per restart. Materials can be arrays — a
 * batch with a shared look may hold two — so both shapes are handled rather than assumed.
 */
export function disposeKit(parent: Scene, kit: Kit): void {
  parent.remove(kit.group);
  kit.group.traverse((o) => {
    const holder = o as unknown as {
      geometry?: { dispose(): void };
      material?: { dispose(): void } | Array<{ dispose(): void }>;
    };
    holder.geometry?.dispose();
    const material = holder.material;
    if (Array.isArray(material)) for (const one of material) one.dispose();
    else material?.dispose();
  });
}

/**
 * Repack every layer from this World's pools.
 *
 * `alpha` is the interpolation point inside the last fixed step, so the whole crowd lands between
 * the last two ticks instead of one frame behind them (TECH.md "Simulation and rendering"). `dt`
 * is the real seconds since the previous frame and only drives the two layers that animate
 * themselves; the ones that repack from pools ignore it.
 */
export function syncKit(kit: Kit, world: World, alpha: number, dt: number): void {
  kit.props.sync(world);
  kit.hazards.sync(world);
  kit.batches.sync(world, alpha, dt);
  kit.telegraphs.sync(world, dt);
  kit.particles?.sync(world.fx);
}
