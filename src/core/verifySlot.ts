import * as fs from 'fs';
import * as path from 'path';

/**
 * The verify slot: a shared, cross-process mutex that lets exactly ONE
 * `request_merge` run its verify suite at a time (TASK-126).
 *
 * Why: the merge queue serializes the *merge*, but every caller ran its verify
 * commands BEFORE enqueuing — so N concurrent `/orchestrate-board` subagents ran
 * N full `bun run test` suites simultaneously. Each vitest run already saturates
 * the CPU with its own worker pool, so N of them oversubscribe the machine by
 * ~N×; git-subprocess-heavy tests then blow their per-test timeouts and the
 * whole verify aborts `verify_failed` — a pure load artefact (every test passes
 * in isolation). Agents responded by blind-retrying, or by pushing
 * `verifyTimeoutMinutes` ever higher, which masks the contention instead of
 * removing it.
 *
 * The slot removes it: verify runs are serialized against each other, so a
 * verify sees the machine as it would in isolation.
 *
 * Design notes:
 *  - **Cross-process by construction.** Concurrent `request_merge` calls may
 *    arrive on one MCP server (in-session subagents) or on several (separate
 *    sessions/editor windows sharing the repo). An in-process mutex would only
 *    cover the first, so the slot is a lock FILE in the shared `commonDir`,
 *    taken with an O_EXCL create — atomic for both cases at once.
 *  - **Never held across a wait on anything else.** `requestMerge` takes the
 *    slot for the verify run and releases it before it parks in the merge queue,
 *    so slot-holder → queue-waiter → slot-waiter cycles cannot form.
 *  - **Self-healing.** A crashed holder must not wedge every future merge, so a
 *    lock is stealable when its holder's process is gone, when its lease has
 *    expired (worst-case duration of the whole verify run + grace), or when the
 *    record is unreadable (a torn write).
 */

/** The record written into the lock file by whoever holds the slot. */
export interface VerifySlotHolder {
  /** Task ID of the holder — what a waiter shows the human. */
  owner: string;
  /** OS process of the holder, so a dead holder is stealable immediately. */
  pid: number;
  /** ISO-8601 acquisition time; the lease is measured from here. */
  acquiredAt: string;
}

/** What a waiter learns about the current holder, once per poll. */
export interface VerifySlotWaitInfo {
  /** The holding task's ID (or 'another session' when the record is unreadable). */
  heldBy: string;
  /** Whole seconds this caller has been waiting for the slot. */
  waitedSeconds: number;
}

/** Releases the slot. Idempotent, and never throws. */
export type VerifySlotRelease = () => Promise<void>;

/**
 * A serialization slot for verify runs. `acquire` resolves only when the caller
 * holds the slot exclusively.
 */
export interface VerifySlot {
  acquire(owner: string, onWait?: (info: VerifySlotWaitInfo) => void): Promise<VerifySlotRelease>;
}

/** Injectable fs for the slot; `createExclusive` MUST fail when the path exists. */
export interface VerifySlotFs {
  exists(p: string): boolean;
  read(p: string): string;
  /** Create the file atomically, failing (EEXIST) when it already exists (O_EXCL). */
  createExclusive(p: string, data: string): void;
  remove(p: string): void;
}

/** Default adapter: real fs, with an O_EXCL create (`wx`) as the atomic primitive. */
export const nodeVerifySlotFs: VerifySlotFs = {
  exists: (p) => fs.existsSync(p),
  read: (p) => fs.readFileSync(p, 'utf-8'),
  createExclusive: (p, data) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data, { encoding: 'utf-8', flag: 'wx' });
  },
  remove: (p) => {
    try {
      fs.unlinkSync(p);
    } catch {
      // already gone — releasing a vanished slot is a no-op
    }
  },
};

/** `<commonDir>/taskwright/verify-slot.lock` — shared across every worktree. */
export function verifySlotPath(commonDir: string): string {
  return path.join(commonDir, 'taskwright', 'verify-slot.lock');
}

/** Grace added on top of the worst-case verify duration before a lease is stealable. */
const LEASE_GRACE_MS = 120_000;

/**
 * How long a held slot stays valid: the worst case a verify run can legitimately
 * take — every command running to its full timeout — plus grace. Shorter than
 * this and a slow-but-healthy verify would have its slot stolen out from under
 * it, re-creating the very contention the slot exists to prevent.
 */
export function verifySlotLeaseMs(verifyTimeoutMs: number, commandCount: number): number {
  const worstCase = Math.max(1, commandCount) * Math.max(1, verifyTimeoutMs);
  return worstCase + LEASE_GRACE_MS;
}

