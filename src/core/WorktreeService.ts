import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Optional git-worktree creation for dispatch. A per-task worktree gives an
 * isolated session its own working directory (and its own
 * `.taskwright/active-task.json`), so parallel sessions in different worktrees
 * never share state. This is a convenience layer over `git worktree add`; the
 * exec/fs dependencies are injectable so the logic is unit-testable.
 */
const execFileAsync = promisify(execFile);

export type GitExecFn = (
  cwd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: GitExecFn = (cwd, args) => execFileAsync('git', args, { cwd, timeout: 15000 });

export interface CreateWorktreeDeps {
  exec?: GitExecFn;
  pathExists?: (p: string) => boolean;
}

export interface WorktreeResult {
  /** Absolute path to the worktree directory. */
  path: string;
  branch: string;
  /** False when the worktree directory already existed (no git was run). */
  created: boolean;
}

/** `<repoRoot>/.worktrees/<branch>` — the conventional location for task worktrees. */
export function worktreePathFor(repoRoot: string, branch: string): string {
  return path.join(repoRoot, '.worktrees', branch);
}

/** Args for `git worktree add`, creating the branch (`-b`) only when it is new. */
export function buildWorktreeAddArgs(
  worktreePath: string,
  branch: string,
  branchExists: boolean
): string[] {
  return branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath];
}

async function branchExists(repoRoot: string, branch: string, exec: GitExecFn): Promise<boolean> {
  try {
    await exec(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create (or reuse) a worktree for `branch` under `<repoRoot>/.worktrees/`. If
 * the directory already exists it is reused as-is; otherwise a worktree is added,
 * creating the branch when it does not already exist.
 */
export async function createWorktree(
  repoRoot: string,
  branch: string,
  deps: CreateWorktreeDeps = {}
): Promise<WorktreeResult> {
  const exec = deps.exec ?? defaultExec;
  const pathExists = deps.pathExists ?? fs.existsSync;
  const worktreePath = worktreePathFor(repoRoot, branch);

  if (pathExists(worktreePath)) {
    return { path: worktreePath, branch, created: false };
  }
  const exists = await branchExists(repoRoot, branch, exec);
  await exec(repoRoot, buildWorktreeAddArgs(worktreePath, branch, exists));
  return { path: worktreePath, branch, created: true };
}
