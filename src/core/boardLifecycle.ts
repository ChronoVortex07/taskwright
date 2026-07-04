import type { SyncTarget } from './boardRef';
import {
  refTip as realRefTip,
  fetchRef as realFetchRef,
  setLocalRef as realSetLocalRef,
  pushRef as realPushRef,
  isAncestor as realIsAncestor,
  snapshotBoardToRef,
  materializeRefToWorktree,
} from './boardRef';

/**
 * Automatic board-ref lifecycle (spec §6). `reconcileBoardRef` idempotently sets
 * up / heals the ref across the local-tip × remote-tip matrix. Deps are
 * injectable so the matrix is unit-tested without git.
 */

export type ReconcileAction = 'created' | 'fetched' | 'pushed' | 'reset-to-remote' | 'noop';

export interface LifecycleDeps {
  refTip: (repoRoot: string, ref: string) => Promise<string | null>;
  fetchRef: (repoRoot: string, remote: string, ref: string) => Promise<string | null>;
  setLocalRef: (repoRoot: string, ref: string, sha: string) => Promise<void>;
  pushRef: (
    repoRoot: string,
    remote: string,
    ref: string
  ) => Promise<{ ok: boolean; rejected: boolean; stderr: string }>;
  isAncestor: (repoRoot: string, a: string, b: string) => Promise<boolean>;
  snapshot: (args: {
    repoRoot: string;
    ref: string;
    indexFile: string;
    message: string;
    parent?: string;
    backlogDir?: string;
  }) => Promise<{ commit: string }>;
  materialize: (target: SyncTarget) => Promise<void>;
}

export const defaultLifecycleDeps: LifecycleDeps = {
  refTip: (r, ref) => realRefTip(r, ref),
  fetchRef: (r, remote, ref) => realFetchRef(r, remote, ref),
  setLocalRef: (r, ref, sha) => realSetLocalRef(r, ref, sha),
  pushRef: (r, remote, ref) => realPushRef(r, remote, ref),
  isAncestor: (r, a, b) => realIsAncestor(r, a, b),
  snapshot: (a) => snapshotBoardToRef(a).then((x) => ({ commit: x.commit })),
  materialize: (t) =>
    materializeRefToWorktree({
      repoRoot: t.repoRoot,
      ref: t.ref,
      indexFile: t.indexFile,
      backlogDir: t.backlogDir,
    }).then(() => undefined),
};

/**
 * Idempotently reconcile the board ref across the local-tip × remote-tip matrix:
 * seed when neither exists, adopt the remote when only it exists, publish the
 * local when only it exists, fast-forward / push / reset when they differ.
 */
export async function reconcileBoardRef(
  target: SyncTarget,
  opts: { deps?: Partial<LifecycleDeps> } = {}
): Promise<{ action: ReconcileAction }> {
  const d: LifecycleDeps = { ...defaultLifecycleDeps, ...opts.deps };
  const local = await d.refTip(target.repoRoot, target.ref);
  const remote = target.remote
    ? await d.fetchRef(target.repoRoot, target.remote, target.ref)
    : null;

  // neither exists → seed from the working copy
  if (!local && !remote) {
    await d.snapshot({
      repoRoot: target.repoRoot,
      ref: target.ref,
      indexFile: target.indexFile,
      message: 'seed board',
      backlogDir: target.backlogDir,
    });
    if (target.remote) await d.pushRef(target.repoRoot, target.remote, target.ref);
    return { action: 'created' };
  }

  // only remote exists → adopt it
  if (!local && remote) {
    await d.setLocalRef(target.repoRoot, target.ref, remote);
    await d.materialize(target);
    return { action: 'fetched' };
  }

  // only local exists → publish it
  if (local && !remote) {
    if (target.remote) await d.pushRef(target.repoRoot, target.remote, target.ref);
    return { action: 'pushed' };
  }

  // both exist
  if (local === remote) return { action: 'noop' };
  if (await d.isAncestor(target.repoRoot, local!, remote!)) {
    await d.setLocalRef(target.repoRoot, target.ref, remote!);
    await d.materialize(target);
    return { action: 'fetched' };
  }
  if (await d.isAncestor(target.repoRoot, remote!, local!)) {
    await d.pushRef(target.repoRoot, target.remote!, target.ref);
    return { action: 'pushed' };
  }
  // diverged → prefer the shared remote
  await d.setLocalRef(target.repoRoot, target.ref, remote!);
  await d.materialize(target);
  return { action: 'reset-to-remote' };
}
