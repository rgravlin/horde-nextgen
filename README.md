# horde-nextgen

Neon Horde: a top-down twin-stick "horde" survival shooter on three.js r186
(`WebGPURenderer`, WebGPU first with an automatic WebGL2 fallback), driven by a
deterministic 60 Hz simulation in plain TypeScript.

You drop onto a night-time factory floor with a pistol and a dozen rounds, the waves come in
from every edge of the screen and keep coming, and the run is about which lanes you can cut
and where you stand while you cut them. Everything glows, the threat is numbers, and each kill
is a short bright pop: XP shards stream into you, a level-up freezes the fight for a
pick-of-three card screen, chests drop at hot spots, and every chapter ends in a boss.

What is in it: 18 weapons across the three families (guns, medieval, alien tech) over seven
delivery paths — projectile, hitscan, the melee sweep, the lobbed arc shell, the continuous
beam, the jumping chain bolt and the drifting orb — 19 enemy archetypes running on 17
movement/attack behaviours, 30 power-ups, ten chapters with their own floor plans, wave
scripts and bosses, and an endless arena once the last chapter is cleared. A run saves and
resumes, on demand or every 30 seconds of play.

The rules live in `src/sim` + `src/content` as plain TypeScript with no DOM, canvas or timers,
so the identical code runs in the browser and headless in Node — which is where the unit tests
and the performance gate drive it from. `src/render`, `src/audio` and `src/ui` only *read* that
state; nothing outside `src/sim` decides what happens in a fight.

## Set-up

Requirements: Node >= 22 (the sandbox runs 22.11.0), a WebGL2-or-better browser, and network
access once, for the install:

    npm install         # once, online; everything after that runs offline

That installs three.js 0.186.1 plus the two self-hosted fonts (the only runtime dependencies),
and Vite, TypeScript, Vitest, tsx and Playwright as dev tools — see [TECH.md](TECH.md) for the
pinned versions and why they were chosen over Babylon, PlayCanvas and raw WebGPU. Chromium for
the browser scenarios comes from `/ms-playwright` (see `playwright.config.ts`); on a fresh
machine that is `npx playwright install chromium`.

## Commands

Run them in the repo root:

    npm run dev         # vite dev server on http://127.0.0.1:5173
    npm test            # vitest run — unit tests, tests/unit/**, plain Node (no DOM)
    npm run test:e2e    # playwright test — browser scenarios, tests/e2e/** (Chromium + SwiftShader)
    npm run typecheck   # tsc --noEmit
    npm run build       # tsc --noEmit && vite build -> dist/
    npm run bench       # tsx tools/bench.ts — headless sim perf gate (exits 1 over 4 ms/step)

`npm run typecheck`, `npm test` and `npm run build` are the checks every change
has to leave green.

`npm run test:e2e` starts its own Vite server on port 5173 and reuses one that is already up,
so `npm run dev` in another terminal does not collide with it. Chromium runs on SwiftShader
(`--enable-unsafe-webgpu --use-angle=swiftshader --enable-unsafe-swiftshader`), which is a
software rasteriser: the scenarios check what the game *does*, never how fast it draws — see
the next section for why, and for where the speed numbers do come from.

### Docker

Nothing here needs Docker — `npm run dev` on the host is the shorter path. It is for a
reproducible toolchain: `Dockerfile` builds the bundle and nginx serves it, `docker-compose.yml`
wraps that plus the dev server and a one-shot checks runner.

    docker compose up dev         # vite in a container -> http://127.0.0.1:5173
    docker compose up web         # builds the image -> http://127.0.0.1:8080
    docker compose --profile checks run --rm checks   # typecheck + unit tests + bench

Open the published port in a browser on the host. The container runs the *rules*, the browser
does the drawing, and a container has no GPU — so a container run exercises the code, never a
real renderer. Treat it as CI with a port, not as a way to judge how the game looks.

Two details in `docker-compose.yml` that are easy to break: `--host 0.0.0.0` is overriding
`server.host: '127.0.0.1'` in `vite.config.ts`, because a server bound to a container's own
loopback is unreachable through `-p`; and `node_modules` is a named volume, so Linux package
binaries never land in a macOS `node_modules` or the other way round. Reset it with
`docker volume rm horde-nextgen_node_modules`. Playwright scenarios do not run in Docker yet —
they need the Chromium image, see the note at the bottom of `docker-compose.yml`.

### Bench mode (in the browser)

The page has the other half of the same measurement. `npm run bench` times one tick of the
rules with no renderer; a browser run times whole frames *with* one, and the two numbers
only mean something side by side — the gap between them is a draw-path question.

    npm run dev         # then open http://127.0.0.1:5173/?bench=1000
    npx playwright test tests/e2e/bench.spec.ts   # the same window, and it keeps the JSON

`?bench=N` replaces the run with a held horde of N bodies, an invulnerable player and
auto-fire, and records frame times for 20 s: `&seconds=` shortens that, `&chapter=` picks
the floor (1-based, so `&chapter=5` benches the reactor). `window.__benchResults` holds the
report once the window is spent — frame milliseconds, the code's own share of them, the load
that survived to the end, and warnings saying so when the load was not held or the frame
budget was blown — and `__forgeState()` reports `mode: "bench"` while it runs. The e2e spec
writes the same report to `test-results/bench-results.json`, which is gitignored. The other
way in is `__forgeDebug.bench(n, {seconds, chapter})`, which arms a window against a run
already in progress.

Nothing in the browser is gated on speed, deliberately: the CI box has no GPU, so a
frame-time threshold there would be a test of SwiftShader rather than of the game. The gate
lives in `npm run bench`, where 4 ms a step is measured with no GPU in the way.

### The gate, and what a bench run means

