/**
 * The two shape checks a restore runs its JSON through.
 *
 * Both answer "is this a save, and this build's shape of one?" with a false rather than an
 * exception, because a bad file is discarded and counted, never half-applied.
 */

/**
 * Copy a saved record onto a fresh one of the same shape.
 *
 * The World's own objects are the schema, so the check is by shape: the same keys, all of
 * them known, nothing extra, every value a finite number, a boolean or a string. That is
 * what makes a save written against a different build a discarded game rather than a
 * corrupt one, which is the failure TECH.md asks for.
 */
export function copyRecord(src: unknown, dest: object): boolean {
  if (typeof src !== 'object' || src === null || Array.isArray(src)) return false;
  const from = src as Record<string, unknown>;
  const to = dest as Record<string, unknown>;
  const mine = Object.keys(dest);
  const theirs = Object.keys(from);
  if (theirs.length !== mine.length) return false;
  for (const key of theirs) {
    if (!(key in dest)) return false;
    const v = from[key];
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isFinite(v)) return false;
    } else if (t !== 'boolean' && t !== 'string') {
      return false;
    }
    to[key] = v;
  }
  return true;
}

/** A saved fixed-length list, each entry a finite number or `null`. */
export function list(src: unknown, n: number): (number | null)[] | null {
  if (!Array.isArray(src) || src.length !== n) return null;
  for (const v of src) {
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  return src as (number | null)[];
}
