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
- **Tests:** **vitest@3.2.7** (Node ≥22) for unit tests. For browser scenarios, **@playwright/test@1.48.2** and **playwright@1.48.2**, pinned exactly; their Chromium is preinstalled at `/ms-playwright`. **tsx@4.23.15** runs `tools/bench.ts` (the only thing under `tools/`); the replay recorder and player are a sim module (`src/sim/replay.ts`) driven by `tests/unit/serialize.test.ts`, not a command.
- **Fonts:** `@fontsource/chakra-petch@5.3.0` and `@fontsource/ibm-plex-mono@5.3.0`, imported in `main.ts`.
- **Scripts:** `dev`, `build`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:e2e` (`playwright test`) and `bench` (`tsx tools/bench.ts`).

## Render backend
- Rendering uses `new WebGPURenderer({ antialias: false, forceWebGL })`, followed by `await renderer.init()` before the first frame.
- Normally WebGPU is used. When `navigator.gpu` is missing, three uses its WebGL2 backend automatically. Force WebGL2 with the URL flag `?gl=webgl2`, read by `readParams` in `src/main.ts` — the only way in, and a reload rather than a toggle: the Settings panel's Video tab offers quality, resolution, shadows, bloom and particles, not the backend.
- Report the active backend as `renderer.backend.isWebGPUBackend ? "webgpu" : "webgl2"` in `__forgeState().backend` (`"none"` when neither came up). There is no debug overlay: `__forgeState()` and `__forgeDebug` are the instruments, and README's "Graphics" section is where the tiers are written out.
- If neither backend works, show an HTML "Your browser can't run this (needs WebGL2)" panel. Do not crash; the simulation keeps running with no view.
- **Compute:** GPU particles run in TSL `Fn().compute(n)` and are dispatched with `renderer.compute()` — on the compute-capable backend only. `particleMode` in `src/render/renderer.ts` takes `gpu` on WebGPU and the CPU-updated instanced field on WebGL2, where a storage-backed instance attribute has no equivalent; three *could* emulate compute there through transform feedback, and this project does not spend a second picture on it. Gameplay must never depend on the GPU: both paths read the same field and drop particles at the same place, so the GPU path is a cosmetic upgrade, not a different game.
- **Post-processing:** `const rp = new RenderPipeline(renderer); rp.outputNode = …`, then call `rp.render()` every frame. (`PostProcessing` was renamed in r183.) The chain is `pass(scene, camera)` → bloom → chromatic aberration on big hits (a strength uniform) → ACES tone mapping → `renderOutput`.
- **Quality tiers** (Low, Medium, High, Ultra) are one table, `PROFILES` in `src/render/quality.ts` — a file with no imports at all, so `tests/unit/quality.test.ts` pins the tiers in plain Node. A tier sets:
  - shadow-map size and shadow on/off: 0 / 1024 / 2048 / 4096 px (one directional key light casts shadows; the pooled point lights for flashes and explosions never do — 0 / 8 / 16 / 16 of them)
  - the particle budget each of the four palette batches may draw: 512 / 1,024 / 2,048 / 4,096
  - bloom on/off, with the chromatic punch riding on the same pass
  - `pixelScale`, multiplied with the settings' own 0.5–1 scale into `renderer.setPixelRatio` and capped at 1
  Player settings only subtract from a tier (`QualityOverrides`): the tier is the ceiling, so `shadows: true` under Low buys nothing. README's "Graphics" section carries the numbers.
- **Auto-detect quality on first launch** (`pickTier`): a tier named in Settings wins outright; a software rasteriser (SwiftShader, llvmpipe, "Basic Render") is Low; the starting point is High for WebGPU on a named adapter and Medium for everything else; a handheld never starts above Medium; ≤4 GiB is Low and ≤8 GiB caps at Medium. Ultra is unreachable by auto-detect — it needs WebGPU, a named adapter, a desktop and ≥16 GiB. The GPU name comes from the adapter description on WebGPU and `WEBGL_debug_renderer_info` on WebGL2.

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
- **Replay file:** `{seed, chapter, autoFire, ticks, inputs: Uint32 bitmask + aim pair + aim distance per tick}`.
  The 32-bit word is full, so the two analogue aim numbers ride beside it at full precision: the pair is quantised
  by the packer and the distance has no bits to live in, and both decide where a shot goes.
- **Pause** stops calling `step()`. The render loop keeps drawing a frozen frame.
- **Renderer (`src/render/`):**
  - one instanced pair per enemy archetype — a body batch and an accent-core batch — drawing a
    shape from `meshes/` that other archetypes may share; instance matrices and colours are
    written from the pools every frame
  - instanced projectiles
  - a GPU particle system
  - set dressing from vendored glTF, four kit modules repeated across the cover (CC0 assets and
    their licences are listed in ASSETS.md; how to add one is in README "Adding a model")

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
  - start / confirm / take the highlighted card with Enter
- **Binds are physical `code`s, not characters** (`KeyboardEvent.code`, plus `'Mouse0'`/`'Mouse1'`), listed once in `src/input/bindings.ts` and read by both the sampler and the Controls tab, so AZERTY and Caps Lock work and a remap takes effect on the next key press.
- **Gamepad** (`navigator.getGamepads`, standard mapping only, dead zone 0.2): move with the left stick, aim with the right stick (fires while aimed), fire with the right trigger, dash with RB or A, swap weapons with LB or Y, pause with Start. With a level-up on screen the three face buttons are the three cards — A, X, Y — which is why the reader takes a `layout` per frame instead of carrying one button table. Three decisions worth keeping:
  - **Polled, not event-driven.** A held button reports "down" every frame, so `src/input/gamepad.ts` keeps the previous frame's pressed bits and reports edges. Dash and fire are read as *held* state (the sim wants them true every tick), swap, pause and a card as *one press each*.
  - **One dead zone, shared.** The 0.2 is `MOVE_DEAD` from `src/sim/input.ts` — the same cut the replay packer calls "centred" — and the reading is rescaled from zero past it, so clearing the zone does not jump to a quarter speed, a full push is still full speed, and a pad-driven run packs into a replay unchanged.
  - **Not in the bind map.** Pads are not remappable in the Controls tab: a stick is not a key under any mapping and the face buttons mean a different thing per screen. They get their own two tables in `gamepad.ts` while sharing the keyboard's action vocabulary (`heldFlagOf`, `pickSlotOf`), so a pad and a key that both mean `dash` are read as held the same way.
- **Keybinds** can be remapped in settings.
- **Input path:** `InputSampler` (DOM) → once per tick it fills a plain `InputFrame {moveX, moveY, aimX, aimY, aimDist, fire, dash, swap, pick}` → `step(world, frame)`. Tests and replays build `InputFrame`s directly.
- **Aim is a point, not only a line.** `aimX`/`aimY` say which way and `aimDist` says how far (metres from the player to the ground point under the cursor; 0 when the device only steers a line). The two kinds whose damage resolves where they land — `arc` and `orb` — read the distance and put the burst there; a round that travels needs only the line. Without it a shell always flew to the top of its range, which against a horde trailing a retreating player means it burst on empty floor: measured on a pack 6–12 m out with the trigger held, the catapult, the singularity gun and the disruptor orb all did essentially nothing. Auto-fire does not use it (it leads the nearest body, which is the point of the setting), and a hand-built frame that leaves it at 0 keeps the old full-range throw.

## State for checks
`window.__forgeState()` returns a fresh plain JSON object. The type of record is `ForgeState` in `src/game/appTypes.ts` — the sketch below summarizes it, and that interface is what the code and the scenarios read:
```
{ scene: "menu"|"playing"|"levelup"|"paused"|"summary"|"victory"|"levelselect"|"settings"|"history",
  backend: "webgpu"|"webgl2"|"none", tick, chapter, mode: "campaign"|"arena"|"bench",
  player: { x, y, hp, maxHp, shield, level, xp, dashReady, alive },
  wave: { index, timeLeft, bossAlive },
  boss: { alive, name, hp, maxHp }  // combined across the encounter's bodies
  chapterComplete, victory,
  score, kills, enemies: { count, byType: {chaser: n, …}, nearest: [{type,x,y,hp}] /*≤10*/ },
  weapons: [{ id, family, ammo, heat, energy, venting, reloading }], activeWeapon,
  powerups: [{id, tier}], levelUpChoices: [id…], fps, errors,
  settings: { quality, particles, damageNumbers, autoFire, shake, binds } }
