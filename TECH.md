# TECH.md: Neon Horde (technical brief)

Every later task follows this file. The look is defined in DESIGN.md. Versions were checked on the npm registry on 2026-10-25. The sandbox runs Node **22.11.0**, so every build tool below was chosen to support `node >=22.0`. Install once with network access; after that, everything runs offline.

## Engine and runtime
- **three@0.186.1** (r186) and **@types/three@0.186.0**, imported from `three/webgpu` (WebGPURenderer, node materials, `RenderPipeline`) and `three/tsl` (shader nodes). Post-processing nodes come from `three/addons/tsl/display/*`: `bloom(node, strength, radius, threshold)` and `chromaticAberration(node, strength, center, scale)`, both confirmed in the r186 source.
- **Why three.js and not the alternatives:**
  - **Babylon.js** is also WebGPU-capable, but it is heavier and centred on its own scene graph and Havok physics. We do not want that physics: the TypeScript sim owns collisions.
  - **PlayCanvas** is editor-centric.
  - **Raw WebGPU** is ruled out by the owner.
  - three r186 gives us one renderer that runs WebGPU first and falls back to WebGL2 on its own. Its shaders are written once in TSL and compile to both WGSL and GLSL. It has `InstancedMesh`, compute through `renderer.compute()`, node post-processing, `GLTFLoader` and `PositionalAudio` if needed, and the largest ecosystem.
  - No physics engine, particle library or audio library is added. We own those: the sim, TSL/instanced particles, and a WebAudio synth.
