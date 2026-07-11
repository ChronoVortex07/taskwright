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
  readDir?: (p: string) => string[];
  removeDir?: (p: string) => void;
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

function normalizedWorktreePath(value: string, caseInsensitive: boolean): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/\/$/, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/** Whether `git worktree list --porcelain` contains the requested absolute path. */
export function worktreeListContainsPath(
  porcelain: string,
  targetPath: string,
  caseInsensitive: boolean = process.platform === 'win32'
): boolean {
  const target = normalizedWorktreePath(targetPath, caseInsensitive);
  return porcelain.split(/\r?\n/).some((line) => {
    if (!line.startsWith('worktree ')) return false;
    return normalizedWorktreePath(line.slice('worktree '.length), caseInsensitive) === target;
  });
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
 * Create (or reuse) a worktree for `branch` under `<repoRoot>/.worktrees/`.
 * Existing directories are reused only when Git confirms their registration.
 * Windows can leave an empty directory behind after removing the worktree that
 * contains the running process's cwd; that empty orphan is safe to remove and
 * recreate. A non-empty orphan fails closed to protect user files.
 */
export async function createWorktree(
  repoRoot: string,
  branch: string,
  deps: CreateWorktreeDeps = {}
): Promise<WorktreeResult> {
  const exec = deps.exec ?? defaultExec;
  const pathExists = deps.pathExists ?? fs.existsSync;
  const readDir = deps.readDir ?? fs.readdirSync;
  const removeDir = deps.removeDir ?? fs.rmdirSync;
  const worktreePath = worktreePathFor(repoRoot, branch);

  if (pathExists(worktreePath)) {
    let porcelain: string;
    try {
      ({ stdout: porcelain } = await exec(repoRoot, ['worktree', 'list', '--porcelain']));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not verify the existing worktree at ${worktreePath}: ${detail}`, {
        cause: error,
      });
    }
    if (worktreeListContainsPath(porcelain, worktreePath)) {
      return { path: worktreePath, branch, created: false };
    }

    if (readDir(worktreePath).length > 0) {
      throw new Error(
        `${worktreePath} is not a registered Git worktree and is not empty. ` +
          'Move or remove it manually before starting this task.'
      );
    }
    removeDir(worktreePath);
  }
  const exists = await branchExists(repoRoot, branch, exec);
  await exec(repoRoot, buildWorktreeAddArgs(worktreePath, branch, exists));
  return { path: worktreePath, branch, created: true };
}
