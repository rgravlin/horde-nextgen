# AGENTS.md

Written by forge when it set this project up; edit it freely (forge never rewrites it).

## Commands

Checks that must pass after every change:

    npm run typecheck
    npm test
    npm run build

## Structure

[ARCHITECTURE.md](ARCHITECTURE.md) has the modules, the shared core, the data flow and where tests live. Follow it.

## Rules

- Keep the simulation (update, collisions, spawning, scoring) apart from rendering and input: code with no DOM, canvas
  or timers, so unit tests drive it directly.
- Advance the simulation on a fixed timestep (accumulate frame time, step at 1/60 s); never scale gameplay by the raw
  frame time alone.
- Read input into a state the simulation polls each step; never change game state inside key or mouse handlers.
- `window.__forgeState()` returns plain JSON of the current state (positions, counts, the scene, `errors`); keep it
  cheap and keep its keys stable, since scenarios assert on them.
- Count caught errors in the state's `errors` instead of swallowing them.
- Reuse objects for bullets, particles and enemies (pools) instead of creating new ones every frame.
- Content (weapons, enemies, levels) is data in one place that the code reads, not copied code per item.
- Use the engine's API as TECH.md pins it; when a call fails the typecheck, read its type definitions in node_modules
  instead of guessing.
- No URL parameters or debug keys that jump to a state only so it can be photographed; a scenario plays there.
- When you add a mechanic, add a scenario step or `state` assertion that fails without it.

Every project:
- Never commit scratch, probe or plan files (e.g. `_plan.json`, `notes.txt`, `probe.mjs`); they go in /tmp.
- Never loosen a test to make it pass (e.g. accepting "404 or 405"); fix the code or the inconsistency it found.
- When behaviour, a command or an endpoint changes, update README and the other docs in the same task.
- One source of truth for config, schema and constants: define each once and import it; never copy it.
- SQL takes parameters (`?`, `$1`), never values pasted into the string.
- Compare secrets and tokens in constant time (`crypto.timingSafeEqual`, `hmac.compare_digest`,
  `subtle.ConstantTimeCompare`), never with `==`/`===`.
- Tokens and IDs that grant access have at least 128 bits from a cryptographic random source.
- Errors are values with one error shape per API (e.g. `{"error": "..."}`); never swallow an error silently.
- Before saying a task is done, run its checks and read their output; say what you verified (adapted from
  superpowers, MIT).
- When something fails, find the root cause from the error before changing code; one hypothesis and one change at a
  time (adapted from superpowers, MIT).