```
- `errors` counts `window.onerror` and `unhandledrejection` events plus sim assertion failures.
- `settings` is how a scenario proves a dial was *stored* rather than merely applied: move it, reload, read it back. A malformed payload in any of the three localStorage keys is dropped and counted in `errors`, never applied.
- `window.__forgeDebug` exposes `{ setSeed, spawn(type,n), grantXp(n), giveWeapon(id), bench(n, {seconds, chapter}), arena() }` for scenarios.

## Performance
- **Busiest moment:** 1,000 enemies, 1,500 projectiles, 8,000 particles, 600 XP shards and 16
  lights, held for the whole window — the same pile in the headless bench and in `?bench=`, and
  `npm run bench -- --enemies=2000` raises the headless one when a change needs a harder load
  than the default.
- **Frame budget:** hold 16.6 ms. The headless sim gate is **≤4 ms per step** (median over 600 ticks) with 1,000 enemies, measured in `npm run bench` with Node and a fail exit code if exceeded. It installs a floor under the load by default — chapter 10, the densest room in the game — because cover is what makes a horde expensive; `--floor=0` drops it to the teaching bay and `--floor=none` to open arena. Flags are `--ticks`, `--budget`, `--floor`, `--enemies`, `--shots`, `--particles`, `--out`, and README's "Commands" is where they are written out.
- **Pools with hard caps:** enemies 2,048, projectiles 2,048, enemy projectiles 512, shards 1,024
  (`src/sim/constants.ts`), particles 8,192 in the stepped ring (`src/sim/fx.ts`), drawn as four
  palette batches of the tier's budget each — 512/1,024/2,048/4,096 — plus 128 damage numbers and
  0/8/16/16 pooled lamps by tier (`src/render/quality.ts`).
- **No per-tick allocations:** no closures, no `.map` or `.filter`, no new objects in `step()`.
- **Draw calls:** about 1 per archetype mesh plus props (target under 150).
- **Bench mode** (`?bench=1000`, or `__forgeDebug.bench(n, {seconds, chapter, ...})`) runs a *held* load — the counts above topped back up every frame, an invulnerable player, the first second discarded — and times each frame twice: its end-to-end period and the code's own share of it, from a clock read inside the frame rather than from gaps between `requestAnimationFrame` stamps. Results go to `window.__benchResults` and to `test-results/bench-results.json`. Reported, not gated; `&seconds=` shortens the window and `&chapter=` picks the floor (1-based).

## Code patterns
```
src/sim/      world.ts(+ pools.ts constants.ts events.ts, all re-exported through world.ts) step.ts rng.ts spatialHash.ts hash.ts fx.ts input.ts replay.ts serialize/(index,blobs,pools,record) systems/(weapons,status,enemyProjectiles,pickups,powerups,waves,boss,drone,obstacles,levels).ts systems/projectiles/(index,shared,ray,melee,flyers).ts systems/enemies/(index,shared,spawn,update,behaviours,seekers,rushers,standoff,support,marksmen,burrowers,phaser,nursery,bosses,contact,deaths).ts  (player movement and steering are in `step.ts`, not a system file; the pool caps and the tuning live in `constants.ts` as one `TUNE`)
src/content/  weapons.ts enemies.ts enemiesA.ts powerups.ts levels/(index,types,elites,builders,factions,chapters-1-3,chapters-4-6,chapters-7-10,arena).ts  (data only, typed defs; `index.ts` joins the three chapter files into `LEVELS`; `arena.ts` is the endless mode's one floor and its escalation ladder, deliberately not a row in that table)
src/render/   renderer.ts (the camera rig lives here) instancing.ts meshes/(index,primitives,shapes,shapesC,props,materials) particles.ts fxView.ts post.ts lights.ts scenery.ts telegraphs.ts damageNumbers.ts shake.ts quality.ts assets.ts
src/audio/    synth.ts (the devices: oscillators, noise, one duck bus) sequencer.ts (the music clock: song data in, "which note sounds when" out) songs.ts sfx.ts
src/input/    bindings.ts (the one bind table, and the default map) sampler.ts (the only place DOM devices are read) gamepad.ts (polled standard pads)
src/game/     app.ts (the scene machine) appState.ts + appTypes.ts (`__forgeState()` and the `ForgeState` shape it promises) appDebug.ts (`__forgeDebug`) appArchive.ts (when a save lands: autosave clock, meta rows, the Continue flag) bench.ts (the load both benches share) loop.ts (the fixed-step accumulator) persistence/(index,keys,envelope,settings,meta,autosave,runArchive)
src/ui/       hud/(index,paint,markers,hands) menus/(index,rows,listen) radar.ts levelup.ts styles.css (DOM overlay)
src/main.ts   tests/unit/*.test.ts  tests/e2e/*.spec.ts  tools/bench.ts  public/(models,textures,hdri)/
```
- Nothing in `input`, `game`, `render`, `audio` or `ui` may decide an outcome: those layers move the `World`, draw it and read it. `loop.ts`, `sequencer.ts` and `quality.ts` are separate files because they are the parts with invariants a plain-Node test can pin.
- **Content is data.** Weapon example (the real SMG row, comments dropped):
  `{ id:"smg", family:"guns", fire:"projectile", rate:15, dmg:11, spread:0.06, speed:52, range:19, pierce:1, knockback:1.2, falloff:[10,19,0.55], ammo:{mag:40,reload:1.6}, mesh:"smg", sfx:"gunLight" }`
  - The `fire` kinds are `projectile`, `hitscan`, `beam`, `arc`, `melee`, `chain` and `orb`.
  - The optional fields are `heat`, `energy`, `aoe`, `dot`, `chain` and `homing`. A weapon declares exactly one thing a trigger pull spends — `ammo`, `heat` or `energy`.
  - A weapon's `mesh` is a label: nothing reads it. What a gun looks like comes from `family` (`weaponKit` in `render/meshes/props.ts`, batched by `FAMILY_BATCH` in `render/instancing.ts`), so a new gun needs no mesh work; `sfx` must name a `RECIPES` key in `src/audio/sfx.ts` or it quietly falls back to the light-gun click.
- Enemy example (the real charger row): `{ id:"charger", faction:"swarm", mesh:"lancer", hp:46, speed:3.1, radius:0.5, armor:1, xp:4, ai:"charger", params:{sepRadius:1.2, sepPush:1.8, touchRange:0.3, touchDamage:9, faceLag:10, armRange:9, nearRange:2.5, windup:0.5, dashTime:0.5, dashSpeed:13, recover:0.4, stalk:0.6}, accent:"#FF2E97" }`.
  - `ai` selects one behaviour function under `systems/enemies/` (one module per movement
    family; the dispatch table that has to cover every id is `systems/enemies/behaviours.ts`).
  - `params` is the behaviour's own namespace — keys are documented where the behaviour reads them.
  - Unlike a weapon's, an enemy's `mesh` *is* a lookup: `hordeMesh(def.mesh)` in `render/instancing.ts`, falling back to the chaser's shape. Shapes are one per silhouette and shared; `fit` scales one down. The three keyed by archetype instead (`teleporter`, `burrower`, `spawner`, in `meshes/shapesC.ts`) are shapes whose job is to carry a behaviour.
  - Behaviours are small state machines whose telegraphs (wind-up, charge line) are emitted as events.
- Levels are data (`LevelDef` in `src/content/levels/types.ts`), and a chapter is a floor plan, a wave script and an elite roster — the three things the sim can actually tell apart:
  `{ id:"loading-bay", name:"Loading Bay", packs:PACKS, waves:[beat(12,"any",["swarmling",12]), beat(20,"any",["splitter",5]), …], duration:78, difficulty:{spawnRate:1,hp:1}, elites:[], eliteChance:0, bosses:["broodmother"], size:60, palette:DOCKS, props:[crate(18,-14), wall(-14,-18,10,2), pillar(-9,12,1.5)], hazards:[acid(24,12,3,10)] }`
  - `packs` is the drumbeat recipe (walked in order, the last row carrying on past the end of the list) and `waves` the timed set pieces that run beside it; both are read by `systems/waves.ts`. `props` are cover boxes installed by `systems/obstacles.ts` — anything thinner than 1.2 m through the middle is refused at load, so a dash cannot cross a wall in one tick.
  - Elites are scale factors on an archetype, never archetypes: `byType` counts stay per archetype, which is what the scenarios assert on.
- **Adding content** means adding one entry to the relevant data file, plus a mesh or behaviour only if it is new. Each content type has a README recipe.

## Testing
`docs/architecture/tests.md` is the per-file inventory — what each test file and tool pins, including the mutation each guard would catch. This section is the shape of it, not the list.
- **Unit tests** (`npm test` → `vitest run`, `tests/unit/**`, `environment: "node"`, no DOM — a file that needs a canvas is in the wrong folder) cover:
  - the RNG, spatial hash, pools and the deterministic step (`simcore.test.ts`), and the import-purity rule (`purity.test.ts`)
  - every weapon kind (spread, pierce, falloff, reload, heat, chain count, DoT) across `weapons-a/b/c.test.ts`
  - every AI behaviour, five-to-six archetypes per file (`enemies-a` … `enemies-e`), plus `enemies-split.test.ts`, which fails if the dispatch table stops covering an id or a whole-run fingerprint moves
  - XP and level-up, power-up tiers capped at 5, dash i-frames
  - the chapter arc, its cover and its wave script (`levels*.test.ts`, `obstacles.test.ts`, `waves.test.ts`), and the Endless Arena's escalation ladder (`arena.test.ts`)
  - save/load round-trip equality, the storage layer against a `Map` fake and one that throws (`persistence.test.ts`), and *when* saves land (`app-save.test.ts`, driven with no renderer and no DOM)
  - same seed plus inputs gives the same hash
  - the quality tiers, the fixed-step loop, the sampler and the gamepad reader (`quality`, `loop`, `sampler`, `gamepad`), each a plain-Node test because none of them needs a device
- **E2E** (`npm run test:e2e` → `playwright test`, `tests/e2e/**`) runs Chromium 1.48.2 from `/ms-playwright` with flags `--enable-unsafe-webgpu --use-angle=swiftshader --enable-unsafe-swiftshader`, against a Vite server on port 5173 that the config starts — and reuses if one is already up, so `npm run dev` in another terminal is not in the way. `playwright.config.ts` is `workers: 1`, `fullyParallel: false`: the specs drive a live 60 Hz run and a shared software rasteriser, so a second worker makes the timings a lie.
- **The first scenario** (`slice.spec.ts`):
  1. Load `/?seed=1`, start chapter 1, and assert `scene==="playing"`.
  2. Hold D for 1 s and assert `player.x` increased.
  3. Wait (auto-fire is on) and assert `kills>0`.
  4. Call `grantXp` and assert `scene==="levelup"`. Press 1 and assert `powerups.length>0`.
  5. Press Esc and assert `scene==="paused"` and that `tick` stays frozen. Press Esc again and assert the game resumes.
  6. Assert `errors===0` throughout.
- **Second pass, same file:** the whole slice again under `?gl=webgl2`, asserting `backend==="webgl2"` — the WebGL2 path is a supported target, not a degraded screenshot.
- Other specs cover the grant path for every weapon family and the heat/charge gauges (`weapons-a`, `weapons-b`), the new archetypes through the live damage pass (`enemies-a`), save/reload/Continue and pause-Load against a real localStorage (`save.spec.ts`), the menu panels (`menus.spec.ts`: a dial change has to survive a reload, a rebound key has to reach the table the sampler reads), and the bench (`bench.spec.ts`, which writes `test-results/bench-results.json` and reports only — no frame-time threshold, because a software rasteriser's numbers are not the game's).
