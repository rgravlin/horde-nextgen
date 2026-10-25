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
| `spread` | half-angle in radians, drawn from `world.rng` per shot. For `melee` it is the half-angle of the sweep instead, and takes no draw: the arc is the weapon's shape, not aim error |
| `speed`, `range` | flight. A round is tested as the segment it swept this tick, so nothing tunnels through a body. `range` is the ray's length for `hitscan`, the sweep's reach for `melee` (measured to the target's body edge) and how far a shell is lobbed for `arc`; `speed` is 0 for the two kinds that resolve in one tick |
| `pierce` | bodies a shot passes through after the first; a shot never damages the same body twice. For `melee` it is how many extra bodies the sweep may clip |
| `knockback` | m/s shove, which staggers the hit enemy for 3 ticks. A sweep and a burst shove outward from their own centre, not along the aim |
| `falloff` | `[start, end, mult]` damage multiplier by distance flown, held flat past `end`. An `arc` burst takes no falloff, so its three entries are equal |
| `ammo` | `{mag, reload}`; an empty hand reloads on its own and cannot fire while it does. For `melee` and `arc` a magazine entry is one swing or one load |
| `pellets` | rounds one trigger pull spawns, each with its own `spread` draw — the shotgun's cone |
| `armorPen` | fraction of the target's armour ignored, taken off before the `armor` subtraction |
| `charge` | `{time, speed, dmg}`: a held trigger builds a draw and looses at a full draw or the moment the button comes up, so a panicked tap still fires, flatter and weaker |
| `aoe` | metres: the burst radius of an `arc` shell; everything overlapping it takes full damage |

`fire` names the delivery path, and four of the seven kinds have one: `projectile` and
`arc`, beside `hitscan` and `melee`, all of them in `src/sim/systems/projectiles.ts`. A
weapon naming a kind the sim does not implement spends no ammo and makes no noise, so a
half-finished kind reads as an empty gun rather than as a gun that works badly.

Ammo, cooldown and reload live on the hand (`world.slots[0..1]`), never on the def, so
two guns never share a magazine. Auto-fire (on by default, and the reason a run keeps
shooting while the player is busy moving) aims at the nearest body, and for a shell it
*leads* it: the burst is centred where that body will be when the shell arrives, at the
distance that takes, because a 1.2 s flight aimed at a body's current footprint lands a
whole flight behind the crowd it was fired at.

To hand a weapon to the player: `world.slots[1].weapon = i` plus its magazine in a unit
test — a swap refuses an empty hand — or `__forgeDebug.giveWeapon(id)` in a browser one.
`tests/e2e/weapons-a.spec.ts` is where the grant path is pinned, because
`forge-scenarios.json` has no step that evaluates JavaScript (its vocabulary is click,
fill, press, wait, hold, mouse, shot, state) and no key grants a weapon.

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