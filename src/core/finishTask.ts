import {
  MergeQueueStore,
  enqueueEntry,
  removeEntry,
  headEntry,
  markEntryActive,
  isHeadStale,
  positionOf,
  recordVerifiedHead,
  type QueueEntry,
} from './mergeQueue';
import { intermediateStatusForMode, IN_PROGRESS, type MergeConfig } from './mergeConfig';

/** Runs a git subcommand in `cwd`, resolving with its captured output. */
export type GitExecFn = (
  cwd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Runs a shell command line in `cwd`, resolving with its exit code + output.
 * `timeoutMs` caps the run; a runner that kills the command for exceeding it
 * reports `timedOut: true` so callers can distinguish a timeout from a red exit.
 */
export type RunFn = (
  cwd: string,
  commandLine: string,
  timeoutMs?: number
) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;

/** True when the worktree has no uncommitted changes. */
export async function isWorktreeClean(exec: GitExecFn, cwd: string): Promise<boolean> {
  const { stdout } = await exec(cwd, ['status', '--porcelain']);
  return stdout.trim() === '';
}

/** The integration branch: `main` if it exists, else `master`. */
export async function resolveBaseBranch(exec: GitExecFn, cwd: string): Promise<string> {
  for (const branch of ['main', 'master']) {
    try {
      await exec(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return branch;
    } catch {
      // try the next candidate
    }
  }
  return 'main';
}

export interface RebaseResult {
  ok: boolean;
  /** Unmerged file paths, present only when `ok` is false. */
  conflicts?: string[];
}

/** Rebase the current branch onto `base`; on conflict, capture the list and abort. */
export async function rebaseOntoBase(
  exec: GitExecFn,
  cwd: string,
  base: string
): Promise<RebaseResult> {
  try {
    await exec(cwd, ['rebase', base]);
    return { ok: true };
  } catch {
    let conflicts: string[] = [];
    try {
      const { stdout } = await exec(cwd, ['diff', '--name-only', '--diff-filter=U']);
      conflicts = stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // best-effort conflict list
    }
    try {
      await exec(cwd, ['rebase', '--abort']);
    } catch {
      // leave the repo as-is if abort fails; caller still reports the conflict
    }
    return { ok: false, conflicts };
  }
}

export interface VerifyResult {
  ok: boolean;
  failedCommand?: string;
  output?: string;
  /** True when the failing command was killed for exceeding the timeout, not a red exit. */
  timedOut?: boolean;
}

/** Run each verify command in order; stop and report at the first non-zero exit. */
export async function runVerifyCommands(
  run: RunFn,
  cwd: string,
  commands: string[],
  timeoutMs?: number
): Promise<VerifyResult> {
  for (const command of commands) {
    const { code, stdout, stderr, timedOut } = await run(cwd, command, timeoutMs);
    if (code !== 0 || timedOut) {
      return {
        ok: false,
        failedCommand: command,
        output: `${stdout}\n${stderr}`.trim(),
        ...(timedOut ? { timedOut: true } : {}),
      };
    }
  }
  return { ok: true };
}

/** Target path of each `git status --porcelain` entry (rename destination, quotes stripped). */
function porcelainTargets(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // strip the 2-char XY status + space; take the destination path for renames
      const rest = line.slice(2).trim();
      const target = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest;
      return target.replace(/^"|"$/g, '');
    });
}

/**
 * True when `git status --porcelain` output contains any change **outside**
 * `backlog/`. Board files under `backlog/` are expected to be dirty (Taskwright
 * runs with `auto_commit: false`). Strict fallback for when the merge footprint
 * cannot be computed — prefer {@link collidingWipPaths}.
 */
export function hasCodeWip(porcelain: string): boolean {
  return porcelainTargets(porcelain).some((target) => !target.startsWith('backlog/'));
}

