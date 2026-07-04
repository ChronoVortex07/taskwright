import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

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
 * The primary worktree's `backlog/` directory, given raw `git worktree list
 * --porcelain` output. Pure — no I/O — so it is unit-tested against captured
 * porcelain text without a live git call.
 */
export function boardRootFromPorcelain(porcelain: string): string {
  const [primary] = parseWorktreeListPorcelain(porcelain);
  if (!primary) {
    throw new Error(
      'resolveBoardRoot: `git worktree list --porcelain` returned no worktree entries'
    );
  }
  return path.join(primary, 'backlog');
}

export interface ResolveBoardRootDeps {
  exec?: GitExecFn;
}

/**
 * Resolve the one physical board's directory from any worktree by running
 * `git worktree list --porcelain` in `cwd` and taking the primary (first)
 * entry. Same result whether `cwd` is the primary, a linked
 * `.worktrees/<branch>` worktree, or a plain non-worktree repo.
 */
export async function resolveBoardRoot(
  cwd: string,
  deps: ResolveBoardRootDeps = {}
): Promise<string> {
  const exec = deps.exec ?? defaultExec;
  const { stdout } = await exec(cwd, ['worktree', 'list', '--porcelain']);
  return boardRootFromPorcelain(stdout);
}
