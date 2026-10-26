import { Scene } from 'three/webgpu';
import { createParticles } from '/work/src/render/particles.ts';
import { createEffects } from '/work/src/sim/fx.ts';
import { profileFor } from '/work/src/render/quality.ts';

const scene = new Scene();
const fx = createEffects();

// Fill a few particles of each kind.
for (let i = 0; i < 100; i++) {
  fx.kind[i] = i % 4;
  fx.life[i] = 0.2;
  fx.span[i] = 0.4;
  fx.size[i] = 0.2;
  fx.x[i] = i * 0.01;
  fx.y[i] = 0;
  fx.z[i] = 0.5;
}
fx.count = 100;

for (const mode of ['gpu', 'cpu'] as const) {
  try {
    const v = createParticles(scene, profileFor('high'), mode);
    v.sync(fx);
    let drawn = 0;
    scene.traverse((o: any) => {
      if (o.isInstancedMesh) drawn += o.count;
    });
    console.log(mode, 'cap', v.cap, 'drawn', drawn, 'mode', v.mode);
  } catch (e) {
    console.log(mode, 'THREW', (e as Error).message);
  }
}