/**
 * Autosave: when the run is due to be written out.
 *
 * The timer is fed *simulated* seconds (`world.time`), never a wall clock, and that is the
 * whole design: time in this game only advances while the sim steps, so a pause, a
 * level-up card screen, a backgrounded tab and a frame that ran out of its step cap all
 * hold the clock still, and an interval measured on it cannot be talked into a save by a
 * stall. It also means the timer is pure enough to test without a renderer, a clock or a
 * browser — which is why this half of the persistence layer sits apart from the two that
 * read and write storage.
 */

import type { World } from '../../sim/world';

/** Seconds of play between autosaves — TECH.md's cadence, written down once. */
export const AUTOSAVE_INTERVAL = 30;

/**
 * When the run is due to be written out.
 *
 * It counts play seconds, not wall-clock ones (see the header), so nothing outside the
 * simulation can pull a save forward.
 */
export interface AutosaveTimer {
  /** Seconds of play between writes. */
  readonly interval: number;
  /** Play seconds at which the next write is due. */
  nextAt: number;
  /** The chapter whose ending has been written since it happened; -1 while none has. */
  endChapter: number;
}

/** A timer for one run: the first write is due a full interval in, or at a chapter's end. */
export function createAutosaveTimer(interval: number = AUTOSAVE_INTERVAL): AutosaveTimer {
  return { interval, nextAt: interval, endChapter: -1 };
}

/**
 * Whether the run should be written right now.
 *
 * A chapter end stays due until somebody acts on it, and it is keyed by *which* chapter
 * ended rather than by "an ending has been written". Both halves matter. The flag outlives
 * the encounter by four seconds of intermission, so a rule that only fired on the rising
 * edge would need somebody to notice the tick it happened on; and a rule that fired once
 * per *run* would spend its one allowance on chapter one and let chapters two and three
 * end unwritten — the intermission is four seconds long and the autosave clock is thirty,
 * so a chapter can easily finish inside the gap its predecessor opened.
 *
 * A victory is not covered here. `victory` arrives after the intermission, by which time
 * there is no chapter left to resume, and a save of a finished run is a Resume button that
 * puts you back inside a game you already won.
 */
export function autosaveDue(timer: AutosaveTimer, world: World): boolean {
  if (world.chapterComplete && world.chapter !== timer.endChapter) return true;
  return world.time >= timer.nextAt;
}

/**
 * Record that the run was written, and start the next interval from where it was written.
 *
 * The timer belongs to a run the way the World does: a restart builds a new World, and the
 * timer is created with it. Handing a spent timer to a fresh run would leave it waiting out
 * an interval it has no way to be inside, which is the one way this helper can be
 * misused, so it is written down here rather than hidden in a name.
 */
export function markAutosaved(timer: AutosaveTimer, world: World): void {
  timer.nextAt = world.time + timer.interval;
  timer.endChapter = world.chapterComplete ? world.chapter : -1;
}
