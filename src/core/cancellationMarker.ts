import * as fs from 'fs';
import * as path from 'path';

/**
 * The cancellation marker is Taskwright's task/worktree-scoped stop signal for a
 * dispatched agent. When a human cancels a dispatch, the extension writes this marker
 * into the task's worktree `.taskwright/` BEFORE tearing the worktree down (the ordering
 * is load-bearing — see src/core/cancelDispatch.ts). A dispatched `/execute-task` session
 * polls for it at each checkpoint and stops cleanly (it never calls request_merge).
 *
 * Mirrors src/core/activeTask.ts (STATE_DIR `.taskwright`, mkdir-on-write, never-throws
 * reads) with ONE deliberate divergence: detection is PRESENCE-ONLY. `isCancelled` is a
 * bare existence check and never reads or parses the file — the JSON `taskId` it stores is
 * for human/debug legibility, never for control flow. State lives at
 * `<root>/.taskwright/cancelled`, where `root` is the worktree the session runs in.
 * Local/ephemeral (git-ignored), never shared.
 */

export interface CancellationMarker {
  /** ID of the cancelled task — for human/debug legibility only, never parsed for control. */
  taskId: string;
  /** ISO-8601 timestamp of when the dispatch was cancelled. */
  cancelledAt: string;
}

const STATE_DIR = '.taskwright';
const STATE_FILE = 'cancelled';

/** Absolute path of the cancellation marker file under `root`. */
export function cancellationMarkerPath(root: string): string {
  return path.join(root, STATE_DIR, STATE_FILE);
}

/**
 * True when a cancellation marker exists for `root`. Presence-only — the file's contents
 * are never read or parsed. Never throws (a missing file / unreadable path ⇒ false).
 */
export function isCancelled(root: string): boolean {
  try {
    return fs.existsSync(cancellationMarkerPath(root));
  } catch {
    return false;
  }
}

/** Write a cancellation marker for `root`, creating the state dir if needed. */
export function writeCancellationMarker(
  root: string,
  taskId: string,
  now: Date = new Date()
): CancellationMarker {
  const marker: CancellationMarker = { taskId, cancelledAt: now.toISOString() };
  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  fs.writeFileSync(cancellationMarkerPath(root), `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
  return marker;
}

/** Clear the cancellation marker for `root`. Idempotent — a missing file is fine. */
export function clearCancellationMarker(root: string): void {
  try {
    fs.unlinkSync(cancellationMarkerPath(root));
  } catch {
    // already absent — nothing to clear
  }
}
