# horde-nextgen

Neon Horde: a top-down twin-stick "horde" survival shooter on three.js r186
(`WebGPURenderer`, WebGPU first with an automatic WebGL2 fallback), driven by a
deterministic 60 Hz simulation in plain TypeScript.

Requirements: Node >= 22 (the sandbox runs 22.11.0) and `npm install` once with
network access — everything after that runs offline.

## Commands

Run them in the repo root:

    npm run dev         # vite dev server on http://127.0.0.1:5173
    npm test            # vitest run — unit tests, tests/unit/**, plain Node (no DOM)
    npm run test:e2e    # playwright test — browser scenarios, tests/e2e/** (Chromium + SwiftShader)
    npm run typecheck   # tsc --noEmit
    npm run build       # tsc --noEmit && vite build -> dist/
    npm run bench       # tsx tools/bench.ts — headless sim perf gate

`npm run typecheck`, `npm test` and `npm run build` are the checks every change
has to leave green.

## Where things live

[ARCHITECTURE.md](ARCHITECTURE.md) has the modules, the data flow and where tests
belong; [TECH.md](TECH.md) the pinned engine versions and why they were chosen;
[DESIGN.md](DESIGN.md) the look. The "Adding content" section below is how to add a
weapon, an enemy or a power-up; `ARCHITECTURE.md` has the rules a new piece of
content has to follow.

## Adding content

Content is data: one entry in one file under `src/content`, which `src/sim` reads. A new
weapon, enemy or power-up is not a new branch in the code. A new *behaviour* is one
function in a dispatch table. The fields below are what the simulation reads today.

### A weapon — `src/content/weapons.ts`, read by `src/sim/systems/weapons.ts`

Add a `WeaponDef`.

| field | what the sim does with it |
|---|---|
| `rate` | shots per second: the hand's cooldown is `1 / (rate × stats.fireRate)` |
| `dmg` | per round, scaled by falloff and `stats.dmg`, then reduced by the target's `armor` (floor 1) |
| `spread` | half-angle in radians, drawn from `world.rng` per shot |
| `speed`, `range` | flight; a round is tested as the segment it swept this tick, so nothing tunnels through a body |
| `pierce` | bodies a round passes through after the first; a round never damages the same body twice |
| `knockback` | m/s shove, which staggers the hit enemy for 3 ticks |
| `falloff` | `[start, end, mult]` damage multiplier by distance flown |
| `ammo` | `{mag, reload}`; an empty hand reloads on its own and cannot fire while it does |

`fire` names the delivery path and only `'projectile'` has one yet: a weapon naming a kind
the sim does not implement simply does not shoot. Ammo, cooldown and reload live on the
hand (`world.slots[0..1]`), never on the def, so two guns never share a magazine. To hand
one to the player in a test: `world.slots[1].weapon = i` plus its magazine — a swap refuses
an empty hand.

### An enemy — `src/content/enemies.ts`, read by `src/sim/systems/enemies.ts`

Add an `EnemyDef`, and if the movement is genuinely new add its `ai` id to `AI_IDS` and one
function to the `AI` table — the table has to cover every id, so a missing behaviour is a
typecheck error rather than an enemy that quietly stands still. The fields with behaviour
behind them are `hp`, `speed`, `radius`, `armor`, `xp` (the shard the body drops) and
`params`: `sepRadius`/`sepPush` for crowd separation through the spatial hash,
`touchRange`/`touchDamage` for contact damage, which one i-frame window caps to a single
hit however many bodies arrive. `accent` is for the renderer, which does not exist yet.

### A power-up — `src/content/powerups.ts`

Add a `PowerupDef` with `maxTier` and `apply(stats, tier)`. Granting one refolds every owned
power-up into `world.stats` from scratch, so a multiplier never depends on the order the
grants arrived in, and a grant past `maxTier` does nothing. Levels are data too
(`levels.ts`), and there is no level file yet: the wave spawner runs off `TUNE` until
chapter scripts land.