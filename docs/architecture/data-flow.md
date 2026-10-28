# Data flow

Split out of [ARCHITECTURE.md](../../ARCHITECTURE.md). Code comments quote these headings ("Data flow", "One shared core, two runtimes"), so they stay one file and are read together with the [module map](modules.md).

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
  so replays and tests build `InputFrame`s directly (`replay.ts` carries `{seed, chapter, autoFire, ticks, codes, aim, lob}`:
  one packed frame code per tick, with the aim pair and the aim distance kept beside it, because the packing quantises the
  pair and has no bits left for the distance).
- The gamepad has no events, so it is **polled** inside `sample`, after the keyboard and mouse have written the
  frame, and it only ever adds to it: the move goes to whichever device is pushing harder, the aim goes to the right
  stick only while that stick is out of its dead zone, and a pad button can set a flag but never clear a key's.
  A pad-driven frame is therefore still one `InputFrame`, and `tests/unit/gamepad.test.ts` drives it — and three
  frames of `step()` — against a plain object shaped like a `Gamepad`, with no browser and no controller.
- `step` order is fixed and listed in `step.ts`: timers → player move/dash → the findability mask and the
  broad-phase rebuild (spatial hash, cell 2) → enemy AI, contact damage and the rounds they begin → the drone
  companion → weapon fire, projectile flight and hits → blast resolution → enemy-round flight and hits → the
  level-up pick → pickups/XP → wave spawns. The grid is built before the passes that query it, and a kill is
  resolved where the damage lands, so a corpse never spends a tick blocking the crowd or soaking a piercing shot.
  Enemy rounds fly in their own pass, after the player's: a body that is killed mid-tick still spends the round it
  had already begun (the shot exists independently of its shooter), and the two delivery passes each query the grid
  without disturbing what the other is iterating.
