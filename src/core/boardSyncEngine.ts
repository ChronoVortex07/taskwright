import * as fs from 'fs';
import * as path from 'path';
import {
  applyClaim,
  clearClaim,
  claimTimestamp,
  isClaimStale,
  readClaim,
  type Claim,
} from './claims';
import { setStatusField } from './frontmatterEdit';
import { detectCRLF, normalizeToLF, restoreLineEndings } from './BacklogWriter';
import {
  fetchRef as realFetchRef,
  setLocalRef as realSetLocalRef,
  refTip as realRefTip,
  pushRef as realPushRef,
  materializeRefToWorktree,
  snapshotBoardToRef,
} from './boardRef';

/**
 * The synced-board CAS engine (spec §4). Each mutation fetches the shared ref,
 * fast-forwards the local ref, materializes it, checks the claim, applies the
 * mutation, snapshots a new commit, and pushes fast-forward-only. A rejected
 * push means the remote advanced — re-fetch and retry; if the race winner
 * claimed the task, surrender. Correctness rests on `git push` being an atomic
 * ref compare-and-swap. Deps are injectable so the loop is tested without git.
 */

/** Absolute path of the task file whose id prefix equals `taskId`, else null. */
export function findTaskFile(repoRoot: string, backlogDir: string, taskId: string): string | null {
  const dir = path.join(repoRoot, backlogDir, 'tasks');
  if (!fs.existsSync(dir)) return null;
  const want = taskId.toUpperCase();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const m = name.match(/^([a-zA-Z]+-\d+(?:\.\d+)*)/);
    if (m && m[1].toUpperCase() === want) return path.join(dir, name);
  }
  return null;
}

export interface SyncTarget {
  repoRoot: string;
  ref: string;
  /** When omitted, the engine works local-only (no fetch/push). */
  remote?: string;
  indexFile: string;
  backlogDir?: string;
}

export type ClaimOutcome =
  | { status: 'claimed'; claim: Claim }
  | { status: 'surrendered'; by: string }
  | { status: 'failed'; reason: string };

