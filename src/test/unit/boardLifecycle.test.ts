import { describe, it, expect } from 'vitest';
import {
  reconcileBoardRef,
  compactBoardRef,
  DEFAULT_COMPACT_THRESHOLD,
  type LifecycleDeps,
} from '../../core/boardLifecycle';
import type { SyncTarget } from '../../core/boardSyncEngine';

const TARGET: SyncTarget = {
  repoRoot: '/repo',
  ref: 'taskwright-board',
  remote: 'origin',
  indexFile: '/repo/.taskwright/board.index',
  backlogDir: 'backlog',
};

function deps(over: Partial<LifecycleDeps> = {}): Partial<LifecycleDeps> {
  return {
    refTip: async () => null,
    fetchRef: async () => null,
    setLocalRef: async () => {},
    pushRef: async () => ({ ok: true, rejected: false, stderr: '' }),
    isAncestor: async () => false,
    snapshot: async () => ({ commit: 'seed' }),
    materialize: async () => {},
    revCount: async () => 0,
    commitTreeRoot: async () => 'ROOT',
    pushForceWithLease: async () => ({ ok: true, rejected: false, stderr: '' }),
    ...over,
  };
}

describe('reconcileBoardRef', () => {
  it('creates + pushes when neither local nor remote exists', async () => {
    let snapped = 0;
    let pushed = 0;
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({
        snapshot: async () => {
          snapped += 1;
          return { commit: 'seed' };
        },
        pushRef: async () => {
          pushed += 1;
          return { ok: true, rejected: false, stderr: '' };
        },
      }),
    });
    expect(out).toEqual({ action: 'created' });
    expect(snapped).toBe(1);
    expect(pushed).toBe(1);
  });

  it('fetches when only the remote exists', async () => {
    let materialized = 0;
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({
        refTip: async () => null,
        fetchRef: async () => 'R',
        materialize: async () => {
          materialized += 1;
        },
      }),
    });
    expect(out).toEqual({ action: 'fetched' });
    expect(materialized).toBe(1);
  });

  it('pushes when only local exists', async () => {
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({ refTip: async () => 'L', fetchRef: async () => null }),
    });
    expect(out).toEqual({ action: 'pushed' });
  });

  it('noop when local equals remote', async () => {
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({ refTip: async () => 'X', fetchRef: async () => 'X' }),
    });
    expect(out).toEqual({ action: 'noop' });
  });

  it('fast-forwards when local is an ancestor of remote', async () => {
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({
        refTip: async () => 'L',
        fetchRef: async () => 'R',
        isAncestor: async (_r, a, b) => a === 'L' && b === 'R',
      }),
    });
    expect(out).toEqual({ action: 'fetched' });
  });

  it('resets to remote when the two diverged', async () => {
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({
        refTip: async () => 'L',
        fetchRef: async () => 'R',
        isAncestor: async () => false,
      }),
    });
    expect(out).toEqual({ action: 'reset-to-remote' });
  });

  it('local-only target: creates without pushing', async () => {
    let pushed = 0;
    const out = await reconcileBoardRef(
      { ...TARGET, remote: undefined },
      {
        deps: deps({
          refTip: async () => null,
          pushRef: async () => {
            pushed += 1;
            return { ok: true, rejected: false, stderr: '' };
          },
        }),
      }
    );
    expect(out).toEqual({ action: 'created' });
    expect(pushed).toBe(0);
  });
});

describe('compactBoardRef', () => {
  it('does nothing below the threshold', async () => {
    const out = await compactBoardRef(TARGET, {
      maxCommits: 200,
      deps: deps({ revCount: async () => 10 }),
    });
    expect(out).toEqual({ squashed: false });
  });

  it('squashes with a lease-guarded force-push above the threshold', async () => {
    let leaseTip: string | undefined;
    const out = await compactBoardRef(TARGET, {
      maxCommits: 200,
      deps: deps({
        revCount: async () => 500,
        fetchRef: async () => 'REMOTE_TIP',
        commitTreeRoot: async () => 'ROOT',
        setLocalRef: async () => {},
        pushForceWithLease: async (_r, _rem, _ref, tip) => {
          leaseTip = tip;
          return { ok: true, rejected: false, stderr: '' };
        },
      }),
    });
    expect(out).toEqual({ squashed: true });
    expect(leaseTip).toBe('REMOTE_TIP'); // lease is on the observed remote tip
  });

  it('aborts (no squash) when the lease is stale', async () => {
    const out = await compactBoardRef(TARGET, {
      maxCommits: 200,
      deps: deps({
        revCount: async () => 500,
        fetchRef: async () => 'REMOTE_TIP',
        commitTreeRoot: async () => 'ROOT',
        pushForceWithLease: async () => ({ ok: false, rejected: true, stderr: 'stale info' }),
      }),
    });
    expect(out).toEqual({ squashed: false });
  });

  it('exposes a sane default threshold', () => {
    expect(DEFAULT_COMPACT_THRESHOLD).toBe(200);
  });
});