- **Build:** **vite@6.4.5**. Vite 7 and 8 need Node ≥22.12, which the sandbox does not have.
- **Language:** **typescript@5.9.3** in strict mode, with **@types/node@22.20.5**. Typecheck with `tsc --noEmit`. (assumed: TS 5.9 over 7.x, which is the newer native port)
- **Tests:** **vitest@3.2.7** (Node ≥22) for unit tests. For browser scenarios, **@playwright/test@1.48.2** and **playwright@1.48.2**, pinned exactly; their Chromium is preinstalled at `/ms-playwright`. **tsx@4.23.15** runs the bench and replay scripts.
- **Fonts:** `@fontsource/chakra-petch@5.3.0` and `@fontsource/ibm-plex-mono@5.3.0`, imported in `main.ts`.
- **Scripts:** `dev`, `build`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:e2e` (`playwright test`) and `bench` (`tsx tools/bench.ts`).

## Render backend
- Rendering uses `new WebGPURenderer({ antialias: false, forceWebGL })`, followed by `await renderer.init()` before the first frame.
- Normally WebGPU is used. When `navigator.gpu` is missing, three uses its WebGL2 backend automatically. Force WebGL2 with the URL flag `?gl=webgl2` or a settings toggle, which sets `forceWebGL: true`.
- Report the active backend as `renderer.backend.isWebGPUBackend ? "webgpu" : "webgl2"` in `__forgeState().backend` and in the F3 overlay.
- If neither backend works, show an HTML "Your browser can't run this (needs WebGL2)" panel. Do not crash.
- **Compute:** GPU particles run in TSL `Fn().compute(n)` and are dispatched with `renderer.compute()`. This works on both backends: on WebGL2, three emulates compute through transform feedback. If compute fails, fall back to CPU-updated instanced particles. Gameplay must never depend on the GPU.
- **Post-processing:** `const rp = new RenderPipeline(renderer); rp.outputNode = …`, then call `rp.render()` every frame. (`PostProcessing` was renamed in r183.) The chain is `pass(scene, camera)` → bloom → chromatic aberration on big hits (a strength uniform) → ACES tone mapping → `renderOutput`.
- **Quality tiers** (Low, Med, High, Ultra) control:
  - shadow-map size and shadow on/off (one directional key light casts shadows; up to 16 pooled point lights for flashes and explosions, which do not cast shadows)
  - particle cap
  - bloom on/off
  - `renderer.setPixelRatio` resolution scale (0.5 to 1)
- **Auto-detect quality on first launch:** use the adapter info on WebGPU, `WEBGL_debug_renderer_info` on WebGL2, and Med when unsure. Low on SwiftShader.

## Simulation and rendering
- `src/sim/` is plain TypeScript with **no imports from `three`, the DOM or `window`**. Lint it with a vitest test that greps the imports.
- The loop runs a fixed **60 Hz** step:
  - The browser keeps an accumulator with `dt = 1/60`, at most 5 steps per frame.
  - The renderer interpolates between the previous and current positions, using `alpha = acc/dt`.
- The whole game state lives in one `World` object built from struct-of-arrays pools (`Float32Array` for x, y, vx, vy, hp; `Uint16Array` for type and state).
- The sim uses:
  - a fixed-cell spatial hash (cell size 2 world units, rebuilt every tick into preallocated arrays)
  - a seeded RNG (xoshiro128**) stored in the World
  - per-tick event ring buffers (hit, kill, spawn, sfx), which the renderer and audio *read* without ever writing to the sim
- **Determinism:** the same seed plus the same input log gives the same `hashWorld(world)` (FNV-1a over the pools).
- **Saves:** `serialize(world)` writes a JSON snapshot to localStorage `neonhorde.save.v1`. It autosaves every 30 s and at the end of each chapter. Settings and history are stored under `neonhorde.settings.v1` and `neonhorde.meta.v1`.
- **Replay file:** `{seed, chapter, inputs: Uint32 bitmask + aim per tick}`.
- **Pause** stops calling `step()`. The render loop keeps drawing a frozen frame.
- **Renderer (`src/render/`):**
  - one `InstancedMesh` per enemy archetype mesh; instance matrices and colours are written from the pools every frame
  - instanced projectiles
  - a GPU particle system
  - set dressing from vendored glTF (CC0 assets are listed in ASSETS.md)

## Input
- **Keyboard and mouse:**
  - move with WASD or the arrow keys
  - aim at the mouse position, projected onto the ground plane
  - fire with LMB (auto-fire is ON by default; the setting switches to click-to-fire)
  - dash with Space or Shift
  - swap weapons with Q or the mouse wheel (there is no separate slot-select key — the two hands
    are reached by swapping, and the number row belongs to the level-up cards)
  - reroll the level-up offer with R
  - pick a level-up card with 1, 2 or 3 (also by click or by gamepad A, X or Y)
  - pause with Esc or P
  - toggle the debug overlay with F3
- **Gamepad** (`navigator.getGamepads`, standard mapping only, dead zone 0.2): move with the left stick, aim with the right stick (fires while aimed), fire with the right trigger, dash with RB or A, swap weapons with LB or Y, pause with Start. With a level-up on screen the three face buttons are the three cards — A, X, Y — which is why the reader takes a `layout` per frame instead of carrying one button table. Three decisions worth keeping:
  - **Polled, not event-driven.** A held button reports "down" every frame, so `src/input/gamepad.ts` keeps the previous frame's pressed bits and reports edges. Dash and fire are read as *held* state (the sim wants them true every tick), swap, pause and a card as *one press each*.
  - **One dead zone, shared.** The 0.2 is `MOVE_DEAD` from `src/sim/input.ts` — the same cut the replay packer calls "centred" — and the reading is rescaled from zero past it, so clearing the zone does not jump to a quarter speed, a full push is still full speed, and a pad-driven run packs into a replay unchanged.
  - **Not in the bind map.** Pads are not remappable in the Controls tab: a stick is not a key under any mapping and the face buttons mean a different thing per screen. They get their own two tables in `gamepad.ts` while sharing the keyboard's action vocabulary (`heldFlagOf`, `pickSlotOf`), so a pad and a key that both mean `dash` are read as held the same way.
- **Keybinds** can be remapped in settings.
- **Input path:** `InputSampler` (DOM) → once per tick it fills a plain `InputFrame {moveX, moveY, aimX, aimY, fire, dash, swap, pick}` → `step(world, frame)`. Tests and replays build `InputFrame`s directly.

## State for checks
`window.__forgeState()` returns a fresh plain JSON object:
```
{ scene: "menu"|"playing"|"levelup"|"paused"|"summary"|"victory"|"levelselect"|"settings",
  backend: "webgpu"|"webgl2", tick, chapter, mode: "campaign"|"arena"|"bench",
  player: { x, y, hp, maxHp, shield, level, xp, dashReady, alive },
  wave: { index, timeLeft, bossAlive },
  score, kills, enemies: { count, byType: {chaser: n, …}, nearest: [{type,x,y,hp}] /*≤10*/ },
  weapons: [{ id, family, ammo, heat, reloading }], activeWeapon, powerups: [{id, tier}],
  levelUpChoices: [id…], fps, errors }