`npm run bench` (`tsx tools/bench.ts`) is the only performance *check*. It builds the headline
load — 1,000 bodies, 1,500 rounds in the air, 8,000 particles, 600 XP shards and 16 lights —
re-seeds it before every measured tick and times 600 ticks after 60 warm-up ones, so the load
does not drain while it is being measured. The gate is the **median step: over 4 ms the
process exits 1**, which is what stops a change that makes a tick slower from landing quietly.
It runs on chapter 10's floor by default, because cover is what makes a horde expensive — every
body asks the prop grid one or two questions a tick — and it prints the worst low-water mark of
what survived a tick, so a window that quietly emptied says so instead of printing a nice
number.

    npm run bench                                  # the gate: ≤4 ms a step at 1,000 bodies
    npm run bench -- --enemies=2000                # same gate near the 2,048-body pool ceiling
    npm run bench -- --floor=0                     # chapter 1's floor, to match a default ?bench= window
    npm run bench -- --floor=none --ticks=1200     # open arena, longer window
    npm run bench -- --budget=3                    # tighten the gate
    npm run bench -- --out=/tmp/bench.json         # keep the numbers

The flags are `--ticks`, `--budget`, `--floor` (a 0-based chapter index — `--floor=9` is the
default and names chapter 10, `none` is open arena), `--enemies`,
`--shots`, `--particles` and `--out`. A `?bench=1000` window and a default `npm run bench` are
the same pile of load on different floors — the browser starts on chapter 1, the headless run on
chapter 10 — so say which one you measured when you quote a number.

To read a browser run on real hardware, measure a built bundle rather than the dev server (a dev
server ships unbundled modules and pays for the transform) and compare three numbers rather than
one: the headless `ms/step`, the report's `workMs` (the code inside a frame) and its `frameMs` /
`fps`.

    npm run build
    npx vite preview --port 4173 --strictPort      # http://127.0.0.1:4173

    # then, in a browser with a real GPU:
    #   http://127.0.0.1:4173/?bench=1000                  the headline load
    #   http://127.0.0.1:4173/?bench=2000&seconds=10        near the pool ceiling
    #   http://127.0.0.1:4173/?bench=1000&gl=webgl2         the fallback path, same load
    #   http://127.0.0.1:4173/?bench=1000&chapter=10        the floor the headless gate measures

The split is the point. The rig was written on a machine where a thousand bodies cost about
6 ms of JS inside a 230 ms frame, and a report that only printed "15 fps" would have pointed at
the simulation while the milliseconds went to the draw path or to how the browser paces
`requestAnimationFrame`. `workMs` against `frameMs` is what tells you which file to open; a
2,000-body window is a load to measure against, not a claim about what the game plays like.

## Graphics: backends, quality tiers and the WebGL2 pass

**Backend.** One renderer covers both paths. It comes up on WebGPU when the browser has
`navigator.gpu`, and on three's WebGL2 backend when it does not — that switch is three's, not the
game's. `?gl=webgl2` forces the WebGL2 path on a machine that has WebGPU, which is how both paths
get exercised: it is a URL knob only (`readParams` in `src/main.ts`), so switching means reloading
the page, and there is no Settings row for it. `__forgeState().backend` answers `"webgpu"`,
`"webgl2"` or `"none"`, and `"none"` means neither came up: the page then shows an HTML "your
browser can't run this (needs WebGL2)" panel instead of a canvas, and the simulation keeps running
behind it with no view. `tests/e2e/slice.spec.ts` runs the scenario twice, once per backend, and
the second pass asserts `backend === "webgl2"`.

**Compute particles** take the same split. The GPU path needs the compute-capable backend, so
WebGPU gets `Fn().compute(n)` dispatched through `renderer.compute()` and WebGL2 gets the
CPU-updated instanced field (`particleMode` in `src/render/renderer.ts`). Both draw the same four
palette batches; gameplay never reads either, which is the invariant every tier knob sits on.

**Tiers.** The four tiers are one table, `PROFILES` in `src/render/quality.ts`, and one function
reads the machine and picks one, `pickTier`:

| tier | shadows | particle budget (×4 palettes) | point lights | bloom (+ chromatic punch) | render scale |
|---|---|---|---|---|---|
| Low | off | 512 | 0 (emissive only) | off | 0.75× |
| Medium | 1024 px | 1,024 | 8 | on (0.40) | 1× |
| High | 2048 px | 2,048 | 16 | on (0.62) | 1× |
| Ultra | 4096 px | 4,096 | 16 | on (0.72) | 1× |

**Auto-detect** runs once at boot, from the backend, the GPU's own name, the device kind and
`navigator.deviceMemory`: a tier named in Settings wins outright; a software rasteriser
(SwiftShader, llvmpipe) goes to Low; a named WebGPU adapter starts at High and everything else
(WebGPU that will not identify itself, either WebGL2 case) at Medium; a handheld never starts
above Medium; 4 GiB or less is Low and 8 GiB is capped at Medium. Ultra is not reachable by
auto-detect — it needs WebGPU, a named adapter, a machine that says it is a desktop and at least
16 GiB, four pieces of evidence rather than an assumption. A machine that cannot say what it is
does not get assumed to be the weak one; it just does not get the top tier.

