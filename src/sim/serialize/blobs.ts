/**
 * The blob codec: a list of typed-array columns in one packed, base64'd string, and back.
 *
 * This is the half of the save format that is about *bytes* rather than about the World: it
 * knows a column is a Float32Array or a Uint16Array, that the bytes are little-endian, and that
 * a quiet pool is mostly zeros worth run-length packing. It deliberately knows nothing about
 * pools, floors or saves — `replay.ts` packs a tick's worth of input through the same two
 * functions, which is the reason they are a module rather than private helpers.
 */

/** A column of a blob: one of the typed arrays the World is made of, at its width. */
export type Column = Uint8Array | Uint16Array | Uint32Array | Float32Array;

/** One column's element width, shared by both directions so they cannot drift apart. */
function columnWidth(col: Column): number {
  if (col instanceof Uint8Array) return 1;
  if (col instanceof Uint16Array) return 2;
  return 4;
}

function totalWidth(cols: readonly Column[]): number {
  let total = 0;
  for (const c of cols) total += c.length * columnWidth(c);
  return total;
}

/**
 * Write the columns into one little-endian byte stream.
 *
 * Little-endian and explicit rather than a copy of the arrays' backing bytes, so the
 * bytes mean the same thing on whatever machine opens the file — the same reasoning that
 * makes `hash.ts` fold floats at their 32-bit patterns.
 */
function packColumns(cols: readonly Column[], out: Uint8Array): void {
  const view = new DataView(out.buffer);
  let at = 0;
  for (const c of cols) {
    if (c instanceof Uint8Array) {
      out.set(c, at);
      at += c.length;
    } else if (c instanceof Uint16Array) {
      for (let i = 0; i < c.length; i++, at += 2) view.setUint16(at, c[i], true);
    } else if (c instanceof Uint32Array) {
      for (let i = 0; i < c.length; i++, at += 4) view.setUint32(at, c[i], true);
    } else {
      for (let i = 0; i < c.length; i++, at += 4) view.setFloat32(at, c[i], true);
    }
  }
}

/**
 * Read a byte stream back into the columns it came from.
 *
 * The length has to land exactly on the end of the stream: a blob that decodes short or
 * long is a blob that got truncated in storage, and that is a discarded save rather than
 * a partly restored one.
 */
function unpackColumns(bytes: Uint8Array, cols: readonly Column[]): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  for (const c of cols) {
    const width = columnWidth(c);
    if (at + c.length * width > bytes.length) return false;
    if (c instanceof Uint8Array) {
      c.set(bytes.subarray(at, at + c.length));
      at += c.length;
    } else if (width === 2) {
      const to = c as Uint16Array;
      for (let i = 0; i < to.length; i++, at += 2) to[i] = view.getUint16(at, true);
    } else if (c instanceof Uint32Array) {
      const to = c as Uint32Array;
      for (let i = 0; i < to.length; i++, at += 4) to[i] = view.getUint32(at, true);
    } else {
      const to = c as Float32Array;
      for (let i = 0; i < to.length; i++, at += 4) to[i] = view.getFloat32(at, true);
    }
  }
  return at === bytes.length;
}

/** Below this many equal bytes in a row it is cheaper to write them out than to say so. */
const MIN_RUN = 4;

/** The most literal bytes one chunk can carry. */
const MAX_LIT = 255;

/**
 * Run-length pack a byte stream.
 *
 * Equal runs of four or more become a three-byte chunk, which is the whole point: a pool
 * that is mostly zeros — every slot nothing was ever allocated in, and most of the ones
 * that have — comes back at a fraction of its size. Literals are buffered, so a stretch
 * of real numbers pays one header per 255 bytes rather than per byte.
 */
