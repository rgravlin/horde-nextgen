# Vendored docs

Saved by `forge-fetch docs` for offline reading. Check each site's terms before publishing these files.

| file | source | fetched |
|---|---|---|
| docs/vendor/threejs.org/docs/llms.txt | https://threejs.org/docs/llms.txt | 2026-10-25 |
| docs/vendor/threejs.org/manual.md | https://threejs.org/manual/#installation | 2026-10-25 |
| docs/vendor/threejs.org/tsl.md | https://threejs.org/tsl/ | 2026-10-25 |
| docs/vendor/threejs.org/docs.md | https://threejs.org/docs/#TSL | 2026-10-25 |
| docs/vendor/raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/webgpu/WebGPURenderer.js.md | https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/webgpu/WebGPURenderer.js | 2026-10-25 |
| docs/vendor/raw.githubusercontent.com/mrdoob/three.js/r186/examples/jsm/tsl/display/BloomNode.js.md | https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/jsm/tsl/display/BloomNode.js | 2026-10-25 |
| docs/vendor/raw.githubusercontent.com/mrdoob/three.js/r186/examples/jsm/tsl/display/ChromaticAberrationNode.js.md | https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/jsm/tsl/display/ChromaticAberrationNode.js | 2026-10-25 |
| docs/vendor/raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/common/RenderPipeline.js.md | https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/common/RenderPipeline.js | 2026-10-25 |
| docs/vendor/raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/common/PostProcessing.js.md | https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/common/PostProcessing.js | 2026-10-25 |
| docs/vendor/raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgpu_compute_particles.md | https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgpu_compute_particles.html | 2026-10-25 |
| docs/vendor/raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgpu_instance_mesh.md | https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgpu_instance_mesh.html | 2026-10-25 |

## Key three.js r186 API names (verified against the files above)

Grep a name here with `grep -rn <name> docs/vendor` to find its full source offline. The import paths below are
copied exactly as written in the r186 sources, so the render code can follow them verbatim.

- **WebGPURenderer({ forceWebGL })** — `new WebGPURenderer({ antialias, forceWebGL })`; `forceWebGL: true` forces the
  WebGL2 backend regardless of WebGPU support (WebGPURenderer.js:41,57). Import from `three/webgpu`.
- **renderer.init()** — `await renderer.init()` before the first frame; `renderAsync()` is deprecated in favour of
  `render()` + `await init()` (llms.txt:54; RenderPipeline.js:253).
- **RenderPipeline** — `const rp = new RenderPipeline( renderer ); rp.outputNode = …; rp.render()`. Renamed from
  `PostProcessing` in r183; `PostProcessing.js` is now a deprecated shim that just `extends RenderPipeline`.
- **pass()** / **renderOutput()** — `pass( scene, camera )` → `scenePass.getTextureNode( 'output' )`; final output
  via `renderOutput( node, toneMapping, colorSpace )`. Both from `three/tsl` (RenderPipeline.js:15,70; BloomNode.md).
- **bloom()** — `bloom( node, strength, radius, threshold )` from `three/addons/tsl/display/BloomNode.js`
  (export at BloomNode.js:597; threshold ~1.0 so only emissives bloom).
- **chromaticAberration()** — `chromaticAberration( node, strength = 1.0, center = null, scale = 1.1 )` from
  `three/addons/tsl/display/ChromaticAberrationNode.js` (export at ChromaticAberrationNode.js:163).
- **Fn().compute(n)** — compute shaders as `Fn( () => { … } )().compute( count ).setName( '…' )`, dispatched with
  **renderer.compute()**: `renderer.compute( computeFn )` (webgpu_compute_particles.md:98,128,172,190,278).
- **instancedArray / storage** — `instancedArray( count, 'vec3' )` + `instanceIndex` + `.element( instanceIndex )`
  for GPU particle buffers (webgpu_compute_particles.md:39,74-76,86); import from `three/tsl`. The docs index lists
  the storage surface: `storage`, `storageBarrier`, `storageElement`, `storageTexture`, `instanceIndex` (docs.md).
- **Tone mapping** — `acesFilmicToneMapping` / `agxToneMapping` (and `ToneMappingNode`, `RenderOutputNode`) present
  in docs.md; DESIGN/TECH call for ACES or AgX.
- **InstancedMesh** — per-archetype instancing; the draw pattern is in webgpu_instance_mesh.md:75 and the API entry
  in docs.md:390/1165.
