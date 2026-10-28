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
- Node, headless — vitest unit tests and `tools/bench.ts` (the only thing under `tools/`). Replay is a
  sim module, `src/sim/replay.ts`, exercised by `tests/unit/serialize.test.ts`; there is no replay command.

There is no server and no worker today. The seam is kept anyway: `step(world, frame)` takes a `World` plus one
`InputFrame`, mutates pooled arrays in place and appends to event rings. Moving the sim to a Worker later would be a
transport change, not a rewrite.

Everything above the core is either a **reader** of state (render, audio, UI) or a **provider** of input. No file
outside `src/sim` may decide gameplay outcomes.


## How this file is split

Three files, each one section-family, so a session can read a whole half of this in one go:

- [docs/architecture/modules.md](docs/architecture/modules.md) — the module map and the imports each module may make.
- [docs/architecture/data-flow.md](docs/architecture/data-flow.md) — data flow, the scene state machine, the localStorage keys and `__forgeState`.
- [docs/architecture/tests.md](docs/architecture/tests.md) — what every test file and tool pins.

The commands and the invariants stay here, below, because they are what the three files describe.

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
(include `tests/unit/**/*.test.ts`, `environment: "node"`), `playwright.config.ts`. Streamed assets live in
`public/models/`, `public/textures/` and `public/hdri/` (served from the site root) with sources and licences
recorded in `ASSETS.md`; README.md keeps the run instructions and the "add a weapon / enemy / level / model" recipes,
and content additions are one data entry plus a mesh or behaviour only when genuinely new.

## Invariants

1. Fixed 1/60 Hz sim, at most 5 steps per frame; rendering interpolates and never scales gameplay by raw frame time.
2. No per-tick allocation: no closures, `.map`/`.filter`, or new objects inside `step`. Pools with the caps in
   `src/sim/constants.ts` (enemies 2048, projectiles 2048, enemy projectiles 512, shards 1024) and `src/sim/fx.ts`
   (the particle ring holds 8192). Render-side: four palette batches of the tier's `particles` budget each
   (512/1024/2048/4096), damage numbers 128, pooled lamps 0/8/16/16 — all keyed off `src/render/quality.ts` — plus
   the two supply-crate batches, which are cut to `POOL_CAPS.chests` (24) because a crate is a *somewhere* rather
   than a *somebody*.
3. Determinism: same seed + same input log → same `hashWorld(world)` (FNV-1a over the pools).
4. GPU paths (compute particles, bloom, shadows) are cosmetic. If a GPU call fails, fall back to the CPU path;
   gameplay and the HUD must be unaffected.
5. Adding a feature means: data in `src/content`, rules in `src/sim`, presentation driven by events in
   `render`/`audio`/`ui`, and a scenario step or `state` assertion proving it.