```
- `errors` counts `window.onerror` and `unhandledrejection` events plus sim assertion failures.
- `window.__forgeDebug` exposes `{ setSeed, spawn(type,n), grantXp(n), giveWeapon(id), bench(n) }` for scenarios.

## Performance
- **Busiest moment:** 1,000 enemies on High (2,000 in the bench stress test), 1,500 projectiles, 8,000 particles, 600 XP shards, 16 lights.
- **Frame budget:** hold 16.6 ms. The headless sim gate is **≤4 ms per step** (median over 600 ticks) with 1,000 enemies, measured in `npm run bench` with Node and a fail exit code if exceeded.
- **Pools with hard caps:** enemies 2,048, projectiles 2,048, enemy projectiles 512, shards 1,024, particles 16k (GPU), damage numbers 64, lights 16.
- **No per-tick allocations:** no closures, no `.map` or `.filter`, no new objects in `step()`.
- **Draw calls:** about 1 per archetype mesh plus props (target under 150).
- **Bench mode** (`?bench=1000` or `?bench=2000`) records frame times to JSON. The figures are reported, not gated.

## Code patterns
```
src/sim/      world.ts step.ts rng.ts spatialHash.ts pools.ts systems/(move,steer,weapons,projectiles,enemies,pickups,waves).ts serialize.ts replay.ts
src/content/  weapons.ts enemies.ts powerups.ts levels.ts  (data only, typed defs)
src/render/   renderer.ts instancing.ts particles.ts post.ts lights.ts assets.ts camera.ts
src/audio/    synth.ts songs.ts sfx.ts      src/ui/ hud.ts menus.ts (DOM overlay)
src/main.ts   tests/unit/*.test.ts  tests/e2e/*.spec.ts  tools/bench.ts  public/assets/
```
- **Content is data.** Weapon example:
  `{ id:"smg", family:"guns", fire:"projectile", rate:14, dmg:6, spread:0.12, speed:40, pierce:0, knockback:0.5, falloff:[8,20,0.5], ammo:{mag:40,reload:1.4}, mesh:"smg", sfx:"gunLight" }`
  - The `fire` kinds are `projectile`, `hitscan`, `beam`, `arc`, `melee`, `chain` and `orb`.
  - The optional fields are `heat`, `energy`, `aoe`, `dot`, `chain` and `homing`.
- Enemy example: `{ id:"charger", faction:"foundry", hp:60, speed:3, radius:0.6, armor:0, xp:3, ai:"charger", ai params:{windup:0.6, dashSpeed:14, cooldown:3}, mesh:"charger", accent:"#FF7A1A" }`.
  - `ai` selects one behaviour function in `systems/enemies.ts`.
  - Behaviours are small state machines whose telegraphs (wind-up, charge line) are emitted as events.
- Levels are data: `{ id, palette, obstacles:[…], hazards:[…], waves:[{t, pack:[["chaser",30],["shooter",4]], edge:"any"}], boss }`.
- **Adding content** means adding one entry to the relevant data file, plus a mesh or behaviour only if it is new. Each content type has a README recipe.

## Testing
- **Unit tests** (vitest, Node environment, no DOM) cover:
  - the RNG and spatial hash
  - every weapon kind (spread, pierce, falloff, reload, heat, chain count, DoT)
  - every AI behaviour (the charger telegraphs before it dashes; the splitter spawns children; the exploder deals AoE)
  - XP and level-up, power-up tiers capped at 5, and dash i-frames
  - save/load round-trip equality
  - same seed plus inputs gives the same hash
  - the import-purity check for the sim
- **The first e2e scenario** (Chromium 1.48.2, flags `--enable-unsafe-webgpu --use-angle=swiftshader --enable-unsafe-swiftshader`):
  1. Load `/?seed=1`, start chapter 1, and assert `scene==="playing"`.
  2. Hold D for 1 s and assert `player.x` increased.
  3. Wait (auto-fire is on) and assert `kills>0`.
  4. Call `grantXp` and assert `scene==="levelup"`. Press 1 and assert `powerups.length>0`.
  5. Press Esc and assert `scene==="paused"` and that `tick` stays frozen. Press Esc again and assert the game resumes.
  6. Assert `errors===0` throughout.
- **Second pass:** run the same scenario with `?gl=webgl2` and assert `backend==="webgl2"`.
- Separate scenarios cover save/reload/resume, death leading to the summary, and the bench (it writes `bench-results.json` and reports only).
