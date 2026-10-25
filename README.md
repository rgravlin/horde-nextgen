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
| `heat` | `{perShot, coolPerSec, max, recover}`: a barrel gauge instead of a magazine. Each trigger pull — each firing tick, for a `beam` — cooks `perShot`, every tick sheds `coolPerSec`, and at `max` the hand vents until it cools back to `recover`. Set `perShot` against what the gun actually does, not against `rate`: on a 1/60 s grid a cooldown of `1/11` s waits out six ticks, so the real cycle is ten bolts a second |
| `energy` | `{capacity, perShot, regenPerSec}`: a charge pool instead of a magazine, refilling on the ticks it is not spent. No reload pause — spend it down and the gun dribbles until the cell recovers. A `chain` bolt that finds nobody to chain to spends nothing |
| `dot` | `{dps, seconds}`: a hit leaves the body burning. One channel per body — a second application renews the timer and keeps the stronger rate instead of adding a second tick. Applied and ticked in `src/sim/systems/status.ts` |
| `chain`, `chainRadius` | for `chain`: how many bodies a bolt jumps to after the first, and the metres each jump may cross. A bolt will not spend two jumps on one body |
| `aoe` | metres: the burst radius of an `arc` shell and of an `orb`; everything overlapping it takes full damage. For `orb` the same circle is the vacuum's reach |
| `pull` | m/s a singularity drags bodies inside `aoe` toward itself while it flies, then pops them in that circle |
| `pellets` | rounds one trigger pull spawns, each with its own `spread` draw — the shotgun's cone |
| `armorPen` | fraction of the target's armour ignored, taken off before the `armor` subtraction |
| `charge` | `{time, speed, dmg}`: a held trigger builds a draw and looses at a full draw or the moment the button comes up, so a panicked tap still fires, flatter and weaker |

`fire` names the delivery path, and all seven kinds have one in
`src/sim/systems/projectiles.ts`: `projectile`, `hitscan`, the `melee` sweep, the lobbed
`arc` shell, the continuous `beam`, the jumping `chain` bolt and the drifting `orb`. A
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

To hand a weapon to the player: `loadSlot(world.slots[1], i)` — one call that fills the
magazine, the charge and the gauge state, which is what the unit tests and
`__forgeDebug.giveWeapon(id)` both use (a swap refuses an empty hand).
`tests/e2e/weapons-a.spec.ts` and `tests/e2e/weapons-b.spec.ts` are where the grant path
is pinned — the first the gun, medieval and instant kinds, the second the alien ones plus
the two gauges, read back through `__forgeState()` as `heat` / `venting` / `energy` per
hand — because `forge-scenarios.json` has no step that evaluates JavaScript (its
vocabulary is click, fill, press, wait, hold, mouse, shot, state) and no key grants a
weapon.

### An enemy — `src/content/enemies.ts`, read by `src/sim/systems/enemies.ts`

Add an `EnemyDef`, and if the movement is genuinely new add its `ai` id to `AI_IDS` and one
function to the `AI` table — the table has to cover every id, so a missing behaviour is a
typecheck error rather than an enemy that quietly stands still. The fields with behaviour
behind them are `hp`, `speed`, `radius`, `armor`, `xp` (the shard the body drops) and
`params`: `sepRadius`/`sepPush` for crowd separation through the spatial hash,
`touchRange`/`touchDamage` for contact damage, which one i-frame window caps to a single
hit however many bodies arrive. A behaviour's own numbers also live in `params` and are
documented where the behaviour reads them — the ranged trio's band edges, wind-up, bolt
speed/damage/life, lob range/arc speed/blast and heal range/beat/amount included.

Ranged bodies spend themselves through the shared `enemyShots` pool (cap 512) that
`src/sim/systems/enemyProjectiles.ts` flies after the enemy pass: a bolt is the segment it
swept this tick and a grenade bursts at the end of its arc, exactly at the point its
telegraph ring was drawn. Both respect the player's i-frames — against an invulnerable
player a round passes through rather than being absorbed — and a telegraphed attack always
buys the player the DESIGN.md 400 ms of warning before it lands.

To make the archetype actually *arrive*, it has to be in the chapter's data two ways at most:
in a `PACKS` row (the drumbeat, which fills the gaps and walks those recipes in order, so a
chapter's mix is knowable rather than drawn from luck) and, for the moments you want at a
second you choose, in that chapter's `waves` script. Which row you edit is a real choice — the
browser scenarios only play the first waves, so a body put into the early rows changes what a
scenario (and a new player) meets first.
`accent` is the body's emissive core colour — the renderer reads it per archetype; bodies
themselves stay dark matte (DESIGN.md "Palette").

### A power-up — `src/content/powerups.ts`

Add a `PowerupDef` with `maxTier` and `apply(stats, tier)`. Granting one refolds every owned
power-up into `world.stats` from scratch, so a multiplier never depends on the order the
grants arrived in, and a grant past `maxTier` does nothing.

### A level — `src/content/levels.ts`, read by `src/sim/systems/levels.ts`

A chapter is a floor plan, a wave script and an elite roster, and `startChapter` installs all
three before the wave clock starts. Add a `LevelDef` to `LEVELS` and the campaign plays it.

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