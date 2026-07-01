/** Runs a git subcommand in `cwd`, resolving with its captured output. */
export type GitExecFn = (
  cwd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

/** Runs a shell command line in `cwd`, resolving with its exit code + output. */
export type RunFn = (
  cwd: string,
  commandLine: string
) => Promise<{ code: number; stdout: string; stderr: string }>;

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
}

/** Run each verify command in order; stop and report at the first non-zero exit. */
export async function runVerifyCommands(
  run: RunFn,
  cwd: string,
  commands: string[]
): Promise<VerifyResult> {
  for (const command of commands) {
    const { code, stdout, stderr } = await run(cwd, command);
    if (code !== 0) {
      return { ok: false, failedCommand: command, output: `${stdout}\n${stderr}`.trim() };
    }
  }
  return { ok: true };
}

/**
 * True when `git status --porcelain` output contains any change **outside**
 * `backlog/`. Board files under `backlog/` are expected to be dirty (Taskwright
 * runs with `auto_commit: false`); real code WIP must block the ff-merge.
 */
export function hasCodeWip(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      // strip the 2-char XY status + space; take the destination path for renames
      const rest = line.slice(2).trim();
      const target = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest;
      return !target.replace(/^"|"$/g, '').startsWith('backlog/');
    });
}

export interface FfMergeResult {
  ok: boolean;
  reason?: string;
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
  if (hasCodeWip(porcelain)) {
    return {
      ok: false,
      reason:
        'The primary tree has uncommitted changes outside backlog/; commit or stash them first.',
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

// --- append: BoardOps + requestMerge orchestrator ---
import {
  MergeQueueStore,
  enqueueEntry,
  removeEntry,
  approveEntry, // re-exported for callers/tests convenience
  headEntry,
  markEntryActive,
  isHeadStale,
  positionOf,
  type QueueEntry,
} from './mergeQueue';
import { intermediateStatusForMode, type MergeConfig } from './mergeConfig';

/** Board mutations `request_merge` performs against the PRIMARY tree's board. */
export interface BoardOps {
  setStatus(taskId: string, status: string): Promise<void>;
  complete(taskId: string): Promise<void>;
  release(taskId: string): Promise<void>;
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
}

export type RequestMergeResult =
  | { status: 'merged'; taskId: string; branch: string }
  | { status: 'pr_opened'; taskId: string; url: string }
  | { status: 'sent_back'; taskId: string; reason: string }
  | { status: 'aborted'; reason: string; detail?: string };

const IN_PROGRESS = 'In Progress';

/**
 * The full `request_merge` lifecycle. One blocking call: it suspends on the
 * long-poll until this task is the head AND (auto-mode OR human-approved), then
 * integrates and cleans up. Aborts before enqueue never touch the queue; aborts
 * after enqueue reset the board status and always dequeue.
 */
export async function requestMerge(deps: FinishDeps, taskId: string): Promise<RequestMergeResult> {
  const { exec, run, queue, board, config, root, primaryRoot, branch, worktreeRel } = deps;

  // 1. Validate + verify up front (aborts here never enqueue).
  if (!(await isWorktreeClean(exec, root))) {
    return {
      status: 'aborted',
      reason: 'Your worktree has uncommitted changes; commit or discard them first.',
    };
  }
  const base = await resolveBaseBranch(exec, root);
  const preRebase = await rebaseOntoBase(exec, root, base);
  if (!preRebase.ok) {
    return {
      status: 'aborted',
      reason: `Rebase onto ${base} hit conflicts; resolve them, then call request_merge again.`,
      detail: (preRebase.conflicts ?? []).join(', '),
    };
  }
  const preVerify = await runVerifyCommands(run, root, config.verifyCommands);
  if (!preVerify.ok) {
    return {
      status: 'aborted',
      reason: `Verification failed on \`${preVerify.failedCommand}\`; fix it and call request_merge again.`,
      detail: preVerify.output,
    };
  }

  // 2. Enqueue + park in the mode's intermediate status.
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
  queue.mutate((q) => enqueueEntry(q, entry));
  await board.setStatus(taskId, intermediateStatusForMode(config.mode));

  try {
    // 3. Wait for the green light.
    const waited = await waitForTurn(deps, taskId);
    if (waited === 'sent_back') {
      await board.setStatus(taskId, IN_PROGRESS);
      return { status: 'sent_back', taskId, reason: 'A reviewer sent this task back for changes.' };
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
      };
    }
    const reVerify = await runVerifyCommands(run, root, config.verifyCommands);
    if (!reVerify.ok) {
      await board.setStatus(taskId, IN_PROGRESS);
      return {
        status: 'aborted',
        reason: `Verification failed on \`${reVerify.failedCommand}\` after waiting; fix it and call request_merge again.`,
        detail: reVerify.output,
      };
    }

    // 5-6. Perform the action, then complete + clean up.
    if (config.mode === 'auto-pr') {
      const pr = await openPullRequest(exec, run, root, branch, base);
      if (!pr.ok) {
        await board.setStatus(taskId, IN_PROGRESS);
        return { status: 'aborted', reason: pr.reason ?? 'Opening the pull request failed.' };
      }
      await board.complete(taskId);
      await board.release(taskId);
      await removeWorktree(exec, primaryRoot, worktreeRel); // keep the branch for the PR
      return { status: 'pr_opened', taskId, url: pr.url ?? '' };
    }

    const merge = await ffMergeToBase(exec, primaryRoot, base, branch);
    if (!merge.ok) {
      await board.setStatus(taskId, IN_PROGRESS);
      return { status: 'aborted', reason: merge.reason ?? 'Fast-forward merge failed.' };
    }
    await board.complete(taskId);
    await board.release(taskId);
    await deleteBranch(exec, primaryRoot, branch);
    await removeWorktree(exec, primaryRoot, worktreeRel);
    return { status: 'merged', taskId, branch };
  } finally {
    // 7. Dequeue — unblocks the next head. Safe/no-op if already removed.
    queue.mutate((q) => removeEntry(q, taskId));
  }
}

/**
 * Long-poll the shared queue until this task may proceed. Returns 'proceed' when
 * it is the head and (auto-mode or approved); 'sent_back' when its entry vanished
 * (a reviewer's Send back). Reclaims a stale foreign head each iteration.
 */
async function waitForTurn(deps: FinishDeps, taskId: string): Promise<'proceed' | 'sent_back'> {
  const { queue, config, now } = deps;
  const base = deps.pollIntervalMs ?? 1000;
  for (;;) {
    const q = queue.read();
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

    await deps.sleep(base + Math.floor(Math.random() * base)); // jittered
  }
}

export { positionOf, approveEntry };
