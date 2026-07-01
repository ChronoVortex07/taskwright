import {
  MergeQueueStore,
  mergeQueuePath,
  approveEntry,
  removeEntry,
  nodeQueueFs,
  type QueueFsDeps,
} from '../core/mergeQueue';
import type { BacklogParser } from '../core/BacklogParser';
import type { BacklogWriter } from '../core/BacklogWriter';

const IN_PROGRESS = 'In Progress';

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
