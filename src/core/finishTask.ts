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
