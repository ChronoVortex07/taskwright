import * as fs from 'fs';
import * as path from 'path';
import { defaultBoardExec, fetchRef, refTip, NO_EOL_CONVERT, type BoardGitExec } from './boardRef';
import { boardWorktreePathFor } from './boardRoot';

/**
 * Lifecycle of the hidden board worktree (TASK-91, spec §2.1/§6): a linked
 * worktree of the `taskwright-board` branch at `<primaryRoot>/.taskwright/board`.
 * The branch is the durable store (it lives in the common git dir and survives
 * any worktree deletion); the worktree is reproducible, so loss — `git clean
 * -dfx`, manual rm — is a repair, not a data-loss event.
 *
 * Mirrors `WorktreeService.createWorktree`'s injectable shape, but with a fixed
 * path and branch-seeding rules: reuse the local ref, else the remote's, else
 * an empty root commit. A truly *fresh* seed from a live board is deliberately
 * NOT done here — that is the enableSync migration's job (boardHomeMigration).
 */

export type BoardWorktreeStatus = 'ok' | 'dir-missing' | 'unregistered' | 'no-branch';

export interface EnsureBoardWorktreeOptions {
  primaryRoot: string;
  /** Board branch name, e.g. `taskwright-board`. */
  ref: string;
  /** Remote to bootstrap from when there is no local branch, e.g. `origin`. */
  remote: string;
  exec?: BoardGitExec;
  pathExists?: (p: string) => boolean;
}

export interface EnsureBoardWorktreeResult {
  /** `<primaryRoot>/.taskwright/board` */
  path: string;
  /** False when the worktree was already healthy (nothing was changed). */
  created: boolean;
  /** Where the checked-out branch came from. */
  seeded: 'existing' | 'from-local-ref' | 'from-remote' | 'none';
}

/** Health of the hidden board worktree, for doctor facts and bootstrap gating. */
export async function boardWorktreeStatusOf(
  primaryRoot: string,
  ref: string,
  deps: { exec?: BoardGitExec; pathExists?: (p: string) => boolean } = {}
): Promise<BoardWorktreeStatus> {
  const exec = deps.exec ?? defaultBoardExec;
  const pathExists = deps.pathExists ?? fs.existsSync;
  const dir = boardWorktreePathFor(primaryRoot);
  if (pathExists(dir)) {
    try {
      await exec(dir, ['rev-parse', '--git-dir']);
      return 'ok';
    } catch {
      return 'unregistered';
    }
  }
  return (await refTip(primaryRoot, ref, exec)) ? 'dir-missing' : 'no-branch';
}

/**
 * Create (or repair) the hidden board worktree. Idempotent: a healthy worktree
 * short-circuits (`created: false`). A present-but-unregistered directory
 * (e.g. a partial `git clean`) is moved aside to `board.broken` rather than
 * deleted — never destroy bytes that might hold un-pushed edits.
 */
export async function ensureBoardWorktree(
  opts: EnsureBoardWorktreeOptions
): Promise<EnsureBoardWorktreeResult> {
  const exec = opts.exec ?? defaultBoardExec;
  const pathExists = opts.pathExists ?? fs.existsSync;
  const dir = boardWorktreePathFor(opts.primaryRoot);

  if (pathExists(dir)) {
    try {
      await exec(dir, ['rev-parse', '--git-dir']);
      return { path: dir, created: false, seeded: 'existing' };
    } catch {
      // Present but not a working git dir — preserve the bytes, clear the path.
      const aside = `${dir}.broken`;
      fs.rmSync(aside, { recursive: true, force: true });
      fs.renameSync(dir, aside);
    }
  }

  // Clear any stale registration left by a deleted directory.
  await exec(opts.primaryRoot, ['worktree', 'prune']);

  // Branch resolution: local ref > remote ref > empty root commit.
  let seeded: EnsureBoardWorktreeResult['seeded'];
  if (await refTip(opts.primaryRoot, opts.ref, exec)) {
    seeded = 'from-local-ref';
  } else {
    const remoteTip = await fetchRef(opts.primaryRoot, opts.remote, opts.ref, exec);
    if (remoteTip) {
      await exec(opts.primaryRoot, ['branch', opts.ref, remoteTip]);
      seeded = 'from-remote';
    } else {
      const indexFile = path.join(opts.primaryRoot, '.taskwright', 'board.index');
      fs.mkdirSync(path.dirname(indexFile), { recursive: true });
      const env = { GIT_INDEX_FILE: indexFile };
      await exec(opts.primaryRoot, ['read-tree', '--empty'], env);
      const tree = (await exec(opts.primaryRoot, ['write-tree'], env)).stdout.trim();
      const root = (
        await exec(
          opts.primaryRoot,
          ['commit-tree', tree, '-m', 'chore(taskwright): board branch root'],
          env
        )
      ).stdout.trim();
      await exec(opts.primaryRoot, ['branch', opts.ref, root]);
      seeded = 'none';
    }
  }

  // Byte-exact checkout: per-command -c flags (the boardRef lesson) instead of
  // persistent per-worktree config, so no repo config is ever mutated.
  await exec(opts.primaryRoot, [...NO_EOL_CONVERT, 'worktree', 'add', dir, opts.ref]);

  return { path: dir, created: true, seeded };
}
