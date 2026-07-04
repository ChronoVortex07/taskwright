import * as path from 'path';
import { resolvePrimaryWorktreeRoot } from './boardRoot';
import {
  defaultBoardExec,
  refTip,
  setLocalRef,
  fetchRef,
  pushRef,
  isAncestor,
  mergeBaseOf,
  readRefFileMap,
  snapshotBoardToRef,
  materializeRefToWorktree,
  commitMergedTree,
  type BoardGitExec,
} from './boardRef';
import { mergeBoards, type MergeConflict } from './boardMerge';

/**
 * Board Sync v2 (spec §2.2, Task F) — the discrete push/pull backbone. Push
 * and pull share the same shape: snapshot the live board onto the local
 * `taskwright-board` ref (captures "ours"), fetch the remote ref ("theirs"),
 * and — only when the remote has commits this clone doesn't already have —
 * union-merge (`boardMerge.ts`) against the base (the local ref's PREVIOUS
 * tip, i.e. the last state known to be shared with the remote) and land the
 * result as a real two-parent merge commit. `pushBoard` then pushes that
 * commit; `pullBoard` materializes it into the live board instead. No live
 * loop, no CAS — one call, one outcome, conflicts always surfaced.
 */

export interface PushPullOptions {
  /** Any worktree's cwd — the one physical board is resolved via `resolvePrimaryWorktreeRoot`. */
  cwd: string;
  ref: string;
  remote: string;
  /** Commit message for the live-board snapshot (and, if a merge is needed, its commit). */
  message: string;
  indexFile?: string;
  backlogDir?: string;
  exec?: BoardGitExec;
}

interface SyncedRef {
  repoRoot: string;
  /** The local ref's tip after this call — the plain snapshot, or a merge commit. */
  localTip: string;
  /** The remote's fetched tip, or null when the remote has no such ref yet. */
  remoteTip: string | null;
  conflicts: MergeConflict[];
}

/**
 * Snapshot the live board onto the local ref, then fold in the remote's ref
 * (only if it has commits this clone lacks) via a three-way union-merge.
 * Shared by push and pull — they differ only in what happens to the result.
 */
async function syncLocalRefWithRemote(opts: PushPullOptions): Promise<SyncedRef> {
  const exec = opts.exec ?? defaultBoardExec;
  const repoRoot = await resolvePrimaryWorktreeRoot(opts.cwd, { exec });
  const indexFile = opts.indexFile ?? path.join(repoRoot, '.taskwright', 'board.index');

  const oldLocalTip = await refTip(repoRoot, opts.ref, exec);
  const { commit: oursCommit } = await snapshotBoardToRef({
    repoRoot,
    ref: opts.ref,
    indexFile,
    message: opts.message,
    parent: oldLocalTip ?? undefined,
    backlogDir: opts.backlogDir,
    exec,
  });

  const remoteTip = await fetchRef(repoRoot, opts.remote, opts.ref, exec);

  if (!remoteTip || (await isAncestor(repoRoot, remoteTip, oursCommit, exec))) {
    // No remote ref yet, or the remote has nothing this clone doesn't already have.
    return { repoRoot, localTip: oursCommit, remoteTip, conflicts: [] };
  }

  const baseSha = oldLocalTip ? await mergeBaseOf(repoRoot, oldLocalTip, remoteTip, exec) : null;
  const baseMap = baseSha ? await readRefFileMap(repoRoot, baseSha, exec) : undefined;
  const oursMap = await readRefFileMap(repoRoot, oursCommit, exec);
  const theirsMap = await readRefFileMap(repoRoot, remoteTip, exec);

  const { merged, conflicts } = mergeBoards(baseMap, oursMap, theirsMap);

  const mergedCommit = await commitMergedTree({
    repoRoot,
    indexFile,
    parents: [oursCommit, remoteTip],
    message: `${opts.message} (merge with remote)`,
    files: merged,
    exec,
  });
  await setLocalRef(repoRoot, opts.ref, mergedCommit, exec);

  return { repoRoot, localTip: mergedCommit, remoteTip, conflicts };
}

export interface PushBoardResult {
  pushed: boolean;
  ref: string;
  remote: string;
  /** The local ref's tip after this call, whether or not the push itself succeeded. */
  commit: string;
  /** True when the push was rejected because the remote moved again after our fetch. */
  rejected?: boolean;
  conflicts: MergeConflict[];
  /** Present when `pushed` is false: the underlying git error. */
  message?: string;
}

/**
 * Snapshot → merge-with-remote → push. Never dirties the working tree (the
 * board is git-ignored on every code branch) and never blocks a code merge.
 * On a fast-forward rejection (the remote moved again between our fetch and
 * our push), returns `rejected: true` rather than retrying automatically —
 * the local ref already advanced, so simply calling `pushBoard` again picks
 * up the new remote state and retries the merge.
 */
export async function pushBoard(opts: PushPullOptions): Promise<PushBoardResult> {
  const exec = opts.exec ?? defaultBoardExec;
  const synced = await syncLocalRefWithRemote(opts);
  const push = await pushRef(synced.repoRoot, opts.remote, opts.ref, exec);
  return {
    pushed: push.ok,
    ref: opts.ref,
    remote: opts.remote,
    commit: synced.localTip,
    rejected: push.rejected,
    conflicts: synced.conflicts,
    message: push.ok ? undefined : push.stderr,
  };
}

export interface PullBoardResult {
  pulled: boolean;
  ref: string;
  remote: string;
  /** Board-relative paths materialized onto disk (sorted); empty when nothing was pulled. */
  files: string[];
  conflicts: MergeConflict[];
  message?: string;
}

/**
 * Fetch → merge-with-local → materialize into the live board. Local,
 * not-yet-pushed edits are preserved (they are the "ours" side of the merge);
 * a same-task edit on both sides resolves by newer `updated_date` and is
 * surfaced in `conflicts`, never silently dropped.
 */
export async function pullBoard(opts: PushPullOptions): Promise<PullBoardResult> {
  const exec = opts.exec ?? defaultBoardExec;
  const synced = await syncLocalRefWithRemote(opts);
  if (!synced.remoteTip) {
    return {
      pulled: false,
      ref: opts.ref,
      remote: opts.remote,
      files: [],
      conflicts: [],
      message: `Remote "${opts.remote}" has no "${opts.ref}" ref yet — push first.`,
    };
  }

  const indexFile = opts.indexFile ?? path.join(synced.repoRoot, '.taskwright', 'board.index');
  const { files } = await materializeRefToWorktree({
    repoRoot: synced.repoRoot,
    ref: opts.ref,
    indexFile,
    backlogDir: opts.backlogDir,
    exec,
  });

  return {
    pulled: true,
    ref: opts.ref,
    remote: opts.remote,
    files,
    conflicts: synced.conflicts,
  };
}
