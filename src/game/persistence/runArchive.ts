/**
 * The run's save slot: write it, read it, ask whether it exists, throw it away.
 *
 * The whole payload goes through one `JSON.stringify` of the snapshot: no envelope, no
 * second copy of the chapter or the score beside it. A second copy is a second thing to
 * keep in step, and everything a resume screen needs (chapter, tick, kills, score) is
 * already inside the snapshot. The shape check is `deserialize`'s; what lives here is the
 * decision about what a missing or unreadable file *means*.
 */

import { SAVE_VERSION, deserialize, serialize } from '../../sim/serialize';
import type { World } from '../../sim/world';
import { note, readJson, reason, writeJson, type ProblemSink, type StorageLike } from './envelope';
import { SAVE_KEY } from './keys';

/**
 * Write the run out, in the shape `serialize` owns.
 *
 * The payload is whatever `serialize(world)` returns, so the fingerprint and the save are
 * built from the same read of the same pools.
 */
export function saveRun(storage: StorageLike, world: World, problems?: ProblemSink): boolean {
  return writeJson(storage, SAVE_KEY, serialize(world), problems);
}

/**
 * Read a run back, or null.
 *
 * Null covers "there is no save" and "the save is unreadable" and the two are told apart
 * by the sink, not by the return value: a first launch is not an error, while a file that
 * a previous session wrote and that now fails to decode is exactly the thing a developer
 * needs to see. The shape check itself is `deserialize`'s — it returns null rather than
 * throwing on a payload it does not recognise, and that null is counted here on the way
 * past.
 */
export function loadRun(storage: StorageLike, problems?: ProblemSink): World | null {
  const data = readJson(storage, SAVE_KEY, problems);
  if (data === null) return null;

  const world = deserialize(data);
  if (world === null) note(problems, `${SAVE_KEY}: payload is not a ${SAVE_VERSION} snapshot`);
  return world;
}

/**
 * Whether something is stored under the save key.
 *
 * Presence only, deliberately: the title screen asks this to decide whether to offer
 * "Resume", and answering it must not cost a megabyte of parsing and a World to prove it.
 * An unreadable save still gets counted, at the one place that has to read it — `loadRun`.
 */
export function hasSave(storage: StorageLike, problems?: ProblemSink): boolean {
  try {
    const text = storage.getItem(SAVE_KEY);
    return text !== null && text !== '';
  } catch (e) {
    note(problems, `${SAVE_KEY}: read failed (${reason(e)})`);
    return false;
  }
}

/** Throw the stored run away: the "abandon this run" door, and what the tests reset with. */
export function clearSave(storage: StorageLike, problems?: ProblemSink): void {
  try {
    storage.removeItem(SAVE_KEY);
  } catch (e) {
    note(problems, `${SAVE_KEY}: remove failed (${reason(e)})`);
  }
}
