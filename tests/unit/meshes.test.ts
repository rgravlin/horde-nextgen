import { describe, expect, it } from 'vitest';

import { DynamicDrawUsage, InstancedBufferAttribute, type BufferGeometry } from 'three/webgpu';

import { ENEMIES } from '../../src/content/enemies';
import {
  accentMaterial,
  arrowGeometry,
  attachFx,
  discGeometry,
  ghostGeometry,
  glowMaterial,
  grenadeGeometry,
  hordeBodyMaterial,
  hordeMesh,
  laserGeometry,
  orbGeometry,
  playerBody,
  playerTrim,
  quadGeometry,
  ringGeometry,
  shardGeometry,
  tracerGeometry,
  triangleCount,
  weaponKit,
} from '../../src/render/meshes';

/**
 * The shapes are data, so this file's job is to notice when one moves.
 *
 * The costs below are what the recipes pay, read back off the builders, and they are what a
 * batch pays per draw: 1,000 bodies of a 206-triangle shape is 206,000 triangles. That is why
 * the folder documents a 40-to-300 budget instead of leaving each shape's cost to whoever
 * copied the last recipe. A change here is not automatically wrong — a boss is allowed to be
 * heavy, and a new archetype may reuse a shape it already has — but it is a decision, and
 * these tests want it made out loud rather than found as a frame-time regression.
 */

/** Triangle budget for one body, from the folder header (DESIGN.md "Horde"). */
const BODY_BUDGET = { min: 40, max: 300 };

/** [body, core] triangles per shape id. */
const SHAPE_COSTS: Record<string, readonly [number, number]> = {
  chaser: [96, 24],
  mote: [40, 16],
  lancer: [72, 24],
  blister: [104, 24],
  shell: [84, 16],
  plate: [104, 20],
  stalk: [194, 16],
  hopper: [100, 28],
  censer: [152, 24],
  sac: [178, 68],
  matron: [206, 70],
  atlas: [112, 32],
  sniper: [92, 16],
  orbiter: [158, 68],
};

/** Every mesh id the content tables actually spawn, in table order. */
function usedMeshIds(): string[] {
  return [...new Set(ENEMIES.map((def) => def.mesh))];
}

describe('hordeMesh', () => {
  it('has a cost entry for every mesh id the enemies use', () => {
    const ids = usedMeshIds();
    // Guards against the reader quietly returning nothing and the loop below checking nobody.
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(SHAPE_COSTS[id], id).toBeDefined();
  });

  it('builds a body and a core for every mesh id, inside the triangle budget', () => {
    for (const id of usedMeshIds()) {
      const shape = hordeMesh(id);
      const body = triangleCount(shape.body);
      const core = triangleCount(shape.core);

      // A zero would mean the recipe merged to nothing: the batch would draw an empty buffer
      // and the archetype would be invisible rather than broken-looking.
      expect(core, `${id}: empty core`).toBeGreaterThan(0);
      expect(body, `${id}: body under the readable-silhouette floor`).toBeGreaterThanOrEqual(
        BODY_BUDGET.min
      );
      expect(body, `${id}: body over the 300-triangle budget`).toBeLessThanOrEqual(BODY_BUDGET.max);
    }
  });

  it('keeps each shape at the cost the recipes were measured at', () => {
    for (const [id, [body, core]] of Object.entries(SHAPE_COSTS)) {
      const shape = hordeMesh(id);
      expect([triangleCount(shape.body), triangleCount(shape.core)], `${id}`).toEqual([body, core]);
    }
  });

  it('caches one geometry per shape, however many callers want one', () => {
    // Two archetypes draw 'mote' (a swarmling cloud and what a splitter leaves behind) and a
    // restart rebuilds every batch, so one shape is asked for many times: the cache is what
    // keeps that one geometry in GPU memory instead of one per batch per restart.
    for (const id of usedMeshIds()) expect(hordeMesh(id), id).toBe(hordeMesh(id));
  });

  it('gives an unknown id the chaser instead of nothing', () => {
    expect(hordeMesh('no-such-shape')).toBe(hordeMesh('chaser'));
    // The fallback goes through the same cache key, so a typo cannot rebuild a shape per spawn.
    expect(hordeMesh('still-no-shape')).toBe(hordeMesh('chaser'));
  });
});

