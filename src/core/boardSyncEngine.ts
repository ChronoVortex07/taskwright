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
  findTaskFile: (repoRoot: string, backlogDir: string, taskId: string) => string | null;
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
  findTaskFile,
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
    await d.snapshot({
      repoRoot: target.repoRoot,
      ref: target.ref,
      indexFile: target.indexFile,
      message: `claim ${taskId} by ${claimedBy}`,
      parent: base,
      backlogDir,
    });

    if (!target.remote) return { status: 'claimed', claim };

    const push = await d.pushRef(target.repoRoot, target.remote, target.ref);
    if (push.ok) return { status: 'claimed', claim };
    if (!push.rejected) return { status: 'failed', reason: push.stderr || 'push failed' };

    await d.sleep(backoffMs(attempt)); // remote advanced — re-fetch and retry
  }
  return { status: 'failed', reason: 'exhausted retries (remote kept advancing)' };
}

export async function releaseTaskSynced(
  target: SyncTarget,
  taskId: string,
  opts: { deps?: Partial<SyncEngineDeps> } = {}
): Promise<{ status: 'released' } | { status: 'failed'; reason: string }> {
  const d: SyncEngineDeps = { ...defaultSyncEngineDeps, ...opts.deps };
  const backlogDir = target.backlogDir ?? 'backlog';

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
    const base = await syncToRemoteBase(target, d);

    const file = d.findTaskFile(target.repoRoot, backlogDir, taskId);
    if (!file) return { status: 'failed', reason: `Task ${taskId} not found on the board` };

    d.clearClaimInFile(file);
    await d.snapshot({
      repoRoot: target.repoRoot,
      ref: target.ref,
      indexFile: target.indexFile,
      message: `release ${taskId}`,
      parent: base,
      backlogDir,
    });

    if (!target.remote) return { status: 'released' };
    const push = await d.pushRef(target.repoRoot, target.remote, target.ref);
    if (push.ok) return { status: 'released' };
    if (!push.rejected) return { status: 'failed', reason: push.stderr || 'push failed' };
    await d.sleep(backoffMs(attempt));
  }
  return { status: 'failed', reason: 'exhausted retries (remote kept advancing)' };
}

/** Fetch and, if the remote advanced, fast-forward the local ref and materialize. */
export async function refreshBoard(
  target: SyncTarget,
  opts: { deps?: Partial<SyncEngineDeps> } = {}
): Promise<{ changed: boolean }> {
  const d: SyncEngineDeps = { ...defaultSyncEngineDeps, ...opts.deps };
  const local = await d.refTip(target.repoRoot, target.ref);
  if (!target.remote) return { changed: false };

  const remoteTip = await d.fetchRef(target.repoRoot, target.remote, target.ref);
  if (!remoteTip || remoteTip === local) return { changed: false };

  await d.setLocalRef(target.repoRoot, target.ref, remoteTip);
  await d.materialize(target);
  return { changed: true };
}
