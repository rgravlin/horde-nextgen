/**
 * The envelope: how a payload gets in and out of storage without an exception escaping.
 *
 * **Why the storage is injected.** Everything here is a function over a
 * `{getItem, setItem, removeItem}` port, which buys two things. Unit tests in plain Node
 * hand it a `Map` and a whole persistence layer gets tested without a browser (the rule
 * ARCHITECTURE.md holds the sim to, extended to the layer that talks to the browser about
 * state). And nothing in here can reach a `window` that may not exist, which matters most
 * on the paths where it is most likely not to: private-mode Safari throws on *both* reads
 * and writes of a full localStorage, and a browser with storage turned off is a browser
 * this game still has to run in.
 *
 * **Nothing here throws, and nothing here forgets to mention what it caught.** A payload
 * that will not parse, or parses into something that is not the shape the key is
 * documented to hold, is discarded *and* reported through the optional `ProblemSink`, so
 * it reaches `__forgeState().errors` (AGENTS.md: count it, do not swallow it). Two
 * consequences worth spelling out, because they are decisions rather than defaults:
 *
 * - **Absence is not an error.** No key, or an empty one, is a first launch: it comes
 *   back as "nothing to load" or as the defaults, uncounted. Only a payload that was
 *   written and cannot be read is a problem.
 * - **A file from a different build is discarded whole.** Unknown keys, a wrong type, a
 *   history row of the wrong shape — the file is refused, defaults take over, and it is
 *   counted. Half-reading a settings file is how a renamed option silently becomes a
 *   different number for everyone who had already changed it. Fields that are simply
 *   *missing* are the exception: they take their default, so a settings file written
 *   before an option existed still carries the ones it knows — including a history row
 *   written before `endless` existed, which still reads as the campaign row it was.
 */

/**
 * The storage this module is allowed to talk to: `Storage` in the browser, a `Map` in a
 * test. `Storage` satisfies it as it stands, so the browser case is a hand-over rather
 * than an adapter.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Where a caught problem goes instead of disappearing.
 *
 * One shape for every problem this module can hit — a message, not an exception or a
 * result union — and one home for the count, which is the app's error tally. A caller
 * that does not pass a sink still gets correct answers (defaults, null); it just does not
 * hear about them, which is the difference between quiet and silent that AGENTS.md asks
 * for.
 */
export interface ProblemSink {
  note(problem: string): void;
}

function note(problems: ProblemSink | undefined, problem: string): void {
  problems?.note(problem);
}

function reason(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Read one JSON payload, or nothing.
 *
 * Four outcomes, three of which are a problem worth counting: no value (fine), a value
 * that will not parse, a value that parses to something other than an object, and a
 * storage that threw on the way in. The last one is the reason the read is wrapped:
 * Safari in private mode and `chrome://pages` with storage blocked both throw.
 */
function readJson(
  storage: StorageLike,
  key: string,
  problems: ProblemSink | undefined,
): Record<string, unknown> | null {
  let text: string | null;
  try {
    text = storage.getItem(key);
  } catch (e) {
    note(problems, `${key}: read failed (${reason(e)})`);
    return null;
  }
  if (text === null || text === '') return null;

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    note(problems, `${key}: payload did not parse`);
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    note(problems, `${key}: payload is not an object`);
    return null;
  }
  return data as Record<string, unknown>;
}

/** Write one JSON payload. False means the write did not land, counted either way. */
function writeJson(
  storage: StorageLike,
  key: string,
  value: unknown,
  problems: ProblemSink | undefined,
): boolean {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    note(problems, `${key}: would not encode (${reason(e)})`);
    return false;
  }
  try {
    storage.setItem(key, text);
    return true;
  } catch (e) {
    // Quota is the common one, and it is worth knowing about: a run that stops
    // autosaving keeps the player playing on a thread they cannot fall back to.
    note(problems, `${key}: write failed (${reason(e)})`);
    return false;
  }
}

export { clamp, note, reason, readJson, writeJson };
