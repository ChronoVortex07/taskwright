import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import {
  resolveBacklogDirectory,
  type BacklogDirectoryResolution,
} from './resolveBacklogDirectory';

/**
 * Board Sync v2 (spec §2.1, §3) — resolves the *one* physical board: the
 * primary worktree's `backlog/` directory. Every worktree (primary, a linked
 * `.worktrees/<branch>`, or a plain non-worktree repo) targets this same path,
 * which is what makes worktree-to-primary visibility automatic and removes the
 * v1 per-worktree materialized copy entirely.
 */

const execFileAsync = promisify(execFile);

export type GitExecFn = (
  cwd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: GitExecFn = (cwd, args) => execFileAsync('git', args, { cwd, timeout: 15000 });

/**
 * Ordered worktree paths from `git worktree list --porcelain` output — the
 * primary worktree is always the first `worktree ` entry, regardless of which
 * worktree ran the command. Ignores every other porcelain line (`HEAD`,
 * `branch`, `detached`, `bare`, `prunable ...`, blank separators).
 */
export function parseWorktreeListPorcelain(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice('worktree '.length).trim());
    }
  }
  return paths;
}

/**
 * The primary worktree's raw root path (not yet joined to `backlog/`), given
 * raw `git worktree list --porcelain` output. Pure — no I/O — exported so
 * callers that need the raw root (e.g. to resolve `backlog.config.yml` /
 * custom directory naming via {@link resolveBacklogDirectory}) don't have to
 * re-run or re-parse git output themselves.
 */
export function primaryWorktreeRootFromPorcelain(porcelain: string): string {
  const [primary] = parseWorktreeListPorcelain(porcelain);
  if (!primary) {
    throw new Error(
      'resolveBoardRoot: `git worktree list --porcelain` returned no worktree entries'
    );
  }
  return primary;
}

/**
 * The primary worktree's `backlog/` directory, given raw `git worktree list
 * --porcelain` output. Pure — no I/O — so it is unit-tested against captured
 * porcelain text without a live git call.
 */
export function boardRootFromPorcelain(porcelain: string): string {
  return path.join(primaryWorktreeRootFromPorcelain(porcelain), 'backlog');
}

export interface ResolveBoardRootDeps {
  exec?: GitExecFn;
}

/**
 * Resolve the primary worktree's raw root path from any worktree by running
 * `git worktree list --porcelain` in `cwd` and taking the primary (first)
 * entry. Same result whether `cwd` is the primary, a linked
 * `.worktrees/<branch>` worktree, or a plain non-worktree repo.
 */
export async function resolvePrimaryWorktreeRoot(
  cwd: string,
  deps: ResolveBoardRootDeps = {}
): Promise<string> {
  const exec = deps.exec ?? defaultExec;
  const { stdout } = await exec(cwd, ['worktree', 'list', '--porcelain']);
  return primaryWorktreeRootFromPorcelain(stdout);
}

/**
 * Resolve the one physical board's directory from any worktree. Same result
 * whether `cwd` is the primary, a linked `.worktrees/<branch>` worktree, or a
 * plain non-worktree repo.
 */
export async function resolveBoardRoot(
  cwd: string,
  deps: ResolveBoardRootDeps = {}
): Promise<string> {
  return path.join(await resolvePrimaryWorktreeRoot(cwd, deps), 'backlog');
}

/**
 * Resolve the backlog directory for a workspace folder / session cwd,
 * preferring the *primary* worktree's board (Board Sync v2 §2.1) over a local
 * one. A linked `.worktrees/<branch>` worktree has no local `backlog/` at all
 * (it's git-ignored, so `git worktree add` never populates it) — resolving
 * locally first would report "no backlog" even though the primary has one.
 *
 * Falls back to local resolution (`resolveBacklogDirectory(workspaceFolderPath)`)
 * when: `cwd` isn't a git repo (or git is unavailable), or the primary itself
 * has no backlog directory (e.g. a plain, non-Taskwright folder was opened as
 * one workspace folder while another folder in the same window is the real
 * project — a legitimate `resolveBacklogDirectory` local-discovery case this
 * must not break).
 */
export async function resolveWorkspaceBacklogRoot(
  workspaceFolderPath: string,
  deps: ResolveBoardRootDeps = {}
): Promise<BacklogDirectoryResolution> {
  try {
    const primaryRoot = await resolvePrimaryWorktreeRoot(workspaceFolderPath, deps);
    const resolution = resolveBacklogDirectory(primaryRoot);
    if (resolution.backlogPath) {
      return resolution;
    }
  } catch {
    // Not a git repo (or git unavailable) — fall through to local resolution.
  }
  return resolveBacklogDirectory(workspaceFolderPath);
}