function packBytes(src: Uint8Array): Uint8Array {
  // Every chunk costs no more than the bytes it covers plus one header byte, and a
  // literal chunk either reaches 255 bytes or is the last thing written: hence the
  // ceiling rather than a guess.
  const out = new Uint8Array(src.length + Math.ceil(src.length / MAX_LIT) + 4);
  const lit = new Uint8Array(MAX_LIT);
  let at = 0;
  let lc = 0;

  const flush = (): void => {
    if (lc === 0) return;
    out[at++] = lc;
    out.set(lit.subarray(0, lc), at);
    at += lc;
    lc = 0;
  };

  let i = 0;
  while (i < src.length) {
    const b = src[i];
    let run = 1;
    while (i + run < src.length && src[i + run] === b && run < MAX_LIT) run++;

    if (run >= MIN_RUN) {
      flush();
      out[at++] = 0;
      out[at++] = run;
      out[at++] = b;
      i += run;
      continue;
    }

    lit[lc++] = b;
    if (lc === MAX_LIT) flush();
    i++;
  }
  flush();
  return out.subarray(0, at);
}

/**
 * Unpack a byte run, expecting exactly `expect` bytes out, or null if it does not add up.
 *
 * Every read is bounds-checked against both the input and the expected output, so a
 * corrupt blob comes back as "not a save" rather than as garbage written into a pool.
 */
function unpackBytes(src: Uint8Array, expect: number): Uint8Array | null {
  const out = new Uint8Array(expect);
  let at = 0;
  let i = 0;
  while (i < src.length) {
    const marker = src[i++];
    if (marker === 0) {
      if (i + 2 > src.length) return null;
      const count = src[i++];
      const value = src[i++];
      if (at + count > expect) return null;
      out.fill(value, at, at + count);
      at += count;
      continue;
    }
    if (i + marker > src.length || at + marker > expect) return null;
    for (let k = 0; k < marker; k++) out[at++] = src[i++];
  }
  return at === expect ? out : null;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 with padding, written out rather than reached for: no `btoa` in the core. */
function encodeBytes(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const rest = bytes.length - i;
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    text += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    text += rest > 1 ? B64[(n >> 6) & 63] : '=';
    text += rest > 2 ? B64[n & 63] : '=';
  }
  return text;
}

/** Undo it. Null for anything that is not padded base64 of a whole number of groups. */
function decodeBytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const groups = text.length / 4;
  let want = groups * 3;
  if (text.endsWith('==')) want -= 2;
  else if (text.endsWith('=')) want -= 1;

  const out = new Uint8Array(want);
  let at = 0;
  for (let g = 0; g < groups; g++) {
    const i = g * 4;
    // A group is four characters for three bytes; only the last one may be padded, and its
    // '=' says how many bytes it carries. The trailing characters of a short group are
    // padding, not data, so the byte shifts below count from the top of what was read.
    const chars = g === groups - 1 && text[i + 3] === '=' ? (text[i + 2] === '=' ? 2 : 3) : 4;

    let n = 0;
    for (let k = 0; k < chars; k++) {
      const v = B64.indexOf(text[i + k]);
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    for (let k = 0; k < chars - 1; k++) {
      out[at++] = (n >> (6 * chars - 8 * (k + 1))) & 0xff;
    }
  }
  return at === out.length ? out : null;
}

/**
 * A column list out as packed base64, and back.
 *
 * Exported because `replay.ts` stores a tick's worth of packed input the same way a pool
 * stores a body: one codec, two users, so the packing gets read once rather than twice.
 * `decodeBlob` writes straight into the arrays it was handed and answers false when the
 * text is not the shape it claims — a discarded save, never a partly restored one.
 */
export function encodeBlob(cols: readonly Column[]): string {
  const bytes = new Uint8Array(totalWidth(cols));
  packColumns(cols, bytes);
  return encodeBytes(packBytes(bytes));
}

export function decodeBlob(text: string, cols: readonly Column[]): boolean {
  const bytes = decodeBytes(text);
  if (bytes === null) return false;
  const packed = unpackBytes(bytes, totalWidth(cols));
  return packed !== null && unpackColumns(packed, cols);
}
