import {
  MergeQueueStore,
  mergeQueuePath,
  approveEntry,
  removeEntry,
  isBranchMergeKey,
  branchFromMergeKey,
  nodeQueueFs,
  type QueueFsDeps,
} from '../core/mergeQueue';
import { IN_PROGRESS } from '../core/mergeConfig';
import type { BacklogParser } from '../core/BacklogParser';
import type { BacklogWriter } from '../core/BacklogWriter';

function storeFor(commonDir: string, fsDeps: QueueFsDeps): MergeQueueStore {
  return new MergeQueueStore(mergeQueuePath(commonDir), fsDeps);
}

/** Grant the manual-review gate: set `approved:true` on the queued task. */
export function approveMergeInQueue(
  commonDir: string,
  taskId: string,
  fsDeps: QueueFsDeps = nodeQueueFs
): void {
  storeFor(commonDir, fsDeps).mutate((q) => approveEntry(q, taskId));
}

/** Reject: drop the task from the queue (does not touch the board status). */
export function sendBackInQueue(
  commonDir: string,
  taskId: string,
  fsDeps: QueueFsDeps = nodeQueueFs
): void {
  storeFor(commonDir, fsDeps).mutate((q) => removeEntry(q, taskId));
}

/**
 * A task-less (branch) merge waiting in the queue — TASK-127.
 *
 * Task merges are reviewed from their board card; a branch merge has no card, so
 * the manual-review gate would otherwise be ungrantable and the dev session would
 * block forever. These are what the "Review Branch Merge" command lists.
 */
export interface PendingBranchMerge {
  /** The queue key (`branch:<name>`) — what approve/send-back is keyed by. */
  key: string;
  branch: string;
  /** Repo-root-relative worktree path. */
  worktree: string;
  submittedAt: string;
  approved: boolean;
  /** 1-based place in the shared FIFO (task merges included). */
  position: number;
}

/** Every task-less merge currently in the queue, in queue order. */
export function pendingBranchMerges(
  commonDir: string,
  fsDeps: QueueFsDeps = nodeQueueFs
): PendingBranchMerge[] {
  return storeFor(commonDir, fsDeps)
    .read()
    .entries.map((entry, index) => ({ entry, position: index + 1 }))
    .filter(({ entry }) => isBranchMergeKey(entry.taskId))
    .map(({ entry, position }) => ({
      key: entry.taskId,
      branch: branchFromMergeKey(entry.taskId) ?? entry.branch,
      worktree: entry.worktree,
      submittedAt: entry.submittedAt,
      approved: entry.approved,
      position,
    }));
}

/**
 * Send a queued task back to work: remove its queue entry and reset its board
 * status to `In Progress`. The status reset makes the board reflect the
 * rejection immediately, even if no agent is currently blocked on the entry
 * (a blocked agent's `request_merge` also returns `sent_back` and resets the
 * status; both write the same value, so this is safe/idempotent).
 */
export async function sendBackMerge(
  commonDir: string,
  taskId: string,
  parser: BacklogParser,
  writer: BacklogWriter,
  fsDeps: QueueFsDeps = nodeQueueFs
): Promise<void> {
  sendBackInQueue(commonDir, taskId, fsDeps);
  // The dequeue above is the authoritative "send back" action and has already
  // happened. The status reset is just a convenience so the board reflects it
  // immediately — a blocked agent's own `request_merge` also resets the status
  // to `In Progress`. So treat this as best-effort: if the task file vanished
  // or the write fails for any reason, swallow the error rather than letting
  // it surface as a misleading "Failed to send back".
  try {
    const task = await parser.getTask(taskId);
    if (task) {
      await writer.updateTask(taskId, { status: IN_PROGRESS }, parser);
    }
  } catch {
    // best-effort; dequeue already succeeded
  }
}