/** Parse a holder record; null when the file is empty, corrupt, or the wrong shape. */
export function parseSlotHolder(raw: string): VerifySlotHolder | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const { owner, pid, acquiredAt } = parsed as Record<string, unknown>;
    if (typeof owner !== 'string' || typeof pid !== 'number' || typeof acquiredAt !== 'string') {
      return null;
    }
    return { owner, pid, acquiredAt };
  } catch {
    return null; // torn/partial write — treat as stealable
  }
}

/** True when signal 0 reaches the pid (i.e. the process still exists). */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return (error as { code?: string }).code === 'EPERM';
  }
}

export interface VerifySlotOptions {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Stealable after this long without a release (see {@link verifySlotLeaseMs}). */
  leaseMs: number;
  /** Base poll interval while waiting; jittered per iteration. Default 1000ms. */
  pollIntervalMs?: number;
  /** This process's pid, written into the holder record. */
  pid?: number;
  /** Liveness probe for a holder's pid. Overridable for tests. */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * File-backed {@link VerifySlot}. Acquisition is a poll loop around an O_EXCL
 * create: free ⇒ take it; held ⇒ steal it when the holder is provably gone
 * (dead pid / expired lease / unreadable record), else wait and re-check.
 */
export class FileVerifySlot implements VerifySlot {
  private readonly pollIntervalMs: number;
  private readonly pid: number;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(
    private readonly filePath: string,
    private readonly fsDeps: VerifySlotFs,
    private readonly opts: VerifySlotOptions
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.pid = opts.pid ?? process.pid;
    this.isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  }

  async acquire(
    owner: string,
    onWait?: (info: VerifySlotWaitInfo) => void
  ): Promise<VerifySlotRelease> {
    const startedMs = this.opts.now().getTime();
    for (;;) {
      const acquiredAt = this.opts.now().toISOString();
      const record: VerifySlotHolder = { owner, pid: this.pid, acquiredAt };
      try {
        this.fsDeps.createExclusive(this.filePath, `${JSON.stringify(record, null, 2)}\n`);
        return this.releaserFor(record);
      } catch {
        // Taken (EEXIST) — or the directory raced with us. Fall through and inspect.
      }

      const holder = this.readHolder();
      if (holder === null || this.isStale(holder)) {
        // Provably abandoned (crashed holder / expired lease / torn write): drop
        // it and retry the create at once. The retry is what makes this safe —
        // if two waiters steal concurrently, only one wins the O_EXCL create.
        this.fsDeps.remove(this.filePath);
        continue;
      }

      if (onWait) {
        const waitedSeconds = Math.max(
          0,
          Math.round((this.opts.now().getTime() - startedMs) / 1000)
        );
        onWait({ heldBy: holder.owner, waitedSeconds });
      }
      const base = this.pollIntervalMs;
      await this.opts.sleep(base + Math.floor(Math.random() * base)); // jittered
    }
  }

  /** The holder record currently on disk, or null when absent/unreadable. */
  private readHolder(): VerifySlotHolder | null {
    if (!this.fsDeps.exists(this.filePath)) return null;
    try {
      return parseSlotHolder(this.fsDeps.read(this.filePath));
    } catch {
      return null; // vanished between exists() and read()
    }
  }

  /** True when the holder is provably gone: dead process, or an expired lease. */
  private isStale(holder: VerifySlotHolder): boolean {
    if (!this.isProcessAlive(holder.pid)) return true;
    const startedMs = Date.parse(holder.acquiredAt);
    if (Number.isNaN(startedMs)) return true; // unusable timestamp ⇒ stealable
    return this.opts.now().getTime() - startedMs > this.opts.leaseMs;
  }

  /**
   * A release that only removes the lock if WE still hold it. A slot stolen from
   * us (lease expired) and re-taken by someone else must survive our release, or
   * we would evict a legitimate holder and re-admit the contention.
   */
  private releaserFor(mine: VerifySlotHolder): VerifySlotRelease {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        const holder = this.readHolder();
        if (
          holder !== null &&
          holder.owner === mine.owner &&
          holder.pid === mine.pid &&
          holder.acquiredAt === mine.acquiredAt
        ) {
          this.fsDeps.remove(this.filePath);
        }
      } catch {
        // Best effort: a release that throws must never fail the merge. A leaked
        // lock is self-healing — its lease expires, or its pid dies with us.
      }
    };
  }
}
