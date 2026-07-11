import * as fs from 'fs';
import * as path from 'path';
import {
  defaultBoardExec,
  fetchRef,
  refTip,
  pushRef,
  isAncestor,
  mergeBaseOf,
  readRefFileMap,
  commitMergedTree,
  NO_EOL_CONVERT,
  type BoardGitExec,
} from './boardRef';
import { mergeBoards, type MergeConflict } from './boardMerge';
import { boardTrackedPaths } from './boardMigration';
import { boardWorktreePathFor } from './boardRoot';

/**
 * Event-driven auto-sync for the git-auto board home (TASK-91, spec §3).
 * A deliberately small state machine — the v1 postmortem invariants are
 * load-bearing and enforced structurally here:
 *
 * - ONE copy: every step targets the hidden board worktree / its branch.
 * - NO background interval: callers fire events (activation, write debounce,
 *   request_merge boundaries, manual commands); nothing polls.
 * - NEVER `reset --hard`: the commit step runs first under the same lock, and
 *   the worktree is advanced with `reset --keep` (aborts rather than destroys).
 * - Degrade, never block: `runBoardAutoSync` never throws — failures come back
 *   as an outcome for the status bar; a board write is never failed by sync.
 */

/** Identity fallback so repos/CI without a git identity can still capture. */
const COMMIT_IDENTITY = ['-c', 'user.name=Taskwright', '-c', 'user.email=taskwright@local'];

export interface AutoCommitResult {
  committed: boolean;
  sha?: string;
}

/**
 * Debounced local capture: stage ONLY the five board state dirs (pathspec-
 * limited so the branch can never grow a non-board path — old v2 clients'
 * materialize guard would refuse the ref on their next pull) and commit.
 * No-op when the tree is clean.
 */
export async function autoCommitBoard(
  boardWorktree: string,
  opts: { exec?: BoardGitExec; pathExists?: (p: string) => boolean; messagePrefix?: string } = {}
): Promise<AutoCommitResult> {
  const exec = opts.exec ?? defaultBoardExec;
  const pathExists = opts.pathExists ?? fs.existsSync;
  const paths = boardTrackedPaths();

  const status = (
    await exec(boardWorktree, [...NO_EOL_CONVERT, 'status', '--porcelain', '--', ...paths])
  ).stdout;
  if (status.trim().length === 0) return { committed: false };

  // `git add` fails on a pathspec matching nothing, so only pass state dirs
  // that exist on disk or have status entries (deleted-but-tracked).
  const statusTargets = status
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((p) => p.length > 0);
  const addPaths = paths.filter(
    (p) =>
      pathExists(path.join(boardWorktree, p)) || statusTargets.some((t) => t.startsWith(`${p}/`))
  );
  if (addPaths.length === 0) return { committed: false };

  await exec(boardWorktree, [...NO_EOL_CONVERT, 'add', '-A', '--', ...addPaths]);
  try {
    await exec(boardWorktree, [
      ...NO_EOL_CONVERT,
      ...COMMIT_IDENTITY,
      'commit',
      '-m',
      `${opts.messagePrefix ?? 'chore(taskwright): board auto-commit'}`,
    ]);
  } catch {
    // Everything staged was a no-op (e.g. eol-only churn) — nothing to commit.
    return { committed: false };
  }
  const sha = (await exec(boardWorktree, ['rev-parse', 'HEAD'])).stdout.trim();
  return { committed: true, sha };
}

/**
 * Cross-process single-flight: an atomic `mkdir` lock with stale-steal.
 * Returns a release fn, or null when another process holds a fresh lock.
 */
export function acquireSyncLock(lockDir: string, staleMs = 60_000): (() => void) | null {
  const lockPath = path.join(lockDir, 'board-sync.lock');
  const tryAcquire = (): (() => void) | null => {
    try {
      fs.mkdirSync(lockPath);
      return () => {
        try {
          fs.rmdirSync(lockPath);
        } catch {
          // already gone — fine
        }
      };
    } catch {
      return null;
    }
  };

  const first = tryAcquire();
  if (first) return first;
  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age > staleMs) {
      fs.rmdirSync(lockPath);
      return tryAcquire();
    }
  } catch {
    // Lock vanished between checks — race lost or won; one more attempt.
    return tryAcquire();
  }
  return null;
}

export interface AutoSyncOutcome {
  /** True when the pre-sync capture made a commit. */
  committed: boolean;
  /** The board branch tip after capture (pre-merge), when it resolved. */
  localTip?: string;
  /** The fetched remote tip; null when no remote / unreachable / no ref. */
  remoteTip: string | null;
  /** True when a two-parent fold of the remote was committed. */
  merged: boolean;
  pushed: boolean;
  /** True when the push was rejected non-fast-forward (remote moved again). */
  rejected: boolean;
  conflicts: MergeConflict[];
  /** Present when a step failed; the sync degraded rather than threw. */
  error?: string;
}