export interface SyncEngineDeps {
  fetchRef: (repoRoot: string, remote: string, ref: string) => Promise<string | null>;
  setLocalRef: (repoRoot: string, ref: string, sha: string) => Promise<void>;
  refTip: (repoRoot: string, ref: string) => Promise<string | null>;
  materialize: (target: SyncTarget) => Promise<void>;
  snapshot: (args: {
    repoRoot: string;
    ref: string;
    indexFile: string;
    message: string;
    parent?: string;
    backlogDir?: string;
  }) => Promise<{ commit: string }>;
  pushRef: (
    repoRoot: string,
    remote: string,
    ref: string
  ) => Promise<{ ok: boolean; rejected: boolean; stderr: string }>;
  readTaskClaim: (filePath: string) => Claim | undefined;
  writeClaimToFile: (filePath: string, claim: Claim) => void;
  clearClaimInFile: (filePath: string) => void;
  writeStatusToFile: (filePath: string, status: string) => void;
  findTaskFile: (repoRoot: string, backlogDir: string, taskId: string) => string | null;
  /** The board-ref sha last materialized into this worktree, or null if unknown. */
  readMaterialized: (target: SyncTarget) => string | null;
  /** Record the board-ref sha just materialized into this worktree. */
  writeMaterialized: (target: SyncTarget, sha: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export const MAX_SYNC_ATTEMPTS = 5;

function rewriteFile(filePath: string, transform: (content: string) => string): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const hadCRLF = detectCRLF(raw);
  const updated = transform(normalizeToLF(raw));
  fs.writeFileSync(filePath, restoreLineEndings(updated, hadCRLF), 'utf-8');
}

/**
 * Per-worktree marker recording the board-ref sha last materialized into this
 * working copy. Lives beside the isolated index in the worktree's git-ignored
 * `.taskwright/`, so each worktree tracks its own materialization independently.
 */
function materializedMarkerPath(target: SyncTarget): string {
  return path.join(path.dirname(target.indexFile), 'board.materialized');
}

export const defaultSyncEngineDeps: SyncEngineDeps = {
  fetchRef: (r, remote, ref) => realFetchRef(r, remote, ref),
  setLocalRef: (r, ref, sha) => realSetLocalRef(r, ref, sha),
  refTip: (r, ref) => realRefTip(r, ref),
  materialize: (t) =>
    materializeRefToWorktree({
      repoRoot: t.repoRoot,
      ref: t.ref,
      indexFile: t.indexFile,
      backlogDir: t.backlogDir,
    }).then(() => undefined),
  snapshot: (a) => snapshotBoardToRef(a).then((r) => ({ commit: r.commit })),
  pushRef: (r, remote, ref) => realPushRef(r, remote, ref),
  readTaskClaim: (filePath) => {
    try {
      return readClaim(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return undefined;
    }
  },
  writeClaimToFile: (filePath, claim) => rewriteFile(filePath, (c) => applyClaim(c, claim)),
  clearClaimInFile: (filePath) => rewriteFile(filePath, clearClaim),
  writeStatusToFile: (filePath, status) => rewriteFile(filePath, (c) => setStatusField(c, status)),
  findTaskFile,
  readMaterialized: (target) => {
    try {
      const sha = fs.readFileSync(materializedMarkerPath(target), 'utf-8').trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  },
  writeMaterialized: (target, sha) => {
    const p = materializedMarkerPath(target);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${sha}\n`, 'utf-8');
  },
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  now: () => new Date(),
};

/** Fixed, deterministic backoff: 25ms, 50ms, 100ms, ... capped at 500ms. */
function backoffMs(attempt: number): number {
  return Math.min(25 * 2 ** (attempt - 1), 500);
}

/** Sync the local ref to the remote head (if any) and materialize; returns the base sha. */
async function syncToRemoteBase(
  target: SyncTarget,
  d: SyncEngineDeps
): Promise<string | undefined> {
  let base = (await d.refTip(target.repoRoot, target.ref)) ?? undefined;
  if (target.remote) {
    const remoteTip = await d.fetchRef(target.repoRoot, target.remote, target.ref);
    if (remoteTip) {
      await d.setLocalRef(target.repoRoot, target.ref, remoteTip);
      base = remoteTip;
    }
  }
  await d.materialize(target);
  return base;
}

export async function claimTaskSynced(
  target: SyncTarget,
  taskId: string,
  claimedBy: string,
  opts: { worktree?: string; stalenessMs?: number; deps?: Partial<SyncEngineDeps> } = {}
): Promise<ClaimOutcome> {
  const d: SyncEngineDeps = { ...defaultSyncEngineDeps, ...opts.deps };
  const backlogDir = target.backlogDir ?? 'backlog';
  const stalenessMs = opts.stalenessMs ?? Number.POSITIVE_INFINITY;

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
    const base = await syncToRemoteBase(target, d);

    const file = d.findTaskFile(target.repoRoot, backlogDir, taskId);
    if (!file) return { status: 'failed', reason: `Task ${taskId} not found on the board` };

    const existing = d.readTaskClaim(file);
    if (
      existing &&
      existing.claimedBy !== claimedBy &&
      !isClaimStale(existing.claimedAt, stalenessMs, d.now().getTime())
    ) {
      return { status: 'surrendered', by: existing.claimedBy };
    }

    const claim: Claim = {
      claimedBy,
      claimedAt: claimTimestamp(d.now()),
      ...(opts.worktree ? { worktree: opts.worktree } : {}),
    };
    d.writeClaimToFile(file, claim);
    const snap = await d.snapshot({
      repoRoot: target.repoRoot,
      ref: target.ref,
      indexFile: target.indexFile,
      message: `claim ${taskId} by ${claimedBy}`,
      parent: base,
      backlogDir,
    });

    // The working copy now matches the snapshot commit, so record it as the
    // materialized sha — this keeps a later refreshBoard poll from redundantly
    // re-materializing (and re-rendering) content this worktree already wrote.
    if (!target.remote) {
      d.writeMaterialized(target, snap.commit);
      return { status: 'claimed', claim };
    }

    const push = await d.pushRef(target.repoRoot, target.remote, target.ref);
    if (push.ok) {
      d.writeMaterialized(target, snap.commit);
      return { status: 'claimed', claim };
    }
    if (!push.rejected) return { status: 'failed', reason: push.stderr || 'push failed' };

    await d.sleep(backoffMs(attempt)); // remote advanced — re-fetch and retry
  }
  return { status: 'failed', reason: 'exhausted retries (remote kept advancing)' };
}

/** Thrown inside an `apply` to abort the CAS loop with a `failed` outcome instead of an exception. */
class BoardWriteAbort extends Error {}

export type BoardWriteOutcome<T> =
  | { status: 'ok'; commit: string; result: T }
  | { status: 'failed'; reason: string };

/**
 * Shared CAS loop for an arbitrary local board write: fetch → fast-forward
 * local → materialize → `apply` the write to the fresh working copy → snapshot →
 * ff-only push, retrying when the remote advances. Because a re-materialize
 * fully resets the board subdirs to the ref, retrying re-runs `apply` from a
 * clean slate (e.g. a task create re-allocates its ID against the advanced
 * board). This is what keeps a local-only write — a `create_task` between two
 * polls — from being silently pruned/overwritten by the next materialize
 * (TASK-28). `message` may be computed from the apply result (the snapshot
 * happens after `apply`), so e.g. a create can label its commit with the ID it
 * allocated. Exceptions from `apply` (validation, missing files) propagate to
 * the caller; nothing is snapshotted or pushed in that case.
 */
export async function applyBoardWriteSynced<T>(
  target: SyncTarget,
  message: string | ((result: T) => string),
  apply: () => Promise<T> | T,
  opts: { deps?: Partial<SyncEngineDeps> } = {}
): Promise<BoardWriteOutcome<T>> {
  const d: SyncEngineDeps = { ...defaultSyncEngineDeps, ...opts.deps };
  const backlogDir = target.backlogDir ?? 'backlog';

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
    const base = await syncToRemoteBase(target, d);

    let result: T;
    try {
      result = await apply();
    } catch (e) {
      if (e instanceof BoardWriteAbort) return { status: 'failed', reason: e.message };
      throw e;
    }

    const snap = await d.snapshot({
      repoRoot: target.repoRoot,
      ref: target.ref,
      indexFile: target.indexFile,
      message: typeof message === 'function' ? message(result) : message,
      parent: base,
      backlogDir,
    });

    if (!target.remote) {
      d.writeMaterialized(target, snap.commit);
      return { status: 'ok', commit: snap.commit, result };
    }
    const push = await d.pushRef(target.repoRoot, target.remote, target.ref);
    if (push.ok) {
      d.writeMaterialized(target, snap.commit);
      return { status: 'ok', commit: snap.commit, result };
    }
    if (!push.rejected) return { status: 'failed', reason: push.stderr || 'push failed' };
    await d.sleep(backoffMs(attempt));
  }
  return { status: 'failed', reason: 'exhausted retries (remote kept advancing)' };
}

/**
 * CAS loop for an unconditional single-file board mutation: locate the task
 * file on the freshly materialized board and `mutate` it. Unlike
 * `claimTaskSynced` there is no surrender check — the caller already owns the
 * right to write (e.g. releasing its own claim, or `request_merge` driving the
 * task it holds through the merge). Returns the new commit on success.
 */
async function mutateTaskSynced(
  target: SyncTarget,
  taskId: string,
  message: string,
  mutate: (filePath: string, d: SyncEngineDeps) => void,
  d: SyncEngineDeps
): Promise<{ status: 'ok'; commit: string } | { status: 'failed'; reason: string }> {
  const backlogDir = target.backlogDir ?? 'backlog';
  const out = await applyBoardWriteSynced<void>(
    target,
    message,
    () => {
      const file = d.findTaskFile(target.repoRoot, backlogDir, taskId);
      if (!file) throw new BoardWriteAbort(`Task ${taskId} not found on the board`);
      mutate(file, d);
    },
    { deps: d }
  );
  return out.status === 'ok' ? { status: 'ok', commit: out.commit } : out;
}

export async function releaseTaskSynced(
  target: SyncTarget,
  taskId: string,
  opts: { deps?: Partial<SyncEngineDeps> } = {}
): Promise<{ status: 'released' } | { status: 'failed'; reason: string }> {
  const d: SyncEngineDeps = { ...defaultSyncEngineDeps, ...opts.deps };
  const result = await mutateTaskSynced(
    target,
    taskId,
    `release ${taskId}`,
    (file, deps) => deps.clearClaimInFile(file),
    d
  );
  return result.status === 'ok' ? { status: 'released' } : result;
}

/**
 * Set a task's board status on the shared ref (the synced-mode counterpart to a
 * plain working-tree status write). `request_merge` routes its status writes —
 * the intermediate "Awaiting Merge"/"Pending Review" park, the abort rollback to
 * "In Progress", and the final "Done" — through here so they land on the board
 * ref and survive the next materialize, instead of being lost as working-tree-only edits.
 */
export async function setStatusSynced(
  target: SyncTarget,
  taskId: string,
  status: string,
  opts: { deps?: Partial<SyncEngineDeps> } = {}
): Promise<{ status: 'ok'; commit: string } | { status: 'failed'; reason: string }> {
  const d: SyncEngineDeps = { ...defaultSyncEngineDeps, ...opts.deps };
  return mutateTaskSynced(
    target,
    taskId,
    `set-status ${taskId} → ${status}`,
    (file, deps) => deps.writeStatusToFile(file, status),
    d
  );
}

/**
 * Reflect the shared board ref in THIS worktree's working copy. Fast-forwards the
 * local ref to the remote tip (when a remote is set), then re-materializes when
 * the working copy is behind the local ref tip.
 *
 * The local ref (`refs/heads/taskwright-board`) is **shared across git
 * worktrees**, so a claim/release made from a sibling worktree (e.g. a dispatched
 * task session's MCP server) advances the shared ref — and the remote — without
 * ever touching this worktree's `backlog/tasks` files. Gating materialize on
 * `local === remote` therefore misses that update, leaving the board view stale.
 * Instead we record the sha last materialized into this worktree and refresh
 * whenever the ref has moved past it.
 */
export async function refreshBoard(
  target: SyncTarget,
  opts: { deps?: Partial<SyncEngineDeps> } = {}
): Promise<{ changed: boolean }> {
  const d: SyncEngineDeps = { ...defaultSyncEngineDeps, ...opts.deps };

  if (target.remote) {
    const remoteTip = await d.fetchRef(target.repoRoot, target.remote, target.ref);
    if (remoteTip) await d.setLocalRef(target.repoRoot, target.ref, remoteTip);
  }

  const localTip = await d.refTip(target.repoRoot, target.ref);
  if (!localTip) return { changed: false };
  if (d.readMaterialized(target) === localTip) return { changed: false };

  await d.materialize(target);
  d.writeMaterialized(target, localTip);
  return { changed: true };
}
