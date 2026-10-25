# ARCHITECTURE.md: Neon Horde

Structure every later task follows. Engine choice and pinned versions live in TECH.md; the look lives in DESIGN.md.
Paths are relative to the repo root. (`package.json`, the root config files and `node_modules` now exist; the scripts
below are the ones `package.json` defines.)

## One shared core, two runtimes

`src/sim` + `src/content` **are** the game: every rule (movement, steering, collision, damage, spawning, XP, scoring)
lives there, as plain TypeScript with **no imports from `three`, the DOM, `window`, `document`, `localStorage`,
`setTimeout`/`setInterval` or `requestAnimationFrame`**. The identical code runs in two runtimes, so no logic is
written twice:

- the browser, wired by `src/main.ts`;
- Node, headless — vitest unit tests, `tools/bench.ts`, `tools/replay.ts`.

There is no server and no worker today. The seam is kept anyway: `step(world, frame)` takes a `World` plus one
`InputFrame`, mutates pooled arrays in place and appends to event rings. Moving the sim to a Worker later would be a
transport change, not a rewrite.

Everything above the core is either a **reader** of state (render, audio, UI) or a **provider** of input. No file
outside `src/sim` may decide gameplay outcomes.

## Module map and allowed imports

| Module | Owns | May import |
|---|---|---|
| `src/content/` | typed data only: `weapons.ts`, `enemies.ts`, `powerups.ts`, `levels.ts`, `types.ts` (the `WeaponDef`/`EnemyDef`/`PowerupDef`/`LevelDef` schemas, defined once) | nothing |
| `src/sim/` | `world.ts` (`World`, pool allocation, the pool caps and tuning in one `TUNE`), `step.ts` (system order), `input.ts` (the `InputFrame` type), `rng.ts` (xoshiro128**), `spatialHash.ts`, `hash.ts`, `systems/{weapons,projectiles,status,enemies,enemyProjectiles,pickups,waves}.ts`, `systems/obstacles.ts` (the one cover + floor-hazard path: swept circle-vs-box and circle-vs-circle push-out, and the hazard clocks), `systems/levels.ts` (the chapter arc: which floor is under the player, and what its script ends on), `serialize.ts` (the save: whole pools and the floor as bytes, scalars as numbers), `replay.ts` (records a run's input and plays it back), later `config.ts` | `src/content` only |
| `src/render/` | `renderer.ts` (WebGPURenderer + `renderer.init()`, backend probe), `camera.ts` (three-quarter chase cam, interpolation, shake), `instancing.ts` (one `InstancedMesh` per archetype + props), `particles.ts` (TSL compute particles), `post.ts` (`RenderPipeline`: bloom → chromatic → ACES), `lights.ts` (pooled point lights), `assets.ts` (glTF loads), `quality.ts` (Low/Med/High/Ultra knobs) | `three`, `three/webgpu`, `three/tsl`, read-only `sim`/`content` |
| `src/audio/` | `synth.ts` (WebAudio graph), `songs.ts`, `sfx.ts` (event id → voice) | read-only `sim` events; no engine import |
| `src/ui/` | `hud.ts`, `menus.ts` (DOM overlay), `theme.css` (DESIGN.md palette/type scale) | read-only `sim`/`game` state; no engine import |
| `src/input/` | `sampler.ts` (keyboard + mouse → `InputFrame`), `gamepad.ts`, `bindings.ts` (default map, remappable) | `sim` types only |
| `src/game/` | `app.ts` (scene state machine), `loop.ts` (fixed-step accumulator), `persist.ts` (save/load), `debugState.ts` (`__forgeState`) | `sim`, `content`, `input`, and the render/audio/ui modules |
| `src/main.ts` | composition root: build the `World`, the renderer, audio, UI and input, register `window.__forgeState` / `window.__forgeDebug` | everything |

Hard rules, checked in CI:

- `tests/unit/purity.test.ts` greps `src/sim/**` and `src/content/**` for `three`, `document`, `window`,
  `localStorage`, `performance.now` and timer calls and fails on any hit.
- `render`, `audio` and `ui` never import each other and never write to the `World`; they only consume it. Only
  `src/sim/` mutates game state; `src/game/` and `src/input/` feed it.
- `src/audio` and `src/ui` must not import from `src/render` — a headless run with rendering disabled still plays
  sound and updates the HUD.
- Anything touching `window` or `localStorage` goes through a port (`StorageLike`, `Clock`) injected from
  `main.ts`/`game`, so unit tests pass in-memory stubs and Node stays green.

## Data flow

```
DOM/gamepad events ──▶ InputSampler ──(once per tick)──▶ InputFrame
                                                        │
                    step(world, frame)  ── fixed 1/60 s, ≤5 steps/frame
                        │  mutates SoA pools in place
                        └─▶ event rings: hit, kill, spawn, sfx, telegraph, shake, damageNumber
                                     │ (read-only, consumed once per rendered frame)
                     ┌───────────────┼───────────────┐
                     ▼               ▼               ▼
                 src/render      src/audio        src/ui + HUD
```

- Handlers only set bits in the sampler's scratch `InputFrame`. Gameplay never changes inside a key/mouse handler,
  so replays and tests build `InputFrame`s directly (`replay.ts` carries `{seed, chapter, autoFire, ticks, codes, aim}`:
  one packed frame code per tick, with the aim pair kept beside it because the packing quantises it).
- `step` order is fixed and listed in `step.ts`: timers → player move/dash → broad-phase rebuild (spatial hash,
  cell 2) → enemy AI, contact damage and the rounds they begin → weapon fire, projectile flight and hits → blast
  resolution → enemy-round flight and hits → the level-up pick → pickups/XP → wave spawns. The grid is built before
  the passes that query it, and a kill is resolved where the damage lands, so a corpse never spends a tick blocking
  the crowd or soaking a piercing shot. Enemy rounds fly in their own pass, after the player's: a body that is killed
  mid-tick still spends the round it had already begun (the shot exists independently of its shooter), and the two
  delivery passes each query the grid without disturbing what the other is iterating.
- Delivery lives one file away from the trigger: `systems/weapons.ts` owns the hand, the cooldown, the magazine, the
  two gauges, the draw and the aim, and hands the shot to `systems/projectiles.ts`, which owns everything after the
  trigger — the swept-segment test for a round, the march for a ray and the beam, the arc of a sweep, the jumps of a
  bolt and the burst of a lobbed shell or a singularity. Damage, falloff, pierce and knockback still all come off the
  shot's `WeaponDef`, and the seven delivery paths share one `damage` helper so a ray, a sweep and a burst that reach
  the same body for the same reason report the same number — and each reports it as one `Hit` event, a beam's
  per-tick cuts included. What keeps hurting a body after the shot is gone is a status, not a shot: `systems/status.ts`
  owns the burn (one channel per body, applied by a hit, ticked once per tick in the weapon pass) and the armour maths
  a burn and a beam share. The enemy side mirrors the split rather than reinventing it: `systems/enemies.ts` decides
  when a ranged body fires and hands the round over, `systems/enemyProjectiles.ts` owns everything after that — the
  swept-segment test for a bolt, the burst at the end of a grenade's arc — on its own 512-slot pool. Enemy rounds
  respect the player's i-frames by passing through an invulnerable player rather than being absorbed, and a grenade's
  last flight step is clamped to its aim point so the burst opens exactly where its telegraph ring was drawn.
- Iteration is by pool index, lowest index first, and randomness only comes from `world.rng`, so the order never
  depends on JS object or Map iteration.
- One browser frame: `sampler.sample()` → drain accumulator with `step` → `render(alpha = acc/dt)` + `audio.drain()`
  + `ui.sync(state)`. Rendering interpolates previous/current positions; pausing stops calling `step` and keeps
  drawing a frozen frame.
- Ring buffers have fixed capacity and drop oldest on overflow (a `droppedEvents` counter keeps that observable).
  The sim never blocks on a consumer.

## Scene state machine (`src/game/app.ts`)

States: `menu`, `levelselect`, `playing`, `levelup`, `paused`, `summary`, `victory`, `settings`, `history`.
Only `playing` advances the sim; every other state freezes it (DESIGN.md's "game freezes, playfield dims").

| State | Sim | Input means | Overlay |
|---|---|---|---|
| menu | no | menu nav; camera orbits a demo arena | title stack |
| levelselect | no | pick unlocked chapter (grid of 10) | chapter grid |
| playing | 60 Hz | gameplay map (move/aim/fire/dash/swap/pause) | HUD |
| levelup | no | 1/2/3 or click picks a card, R rerolls | 3 cards + reroll |
| paused | no | Esc/P resumes; quit-to-menu saves first | pause panel |
| summary | no | restart level / restart run / menu | death stats |
| victory | no | menu / arena | victory sweep |
| settings | no | tabs Audio/Video/Controls/Gameplay | settings panel |
| history | no | nav | mono stats table |

Transitions are declared in a table and are triggered by input events or by sim events (`xpThreshold`, `playerDead`,
`chapterCleared`) — never by direct DOM manipulation. `levelup`, `paused`, `settings` and `history` remember where
they came from and return there. `settings`/`history` are reachable from both `menu` and `paused`.

## localStorage keys (all JSON, all versioned)

| Key | Contents | Written |
|---|---|---|
| `neonhorde.save.v1` | resumable run snapshot: `seed`, `chapter`, `tick`, wave progress, player, weapon slots, powerups, score, kills — plus the five pools and the floor, byte for byte | autosave every 30 s, on pause, at each chapter end |
| `neonhorde.settings.v1` | master/sfx/music volume, quality tier, resolution scale, auto-fire, dash keybind map, shake amount | on change |
| `neonhorde.meta.v1` | unlocked chapters, best score per chapter, run-history rows for the history screen | when a run ends |

`serialize(world)` in `src/sim/serialize.ts` only produces and consumes the snapshot object; the localStorage read
and write happen in `src/game/persist.ts` through the `StorageLike` port. A `v1` payload that fails to parse or
shape-check is discarded (`deserialize` returns `null`, never throws) and counted in `errors`, never fatal.

Two things about the shape are load-bearing, so they are recorded here rather than only in the code:

- **Pools travel as bytes, not as JSON numbers.** `hashWorld` folds whole typed arrays, and `alloc` clears a slot
  on the way *in*, so a dead slot still carries the body that died in it and the free stack's order decides where
  the next body lands. Both are part of the run's identity, so both are restored byte for byte (columns packed
  through one run-length codec, then base64) instead of being rewritten as numbers, which would collapse `-0` and
  the float32 patterns. Anything that is a double in the `World` — xp, score, a hazard clock — stays a JSON
  number for the opposite reason: 32 bits would lose the thing it is there to keep.
- **A replay is a recipe, a save is a state.** `replay.ts` stores the seed, the chapter and one packed frame code
  per tick plus its aim pair, and `playReplay` rebuilds the run by stepping it, which is what keeps a chapter at
  tens of kilobytes and lets a changed build be diffed against a recorded run by hash. It assumes default pool
  sizes; a save carries its own.

## State for checks

`window.__forgeState()` (`src/game/debugState.ts`) builds a fresh plain object each call from the `World` plus
`renderer.backend` and an fps estimate — stable key set per TECH.md, ≤10 nearest enemies, no pool references
leaked. `window.__forgeDebug` (`setSeed`, `spawn`, `grantXp`, `giveWeapon`, `bench`) routes through `step`-side
APIs only, so scenario results stay reproducible. Caught errors increment `errors` instead of being swallowed.
No URL parameter or key jumps to a state purely so it can be photographed; scenarios play their way there.

## Tests and tools

| Path | Kind | Covers |
|---|---|---|
| `tests/unit/*.test.ts` | vitest, `environment: "node"`, no DOM | rng + spatial hash; every weapon kind (spread, pierce, falloff, reload, heat, chain, DoT); every AI behaviour (the melee five in `enemies-a.test.ts` — charger telegraphs before dashing, splitter spawns children, exploder AoE — and the ranged trio in `enemies-b.test.ts`: shooter band and 24-tick flash, grenade burst at its telegraphed ring, healer pulse, plus the enemy-round pool's i-frame gate); XP/level-up, powerup tiers capped at 5, dash i-frames; the chapter arc and its cover (`obstacles.test.ts`); the wave script (`waves.test.ts`: a scripted pack lands at its second and at no second before, nothing comes down inside cover or inside the 32×18 m view rect over all ten layouts, and the chapter's `hp` scale reaches the bodies); save/load round-trip; same seed + inputs → same `hashWorld`; `purity.test.ts` for the import rule |
| `tests/e2e/*.spec.ts` | Playwright 1.48.2, Chromium from `/ms-playwright`, flags `--enable-unsafe-webgpu --use-angle=swiftshader --enable-unsafe-swiftshader` | `slice.spec.ts` (play → move → kills → level-up → pause/resume, `errors === 0`, then the same pass with `?gl=webgl2` asserting `backend === "webgl2"`), `weapons-a.spec.ts` (the grant path in the live loop for the gun, medieval and instant kinds) and `weapons-b.spec.ts` (the alien kinds plus the heat and charge gauges, read back as `heat` / `venting` / `energy` per hand), and the enemies spec pins the melee five through the live loop (`enemies-a.spec.ts`, which spawns rings of bodies through `__forgeDebug.spawn` and lets the real damage pass prove the splitter's split). Later tasks add `persistence.spec.ts` (save/reload/resume), `death.spec.ts` (death → summary) and `bench.spec.ts` (writes `bench-results.json`, reports only) |
| `tools/bench.ts` | `tsx`, Node, no renderer | headless sim gate: median ≤4 ms/step at 1,000 enemies over 600 ticks, non-zero exit above that |
| `tools/replay.ts` | `tsx` | replays a recorded `{seed, inputs}` log and asserts the hash matches |
| `forge-scenarios.json` | root | the scenario steps and `state` assertions the Playwright specs read. A new mechanic lands with a step or assertion that fails without it |

Unit tests construct a `World` from a seed and feed it `InputFrame`s — no DOM, no renderer, no audio context.
Playwright specs assert on `__forgeState()`, not on pixels.

## Commands (from `package.json`, run in `/work`)

```
npm run dev         # vite dev server on http://127.0.0.1:5173
npm run build       # tsc --noEmit && vite build → dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run (tests/unit, node env)
npm run test:e2e    # playwright test (tests/e2e, webServer: `npx vite --port 5173 --strictPort`, reused if already up)
npm run bench       # tsx tools/bench.ts (sim perf gate)
```

Root config files: `tsconfig.json` (strict, `moduleResolution: "bundler"`), `vite.config.ts`, `vitest.config.ts`
(include `tests/unit/**/*.test.ts`, `environment: "node"`), `playwright.config.ts`. Assets live in
`public/assets/` with sources and licences recorded in `ASSETS.md`; README.md keeps the run instructions and the
"add a weapon / enemy / level / model" recipes, and content additions are one data entry plus a mesh or behaviour
only when genuinely new.

## Invariants

1. Fixed 1/60 Hz sim, at most 5 steps per frame; rendering interpolates and never scales gameplay by raw frame time.
2. No per-tick allocation: no closures, `.map`/`.filter`, or new objects inside `step`. Pools with the caps in
   `config.ts` (enemies 2048, projectiles 2048, enemy projectiles 512, shards 1024, particles 16k, damage numbers
   64, lights 16).
3. Determinism: same seed + same input log → same `hashWorld(world)` (FNV-1a over the pools).
4. GPU paths (compute particles, bloom, shadows) are cosmetic. If a GPU call fails, fall back to the CPU path;
   gameplay and the HUD must be unaffected.
5. Adding a feature means: data in `src/content`, rules in `src/sim`, presentation driven by events in
   `render`/`audio`/`ui`, and a scenario step or `state` assertion proving it.