export interface RunBoardAutoSyncOptions {
  primaryRoot: string;
  ref: string;
  remote: string;
  /** Directory holding the cross-process lock; defaults to `<primary>/.taskwright`. */
  lockDir?: string;
  exec?: BoardGitExec;
}

/**
 * One sync pass: commit-if-dirty → fetch (explicit refspec via `fetchRef`'s
 * staging ref — the FETCH_HEAD-race lesson) → fold a diverged remote with
 * `mergeBoards` as a real two-parent commit → advance the worktree with
 * `reset --keep` → push best-effort. Never throws; single-flight via the lock.
 */
export async function runBoardAutoSync(
  opts: RunBoardAutoSyncOptions
): Promise<AutoSyncOutcome | { skipped: 'locked' }> {
  const exec = opts.exec ?? defaultBoardExec;
  const lockDir = opts.lockDir ?? path.join(opts.primaryRoot, '.taskwright');
  fs.mkdirSync(lockDir, { recursive: true });
  const release = acquireSyncLock(lockDir);
  if (!release) return { skipped: 'locked' };

  const outcome: AutoSyncOutcome = {
    committed: false,
    remoteTip: null,
    merged: false,
    pushed: false,
    rejected: false,
    conflicts: [],
  };
  try {
    const worktree = boardWorktreePathFor(opts.primaryRoot);
    outcome.committed = (await autoCommitBoard(worktree, { exec })).committed;

    const localTip = await refTip(opts.primaryRoot, opts.ref, exec);
    if (!localTip) {
      outcome.error = `board branch "${opts.ref}" does not exist`;
      return outcome;
    }
    outcome.localTip = localTip;

    outcome.remoteTip = await fetchRef(opts.primaryRoot, opts.remote, opts.ref, exec);

    if (
      outcome.remoteTip &&
      !(await isAncestor(opts.primaryRoot, outcome.remoteTip, localTip, exec))
    ) {
      const baseSha = await mergeBaseOf(opts.primaryRoot, localTip, outcome.remoteTip, exec);
      const baseMap = baseSha ? await readRefFileMap(opts.primaryRoot, baseSha, exec) : undefined;
      const oursMap = await readRefFileMap(opts.primaryRoot, localTip, exec);
      const theirsMap = await readRefFileMap(opts.primaryRoot, outcome.remoteTip, exec);
      const { merged, conflicts } = mergeBoards(baseMap, oursMap, theirsMap);
      outcome.conflicts = conflicts;

      const mergedCommit = await commitMergedTree({
        repoRoot: opts.primaryRoot,
        indexFile: path.join(opts.primaryRoot, '.taskwright', 'board-sync.index'),
        parents: [localTip, outcome.remoteTip],
        message: 'chore(taskwright): board auto-sync (merge with remote)',
        files: merged,
        exec,
      });
      // `reset --keep` in the worktree moves the checked-out branch AND the
      // working tree; uncommitted edits were captured above under this same
      // lock, and --keep aborts rather than destroys if any remain.
      await exec(worktree, [...NO_EOL_CONVERT, 'reset', '--keep', mergedCommit]);
      outcome.merged = true;
    }

    const push = await pushRef(opts.primaryRoot, opts.remote, opts.ref, exec);
    outcome.pushed = push.ok;
    outcome.rejected = push.rejected;
    if (!push.ok && !outcome.error) outcome.error = push.stderr || undefined;
    return outcome;
  } catch (e) {
    outcome.error = e instanceof Error ? e.message : String(e);
    return outcome;
  } finally {
    release();
  }
}

export interface BoardSyncSchedulerOptions {
  /** Quiet period after the last board write before the run fires. */
  debounceMs?: number;
  /** The work: typically auto-commit + sync + status-bar refresh. */
  run: () => Promise<void>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/**
 * In-process debounce + single-flight for sync events. `noteWrite()` (re)arms
 * the debounce; `requestSync()` runs immediately, coalescing concurrent
 * requests into exactly one queued follow-up run.
 */
export class BoardSyncScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private pending = false;
  private disposed = false;

  constructor(private readonly opts: BoardSyncSchedulerOptions) {}

  noteWrite(): void {
    if (this.disposed) return;
    const setTimer = this.opts.setTimer ?? setTimeout;
    const clearTimer = this.opts.clearTimer ?? clearTimeout;
    if (this.timer !== undefined) clearTimer(this.timer);
    this.timer = setTimer(() => {
      this.timer = undefined;
      this.requestSync();
    }, this.opts.debounceMs ?? 7000);
  }

  requestSync(): void {
    if (this.disposed) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    void this.opts
      .run()
      .catch(() => {
        // run() owns its error surfacing (status bar); the scheduler never throws.
      })
      .finally(() => {
        this.running = false;
        if (this.pending && !this.disposed) {
          this.pending = false;
          this.requestSync();
        }
      });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      (this.opts.clearTimer ?? clearTimeout)(this.timer);
      this.timer = undefined;
    }
  }
}
