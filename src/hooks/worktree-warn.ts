import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isPrimaryTree, collectDispatchedBranches } from '../core/worktreeGuard';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function main(): void {
  let gitDir: string;
  let commonDir: string;
  let branch: string | null;
  try {
    gitDir = path.resolve(git(['rev-parse', '--git-dir']));
    commonDir = path.resolve(git(['rev-parse', '--git-common-dir']));
    try {
      branch = git(['symbolic-ref', '--short', 'HEAD']);
    } catch {
      branch = null; // detached HEAD
    }
  } catch {
    process.exit(0); // not a git repo — nothing to warn about
  }
  const primaryRoot = path.dirname(commonDir);
  const dispatchedBranches = collectDispatchedBranches(primaryRoot, { listDirs });

  // Warn only when a dispatched task branch is checked out in the primary tree.
  if (branch !== null && isPrimaryTree(gitDir) && dispatchedBranches.includes(branch)) {
    process.stderr.write(
      `\n⚠ Taskwright: branch "${branch}" is dispatched to .worktrees/${branch}.\n` +
        `  Work inside that worktree, not the primary tree, to avoid cross-agent git conflicts.\n\n`
    );
  }
  // Always exit 0 — advisory only, never blocks.
  process.exit(0);
}

main();