describe('props', () => {
  /** What each prop costs a draw, and one line on why that is its shape. */
  const PROPS: ReadonlyArray<[string, BufferGeometry, number]> = [
    ['tracer', tracerGeometry(), 20],
    ['arrow', arrowGeometry(), 26],
    ['orb', orbGeometry(), 80],
    ['grenade', grenadeGeometry(), 30],
    ['shard', shardGeometry(), 8],
    ['player body', playerBody(), 216],
    ['player trim', playerTrim(), 38],
    ['gun kit', weaponKit().guns, 48],
    ['medieval kit', weaponKit().medieval, 120],
    ['alien kit', weaponKit().alien, 108],
    ['charge quad', quadGeometry(), 2],
    ['disc', discGeometry(), 20],
    ['ring', ringGeometry(), 120],
    ['laser', laserGeometry(), 16],
    ['dash ghost', ghostGeometry(), 84],
  ];

  it('keeps the projectiles, the kit and the telegraph shapes at their measured cost', () => {
    for (const [name, geometry, count] of PROPS) {
      expect(triangleCount(geometry), `${name}: triangles`).toBe(count);
    }
  });

  it('hands a fresh prop to every caller and keeps the horde shapes shared', () => {
    // The two halves differ on purpose: a horde shape is drawn by a whole archetype's worth of
    // bodies, so it is cached and then cloned per batch (`instancing.ts`), because a
    // per-instance attribute belongs to one instance stream. A prop is one batch, so its
    // builder just builds. The assertion is here to make caching these a decision with a test
    // attached rather than a quiet edit.
    expect(tracerGeometry()).not.toBe(tracerGeometry());
    expect(weaponKit().guns).not.toBe(weaponKit().guns);
    expect(hordeMesh('chaser')).toBe(hordeMesh('chaser'));
  });

  it('gives one kit shape per weapon family', () => {
    // `renderer.ts` builds three gun meshes out of this record and shows the one matching the
    // weapon the player is holding, so the keys are the lookup and not a detail.
    expect(Object.keys(weaponKit()).sort()).toEqual(['alien', 'guns', 'medieval']);
  });

  it('keeps the ring and disc segments settable', () => {
    // The low quality tier drops a telegraph to fewer segments; the builders take the count so
    // it can, and a hardcoded 20 would make that knob a lie.
    expect(triangleCount(discGeometry(6))).toBe(6);
    expect(triangleCount(ringGeometry(6))).toBe(36);
  });
});

describe('the two per-instance attributes', () => {
  it('gives the body material a flash and a dissolve', () => {
    const material = hordeBodyMaterial(0x334155);
    expect(material.alphaTest).toBe(0.5);
    expect(material.opacityNode).not.toBeNull();
    expect(material.colorNode).not.toBeNull();
  });

  it('gives the accents the dissolve only', () => {
    // They are already at full brightness, so a flash would buy one more buffer to upload.
    const accent = accentMaterial(0xff2d95);
    expect(accent.alphaTest).toBe(0.5);
    expect(accent.opacityNode).not.toBeNull();
    expect(accent.colorNode).toBeNull();

    // And the plain glow carries neither: a round is not a body that can be hit, and a
    // material that reads `aDie` needs every batch using it to supply the attribute.
    const glow = glowMaterial(0xff7a1a, 2.6);
    expect(glow.alphaTest).toBe(0);
    expect(glow.opacityNode).toBeNull();
  });

  it('writes both buffers onto a geometry, and only the dissolve when there is no flash', () => {
    const cap = 4;
    const withBoth = quadGeometry();
    attachFx(withBoth, new Float32Array(cap), new Float32Array(cap));
    for (const name of ['aDie', 'aHit']) {
      const written = withBoth.getAttribute(name);
      // An *instanced* attribute: a plain BufferAttribute would hand every instance the same
      // number, and a whole pack would flash and dissolve as one blob.
      expect(written, name).toBeInstanceOf(InstancedBufferAttribute);
      const attribute = written as InstancedBufferAttribute;
      expect(attribute.itemSize).toBe(1);
      expect(attribute.count).toBe(cap);
      expect(attribute.usage).toBe(DynamicDrawUsage);
    }

    const core = quadGeometry();
    attachFx(core, null, new Float32Array(cap));
    expect(core.getAttribute('aDie')).toBeDefined();
    expect(core.getAttribute('aHit')).toBeUndefined();
  });
});