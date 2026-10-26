/**
 * The two buffers a tick writes into and reads back later: the event ring and the stack
 * of waiting blasts.
 *
 * Both exist so a fact can be *announced* where it happens and *paid out* later without
 * the two halves having to know about each other. The ring is a broadcast, not a queue —
 * nothing in the sim is required to drain it, which is why a consumer keeps its own cursor
 * into `written`. A drain would make the first reader silence the rest, and the first
 * reader is whichever feature got written first. The blast stack is a stack, not a
 * recursion: a burst that kills a second bomber queues another entry rather than calling
 * itself, and `resolveBlasts` in `systems/enemies/deaths.ts` walks it until it is empty.
 *
 * The functions still take a whole `World` rather than the buffer inside it, so every
 * caller that hands them `w` keeps working; the import of `World` is type-only and this
 * file therefore has no runtime dependency on `world.ts`.
 */

import type { World } from './world';

/**
 * Circular event buffer, oldest first, dropping the oldest on overflow.
 *
 * It is a broadcast, not a queue: nothing in the sim is required to drain it, which is
 * why a consumer (the particle field in `fx.ts`, later audio) keeps its own cursor into
 * `written` rather than consuming `count`.
 */
export interface EventRing {
  readonly cap: number;
  readonly type: Int32Array;
  readonly a: Int32Array;
  readonly b: Int32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Next write slot. */
  head: number;
  /** Unread events. */
  count: number;
  /** Events dropped for lack of room; keeps the loss observable. */
  dropped: number;
  /**
   * How many events have ever been pushed, which is what makes a cursor possible: the
   * unread window is `[written - count, written)` and a slot is `written % cap`. Only
   * `clearEvents` resets it, and only because that call means "nobody wants the past".
   */
  written: number;
}

/**
 * Death blasts waiting to be resolved, newest at the top of the stack.
 *
 * A blast is queued where the death happens and paid out later in the tick, in
 * `resolveBlasts`, rather than resolved inside the kill. Two reasons, both about
 * correctness rather than tidiness: the kill happens while a shot is walking the
 * tick's shared hash-query buffer, and a blast that queried it there would rewrite
 * the very list the shot is still iterating; and a blast that kills another bomber
 * queues another blast, which wants a stack to land on rather than recursion.
 */
export interface BlastStack {
  readonly cap: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Metres of reach the burst carries. */
  readonly r: Float32Array;
  /** Damage at the centre, before armour. */
  readonly dmg: Float32Array;
  /** How many blasts deep this one was queued, capped by the resolver. */
  readonly chain: Uint8Array;
  count: number;
  /** Bursts dropped because the stack was full; keeps the loss observable. */
  dropped: number;
  /**
   * How deep the burst being paid out right now sits, so a death caused by a burst can
   * mark its own child instead of starting a fresh chain. Only `resolveBlasts` writes it,
   * and it is back to 0 between ticks.
   */
  depth: number;
}

/** The stack of waiting bursts. See `BlastStack`. */
export function createBlastStack(cap: number): BlastStack {
  return {
    cap,
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    r: new Float32Array(cap),
    dmg: new Float32Array(cap),
    chain: new Uint8Array(cap),
    count: 0,
    dropped: 0,
    depth: 0,
  };
}

/**
 * Append an event. On overflow the oldest unread event is dropped and counted,
 * because the sim must never block on a consumer (ARCHITECTURE.md). A full ring
 * has its read cursor sitting on `head`, so overwriting that slot is the drop.
 */
export function pushEvent(w: World, type: number, a: number, b: number, x: number, y: number): void {
  const e = w.events;
  if (e.count === e.cap) {
    e.count--;
    e.dropped++;
  }
  const i = e.head;
  e.type[i] = type;
  e.a[i] = a;
  e.b[i] = b;
  e.x[i] = x;
  e.y[i] = y;
  e.head = (i + 1) % e.cap;
  e.count++;
  e.written++;
}

/**
 * The slot a cursor points at, for a consumer that tracks `written` rather than
 * `count` (see `EventRing`). Returns -1 for a position already overwritten.
 */
export function eventAt(w: World, at: number): number {
  const e = w.events;
  if (at < 0 || at >= e.written || at < e.written - e.count) return -1;
  return at % e.cap;
}

/** Slot index of the k-th unread event, 0 = oldest; -1 when k is out of range. */
export function eventSlot(w: World, k: number): number {
  const e = w.events;
  if (k < 0 || k >= e.count) return -1;
  return (e.head - e.count + k + e.cap * 2) % e.cap;
}

/** Slot index of the first unread event of `type`, or -1. */
export function findEvent(w: World, type: number): number {
  const e = w.events;
  for (let k = 0; k < e.count; k++) {
    const i = (e.head - e.count + k + e.cap * 2) % e.cap;
    if (e.type[i] === type) return i;
  }
  return -1;
}

export function countEvents(w: World, type: number): number {
  const e = w.events;
  const base = (e.head - e.count + e.cap * 2) % e.cap;
  let n = 0;
  for (let k = 0; k < e.count; k++) {
    if (e.type[(base + k) % e.cap] === type) n++;
  }
  return n;
}

/**
 * Drop every unread event; the consumers call this once per rendered frame.
 *
 * `written` goes back to zero with them, so a consumer that tracks a cursor starts from
 * the same reset point rather than reading a window that no longer exists. What a
 * consumer loses by this call is the events that arrived since its last look, which is
 * why the particle field keeps a cursor instead of calling this: the ring is a broadcast.
 */
export function clearEvents(w: World): void {
  const e = w.events;
  e.head = 0;
  e.count = 0;
  e.written = 0;
}