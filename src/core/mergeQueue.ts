import * as fs from 'fs';
import * as path from 'path';

/** Integration mode chosen at submission; drives gate, action, and status name. */
export type MergeMode = 'manual-review' | 'auto-merge' | 'auto-pr';

/** One task's place in the shared right-of-way queue. */
export interface QueueEntry {
  taskId: string;
  branch: string;
  /** Repo-root-relative worktree path, e.g. `.worktrees/task-7-login`. */
  worktree: string;
  mode: MergeMode;
  /** ISO-8601 submission time. */
  submittedAt: string;
  /** Set by the board UI (manual-review gate). */
  approved: boolean;
  /** True while the head performs its merge. */
  active: boolean;
  /** ISO-8601 time the head went active, or null. */
  activeAt: string | null;
}

export interface MergeQueue {
  version: 1;
  entries: QueueEntry[];
}

export const EMPTY_QUEUE: MergeQueue = { version: 1, entries: [] };

/** Append `entry` unless its taskId is already queued (idempotent). */
export function enqueueEntry(queue: MergeQueue, entry: QueueEntry): MergeQueue {
  if (queue.entries.some((e) => e.taskId === entry.taskId)) return queue;
  return { version: 1, entries: [...queue.entries, entry] };
}

/** The right-of-way holder (first entry), or undefined when empty. */
export function headEntry(queue: MergeQueue): QueueEntry | undefined {
  return queue.entries[0];
}

/** 1-based position of `taskId`, or 0 when absent. */
export function positionOf(queue: MergeQueue, taskId: string): number {
  const i = queue.entries.findIndex((e) => e.taskId === taskId);
  return i < 0 ? 0 : i + 1;
}

function patchEntry(queue: MergeQueue, taskId: string, patch: Partial<QueueEntry>): MergeQueue {
  return {
    version: 1,
    entries: queue.entries.map((e) => (e.taskId === taskId ? { ...e, ...patch } : e)),
  };
}

/** Mark a queued task approved (written by the board's Approve control). */
export function approveEntry(queue: MergeQueue, taskId: string): MergeQueue {
  return patchEntry(queue, taskId, { approved: true });
}

/** Remove a task from the queue (dequeue on completion, or Send back). */
export function removeEntry(queue: MergeQueue, taskId: string): MergeQueue {
  return { version: 1, entries: queue.entries.filter((e) => e.taskId !== taskId) };
}

/** Mark a task as the active head performing its merge, at ISO time `atIso`. */
export function markEntryActive(queue: MergeQueue, taskId: string, atIso: string): MergeQueue {
  return patchEntry(queue, taskId, { active: true, activeAt: atIso });
}

/**
 * True when the head has been `active` longer than `timeoutMinutes` — a crashed
 * agent that wedged the queue. Reclaimable: drop the stale head, promote next.
 */
export function isHeadStale(queue: MergeQueue, timeoutMinutes: number, now: Date): boolean {
  const head = headEntry(queue);
  if (!head || !head.active || !head.activeAt) return false;
  const startedMs = Date.parse(head.activeAt);
  if (Number.isNaN(startedMs)) return false;
  return now.getTime() - startedMs > timeoutMinutes * 60_000;
}

/** Injectable fs for the queue store; `writeAtomic` must be crash-safe. */
export interface QueueFsDeps {
  exists(p: string): boolean;
  read(p: string): string;
  writeAtomic(p: string, data: string): void;
}

/** Default adapter: real fs with mkdir + temp-then-rename atomic write. */
export const nodeQueueFs: QueueFsDeps = {
  exists: (p) => fs.existsSync(p),
  read: (p) => fs.readFileSync(p, 'utf-8'),
  writeAtomic: (p, data) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, p);
  },
};

/** `<commonDir>/taskwright/merge-queue.json` — shared across all worktrees. */
export function mergeQueuePath(commonDir: string): string {
  return path.join(commonDir, 'taskwright', 'merge-queue.json');
}

/**
 * File-backed shared queue. `read` tolerates missing/corrupt files as
 * {@link EMPTY_QUEUE}; `mutate` is a read-modify-write persisted atomically.
 * (Single-writer-at-a-time is enforced by the right-of-way rule, not by locking.)
 */
export class MergeQueueStore {
  constructor(
    private readonly filePath: string,
    private readonly fsDeps: QueueFsDeps
  ) {}

  read(): MergeQueue {
    if (!this.fsDeps.exists(this.filePath)) return EMPTY_QUEUE;
    try {
      const data = JSON.parse(this.fsDeps.read(this.filePath)) as Partial<MergeQueue>;
      if (Array.isArray(data?.entries))
        return { version: 1, entries: data.entries as QueueEntry[] };
    } catch {
      // fall through — treat as empty
    }
    return EMPTY_QUEUE;
  }

  mutate(fn: (queue: MergeQueue) => MergeQueue): MergeQueue {
    const next = fn(this.read());
    this.fsDeps.writeAtomic(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
