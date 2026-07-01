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
  const url = (create.stdout.match(/https?:\/\/\S+/) ?? [''])[0].trim();
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
