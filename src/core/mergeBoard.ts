import { type MergeMode, type MergeQueue, positionOf } from './mergeQueue';

/** A queued task's board-facing state, derived from the shared merge queue. */
export interface MergeTaskState {
  queued: boolean;
  /** 1-based FIFO position (1 = right-of-way head). */
  position: number;
  /** Human-approved (manual-review gate satisfied). */
  approved: boolean;
  /** The head is performing its merge right now. */
  active: boolean;
  /** The integration mode captured on the entry at submission. */
  mode: MergeMode;
}

/** Derive `taskId`'s merge state from the queue, or undefined when not queued. */
export function mergeStateForTask(queue: MergeQueue, taskId: string): MergeTaskState | undefined {
  const entry = queue.entries.find((e) => e.taskId === taskId);
  if (!entry) return undefined;
  return {
    queued: true,
    position: positionOf(queue, taskId),
    approved: entry.approved,
    active: entry.active,
    mode: entry.mode,
  };
}
