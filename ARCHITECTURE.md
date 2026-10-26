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
| `src/render/` | `renderer.ts` (WebGPURenderer + `renderer.init()`, backend probe, the camera rig and the `RenderPipeline` chain: bloom → chromatic → ACES), `instancing.ts` (one `InstancedMesh` per look: archetype bodies and cores, rounds, shards, the dash trail), `meshes.ts` (the procedural geometry and materials those batches draw, and the two per-instance flash/dissolve attributes), `scenery.ts` (the floor's hazard discs), `telegraphs.ts` (the Threat Red charge strips, landing rings and sniper sights), `fxView.ts` (the instanced particle fields), `lights.ts` (the pooled point lights), `assets.ts` (the concrete floor, the Kenney kit cover and the HDRI environment). The quality tier is read by `assets.ts`, `lights.ts`, `instancing.ts` and `renderer.ts`, which is where the Low/Med/High knobs live. | `three`, `three/webgpu`, `three/tsl`, read-only `sim`/`content` |
| `src/audio/` | `synth.ts` (WebAudio graph), `songs.ts`, `sfx.ts` (event id → voice) | read-only `sim` events; no engine import |
| `src/ui/` | `hud.ts` (the corner readouts, the boss plate and the edge markers), `radar.ts` (the top-left map, painted on one 2D canvas), `levelup.ts` (the three-card offer), `menus.ts` (the screen panels), `styles.css` (DESIGN.md palette/type scale for the whole overlay) | read-only `sim`/`game` state; no engine import |
| `src/input/` | `sampler.ts` (keyboard + mouse + pad → `InputFrame`), `gamepad.ts` (the polled pad: two dead-zoned sticks, edge-tracked buttons, one of two face-button tables per frame), `bindings.ts` (default map, remappable — pads are not in it) | `sim` types and `sim` constants only |
| `src/game/` | `app.ts` (scene state machine, and the save timing hung off it: `archiveRun`, the `save`/`load` commands, Continue), `loop.ts` (fixed-step accumulator), `persistence.ts` (the three storage slots: run, settings, meta; plus the autosave clock), `debugState.ts` (`__forgeState`) | `sim`, `content`, `input`, and the render/audio/ui modules |
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
DOM events + a polled pad ─▶ InputSampler ──(once per tick)──▶ InputFrame
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
- The gamepad has no events, so it is **polled** inside `sample`, after the keyboard and mouse have written the
  frame, and it only ever adds to it: the move goes to whichever device is pushing harder, the aim goes to the right
  stick only while that stick is out of its dead zone, and a pad button can set a flag but never clear a key's.
  A pad-driven frame is therefore still one `InputFrame`, and `tests/unit/gamepad.test.ts` drives it — and three
  frames of `step()` — against a plain object shaped like a `Gamepad`, with no browser and no controller.
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
| menu | no | menu nav; camera orbits a demo arena; **Continue** appears while a save is in storage | title stack |
| levelselect | no | pick unlocked chapter (grid of 10) | chapter grid |
| playing | 60 Hz | gameplay map (move/aim/fire/dash/swap/pause) | HUD |
| levelup | no | 1/2/3 or click picks a card, R rerolls | 3 cards + reroll |
| paused | no | Esc/P resumes; **Save run** and **Load saved run** on the panel | pause panel |
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
| `neonhorde.save.v1` | resumable run snapshot: `seed`, `chapter`, `tick`, wave progress, player, weapon slots, powerups, score, kills — plus the five pools and the floor, byte for byte | every 30 s of play, at each chapter end, and on the pause panel's Save run. Cleared when a run ends (dead or won): a slot only ever holds a run worth resuming |
| `neonhorde.settings.v1` | master/sfx/music volume, quality tier (`auto`/low/med/high), resolution scale, auto-fire, shake amount | on change (nothing writes it until the settings screen exists) |
| `neonhorde.meta.v1` | unlocked chapters, best *time* per chapter (`-1` = never cleared), run-history rows for the history screen (last 50: date, chapter, time, kills, score, weapon ids) | at a chapter's end, and when a run ends |

`serialize(world)` in `src/sim/serialize.ts` only produces and consumes the snapshot object; the localStorage read
and write happen in `src/game/persistence.ts` through the `StorageLike` port (`{getItem, setItem, removeItem}`, so a
unit test hands it a `Map`). A `v1` payload that fails to parse or shape-check is discarded (`deserialize` returns
`null`, never throws) and counted through the module's `ProblemSink`, which is what feeds `errors` — never fatal,
never silent. Absence is not a problem: no key, or an empty one, is a first launch and reads back as the defaults.
Key remapping is deliberately not in the settings payload yet; the bind map belongs to `src/input/bindings.ts` when
remapping lands, so that there is one table and the sampler reads it.

The points below are load-bearing rather than incidental, so they are recorded here rather than only in the code:

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
- **The autosave clock counts play seconds.** `AutosaveTimer` in `persistence.ts` is fed `world.time`, which only
  moves while the sim steps, so a pause, a level-up freeze and a frame that ran out of its step cap all hold the
  interval still — a wall-clock timer would spend a long pause writing saves and call that autosave. It reports due
  every 30 s and at a chapter's end, keyed by *which* chapter ended, because the intermission is 4 s and the
  interval is 30: a chapter can end inside the gap its predecessor opened.
- **The shell owns the shelf, not the keys.** `archiveRun()` in `app.ts` runs once per frame outside the step loop
  and is the only thing that writes: a frozen scene writes nothing, so the interval is measured in play and the
  pause screen's Save is a request rather than a second clock. `save`, `load` and the title's Continue arrive as
  `HudCommand`s and go through `App.command`, exactly like `start` and `restart` — no key or click handler touches
  the `World` — and a load swaps whole `World`s (`enterWorld`), because a save is a state, not a patch. Both
  buttons ask `hasSave()` before they appear, and a load from storage is checked before it is played: an empty or
  corrupt slot leaves the title on the title and costs one `errors`.

## State for checks

`window.__forgeState()` (`src/game/debugState.ts`) builds a fresh plain object each call from the `World` plus
`renderer.backend` and an fps estimate — stable key set per TECH.md, ≤10 nearest enemies, no pool references
leaked. `window.__forgeDebug` (`setSeed`, `spawn`, `grantXp`, `giveWeapon`, `bench`) routes through `step`-side
APIs only, so scenario results stay reproducible. Caught errors increment `errors` instead of being swallowed.
No URL parameter or key jumps to a state purely so it can be photographed; scenarios play their way there.

## Tests and tools

| Path | Kind | Covers |
|---|---|---|
| `tests/unit/*.test.ts` | vitest, `environment: "node"`, no DOM | rng + spatial hash; every weapon kind (spread, pierce, falloff, reload, heat, chain, DoT); every AI behaviour (the melee five in `enemies-a.test.ts` — charger telegraphs before dashing, splitter spawns children, exploder AoE — and the ranged trio in `enemies-b.test.ts`: shooter band and 24-tick flash, grenade burst at its telegraphed ring, healer pulse, plus the enemy-round pool's i-frame gate); XP/level-up, powerup tiers capped at 5, dash i-frames; the chapter arc and its cover (`obstacles.test.ts`); the wave script (`waves.test.ts`: a scripted pack lands at its second and at no second before, nothing comes down inside cover or inside the 32×18 m view rect over all ten layouts, and the chapter's `hp` scale reaches the bodies); save/load round-trip; same seed + inputs → same `hashWorld`; the storage layer against a `Map` fake and a fake that throws (`persistence.test.ts`: the three keys, corrupt and partial payloads, the 50-row history cap, chapter unlocks, the autosave interval measured in play seconds); the shell's save timing (`app-save.test.ts` drives `advance(nowMs)` with no renderer and no DOM, and pins *when* the writes happen: one at 30 s of play and one per interval after it, none on the title screen, a chapter's end and a run's end each reaching the meta file, a loaded run resuming at its saved tick and playing on, and a storage that throws heard once per interval rather than per frame); the gamepad reader against a fake `Gamepad` (`gamepad.test.ts`: the radial dead zone and its rescale, held buttons read as held and pressed ones read as edges, the two face-button layouts, the merge against a held key and a projected mouse, three runs driven through `step()` (walk, shoot, take a card) and three through the headless scene machine (`createApp` with no view, no overlay and no shelf), so a pad frame has to be a frame the game plays and the shell has to hand it over); `purity.test.ts` for the import rule |
| `tests/e2e/*.spec.ts` | Playwright 1.48.2, Chromium from `/ms-playwright`, flags `--enable-unsafe-webgpu --use-angle=swiftshader --enable-unsafe-swiftshader` | `slice.spec.ts` (play → move → kills → level-up → pause/resume, `errors === 0`, then the same pass with `?gl=webgl2` asserting `backend === "webgl2"`), `weapons-a.spec.ts` (the grant path in the live loop for the gun, medieval and instant kinds) and `weapons-b.spec.ts` (the alien kinds plus the heat and charge gauges, read back as `heat` / `venting` / `energy` per hand), and the enemies spec pins the melee five through the live loop (`enemies-a.spec.ts`, which spawns rings of bodies through `__forgeDebug.spawn` and lets the real damage pass prove the splitter's split). `save.spec.ts` leaves the page: play, pause, Save, reload, Continue — the reload is the point, since a new app on a new `World` has to read the run back out of the same storage — plus the pause panel's Load and a check that an empty shelf offers no Continue, all read as `player.x` / `tick` restored within a few frames of drift and `errors === 0`. Playwright 1.48 has no gamepad emulation — its input API is keyboard, mouse, wheel and touch — so the pad has no spec here: it is pinned in `gamepad.test.ts`, which reads a `GamepadReader` fed by a plain object. Later tasks add `death.spec.ts` (death → summary) and `bench.spec.ts` (writes `bench-results.json`, reports only) |
| `tools/bench.ts` | `tsx`, Node, no renderer | headless sim gate: median ≤4 ms/step at 1,000 enemies over 600 ticks, non-zero exit above that |
| `tools/replay.ts` | `tsx` | replays a recorded `{seed, inputs}` log and asserts the hash matches |
| `forge-scenarios.json` | root | the scenario steps and `state` assertions the Playwright specs read. A new mechanic lands with a step or assertion that fails without it. Its `save` scenario drives Save → Menu → Continue in one page, because the step vocabulary has no reload — the spec is where the cross-page round trip is pinned |

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