/**
 * The porcelain entries (outside `backlog/`) that actually collide with the
 * paths a fast-forward merge would update (`mergeTouchedPaths`, from
 * `git diff --name-only base..branch`). Only these block the ff-merge —
 * unrelated WIP (untracked scratch files, mods to files the merge never
 * touches) survives a fast-forward untouched and must not abort it.
 */
export function collidingWipPaths(porcelain: string, mergeTouchedPaths: string[]): string[] {
  const touched = new Set(mergeTouchedPaths);
  return porcelainTargets(porcelain).filter(
    (target) => !target.startsWith('backlog/') && touched.has(target)
  );
}

export interface FfMergeResult {
  ok: boolean;
  reason?: string;
  /** Machine-readable cause, when it maps to a MergeAbortCode. */
  code?: MergeAbortCode;
}

/**
 * Fast-forward `base` in the primary tree up to `branch`. Requires the primary
 * tree to be on `base` and free of code WIP (board changes allowed). The
 * right-of-way makes touching the primary tree safe.
 */
export async function ffMergeToBase(
  exec: GitExecFn,
  primaryRoot: string,
  base: string,
  branch: string
): Promise<FfMergeResult> {
  let current: string;
  try {
    current = (await exec(primaryRoot, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  } catch {
    return {
      ok: false,
      reason: 'The primary tree has a detached HEAD; check out the base branch first.',
    };
  }
  if (current !== base) {
    return {
      ok: false,
      reason: `The primary tree is on "${current}", not "${base}"; check out ${base} first.`,
    };
  }
  const { stdout: porcelain } = await exec(primaryRoot, ['status', '--porcelain']);
  // Block only WIP that the fast-forward would actually overwrite: intersect the
  // porcelain paths (outside backlog/) with the merge footprint. Unrelated WIP
  // (scratch files, mods the merge never touches) survives an ff untouched.
  let blocking: string[] | null;
  try {
    const { stdout } = await exec(primaryRoot, ['diff', '--name-only', `${base}..${branch}`]);
    blocking = collidingWipPaths(
      porcelain,
      stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  } catch {
    blocking = null; // footprint unknown — fall back to the strict check below
  }
  if (blocking === null && hasCodeWip(porcelain)) {
    return {
      ok: false,
      reason:
        'The primary tree has uncommitted changes outside backlog/; commit or stash them first.',
      code: 'dirty_primary',
    };
  }
  if (blocking !== null && blocking.length > 0) {
    return {
      ok: false,
      reason: `The primary tree has uncommitted changes this merge would overwrite: ${blocking.join(', ')}; commit or stash them first.`,
      code: 'dirty_primary',
    };
  }
  try {
    await exec(primaryRoot, ['merge', '--ff-only', branch]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `fast-forward merge failed: ${detail}` };
  }
  return { ok: true };
}

export interface PrResult {
  ok: boolean;
  url?: string;
  reason?: string;
}

/** Push `branch` and open a PR targeting `base` via `gh`, capturing the URL. */
export async function openPullRequest(
  exec: GitExecFn,
  run: RunFn,
  cwd: string,
  branch: string,
  base: string
): Promise<PrResult> {
  const { stdout: remotes } = await exec(cwd, ['remote']);
  if (remotes.trim() === '') {
    return {
      ok: false,
      reason: 'auto-pr requires a configured git remote; none found (git remote is empty).',
    };
  }
  try {
    await exec(cwd, ['push', '-u', 'origin', branch]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `git push failed: ${detail}` };
  }
  const create = await run(cwd, `gh pr create --base ${base} --head ${branch} --fill`);
  if (create.code !== 0) {
    return {
      ok: false,
      reason: `gh pr create failed (is the GitHub CLI installed and authenticated?): ${`${create.stdout}\n${create.stderr}`.trim()}`,
    };
  }
  const url = create.stdout.match(/https?:\/\/\S+/)?.[0]?.trim();
  return { ok: true, url };
}

/**
 * Best-effort worktree removal, run from the primary tree. `--force` also sweeps
 * stray untracked files. On Windows the dir may be busy if a process cwd is still
 * inside it; we swallow the error and `prune` to self-heal the registration.
 */
export async function removeWorktree(
  exec: GitExecFn,
  primaryRoot: string,
  worktreeRelPath: string
): Promise<void> {
  try {
    await exec(primaryRoot, ['worktree', 'remove', '--force', worktreeRelPath]);
  } catch {
    // leftover dir; prune below cleans the registration
  }
  try {
    await exec(primaryRoot, ['worktree', 'prune']);
  } catch {
    // non-fatal
  }
}

/** Best-effort local branch delete, run from the primary tree. */
export async function deleteBranch(
  exec: GitExecFn,
  primaryRoot: string,
  branch: string
): Promise<void> {
  try {
    await exec(primaryRoot, ['branch', '-D', branch]);
  } catch {
    // non-fatal — the merge already succeeded
  }
}

/** Board mutations `request_merge` performs against the PRIMARY tree's board. */
export interface BoardOps {
  setStatus(taskId: string, status: string): Promise<void>;
  release(taskId: string): Promise<void>;
  /** Discard the primary tree's uncommitted edits to this task's file so a
   *  fast-forward merge can update it (drops the transient intermediate-status write). */
  resetTaskFile(taskId: string): Promise<void>;
}

/**
 * A liveness update emitted during `request_merge`'s long phases (TASK-88), so
 * MCP clients that reset tool timeouts on progress stay alive and the human
 * sees what the merge is doing. Purely observational — dropping every event
 * changes nothing.
 */
export interface MergeProgress {
  /** Which long phase is running. */
  phase: 'verify' | 'queue-wait';
  /** Human-readable liveness line (what a client should display). */
  message: string;
  /** verify: the command line currently running. */
  command?: string;
  /** verify: 1-based index of the running command. */
  commandIndex?: number;
  /** verify: total number of verify commands. */
  commandCount?: number;
  /** verify: whole seconds since this command started. */
  elapsedSeconds?: number;
  /** queue-wait: 1-based position in the merge queue. */
  queuePosition?: number;
  /** queue-wait: manual-review approval state. */
  approved?: boolean;
}

/** Per-call options for {@link requestMerge} (TASK-88). */
export interface RequestMergeOptions {
  /**
   * Cap on the queue/approval wait, in minutes (0 = check once). When exceeded,
   * requestMerge returns `{ status: 'pending' }` — the queue entry and the
   * intermediate board status are KEPT — instead of blocking forever. Omit for
   * the fully-blocking default.
   */
  waitMinutes?: number;
  /**
   * The `ticket` a previous `pending` return handed back. When presented and the
   * queue entry has vanished (a reviewer's Send back while the caller was
   * parked), the resume returns `sent_back` instead of silently re-submitting.
   */
  ticket?: string;
}

export interface FinishDeps {
  /** The worktree cwd the agent runs in. */
  root: string;
  /** The primary working tree root (ff-merge target, branch/worktree cleanup). */
  primaryRoot: string;
  /** The current branch of the worktree. */
  branch: string;
  /** Repo-root-relative worktree path, e.g. `.worktrees/task-7-x`. */
  worktreeRel: string;
  config: MergeConfig;
  queue: MergeQueueStore;
  board: BoardOps;
  exec: GitExecFn;
  run: RunFn;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Base long-poll interval; jittered per iteration. Default 1000ms. */
  pollIntervalMs?: number;
  /**
   * Optional observer for long-phase liveness (TASK-88). Fire-and-forget: it is
   * only consulted when set (no observer ⇒ zero extra sleeps/ticks) and a
   * throwing observer never breaks the merge.
   */
  onProgress?: (progress: MergeProgress) => void;
  /** Interval between progress heartbeats/verify ticks. Default 10s. */
  progressIntervalMs?: number;
}

/**
 * Machine-readable abort causes for `request_merge`, so orchestrators can branch
 * on the outcome instead of parsing prose. Aborts without a mapped cause (e.g.
 * a failed `gh pr create`) carry no code.
 */
export type MergeAbortCode =
  | 'verify_timeout'
  | 'verify_failed'
  | 'dirty_worktree'
  | 'dirty_primary'
  | 'rebase_conflict'
  /**
   * The call came from the primary tree with no `worktree` target — a misuse,
   * not a cancellation. It is the shape a `start_task`-bootstrapped session
   * lands in: the MCP server roots at launch and an in-session `cd` does not
   * move it, so such a session must close with `request_merge { taskId, worktree }`.
   */
  | 'wrong_root';

export type RequestMergeResult =
  | { status: 'merged'; taskId: string; branch: string }
  | { status: 'pr_opened'; taskId: string; url: string }
  | { status: 'sent_back'; taskId: string; reason: string }
  | { status: 'aborted'; reason: string; detail?: string; code?: MergeAbortCode }
  | {
      /** waitMinutes elapsed: still queued, nothing failed (TASK-88). The queue
       *  entry and intermediate board status are kept; call request_merge again
       *  with the same taskId (+ this ticket) to resume — verify is skipped when
       *  the base has not moved. */
      status: 'pending';
      taskId: string;
      /** 1-based position in the merge queue at return time. */
      queuePosition: number;
      /** Opaque resume token; pass it back so a reviewer's Send back while parked is detected. */
      ticket: string;
      message: string;
    };

/** The current HEAD commit SHA of `cwd`, or null when it cannot be resolved. */
async function resolveHeadSha(exec: GitExecFn, cwd: string): Promise<string | null> {
  try {
    return (await exec(cwd, ['rev-parse', 'HEAD'])).stdout.trim() || null;
  } catch {
    return null; // unknown — callers must treat this as "re-verify"
  }
}

/** The abort reason for a verify timeout — actionable, and never "Verification failed". */
function verifyTimeoutReason(command: string | undefined, timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  return `verify timed out after ${seconds}s on \`${command}\` (raise taskwright.mergeVerifyTimeoutMinutes or pass verifyTimeoutMinutes)`;
}

/** Invoke the progress observer, swallowing observer errors (fire-and-forget). */
function safeEmit(deps: FinishDeps, progress: MergeProgress): void {
  if (!deps.onProgress) return;
  try {
    deps.onProgress(progress);
  } catch {
    // observational only — a broken observer must never break the merge
  }
}

/**
 * Run the verify commands, emitting progress (command name, i/n, elapsed ticks
 * while a command runs) when an observer is attached (TASK-88). With no
 * observer this is exactly {@link runVerifyCommands} — no extra sleeps, no
 * behavioral change.
 */
async function runVerifyObserved(deps: FinishDeps, stage: string): Promise<VerifyResult> {
  const { run, root, config } = deps;
  if (!deps.onProgress) {
    return runVerifyCommands(run, root, config.verifyCommands, config.verifyTimeoutMs);
  }
  const commands = config.verifyCommands;
  const tickMs = deps.progressIntervalMs ?? 10_000;
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const startMs = deps.now().getTime();
    const emit = (elapsedSeconds: number): void =>
      safeEmit(deps, {
        phase: 'verify',
        command,
        commandIndex: i + 1,
        commandCount: commands.length,
        elapsedSeconds,
        message: `${stage}: running \`${command}\` (${i + 1}/${commands.length}, ${elapsedSeconds}s elapsed)`,
      });
    emit(0);
    // Race the command against tick-length sleeps so a long-running suite still
    // produces liveness every tick (clients reset tool timeouts on progress).
    const running = run(root, command, config.verifyTimeoutMs).then((result) => ({
      settled: true as const,
      result,
    }));
    let outcome: Awaited<ReturnType<RunFn>>;
    for (;;) {
      const winner = await Promise.race([
        running,
        deps.sleep(tickMs).then(() => ({ settled: false as const })),
      ]);
      if (winner.settled) {
        outcome = winner.result;
        break;
      }
      emit(Math.max(0, Math.round((deps.now().getTime() - startMs) / 1000)));
    }
    if (outcome.code !== 0 || outcome.timedOut) {
      return {
        ok: false,
        failedCommand: command,
        output: `${outcome.stdout}\n${outcome.stderr}`.trim(),
        ...(outcome.timedOut ? { timedOut: true } : {}),
      };
    }
  }
  return { ok: true };
}

/**
 * The full `request_merge` lifecycle. By default one blocking call: it suspends
 * on the long-poll until this task is the head AND (auto-mode OR
 * human-approved), then integrates and cleans up. Aborts before enqueue never
 * touch the queue; aborts after enqueue reset the board status and always
 * dequeue.
 *
 * TASK-88 unpins the wait from the caller's process: with `opts.waitMinutes`
 * the wait is bounded — on expiry the call returns `{ status: 'pending' }`,
 * KEEPING the queue entry and the intermediate board status, and a later call
 * for the same task resumes that entry idempotently (no re-enqueue, and no
 * re-verify when the post-rebase HEAD still matches the recorded verified sha).
 */
export async function requestMerge(
  deps: FinishDeps,
  taskId: string,
  opts?: RequestMergeOptions
): Promise<RequestMergeResult> {
  const { exec, run, queue, board, config, root, primaryRoot, branch, worktreeRel } = deps;

  // Resume detection (TASK-88): a previous call may have returned 'pending',
  // leaving our entry queued. A presented ticket with NO surviving entry means
  // a reviewer sent the task back while the caller was parked — surface that
  // instead of silently re-submitting.
  const existing = queue.read().entries.find((e) => e.taskId === taskId);
  if (!existing && opts?.ticket !== undefined) {
    return {
      status: 'sent_back',
      taskId,
      reason: 'A reviewer sent this task back for changes while it was parked in the queue.',
    };
  }
  const resumed = existing !== undefined;

  // 1. Validate + verify up front (aborts here never enqueue).
  if (!(await isWorktreeClean(exec, root))) {
    return {
      status: 'aborted',
      reason: 'Your worktree has uncommitted changes; commit or discard them first.',
      code: 'dirty_worktree',
    };
  }
  const base = await resolveBaseBranch(exec, root);
  const preRebase = await rebaseOntoBase(exec, root, base);
  if (!preRebase.ok) {
    return {
      status: 'aborted',
      reason: `Rebase onto ${base} hit conflicts; resolve them, then call request_merge again.`,
      detail: (preRebase.conflicts ?? []).join(', '),
      code: 'rebase_conflict',
    };
  }
  // The commit any verify verdict applies to. Comparing HEAD (not the base ref)
  // is race-free: verified content == merged content, by construction.
  // Unresolvable ⇒ always (re-)verify.
  const verifiedHeadSha = await resolveHeadSha(exec, root);
  // Resume skip (TASK-88): the queue entry records the HEAD its verify passed
  // against; when the post-rebase HEAD still matches, the tree is byte-identical
  // to the one already verified — re-verifying is redundant.
  const verifyStillCurrent =
    verifiedHeadSha !== null && existing?.verifiedHeadSha === verifiedHeadSha;
  if (!verifyStillCurrent) {
    const preVerify = await runVerifyObserved(deps, 'verify');
    if (!preVerify.ok) {
      return {
        status: 'aborted',
        reason: preVerify.timedOut
          ? verifyTimeoutReason(preVerify.failedCommand, config.verifyTimeoutMs)
          : `Verification failed on \`${preVerify.failedCommand}\`; fix it and call request_merge again.`,
        detail: preVerify.output,
        code: preVerify.timedOut ? 'verify_timeout' : 'verify_failed',
      };
    }
  }

  // 2. Enqueue + park in the mode's intermediate status (inside try so dequeue covers failures).
  const entry: QueueEntry = {
    taskId,
    branch,
    worktree: worktreeRel,
    mode: config.mode,
    submittedAt: deps.now().toISOString(),
    approved: false,
    active: false,
    activeAt: null,
  };

  // A 'pending' return parks the entry for a later resume — the ONLY exit that
  // must not dequeue.
  let keepQueued = false;
  try {
    queue.mutate((q) => enqueueEntry(q, entry)); // idempotent — a resume keeps its original slot
    if (verifiedHeadSha !== null) {
      queue.mutate((q) => recordVerifiedHead(q, taskId, verifiedHeadSha));
    }
    // A resume is already parked in the intermediate status; don't re-write it
    // (each write bumps updated_date, polluting board merge resolution).
    if (!resumed) await board.setStatus(taskId, intermediateStatusForMode(config.mode));

    // 3. Wait for the green light (bounded when waitMinutes is set).
    const deadlineMs =
      opts?.waitMinutes !== undefined ? deps.now().getTime() + opts.waitMinutes * 60_000 : null;
    const waited = await waitForTurn(deps, taskId, deadlineMs);
    if (waited === 'sent_back') {
      await board.setStatus(taskId, IN_PROGRESS);
      return { status: 'sent_back', taskId, reason: 'A reviewer sent this task back for changes.' };
    }
    if (waited === 'wait_timeout') {
      // Pending is not an abort: keep the queue entry and the parked board
      // status so a later request_merge call resumes exactly where we left off.
      keepQueued = true;
      const q = queue.read();
      const position = positionOf(q, taskId);
      const submittedAt =
        q.entries.find((e) => e.taskId === taskId)?.submittedAt ?? entry.submittedAt;
      const awaitingApproval = config.mode === 'manual-review';
      return {
        status: 'pending',
        taskId,
        queuePosition: position,
        ticket: `${taskId}@${submittedAt}`,
        message:
          `Still waiting in the merge queue (position ${position}` +
          (awaitingApproval ? ', awaiting human approval on the board' : '') +
          `). The queue entry is kept — call request_merge again with the same taskId and this ticket to resume; verify is skipped when the base has not moved.`,
      };
    }

    // Mark active so the stale-head reclaim protects us while we merge.
    queue.mutate((q) => markEntryActive(q, taskId, deps.now().toISOString()));

    // 4. Re-validate — `main` may have advanced while we waited.
    const reRebase = await rebaseOntoBase(exec, root, base);
    if (!reRebase.ok) {
      await board.setStatus(taskId, IN_PROGRESS);
      return {
        status: 'aborted',
        reason: `Rebase onto ${base} hit conflicts after waiting; resolve them and call request_merge again.`,
        detail: (reRebase.conflicts ?? []).join(', '),
        code: 'rebase_conflict',
      };
    }
    // Skip the redundant re-verify when the rebase was a no-op: HEAD still at
    // the commit the pre-enqueue verify passed against ⇒ identical tree.
    const headSha = await resolveHeadSha(exec, root);
    const rebaseWasNoOp =
      verifiedHeadSha !== null && headSha !== null && headSha === verifiedHeadSha;
    if (!rebaseWasNoOp) {
      const reVerify = await runVerifyObserved(deps, 're-verify');
      if (!reVerify.ok) {
        await board.setStatus(taskId, IN_PROGRESS);
        return {
          status: 'aborted',
          reason: reVerify.timedOut
            ? verifyTimeoutReason(reVerify.failedCommand, config.verifyTimeoutMs)
            : `Verification failed on \`${reVerify.failedCommand}\` after waiting; fix it and call request_merge again.`,
          detail: reVerify.output,
          code: reVerify.timedOut ? 'verify_timeout' : 'verify_failed',
        };
      }
    }

    // 5-6. Perform the action, then mark Done + clean up. The task file stays on
    // the board (status Done); filing it into completed/ is a separate, opt-in action.
    if (config.mode === 'auto-pr') {
      const pr = await openPullRequest(exec, run, root, branch, base);
      if (!pr.ok) {
        await board.setStatus(taskId, IN_PROGRESS);
        return { status: 'aborted', reason: pr.reason ?? 'Opening the pull request failed.' };
      }
      await board.setStatus(taskId, 'Done');
      await board.release(taskId);
      await removeWorktree(exec, primaryRoot, worktreeRel); // keep the branch for the PR
      return { status: 'pr_opened', taskId, url: pr.url ?? '' };
    }

    await board.resetTaskFile(taskId); // drop the transient status edit so the ff can update the file
    const merge = await ffMergeToBase(exec, primaryRoot, base, branch);
    if (!merge.ok) {
      await board.setStatus(taskId, IN_PROGRESS);
      return {
        status: 'aborted',
        reason: merge.reason ?? 'Fast-forward merge failed.',
        ...(merge.code ? { code: merge.code } : {}),
      };
    }
    await board.setStatus(taskId, 'Done');
    await board.release(taskId);
    await removeWorktree(exec, primaryRoot, worktreeRel);
    await deleteBranch(exec, primaryRoot, branch);
    return { status: 'merged', taskId, branch };
  } finally {
    // 7. Dequeue — unblocks the next head. Safe/no-op if already removed.
    // A 'pending' return is the one exit that parks the entry instead (TASK-88).
    if (!keepQueued) queue.mutate((q) => removeEntry(q, taskId));
  }
}

/**
 * Long-poll the shared queue until this task may proceed. Returns 'proceed' when
 * it is the head and (auto-mode or approved); 'sent_back' when its entry vanished
 * (a reviewer's Send back); 'wait_timeout' when `deadlineMs` passed first
 * (TASK-88 — only when the caller bounded the wait). Reclaims a stale foreign
 * head each iteration, and emits queue-wait progress (position, approval state)
 * on change or heartbeat when an observer is attached.
 */
async function waitForTurn(
  deps: FinishDeps,
  taskId: string,
  deadlineMs: number | null = null
): Promise<'proceed' | 'sent_back' | 'wait_timeout'> {
  const { queue, config, now } = deps;
  const base = deps.pollIntervalMs ?? 1000;
  const heartbeatMs = deps.progressIntervalMs ?? 10_000;
  let lastSignature = '';
  let lastEmitMs = -Infinity;
  for (;;) {
    const q = queue.read();
    // positionOf returns 0 only when our entry is absent — a reviewer's Send back
    // removed it, so the task must return to In Progress rather than merge.
    if (positionOf(q, taskId) === 0) return 'sent_back';

    // Reclaim a stale foreign head so a crashed agent can't wedge the queue.
    const head = headEntry(q);
    if (head && head.taskId !== taskId && isHeadStale(q, config.staleMinutes, now())) {
      queue.mutate((cur) => removeEntry(cur, head.taskId));
      continue;
    }

    const isHead = head?.taskId === taskId;
    const gated = config.mode !== 'manual-review';
    const approved = q.entries.find((e) => e.taskId === taskId)?.approved === true;
    if (isHead && (gated || approved)) return 'proceed';

    if (deadlineMs !== null && now().getTime() >= deadlineMs) return 'wait_timeout';

    if (deps.onProgress) {
      const position = positionOf(q, taskId);
      const signature = `${position}:${approved}`;
      const nowMs = now().getTime();
      if (signature !== lastSignature || nowMs - lastEmitMs >= heartbeatMs) {
        const awaitingApproval = config.mode === 'manual-review' && !approved;
        safeEmit(deps, {
          phase: 'queue-wait',
          queuePosition: position,
          approved,
          message: awaitingApproval
            ? `Waiting in the merge queue at position ${position}; awaiting human approval on the board.`
            : `Waiting in the merge queue at position ${position}.`,
        });
        lastSignature = signature;
        lastEmitMs = nowMs;
      }
    }

    await deps.sleep(base + Math.floor(Math.random() * base)); // jittered
  }
}