- **Who may be found is decided once, at the top of the tick.** `markFindable` refills `hash.findable` from the
  phase slot and that byte array is what `rebuild` indexes and what every `queryRadius` in the tick filters on —
  the hitscan march, the chain jump, the melee arc, a flying round's segment test, the drone's target scan, the
  thorns pulse and the burst resolver all read the same buffer. That is what makes "a shot cannot hit what it
  cannot see" one rule instead of thirteen: a burrower under the floor is simply not in the grid, and the two
  passes that skip the grid (the burn tick and the chapter's acid) ask `underground(phase)` for the same answer.
  The mask is a per-tick snapshot derived from the phase slot, not a second source of truth, so it is never saved
  and nothing has to remember to clear it; the same rule denies a hidden body its own touch, which is why
  untargetable is never the same thing as free damage.
- Delivery lives one folder away from the trigger: `systems/weapons.ts` owns the hand, the cooldown, the magazine, the
  two gauges, the draw and the aim, and hands the shot to `systems/projectiles/`, which owns everything after the
  trigger — the swept-segment test for a round, the march for a ray and the beam, the arc of a sweep, the jumps of a
  bolt and the burst of a lobbed shell or a singularity. The aim is resolved once a tick into `world.muzzle`, which is
  the line the round takes (led at `world.nearest` when auto-fire is the one shooting, the steered pair otherwise) and
  which the shot then spends; `render/facing.ts` reads that same field to turn the player's rig, so a barrel cannot be
  drawn pointing somewhere its own tracers do not go. It is derived per tick and read-only downstream, so it is in
  neither the save nor the fingerprint, exactly like `hash.findable` above. The ward drone's *place* is the same kind
  of fact one layer down: `systems/drone.ts` answers it with `droneOrbit(tick, playerX, playerY, out)` and looses the
  volley from that answer, and a drawn drone or a `__forgeState()` read is meant to take that call rather than derive
  a circle of their own — a second `cos`/`sin` is free to disagree about the radius, the centre or the bearing, and
  then the companion is drawn somewhere its own rounds did not come from; `tests/unit/drone.test.ts` holds the
  origins a run really loosed, read out of the event ring, against it. Damage, falloff, pierce and knockback still
  all come off the shot's `WeaponDef`, and the seven delivery paths share one `damage` helper so a ray, a sweep and a
  burst that reach the same body for the same reason report the same number — and each reports it as one `Hit` event, a
  beam's per-tick cuts included. What keeps hurting a body after the shot is gone is a status, not a shot:
  `systems/status.ts` owns the burn (one channel per body, applied by a hit, ticked once per tick in the weapon pass)
  and the armour maths a burn and a beam share. The enemy side mirrors the split rather than reinventing it:
  `systems/enemies/` decides when a ranged body fires and hands the round over, `systems/enemyProjectiles.ts` owns
  everything after that — the swept-segment test for a bolt, the burst at the end of a grenade's arc — on its own
  512-slot pool. Enemy rounds respect the player's i-frames by passing through an invulnerable player rather than
  being absorbed, and a grenade's last flight step is clamped to its aim point so the burst opens exactly where its
  telegraph ring was drawn.
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

`serialize(world)` in `src/sim/serialize/` only produces and consumes the snapshot object; the localStorage read
and write happen in `src/game/persistence/` through the `StorageLike` port (`{getItem, setItem, removeItem}`, so a
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
  per tick plus its aim pair and aim distance, and `playReplay` rebuilds the run by stepping it, which is what keeps a chapter at
  tens of kilobytes and lets a changed build be diffed against a recorded run by hash. It assumes default pool
  sizes; a save carries its own.
- **The autosave clock counts play seconds.** `AutosaveTimer` in `persistence/autosave.ts` is fed `world.time`, which only
  moves while the sim steps, so a pause, a level-up freeze and a frame that ran out of its step cap all hold the
  interval still — a wall-clock timer would spend a long pause writing saves and call that autosave. It reports due
  every 30 s and at a chapter's end, keyed by *which* chapter ended, because the intermission is 4 s and the
  interval is 30: a chapter can end inside the gap its predecessor opened.
- **The shell owns the shelf, not the keys.** `keepShelf()` in `appArchive.ts` runs once per frame outside the
  step loop and is the only thing that writes: a frozen scene writes nothing, so the interval is measured in play
  and the pause screen's Save is a request rather than a second clock. It is handed a `Shelf` (the storage port,
  the problem sink, and live reads of "is this a bench page" and "is this the title") rather than closing over the
  app, so the four timing rules are testable against a `Map` with no scene machine. `save`, `load` and the title's
  Continue arrive as `HudCommand`s and go through `App.command`, exactly like `start` and `restart` — no key or
  click handler touches the `World` — and a load swaps whole `World`s (`enterWorld`), because a save is a state,
  not a patch. Both
  buttons ask `hasSave()` before they appear, and a load from storage is checked before it is played: an empty or
  corrupt slot leaves the title on the title and costs one `errors`.

## State for checks

`window.__forgeState()` is `buildState` in `src/game/appState.ts`: a fresh plain object each call from the `World`
plus the shell read through a `StateHost` (`scene`, `backend`, `mode`, `errors`, the frame-time ring) — stable key
set per TECH.md, ≤10 nearest enemies, no pool references leaked. Two keys are read off the *drawing* rather than
out of the World, because the drawing is the thing being checked: `player.barrel` through `View.playerFace` and
`drone.drawn` through `View.dronePoint`. `window.__forgeDebug` (`setSeed`, `spawn`, `grantXp`, `giveWeapon`,
`givePowerup`, `bench`) is `createDebug` in `src/game/appDebug.ts`, and it takes the live `World` from its
host — a bench window arms a new run, so the bodies have to go into the world that restart made. Both route
through `step`-side APIs only, so scenario results stay reproducible. Caught errors increment `errors` instead of
being swallowed.
No URL parameter or key jumps to a state purely so it can be photographed; scenarios play their way there.

