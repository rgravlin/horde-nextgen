import { Scene } from 'three/webgpu';
import { createParticles } from '/work/src/render/particles.ts';
import { createEffects } from '/work/src/sim/fx.ts';
import { profileFor } from '/work/src/render/quality.ts';

function field(n: number) {
  const fx = createEffects();
  for (let i = 0; i < n; i++) {
    fx.kind[i] = i % 4;
    fx.life[i] = 0.2;
    fx.span[i] = 0.4;
    fx.size[i] = 0.2;
    fx.x[i] = i * 0.01;
    fx.y[i] = 0;
    fx.z[i] = 0.5;
  }
  fx.count = n;
  return fx;
}

for (const mode of ['gpu', 'cpu'] as const) {
  for (const [label, n, tier] of [
    ['100 particles, high', 100, 'high'],
    ['8192 particles, low (cap 512/palette)', 8192, 'low'],
  ] as const) {
    const scene = new Scene();
    const v = createParticles(scene, profileFor(tier as any), mode);
    v.sync(field(n));
    let drawn = 0;
    const geoms = new Set<unknown>();
    const bufs = new Set<unknown>();
    scene.traverse((o: any) => {
      if (!o.isInstancedMesh) return;
      drawn += o.count;
      geoms.add(o.geometry);
      const a = o.geometry.getAttribute('aPart');
      if (a) bufs.add(a.array);
    });
    console.log(mode, '|', label, '| drawn', drawn, '| geometries', geoms.size, '| record buffers', bufs.size);
  }
}