**Settings** only ever subtract, and the Video tab is where they are: `quality`
(`auto` → `low` → `medium` → `high` → `ultra`), `resolution` (50–100%, six stops, under the
tier's own ceiling), `shadows`, `bloom + chromatic` (the punch travels with the bloom pass rather
than having its own row) and `particles` (`off` / `low` / `medium` / `full`, as a fraction of the
tier's budget). A tier is the ceiling: `shadows: on` under Low buys nothing, because the tier's
answer is the cap and the setting sits under it. Rows are click-to-cycle buttons; the panel also
holds the mute, gunfire and music dials, the damage-number toggle, auto-fire and screen shake.
Everything else worth knowing about the look — palette, typography, the camera rig, what Threat
Red is reserved for — is in DESIGN.md.

## Where things live

[ARCHITECTURE.md](ARCHITECTURE.md) has the modules, the data flow and where tests
belong; [TECH.md](TECH.md) the pinned engine versions and why they were chosen;
[DESIGN.md](DESIGN.md) the look; [ASSETS.md](ASSETS.md) every streamed file with its
source and licence. The "Adding content" section below has the recipes: a weapon, an
enemy, a power-up, a level, a model and a song; `ARCHITECTURE.md` has the rules a new
piece of content has to follow.

Assets are fetched, not generated: `public/models/` (the Kenney City Kit Industrial
glTF cover), `public/textures/` (the wet-concrete floor) and `public/hdri/` (the
environment map), served verbatim from the site root. Adding one means a row in
`ASSETS.md` — see "Adding a model" below.

## Assets and licences

Everything streamed is CC0 and every file is listed with its source, licence and author in
[ASSETS.md](ASSETS.md); this is only what the game does with it. `public/` weighs about 6.5 MB,
of which a page fetches about 3.2 MB at boot (half of that the HDRI).

| what | where | what it is used for |
|---|---|---|
| Kenney City Kit Industrial — 37 GLBs + their shared `Textures/colormap.png`, CC0 | `public/models/kenney-industrial/` | the four cover modules in `PROP_MODEL` (`src/render/assets.ts`), one instanced layer per look, repeated rather than stretched |
| Poly Haven `concrete_floor_02` — six 1k maps, CC0, Rob Tuytel | `public/textures/concrete_floor_02/` | the wet-concrete floor; three of the six are fetched (`diff`, `nor_gl`, `rough`), the rest are kept with the set |
| Poly Haven `autoshop_01_1k.hdr`, CC0, Oliksiy Yakovlyev | `public/hdri/` | reflections and IBL only, never a visible backdrop (DESIGN.md) |
| Chakra Petch and IBM Plex Mono, OFL-1.1 | `@fontsource/*` in `node_modules`, imported by `src/main.ts` | the two type families; pinned in `package.json` rather than listed in `ASSETS.md` because they arrive through npm |

Three rules that come with them:

- **One kit.** The industrial pack is the only set-dressing source, so cover reads as one place.
  A second kit needs a reason stronger than variety — DESIGN.md's "Avoid" list names mixing packs
  with clashing styles.
- **`Textures/colormap.png` stays beside the GLBs.** Each `.glb` references it relatively, and the
  one-material merge in `toModule()` depends on that. A piece with its own texture wants its own
  material and its own layer, which is a different change than adding a module.
- **Nothing licensed is unrecorded, and nothing recorded is unused without a reason.** Enemies,
  projectiles, FX and all audio are procedural (DESIGN.md "Not sourced"); the three unused floor
  maps are kept next to the three that are fetched because the set came as one download.

Adding a file means: put it under `public/`, point at it from `src/render/assets.ts`, add its row
to `ASSETS.md`, and keep the fetch optional — a missing file has to fall back and be counted, the
way the four modules and three maps and the HDRI already do. See "Adding a model".

## Controls

Keyboard, mouse and gamepad are read the same way: once per frame into one `InputFrame`, which is
all `step()` ever sees. Nothing changes inside a key or button handler, so a keyboard run, a pad
run and a recorded replay all drive the same simulation code.

The aim carries a distance as well as a direction: where the cursor points on the floor, or how hard the
right stick is pushed. A round that travels only needs the line, but a catapult shell and an orb burst
where they land, so they read the distance and go where you pointed rather than to the top of the
weapon's range.

### Keyboard and mouse

| what | keys |
|---|---|
| move | `W` `A` `S` `D`, or the arrow keys |
| aim | the mouse, projected onto the floor |
| fire | left button — auto-fire is on by default, which is what the setting switches off |
| dash | `Space` or either `Shift` |
| swap hands | `Q`, or the mouse wheel |
| start / confirm / take the highlighted card | `Enter` |
| take a level-up card | `1` `2` `3`, or click the card |
| reroll the offer | `R` |
| pause / resume | `Esc` or `P` |

Behind those rows are thirteen bindable actions — four move keys plus fire, dash, swap hands, reroll, pause, accept and the three card keys — listed once in `src/input/bindings.ts`, which is the one table both
the sampler and the settings screen's Controls tab read — so a remap is real on the next key
press, not on the next reload. Keys are physical `KeyboardEvent.code` values (`'KeyW'`,
`'Space'`, `'Mouse0'`), which is why the defaults still work on AZERTY and with Caps Lock on, and
why a mouse button can be bound too. To rebind: Settings → Controls, click a row (it prints
`press a key`), then press the key; a second click on the waiting row, or `Esc`, cancels, and
**Reset keys** puts the whole map back. A key taken off one action is taken off it everywhere, so
no two rows can end up sharing one. The gamepad is deliberately not in that list — see below.

The screen also answers to the mouse: the menu stacks, the chapter grid and the three level-up
cards are clickable, and Playwright drives them through `data-scene` / `data-action` attributes
rather than pixel positions.

### Gamepad

A controller is polled, not listened for, and picked up on the frame after you plug it in. Only a
pad reporting the `standard` mapping is read: on anything else index 0 is not necessarily the
bottom face button, and a controller whose buttons silently mean other buttons is worse than no
controller.

| what | control |
|---|---|
| move | left stick — 0.2 radial dead zone, rescaled from zero past it, so a half-push is half speed and a full push is still full speed |
| aim + fire | right stick: aims and fires while it is held out of its dead zone |
| fire | right trigger, which fires along the aim without steering it |
| dash | `RB` or `A` — read as held, like `Space`, so you can hold it and keep dashing |
| swap hands | `LB` or `Y` — one swap per press |
| pause | `Start` — one pause per press, however long you hold it |
| take a level-up card | `A` `X` `Y`, left to right |

`A` is therefore a dash in a fight and the left card at a level-up: a pad has six buttons and two
thumbs, so the face buttons are read against whatever screen is up. That is the only thing that
changes meaning between screens, and it is why the reader takes the layout as an argument instead
of learning about scenes. Movement and aim go to whichever device is pushing harder and a pad
button can only ever add a flag, never clear a key's, so the two devices can be used together
without one fighting the other.

The pad is not in the Controls tab. A stick is not a key under any mapping and the face buttons
depend on the screen, so it keeps its own two button tables in `src/input/gamepad.ts`, where they
sit next to the reason each button is where it is.

Pinned by `tests/unit/gamepad.test.ts`, which drives `GamepadReader` with plain objects shaped
like a `Gamepad` — three runs through `step()` and three more through the real scene machine driven
headless (`createApp` with no renderer, no overlay and no shelf), so a pad frame has to be a frame
the game plays *and* the shell has to hand it over. There is no browser scenario for it:
Playwright 1.48 emulates keyboard, mouse, wheel and touch, not gamepads.

## Saves, settings and Continue

Three versioned JSON keys in `localStorage`, all under the app's own name:

| key | what it holds |
|---|---|
| `neonhorde.save.v1` | the run you can come back to: seed, chapter, tick, wave clock, the player, both weapon hands, power-ups, score and kills, plus the floors and the pools byte for byte |
| `neonhorde.settings.v1` | volumes and the mute, quality tier, resolution scale, shadows, bloom, particles, damage numbers, auto-fire, screen shake and the key map. Read at boot and rewritten the moment a Settings row changes, so what the panel shows and what a reload reads are one thing |
| `neonhorde.meta.v1` | unlocked chapters, best time per chapter, whether the Endless Arena is unlocked, and the last 50 runs for the history screen |

A run is written every 30 seconds of *play* — a pause or a level-up freeze holds that clock
still, so time spent reading the pause menu costs nothing — at the end of every chapter, and
whenever you ask for it. It is cleared as soon as a run is over, dead or won: a slot only ever
holds something you could actually resume. A malformed or future-shaped file is not a crash:
bad fields fall back to defaults and the fact is reported through the problem sink, which lands in
`__forgeState().errors`.

To reach it: `Esc` pauses, and the pause panel offers **Save run** and **Load saved run**. The
title screen shows **Continue** while a save is waiting and puts that run back at the tick and
the place it was written at, mid-fight and mid-chapter if that is where it stopped. Both
screens hide the button when there is nothing to load. Storage that refuses — private mode, a
full quota — leaves the game playing without saves rather than broken, and the failure is
counted in `__forgeState().errors` instead of swallowed.

Pinned by `tests/unit/app-save.test.ts` (when the writes happen, headless),
`tests/e2e/save.spec.ts` (play → pause → Save → reload the page → Continue, plus the
pause-screen Load) and the `save` scenario in `forge-scenarios.json`.

## Adding content

Content is data: one entry in one file under `src/content`, which `src/sim` reads. A new
weapon, enemy or power-up is not a new branch in the code. A new *behaviour* is one
function in a dispatch table, and a new *look* is either a procedural recipe or a streamed
CC0 file (see "Adding a model"). The fields below are what the simulation reads today, and
every recipe ends with the check that fails without it.

### Adding a weapon — `src/content/weapons.ts`, read by `src/sim/systems/weapons.ts`

Add a `WeaponDef`.

| field | what the sim does with it |
|---|---|
| `rate` | shots per second: the hand's cooldown is `1 / (rate × stats.fireRate)` |
| `dmg` | per round, scaled by falloff and `stats.dmg`, then reduced by the target's `armor` (floor 1) |
| `spread` | half-angle in radians, drawn from `world.rng` per shot. For `melee` it is the half-angle of the sweep instead, and takes no draw: the arc is the weapon's shape, not aim error |
| `speed`, `range` | flight. A round is tested as the segment it swept this tick, so nothing tunnels through a body. `range` is the ray's length for `hitscan`, the sweep's reach for `melee` (measured to the target's body edge) and how far a shell is lobbed for `arc`; `speed` is 0 for the two kinds that resolve in one tick |
| `pierce` | bodies a shot passes through after the first; a shot never damages the same body twice. For `melee` it is how many extra bodies the sweep may clip |
| `knockback` | m/s shove, which staggers the hit enemy for 3 ticks. A sweep and a burst shove outward from their own centre, not along the aim |
| `falloff` | `[start, end, mult]` damage multiplier by distance flown, held flat past `end`. An `arc` burst takes no falloff, so its three entries are equal |
| `ammo` | `{mag, reload}`; an empty hand reloads on its own and cannot fire while it does. For `melee` and `arc` a magazine entry is one swing or one load |
| `heat` | `{perShot, coolPerSec, max, recover}`: a barrel gauge instead of a magazine. Each trigger pull — each firing tick, for a `beam` — cooks `perShot`, every tick sheds `coolPerSec`, and at `max` the hand vents until it cools back to `recover`. Set `perShot` against what the gun actually does, not against `rate`: on a 1/60 s grid a cooldown of `1/11` s waits out six ticks, so the real cycle is ten bolts a second |
| `energy` | `{capacity, perShot, regenPerSec}`: a charge pool instead of a magazine, refilling on the ticks it is not spent. No reload pause — spend it down and the gun dribbles until the cell recovers. A `chain` bolt that finds nobody to chain to spends nothing |
| `dot` | `{dps, seconds}`: a hit leaves the body burning. One channel per body — a second application renews the timer and keeps the stronger rate instead of adding a second tick. Applied and ticked in `src/sim/systems/status.ts` |
| `chain`, `chainRadius` | for `chain`: how many bodies a bolt jumps to after the first, and the metres each jump may cross. A bolt will not spend two jumps on one body |
| `aoe` | metres: the burst radius of an `arc` shell and of an `orb`; everything overlapping it takes full damage. For `orb` the same circle is the vacuum's reach |
| `pull` | m/s a singularity drags bodies inside `aoe` toward itself while it flies, then pops them in that circle |
| `homing` | rad/s a flying shot may steer with while it hunts. Only the three kinds that spend ticks in the air read it — `projectile`, `arc` and `orb` — and they turn toward the nearest live body inside a 12 m seek band, once a tick, before the segment they are about to sweep is tested. A shot that finds nobody flies the line the aim gave it and one that finds one still has to reach it before its flight time runs out: a curve, not a lock-on |
| `pellets` | rounds one trigger pull spawns, each with its own `spread` draw — the shotgun's cone |
| `armorPen` | fraction of the target's armour ignored, taken off before the `armor` subtraction |
| `charge` | `{time, speed, dmg}`: a held trigger builds a draw and looses at a full draw or the moment the button comes up, so a panicked tap still fires, flatter and weaker |

`fire` names the delivery path, and all seven kinds have one under
`src/sim/systems/projectiles/`: `projectile`, `hitscan`, the `melee` sweep, the lobbed
`arc` shell, the continuous `beam`, the jumping `chain` bolt and the drifting `orb`. The
folder is cut along those paths — `ray.ts` holds the hitscan, beam and chain marches,
`melee.ts` the arc sweep, `flyers.ts` everything a round does while it is in the air, and
`shared.ts` the one `damage` helper, the falloff and the query padding they all read — so
a new kind is a new module plus a line in `index.ts`, not a new branch in a switch. A
`beam` and a `chain` bolt resolve the tick they are called; a `chain` bolt that finds
nobody is never thrown, and an `orb` resolves where it gets to rather than where it was
aimed. Every hit reports one `Hit` event, the beam's cuts included — that event is what a
hit flash, an impact burst and a damage number get drawn from; only the burn stays quiet.

Ammo, heat, charge, cooldown and reload live on the hand (`world.slots[0..1]`), never on
the def, so two guns never share a magazine or a barrel, and a hand spends exactly one of
the three gauges its def declares. Auto-fire (on by default, and the reason a run keeps
shooting while the player is busy moving) aims at the nearest body, and for a shell it
*leads* it: the burst is centred where that body will be when the shell arrives, at the
distance that takes, because a 1.2 s flight aimed at a body's current footprint lands a
whole flight behind the crowd it was fired at. A singularity is pointed, not led — it pops
where it arrives, so chasing a body that has not got there yet spends the flight on empty
floor.

**What a new gun touches.** One entry in `WEAPONS` is nearly the whole change:

- It is obtainable the moment it exists. `listGuns` in `src/sim/systems/pickups.ts` offers every
  gun the run is not already holding, so a chest or a level-up card can hand it out on the first
  wave and nothing else has to know its name.
- `mesh` is a label, not a lookup — nothing reads it. A gun's look comes from `family`:
  `weaponKit()` in `src/render/meshes/props.ts` builds one shape per family for the player's two
  hands, and `FAMILY_BATCH` in `src/render/instancing.ts` gives each family one instanced shot
  batch, so a new alien gun draws in the cyan batch as soon as it is written. A genuinely
  new silhouette is a `meshes/` change, and only for a *body* does the triangle budget in
  `tests/unit/meshes.test.ts` come into it.
- `sfx` has to name an entry in `RECIPES` (`src/audio/sfx.ts`) or the gun silently falls back to
  the light-gun click, which is why the recipe list is short and shared between families.
- The HUD writes its own caption: `handLabel` splits the camel-case id and adds
  `family · fire`, so `disruptorOrb` prints as "Disruptor Orb / alien · orb" with nothing to
  author.
- To hand it to the player in a test: `loadSlot(world.slots[1], i)` — one call that fills the
  magazine, the charge and the gauge state, which is what the unit tests and
  `__forgeDebug.giveWeapon(id)` both use (a swap refuses an empty hand).
- The tests to add: a case in `tests/unit/weapons-a|b|c.test.ts` for the numbers (build a World,
  `loadSlot` the gun, step it and read the pools) and a step in `tests/e2e/weapons-a.spec.ts` or
  `weapons-b.spec.ts` for the grant path, read back through `__forgeState()` as `heat` /
  `venting` / `energy` per hand — `forge-scenarios.json` has no step that evaluates JavaScript
  (its vocabulary is click, fill, press, wait, hold, mouse, shot, state) and no key grants a
  weapon.

### Adding an enemy — `src/content/enemies.ts` (+ `enemiesA.ts`), read by `src/sim/systems/enemies/`

Add an `EnemyDef` to the table — the core thirteen live in `enemies.ts`, later archetypes in
`enemiesA.ts`, and `ENEMIES` (the only thing anyone else imports) is both spread together —
and if the movement is genuinely new add its `ai` id to `AI_IDS` and one function to the `AI`
table in `src/sim/systems/enemies/behaviours.ts` — the table has to cover every id, so a
missing behaviour is a typecheck error rather than an enemy that quietly stands still. A new
behaviour gets its own file under `src/sim/systems/enemies/` rather than being appended to the
file that already holds a range of them: `marksmen.ts` holds the two bodies that share a
locked sight line, `rushers.ts` the ones that commit to a dash, `support.ts` the ones that
buff. What a body draws is a separate choice: `mesh` names a recipe in `SHAPES`
(`src/render/meshes/shapes.ts`, plus `shapesC.ts` for the three bodies whose shape has to
carry a behaviour of their own), which `tests/unit/meshes.test.ts` pins by triangle count, so
a new id needs its cost added there as well as its recipe. A new archetype can wear a shape
that already exists — most of them do — and `fit` scales it to the body instead of
re-authoring it.

The fields with behaviour behind them are `hp`, `speed`, `radius`,
`armor`, `xp` (the shard the body drops) and `params`: `sepRadius`/`sepPush` for crowd
separation through the spatial hash, `touchRange`/`touchDamage` for contact damage, which
one i-frame window caps to a single hit however many bodies arrive. A behaviour's own
numbers also live in `params` and are documented where the behaviour reads them — the
ranged bodies' band edges, orbit radius, wind-up, bolt speed/damage/life, lob range/arc
speed/blast and heal range/beat/amount included.

Ranged bodies spend themselves through the shared `enemyShots` pool (cap 512) that
`src/sim/systems/enemyProjectiles.ts` flies after the enemy pass: a bolt is the segment it
swept this tick and a grenade bursts at the end of its arc, exactly at the point its
telegraph ring was drawn. A sight-line body writes its aim into `fx`/`fy` the tick its tell
starts and then does not steer, so the line the renderer draws (a tube, for anything in
`SIGHT_LINES` in `src/render/telegraphs.ts`) is the bearing the round will take — the lead it
takes is one tick of the player's own velocity, never a prediction of a turn he has not made.
Both respect the player's i-frames — against an invulnerable player a round passes through
rather than being absorbed — and a telegraphed attack always buys the player the DESIGN.md
400 ms of warning before it lands.

To make the archetype actually *arrive*, it has to be in the chapter's data two ways at most:
in a `PACKS` row in `src/content/enemies.ts` (the drumbeat, which fills the gaps and walks those
recipes in order, so a chapter's mix is knowable rather than drawn from luck) and, for the moments
you want at a second you choose, in that chapter's `waves` script. Which row you edit is a real
choice — the browser scenarios only play the first waves, so a body put into the early rows
changes what a scenario (and a new player) meets first.
`accent` is the body's emissive core colour — the renderer reads it per archetype; bodies
themselves stay dark matte (DESIGN.md "Palette").

Then the three checks a new body owes: `tests/unit/enemies-split.test.ts` fails if `AI_IDS` has
an id the `AI` table does not cover (that one is a typecheck error too) or if a helper got copied
into a second module; a behaviour file of your own wants its own `tests/unit/enemies-*.test.ts`,
written the way `enemies-e.test.ts` is written — drive `step()` with plain `InputFrame`s and
assert on the telegraph events, not on a drawing; and `tests/e2e/enemies-a.spec.ts` is where a
body that has to be *reachable in the browser* gets pinned.

### Adding a power-up — `src/content/powerups.ts`

Add a `PowerupDef` with `kind` (`stat`, `timed` or `curse`), `maxTier` and `apply(stats, tier)`.
Granting one refolds every owned power-up into `world.stats` from scratch, so a multiplier never
depends on the order the grants arrived in, never compounds across ticks, and a grant past
`maxTier` does nothing; a `timed` one runs out and stops being counted rather than sitting on the
stat block forever.

A card has to change a number the simulation actually reads. `tests/unit/powerups.test.ts` walks
the whole table and fails on a card that changes nothing *and* on a `StatBlock` field nobody
reads, so a new stat needs its read point in `src/sim` in the same change — a card that lies is
worse than a card that is missing. Two doors offer one: a level-up deals three cards out of the
cards still under their cap (`buildChoices`), and a supply crate gives a gun *or* a power-up, so a
new card is reachable as soon as it is written. Both doors go through `grantPowerup`, which is
also where a re-dose replaces a running timed dose instead of stacking a second copy of it.

### Adding a level — `src/content/levels/`, read by `src/sim/systems/levels.ts`

A chapter is a floor plan, a wave script and an elite roster, and `startChapter` installs all
three before the wave clock starts. The ten chapters are written out in three files, by range:
`chapters-1-3.ts`, `chapters-4-6.ts`, `chapters-7-10.ts`, which `index.ts` spreads into
`LEVELS` in play order — that join is the only thing that decides which floor comes next. Add
a `LevelDef` to the file for its range, or a fourth file and one line in `index.ts`, and the
campaign plays it. What the chapters share is written once: the floor and script shorthands
and the three chapter-family tints in `builders.ts`, the elite variants in `elites.ts`, the
`LevelDef` schema in `types.ts`.
`tests/unit/levels-split.test.ts` fingerprints a 1,800-tick run of each chapter, so a floor
plan that changes on the way is a failing test rather than a campaign that plays differently.

The fields with behaviour behind them: `size` is the arena's half-extents in metres — a World
builds 120×120 m of floor and a chapter claims a square of it, and the band the game keeps
itself inside is 40 to 60 (under about 40 the wave spawner runs out of room to arrive in).
`palette` is the fog and key-light tint, read once per chapter. `props` is cover, authored
with `wall`/`crate`/`tank`/`pillar`; `hazards` are the two floor zones, `acid` at `dps` a
second and `crusher` telling for `warn` seconds before it hits for `dps` every `gap` seconds.

Cover is one code path — `src/sim/systems/obstacles.ts` — for all four shapes: a body or a
round is a circle, a prop is a box or a circle, and what is tested is the segment the mover
sweeps in one tick at its own radius. Bodies slide along walls instead of pathing around
them, rounds from both sides retire at the first footprint they enter, and `pointBlocked` is
what a spawner asks before it puts a body down. A prop thinner than 1.2 m through the middle
is refused when the chapter loads and counted in `props.dropped`, because under that a dash
crosses the whole thing in one tick — which is also why a column carries its radius next to
its diameter: the box around a pillar is not the pillar.

Two things a layout has to leave clear: the middle of the floor, because that is where a run
is dropped and a chapter may not open by charging the player for the floor he was put onto —
`tests/unit/obstacles.test.ts` fails a chapter that drops him inside cover or standing in a
pool — and the twelve metres straight down +x from it, which the browser scenarios walk with
a held key.

**The wave script.** Beside the floor plan a chapter writes what happens on it:

| field | what the sim does with it |
|---|---|
| `waves` | timed packs, authored with `beat(t, edge, …)` and `eliteBeat(t, edge, elite, …)`. Each lands at second `t` on the clock the chapter starts at zero, from `edge` — one of `any`, `e`, `w`, `n`, `s`, `ne`, `nw`, `se`, `sw`, all read relative to the player — with every body it names put down around one landing point so it arrives as one thing. `elite` puts that variant on the whole pack, which beats the per-body roll |
| `duration` | where the script stops and the chapter's `bosses` walk in, escorted by the last row of `packs` |
| `difficulty` | two dials that multiply into one number. `spawnRate` divides the gap between drumbeat batches (it divides the whole curve, so a hard chapter is meaner from its first batch, not only once the waves have wound up); `hp` multiplies the HP of every body the spawner puts down, script and drumbeat alike |

Between the beats the fill runs: a batch every `1.4 × 0.88^(wave−1)` seconds (floor 0.3 s, then
divided by `spawnRate`), sized 1 → 12 by the wave index, drawing straight down `packs` and
starting each batch where the last one stopped. Both halves are data, so the fifth body of a
chapter's second batch is the same archetype in every run at every seed.

A landing point is chosen **outside the view rect and off cover**: 32×18 m around the player is
never offered as a spawn point, and `pointBlocked` is asked before anything is spawned rather
than a body being shoved out of a wall afterwards — pushed out of a wall, a body arrives
somewhere the script never pointed at. If the edge a beat names has no clear floor, the pack is
retried on the next tick for half a second and then given up on and counted in `wave.skips`, so
a chapter that lost a set piece can be found. `tests/unit/waves.test.ts` walks all ten
layouts, second by second, and names the chapter, second, archetype and position of any body
that came down inside cover or inside the eyeline. When you write a beat, leave it at least
eight seconds inside `duration` and remember the pool stops at 2,048 bodies: a chapter that
runs longer or spawns faster than its neighbours needs its `spawnRate` checked against a run,
not against the table.
### The Endless Arena — `src/content/levels/arena.ts`, read by `src/sim/systems/{levels,waves,powerups}.ts`

The arena is a mode, not an eleventh chapter: one 56 m floor, one escalation ladder, no wave
script to walk and no encounter to clear, so there is nothing to win and no `duration` to run out
of. It is deliberately not a row in `LEVELS` — that array is the chapter grid, `bestTimes` and the
unlock count are indexed by it, and a run that never clears would have nothing to write into a
per-chapter column — so it lives beside the chapters as a floor plus six bands, and
`world.endless` is the flag that says a run is one. That flag picks the floor (`startArena`),
which pressure table the spawner reads (`bandAt`) and whether an elite roll happens at all.

Pressure is a rate rather than a cap. Each band carries a batch size, a gap divisor, an HP price
and an elite rate, and the last one stops rather than climbing on forever: its drumbeat already
asks for about ninety bodies a second, past which spawns land in a full 2,048-body pool, and a
run that cannot be lost is not a run. `tests/unit/arena.test.ts` pins that the rungs rise —
batch, gap divisor, HP price and elite rate each higher at the top than at the bottom — that the
top rung is a rung and not a slope (`bandAt(400)` is still Annihilation, every batch still
inside `TUNE.batchCap`), that the floor keeps filling ninety seconds past it, and that a long run
of steps never reports a victory.

Two doors in, and both are earned. **Endless Arena** appears on the victory panel and on the
title, shown only once the meta file has a win in it — that is what `arenaUnlocked` under
`neonhorde.meta.v1` is for, because the mode's first band is the Kill Floor's pressure and
nothing before it teaches that. `__forgeDebug.arena()`, and the `?arena=1` URL knob that calls it,
start the mode without a saved win: the scripted door exists so the `arena` scenario in
`forge-scenarios.json` can play a run it has not earned, and it goes through the same
`startArena` the menu button does rather than editing state. Inside an arena run both restart keys
start another arena run; the only way out is the menu. On death the summary shows the same five
numbers as a chapter run with "Endless Arena" where the chapter name goes.

### Adding a model — built in `src/render/meshes/`, or streamed from `public/`

A look is chosen one of two ways, and the choice is made by how many of the thing there are.
Bodies, rounds, the supply crate's two halves and the telegraphs are **built**: procedural
geometry, because 1,000 bodies cannot be authored one at a time (DESIGN.md "Horde"). The room's
cover is **fetched**: CC0 glTF, because a handful of set pieces is cheaper to stream than to
model. What a page streams at startup is nine files — the floor's three maps, the kit's shared
colormap, the HDRI and four kit modules — about 3.2 MB, of which the HDRI is half.

**Built.** Add a recipe to `SHAPES` in `src/render/meshes/shapes.ts`, keyed by *silhouette* and
authored in metres with the feet at `y = 0`; `shapesC.ts` takes the exceptions whose shape has to
carry a behaviour (the teleporter, the burrower, the spawner). Then put `mesh: "<your key>"` on
the `EnemyDef` — most new archetypes wear a shape that already exists and `fit` scales it, so
look for one before writing a recipe.

- `hordeMesh(id)` answers an unknown key with the `chaser` recipe rather than with an error, so a
  typo draws the wrong body instead of failing. `tests/unit/meshes.test.ts` is what catches it: it
  walks every `mesh` id in the content tables and fails if one has no `[body, core]` entry in
  `SHAPE_COSTS`, or pays outside the 40–300 triangle body budget. Add the new recipe's pair to
  that table, read back with `triangleCount()` rather than counted by hand.
- The budget is per draw. `createBatches` gives each archetype its own instanced pair — bodies
  and accent cores — drawing a shape it may share with other archetypes, so 1,000 bodies of a
  206-triangle recipe costs 206,000 triangles. A new shape is therefore a performance decision,
  not a free asset; that is why the cost is written down twice, in the recipe and in the test.
- Nothing in `src/render/meshes/` reads a `World`. It hands out geometry and materials and stays
  ignorant of who wears them — the callers are `instancing.ts`, which clones each shape before it
  attaches a batch's per-instance buffers, and `chests.ts`, which draws the crate and its pillar
  as one batch each, cut to the crate pool. The two prop shapes are not in `SHAPE_COSTS`, which
  is keyed by enemy silhouette; their 40–300 triangle cost is pinned in `tests/unit/chests.test.ts`.

**Streamed.** Put the file under `public/` — Vite serves that folder verbatim at the site root,
which is where the paths in `src/render/assets.ts` point — and add a row to `ASSETS.md` with its
source URL, licence and author. CC0 or equivalent only, and one kit per family: the Kenney City
Kit Industrial pack is the only set-dressing source, so cover reads as one place (DESIGN.md).
Keep the repo small the way it already is — the kit's duplicate FBX/OBJ formats and its preview
PNGs were deleted, only the GLBs, their shared `Textures/colormap.png` and `License.txt` are
kept. Prefer a folder name without a space: `MODEL_ROOT` has to percent-encode the one the kit
arrived with (`GLB%20format`).

- Cover is one instanced layer per look. `PROP_MODEL` holds one module per `PropKind`, **in
  `PropKind` order** — Wall, Crate, Tank, Pillar. Swapping a module means editing that entry
  *and* the `MODULE_SIZE` and `MODULE_HEIGHT` at the same index: those two numbers are what keep
  a module inside the collider that stops the player, and `src/sim/systems/obstacles.ts` stays
  the source of truth for what blocks a body. A module that pokes outside its box is a wall you
  can shoot through, which is the bug `scenery.ts` names.
- Modules are **repeated, not stretched**: `layModules` fills the obstacle's footprint at the
  module's own proportions (`RUN_CAP` along one axis, `LAYER_CAP` instances per layer) and pulls
  the last row back flush with the box. Only the fallback primitive may stretch, because a box
  has no detail to smear.
- `toModule()` bakes each glTF node's world matrix into the vertices before measuring, drops
  every attribute the primitives disagree about (only position, normal and uv survive; a mesh
  with no normals gets them recomputed) and merges everything into one non-indexed buffer. That
  merge is what lets a whole kit draw in one material — and it is why a new kit piece has to
  share `Textures/colormap.png`. A model with its own texture needs its own material and its own
  layer, which is a different change than adding a module.
- Everything streamed is optional and degrades: a file that does not arrive leaves the fallback
  box or the flat concrete in place, pushes its path into `Assets.missing`, and that count seeds
  `__forgeState().errors` (`renderer.ts` starts the error count at it) beside a
  `console.warn('assets not loaded: …')`. So a wrong path fails loudly instead of quietly
  flattening the room. All of it loads in one `Promise.all` before the first frame — it is
  awaited so the floor cannot pop from grey to concrete a second into a run.
- Streaming a *body* is not wired yet. `createBatches` takes geometry only from `meshes/`, so a
  streamed character needs a second path first — a loaded glTF flattened to one module per
  archetype, the way `toModule` does for cover — before one can be drawn. Nothing in the sim would
  change; it is a renderer change plus the licence row.

To check either kind: `npm test` for the shape costs, then `npm run dev` and load the floor it
belongs on. `__forgeState().errors` should still be `0`, and `__forgeState().backend` beside
`__forgeState().settings.quality` say what the machine picked — there is no on-screen debug
overlay, those two hooks are the instruments — which is where a Low-tier machine will differ from
the one that authored the look.

### Adding a song, and a sound — `src/audio/`

The soundtrack is three `SongDef`s in `src/audio/songs.ts`, and `CHAPTER_SONGS` says which of
the ten floors plays which. A track is a tempo, a scale, a register and a set of parts on the
16-step grid; `src/audio/sequencer.ts` turns a part into notes at times and `src/audio/synth.ts`
turns a note into oscillators. To add a tune, write a `SongDef` and put its id in the chapter
grid — a floor gets one *song* and up to four *arrangements* of it, which is what a part's
`from: n` means: it joins the mix at intensity tier `n`, so the arrangement thickens with the
size of the horde rather than with the clock. A part marked `boss: true` plays only while the
encounter is alive. `tests/unit/sequencer.test.ts` runs `checkSong` over every track, so a
mis-sized bar or a note outside the scale is a failing test, not a strange noise.

To add a sound effect, add a recipe name to `RECIPES` in `src/audio/sfx.ts`, a `RecipeTune`
(gap, gain, reach) at the same index in `RECIPE_TUNE`, a voice builder at the same index in
`eventVoices` in `synth.ts`, and the event that wants it in `recipeForEvent`. The gap and the
reach are the sound: a noise that arrives more than about once per 45 ms, or further than about
30 m away, is not information, and the mixer drops it on purpose. Audio never reads
`world.rng` and never writes a `World` — `tests/unit/audio.test.ts` fails if either starts.
