/**
 * When a run gets written out: the autosave clock, the meta rows a chapter and a run leave
 * behind, and the shelf flag the Continue button reads.
 *
 * `persistence.ts` owns what the files look like; `app.ts` owns the scene. This is the seam
 * between them — the four rules about *when* a save lands, which is the part a save feature
 * actually has to get right and the part no test of the storage layer can see. It lives in its
 * own file for the same reason the state read does: it is a reader of the run plus one piece of
 * bookkeeping, so it is testable against a `Map` with no scene machine at all.
 *
 * Nothing here reaches for `window` or `localStorage`: the shelf arrives as a port, and a
 * storage that refuses is counted through `problems` rather than swallowed (AGENTS.md).
 */

import { autosaveDue, clearSave, createAutosaveTimer, loadMeta, markAutosaved, recordRunEnd, saveMeta, saveRun, saveSettings, type AutosaveTimer, type Meta, type ProblemSink, type Settings, type StorageLike } from './persistence';
import type { World } from '../sim/world';

/**
 * What one run owes the storage, and how much of it it has already paid.
 *
 * It is created with the run rather than with the app, because both halves of it are
 * facts about *this* run: the autosave clock's next due time counts play seconds from
 * this run's start, and "has this chapter's ending been written" only means something
 * while the chapter is part of an unfinished run. A restart that kept the old archive
 * would hand a fresh run a spent clock (ARCHITECTURE.md "The autosave clock counts play
 * seconds"), which is the one way this file can be misused, so it is written down here.
 *
 * `onShelf` is the exception, and it is carried across a restart rather than reset with the
 * rest: it answers "is there a run to come back to", which is a fact about the *file*, not
 * about the run that is playing now. The pause menu's Load asks it every frame.
 */
export interface RunArchive {
  /** When the run is due to be written out: every 30 s of play, and at a chapter's end. */
  autosave: AutosaveTimer;
  /** The chapter whose clearing has been written to the meta; -1 while none has. */
  clearedChapter: number;
  /** The finished run's own history row has been written, so a run is counted once. */
  ended: boolean;
  /** Whether a resumable run is on the shelf, kept current by every write. */
  onShelf: boolean;
}

/** Start the debt of a fresh run, carrying over what is already on the shelf. */
export function createArchive(onShelf = false): RunArchive {
  return { autosave: createAutosaveTimer(), clearedChapter: -1, ended: false, onShelf };
}

/**
 * The shelf a run gets written to, and where a problem about it goes.
 *
 * `benched` and `idle` are read live rather than passed positionally: both decide whether this
 * frame owes a file, and a call that reads `keepShelf(shelf, archive, world, true, true)` is a
 * call somebody has to get the order of right.
 */
export interface Shelf {
  readonly storage: StorageLike | null;
  readonly problems: ProblemSink;
  /** True while a bench rig holds the World — a rig is a measurement, not a run. */
  readonly benched: boolean;
  /** True on the title screen, whose World never started a run. */
  readonly idle: boolean;
  /** Hand the new history to the shell, which keeps a copy the chapter grid reads. */
  wroteMeta(next: Meta): void;
}

/**
 * Store the settings. One call, so a dial click and a keybind change cannot disagree about
 * whether the file got written; a storage that refuses is counted and the change still applies
 * for this run.
 */
export function storeSettings(shelf: Shelf, settings: Settings): void {
  if (shelf.storage === null) return;
  saveSettings(shelf.storage, settings, shelf.problems);
}

/** Add this run to the machine's history, and open what it earned. */
function writeMeta(shelf: Shelf, w: World): void {
  const storage = shelf.storage;
  if (storage === null) return;
  // One read, one write: the file is the history, so a run's row goes onto whatever is
  // already there rather than replacing it, and `recordRunEnd` does the unlocking. The
  // in-memory copy follows the file, so a chapter grid opened after this offers what was
  // earned rather than what was on disk when the page loaded.
  const fresh = recordRunEnd(loadMeta(storage, shelf.problems), w, new Date().toISOString());
  saveMeta(storage, fresh, shelf.problems);
  shelf.wroteMeta(fresh);
}

/**
 * Write the run out now, because the player asked.
 *
 * The clock starts again from here: a hand-written save of the same state the autosave
 * was due for would otherwise spend its next write, a frame later, on nothing new.
 */
export function writeSave(shelf: Shelf, archive: RunArchive, w: World): void {
  const storage = shelf.storage;
  if (storage === null) return;
  if (saveRun(storage, w, shelf.problems)) archive.onShelf = true;
  markAutosaved(archive.autosave, w);
}

/**
 * Keep the storage in step with the run: the autosave clock, and the meta write when a
 * chapter or the run ends.
 *
 * Four rules hold it together, and all four exist because a save that lands at the wrong
 * moment is worse than one that does not land:
 *
 * - A chapter's end is recorded, keyed by *which* chapter, and it is recorded before the
 *   autosave writes, because that write is the one that lets the next floor be resumed.
 * - A finished run writes its history row and then loses its slot. A dead or won run is
 *   not a run to come back to, and `persistence.ts` is explicit that a save of one is a
 *   Continue button into a game you already finished.
 * - A failed write is counted and the interval restarts anyway. Retrying a storage that
 *   refused (quota, private mode) every frame would spend the run's whole error budget on
 *   one bad write.
 * - A bench page writes nothing, before its window ends or after. Its World is a rig rather than
 *   a run: a thousand seeded bodies cost megabytes of storage, would blow the quota, and would
 *   then hand the next player a Continue into a test bench. The window ending does not turn the
 *   page back into a session — the floor stays full of seeded bodies — so the rule is about the
 *   rig, not about whether it is still timing. Earning a chapter from a bench is the same
 *   category of untruth, so the meta write waits for a run that was played.
 */
export function keepShelf(shelf: Shelf, archive: RunArchive, w: World): void {
  const storage = shelf.storage;
  if (storage === null || shelf.idle || shelf.benched) return;

  if (w.over || w.victory) {
    if (archive.ended) return;
    archive.ended = true;
    writeMeta(shelf, w);
    clearSave(storage, shelf.problems);
    archive.onShelf = false;
    return;
  }

  if (w.chapterComplete && w.chapter !== archive.clearedChapter) {
    archive.clearedChapter = w.chapter;
    writeMeta(shelf, w);
  }

  if (autosaveDue(archive.autosave, w)) {
    if (saveRun(storage, w, shelf.problems)) archive.onShelf = true;
    markAutosaved(archive.autosave, w);
  }
}