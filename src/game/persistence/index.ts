/**
 * The three places where something outlives the run that made it.
 *
 * TECH.md pins three localStorage keys and this folder is the only place that knows what
 * lives under them: `neonhorde.save.v1` (the run you can come back to),
 * `neonhorde.settings.v1` (the player's knobs) and `neonhorde.meta.v1` (the facts that
 * belong to the machine rather than to a run — what is unlocked, the best time per
 * chapter, and the last fifty runs for the history screen). The split is by lifetime, and
 * it is the reason there are four modules rather than one: a save is thrown away when its
 * run ends, settings live across runs, and meta is written *because* a run ended.
 *
 * - `envelope.ts` is the port: `StorageLike`, the `ProblemSink` a bad payload is reported
 *   through, and the two JSON helpers. Everything else is a function over that port, so a
 *   unit test in plain Node hands it a `Map` and the whole layer gets tested without a
 *   browser, and no path here can reach a `window` that may not exist.
 * - `keys.ts` names the three keys, and `runArchive.ts` uses the first of them to write,
 *   read, sense and drop a run.
 * - `settings.ts` and `meta.ts` are the other two payloads: their shapes, their defaults
 *   and the checks a file has to pass before it counts as that machine's settings.
 * - `autosave.ts` decides when a run is due to be written, on play seconds rather than on
 *   a clock.
 *
 * Two rules the whole folder holds to, spelled out in `envelope.ts` and worth repeating
 * here because they are decisions rather than defaults: nothing in here throws (a storage
 * that throws is caught, counted and answered with a default), and a payload from a
 * different build is discarded whole rather than half-read. Absence is never a problem;
 * only something that was written and cannot be read is.
 *
 * The public surface below is the one `src/game/persistence.ts` had, so `main.ts`, the app
 * shell and the tests all keep coming through the same door.
 */

export * from './autosave';
export * from './envelope';
export * from './keys';
export * from './meta';
export * from './runArchive';
export * from './settings';
