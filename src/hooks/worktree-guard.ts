import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { shouldBlockCommit, collectDispatchedBranches } from '../core/worktreeGuard';

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
    process.exit(0); // not a git repo — never block
  }
  const primaryRoot = path.dirname(commonDir);
  const dispatchedBranches = collectDispatchedBranches(primaryRoot, { listDirs });
  const decision = shouldBlockCommit({ gitDir, branch, dispatchedBranches });
  if (decision.block) {
    process.stderr.write(`\n${decision.message}\n\n`);
    process.exit(1);
  }
  process.exit(0);
}

main();
