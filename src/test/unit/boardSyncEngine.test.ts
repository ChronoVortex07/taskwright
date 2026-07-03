import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findTaskFile,
  claimTaskSynced,
  releaseTaskSynced,
  setStatusSynced,
  applyBoardWriteSynced,
  refreshBoard,
  MAX_SYNC_ATTEMPTS,
  type SyncEngineDeps,
  type SyncTarget,
} from '../../core/boardSyncEngine';
import type { Claim } from '../../core/claims';
import { snapshotBoardToRef, pushRef, fetchRef, setLocalRef, refTip } from '../../core/boardRef';
import { makeTempGitRepo, type TempRepo } from './helpers/tempGitRepo';

const execFileAsync = promisify(execFile);

describe('findTaskFile', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-find-'));
    fs.mkdirSync(path.join(root, 'backlog', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'backlog', 'tasks', 'task-1 - A.md'), 'A');
    fs.writeFileSync(path.join(root, 'backlog', 'tasks', 'task-12 - Long.md'), 'B');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds the file whose id prefix matches the task id (case-insensitive)', () => {
    expect(findTaskFile(root, 'backlog', 'TASK-1')).toBe(
      path.join(root, 'backlog', 'tasks', 'task-1 - A.md')
    );
    expect(findTaskFile(root, 'backlog', 'TASK-12')).toBe(
      path.join(root, 'backlog', 'tasks', 'task-12 - Long.md')
    );
  });

  it('returns null when no file matches', () => {
    expect(findTaskFile(root, 'backlog', 'TASK-99')).toBeNull();
  });
});

const TARGET: SyncTarget = {
  repoRoot: '/repo',
  ref: 'taskwright-board',
  remote: 'origin',
  indexFile: '/repo/.taskwright/board.index',
  backlogDir: 'backlog',
};

/** Build fully-faked deps; each test overrides only what it needs. */
function fakeDeps(over: Partial<SyncEngineDeps> = {}): SyncEngineDeps {
  let claimOnDisk: Claim | undefined;
  let materializedMarker: string | null = null;
  return {
    fetchRef: async () => 'remote-tip',
    setLocalRef: async () => {},
    refTip: async () => 'remote-tip',
    materialize: async () => {},
    snapshot: async () => ({ commit: 'new-commit' }),
    pushRef: async () => ({ ok: true, rejected: false, stderr: '' }),
    readTaskClaim: () => claimOnDisk,
    writeClaimToFile: (_f, c) => {
      claimOnDisk = c;
    },
    clearClaimInFile: () => {
      claimOnDisk = undefined;
    },
    writeStatusToFile: () => {},
    findTaskFile: () => '/repo/backlog/tasks/task-1 - A.md',
    readMaterialized: () => materializedMarker,
    writeMaterialized: (_t, sha) => {
      materializedMarker = sha;
    },
    sleep: async () => {},
    // Local-time construction so it lines up with the bare 'YYYY-MM-DD HH:mm'
    // claim strings below (claimTimestamp/isClaimStale both treat those as local).
    now: () => new Date(2026, 6, 1, 9, 0),
    ...over,
  };
}

describe('claimTaskSynced', () => {
  it('claims a free task and returns claimed', async () => {
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', { deps: fakeDeps() });
    expect(out.status).toBe('claimed');
    if (out.status === 'claimed') expect(out.claim.claimedBy).toBe('@alice');
  });

  it('surrenders when someone else already holds a live claim', async () => {
    const deps = fakeDeps({
      readTaskClaim: () => ({ claimedBy: '@bob', claimedAt: '2026-07-01 08:59' }),
    });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', {
      stalenessMs: 60 * 60 * 1000,
      deps,
    });
    expect(out).toEqual({ status: 'surrendered', by: '@bob' });
  });

  it('reclaims a STALE foreign claim (past staleness window)', async () => {
    const deps = fakeDeps({
      readTaskClaim: () => ({ claimedBy: '@bob', claimedAt: '2026-06-01 08:00' }),
    });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', {
      stalenessMs: 60 * 60 * 1000,
      deps,
    });
    expect(out.status).toBe('claimed');
  });

  it('retries on a rejected push, then succeeds', async () => {
    let pushes = 0;
    const deps = fakeDeps({
      pushRef: async () => {
        pushes += 1;
        return pushes === 1
          ? { ok: false, rejected: true, stderr: 'non-fast-forward' }
          : { ok: true, rejected: false, stderr: '' };
      },
    });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', { deps });
    expect(out.status).toBe('claimed');
    expect(pushes).toBe(2);
  });

  it('surrenders if the race winner claimed the task before our retry', async () => {
    let pushes = 0;
    let claim: Claim | undefined;
    const deps = fakeDeps({
      readTaskClaim: () => claim,
      writeClaimToFile: (_f, c) => {
        claim = c;
      },
      pushRef: async () => {
        pushes += 1;
        if (pushes === 1) {
          // Simulate the winner's claim landing on the remote before our retry.
          claim = { claimedBy: '@winner', claimedAt: '2026-07-01 09:00' };
          return { ok: false, rejected: true, stderr: 'rejected' };
        }
        return { ok: true, rejected: false, stderr: '' };
      },
    });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', {
      stalenessMs: 60 * 60 * 1000,
      deps,
    });
    expect(out).toEqual({ status: 'surrendered', by: '@winner' });
  });

  it('fails after MAX_SYNC_ATTEMPTS of persistent rejection', async () => {
    let pushes = 0;
    const deps = fakeDeps({
      pushRef: async () => {
        pushes += 1;
        return { ok: false, rejected: true, stderr: 'rejected' };
      },
    });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', { deps });
    expect(out.status).toBe('failed');
    expect(pushes).toBe(MAX_SYNC_ATTEMPTS);
  });

  it('returns failed when the task file is missing', async () => {
    const deps = fakeDeps({ findTaskFile: () => null });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', { deps });
    expect(out).toEqual({ status: 'failed', reason: 'Task TASK-1 not found on the board' });
  });
});

describe('releaseTaskSynced', () => {
  it('clears the claim and pushes', async () => {
    let claim: Claim | undefined = { claimedBy: '@alice', claimedAt: '2026-07-01 09:00' };
    const out = await releaseTaskSynced(TARGET, 'TASK-1', {
      deps: fakeDeps({
        readTaskClaim: () => claim,
        clearClaimInFile: () => {
          claim = undefined;
        },
      }),
    });
    expect(out).toEqual({ status: 'released' });
    expect(claim).toBeUndefined();
  });
});

describe('setStatusSynced', () => {
  it('writes the status, snapshots, and pushes', async () => {
    let status = 'To Do';
    let snapshotted = false;
    let pushed = false;
    const out = await setStatusSynced(TARGET, 'TASK-1', 'Done', {
      deps: fakeDeps({
        writeStatusToFile: (_f, s) => {
          status = s;
        },
        snapshot: async () => {
          snapshotted = true;
          return { commit: 'status-commit' };
        },
        pushRef: async () => {
          pushed = true;
          return { ok: true, rejected: false, stderr: '' };
        },
      }),
    });
    expect(out).toEqual({ status: 'ok', commit: 'status-commit' });
    expect(status).toBe('Done');
    expect(snapshotted).toBe(true);
    expect(pushed).toBe(true);
  });

  it('materializes the latest ref before writing (CAS ordering)', async () => {
    const order: string[] = [];
    await setStatusSynced(TARGET, 'TASK-1', 'Done', {
      deps: fakeDeps({
        materialize: async () => {
          order.push('materialize');
        },
        writeStatusToFile: () => {
          order.push('write');
        },
        snapshot: async () => {
          order.push('snapshot');
          return { commit: 'c' };
        },
      }),
    });
    expect(order).toEqual(['materialize', 'write', 'snapshot']);
  });

  it('retries on a rejected push, then succeeds', async () => {
    let pushes = 0;
    const out = await setStatusSynced(TARGET, 'TASK-1', 'Done', {
      deps: fakeDeps({
        pushRef: async () => {
          pushes += 1;
          return pushes === 1
            ? { ok: false, rejected: true, stderr: 'non-fast-forward' }
            : { ok: true, rejected: false, stderr: '' };
        },
      }),
    });
    expect(out.status).toBe('ok');
    expect(pushes).toBe(2);
  });

  it('returns failed when the task file is missing', async () => {
    const out = await setStatusSynced(TARGET, 'TASK-1', 'Done', {
      deps: fakeDeps({ findTaskFile: () => null }),
    });
    expect(out).toEqual({ status: 'failed', reason: 'Task TASK-1 not found on the board' });
  });
});

describe('applyBoardWriteSynced', () => {
  it('materializes before apply, snapshots after, pushes, and returns the apply result', async () => {
    const order: string[] = [];
    const out = await applyBoardWriteSynced(
      TARGET,
      'create TASK-9',
      async () => {
        order.push('apply');
        return 'TASK-9';
      },
      {
        deps: fakeDeps({
          materialize: async () => {
            order.push('materialize');
          },
          snapshot: async () => {
            order.push('snapshot');
            return { commit: 'write-commit' };
          },
          pushRef: async () => {
            order.push('push');
            return { ok: true, rejected: false, stderr: '' };
          },
        }),
      }
    );
    expect(order).toEqual(['materialize', 'apply', 'snapshot', 'push']);
    expect(out).toEqual({ status: 'ok', commit: 'write-commit', result: 'TASK-9' });
  });

  it('re-runs apply after a rejected push (the remote advanced)', async () => {
    let applies = 0;
    let pushes = 0;
    const out = await applyBoardWriteSynced(
      TARGET,
      'create',
      async () => {
        applies += 1;
        return applies;
      },
      {
        deps: fakeDeps({
          pushRef: async () => {
            pushes += 1;
            return pushes === 1
              ? { ok: false, rejected: true, stderr: 'non-fast-forward' }
              : { ok: true, rejected: false, stderr: '' };
          },
        }),
      }
    );
    expect(applies).toBe(2); // the write is re-applied onto the freshly materialized board
    expect(out).toMatchObject({ status: 'ok', result: 2 });
  });

  it('computes the snapshot message from the apply result', async () => {
    let message: string | undefined;
    await applyBoardWriteSynced(
      TARGET,
      (id: string) => `create ${id}`,
      async () => 'TASK-3',
      {
        deps: fakeDeps({
          snapshot: async (a) => {
            message = a.message;
            return { commit: 'c' };
          },
        }),
      }
    );
    expect(message).toBe('create TASK-3');
  });

  it('fails after MAX_SYNC_ATTEMPTS of persistent rejection', async () => {
    let pushes = 0;
    const out = await applyBoardWriteSynced(TARGET, 'create', async () => 'x', {
      deps: fakeDeps({
        pushRef: async () => {
          pushes += 1;
          return { ok: false, rejected: true, stderr: 'rejected' };
        },
      }),
    });
    expect(out.status).toBe('failed');
    expect(pushes).toBe(MAX_SYNC_ATTEMPTS);
  });

  it('fails immediately on a non-rejected push error', async () => {
    const out = await applyBoardWriteSynced(TARGET, 'create', async () => 'x', {
      deps: fakeDeps({
        pushRef: async () => ({ ok: false, rejected: false, stderr: 'auth denied' }),
      }),
    });
    expect(out).toEqual({ status: 'failed', reason: 'auth denied' });
  });

  it('local mode (no remote) skips push and records the materialized marker', async () => {
    let pushed = false;
    let marker: string | undefined;
    const out = await applyBoardWriteSynced(
      { ...TARGET, remote: undefined },
      'create',
      async () => 'x',
      {
        deps: fakeDeps({
          snapshot: async () => ({ commit: 'local-commit' }),
          pushRef: async () => {
            pushed = true;
            return { ok: true, rejected: false, stderr: '' };
          },
          writeMaterialized: (_t, sha) => {
            marker = sha;
          },
        }),
      }
    );
    expect(out).toMatchObject({ status: 'ok', commit: 'local-commit' });
    expect(pushed).toBe(false);
    expect(marker).toBe('local-commit');
  });

  it('propagates an apply exception (validation errors surface to the caller)', async () => {
    let snapshotted = false;
    await expect(
      applyBoardWriteSynced(
        TARGET,
        'create',
        async () => {
          throw new Error('Invalid status "Nope"');
        },
        {
          deps: fakeDeps({
            snapshot: async () => {
              snapshotted = true;
              return { commit: 'c' };
            },
          }),
        }
      )
    ).rejects.toThrow('Invalid status "Nope"');
    expect(snapshotted).toBe(false); // nothing committed when the write itself failed
  });
});

describe('refreshBoard', () => {
  it('fast-forwards the local ref to the fetched remote tip before materializing', async () => {
    let setTo: string | undefined;
    await refreshBoard(TARGET, {
      deps: fakeDeps({
        fetchRef: async () => 'remote-new',
        setLocalRef: async (_r, _ref, sha) => {
          setTo = sha;
        },
        refTip: async () => 'remote-new',
        readMaterialized: () => 'old',
      }),
    });
    expect(setTo).toBe('remote-new');
  });

  it('materializes when the ref advanced past what this worktree last materialized', async () => {
    // A sibling worktree already advanced BOTH the shared local ref and the
    // remote to 'new', so local === remote — the old sha-equality check missed
    // this and left the working copy stale.
    let materialized = 0;
    let marker: string | null = 'old';
    const out = await refreshBoard(TARGET, {
      deps: fakeDeps({
        fetchRef: async () => 'new',
        refTip: async () => 'new',
        readMaterialized: () => marker,
        writeMaterialized: (_t, sha) => {
          marker = sha;
        },
        materialize: async () => {
          materialized += 1;
        },
      }),
    });
    expect(out).toEqual({ changed: true });
    expect(materialized).toBe(1);
    expect(marker).toBe('new'); // marker advanced so the next poll is a no-op
  });

  it('does nothing when this worktree already materialized the current ref tip', async () => {
    let materialized = 0;
    const out = await refreshBoard(TARGET, {
      deps: fakeDeps({
        fetchRef: async () => 'same',
        refTip: async () => 'same',
        readMaterialized: () => 'same',
        materialize: async () => {
          materialized += 1;
        },
      }),
    });
    expect(out).toEqual({ changed: false });
    expect(materialized).toBe(0);
  });

  it('materializes on first refresh when this worktree has no marker yet', async () => {
    let materialized = 0;
    const out = await refreshBoard(TARGET, {
      deps: fakeDeps({
        fetchRef: async () => 'tip',
        refTip: async () => 'tip',
        readMaterialized: () => null,
        materialize: async () => {
          materialized += 1;
        },
      }),
    });
    expect(out).toEqual({ changed: true });
    expect(materialized).toBe(1);
  });

  it('does NOT advance the marker when materialize fails (no false progress)', async () => {
    // The board.materialized freeze: materialize threw (an unforced prune
    // rmSync raced a sibling materialize), so writeMaterialized must never run —
    // the marker stays put and the failure propagates for the caller to surface,
    // rather than the marker lying that this tip was materialized.
    let marker: string | null = 'old-tip';
    let wroteMarker = false;
    await expect(
      refreshBoard(TARGET, {
        deps: fakeDeps({
          fetchRef: async () => 'new-tip',
          refTip: async () => 'new-tip',
          readMaterialized: () => marker,
          materialize: async () => {
            throw new Error("ENOENT: no such file or directory, lstat 'backlog/tasks/x.md'");
          },
          writeMaterialized: (_t, sha) => {
            wroteMarker = true;
            marker = sha;
          },
        }),
      })
    ).rejects.toThrow(/ENOENT/);
    expect(wroteMarker).toBe(false); // marker NOT advanced on failure
    expect(marker).toBe('old-tip');
  });
});

describe('two-clone anti-double-claim (integration)', () => {
  let origin: string;
  let a: TempRepo;
  let b: TempRepo;

  beforeEach(async () => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-origin-'));
    await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);

    a = await makeTempGitRepo();
    await a.git(['remote', 'add', 'origin', origin]);
    await a.git(['push', '-q', 'origin', 'main']);
    a.addGitignore(['.taskwright/', 'backlog/tasks/']);
    a.writeFile('backlog/tasks/task-1 - A.md', '---\nid: TASK-1\ntitle: A\nstatus: To Do\n---\n');

    // Seed the board ref from A and push it.
    await snapshotBoardToRef({
      repoRoot: a.root,
      ref: 'taskwright-board',
      indexFile: path.join(a.root, '.taskwright/board.index'),
      message: 'seed',
    });
    await pushRef(a.root, 'origin', 'taskwright-board');

    // B clones the same origin and syncs the board ref.
    b = await makeTempGitRepo();
    await b.git(['remote', 'add', 'origin', origin]);
    b.addGitignore(['.taskwright/', 'backlog/tasks/']);
    await setLocalRef(
      b.root,
      'taskwright-board',
      (await fetchRef(b.root, 'origin', 'taskwright-board'))!
    );
  });

  afterEach(() => {
    a.cleanup();
    b.cleanup();
    fs.rmSync(origin, { recursive: true, force: true });
  });

  it('the second claimant surrenders to the first', async () => {
    const target = (root: string): SyncTarget => ({
      repoRoot: root,
      ref: 'taskwright-board',
      remote: 'origin',
      indexFile: path.join(root, '.taskwright/board.index'),
      backlogDir: 'backlog',
    });

    const first = await claimTaskSynced(target(a.root), 'TASK-1', '@alice', {
      stalenessMs: 60 * 60 * 1000,
    });
    expect(first.status).toBe('claimed');

    const second = await claimTaskSynced(target(b.root), 'TASK-1', '@bob', {
      stalenessMs: 60 * 60 * 1000,
    });
    expect(second).toEqual({ status: 'surrendered', by: '@alice' });
  });
});

describe('shared-worktree board refresh (integration)', () => {
  let origin: string;
  let primary: TempRepo;
  const taskFile = 'backlog/tasks/task-1 - A.md';

  const target = (root: string): SyncTarget => ({
    repoRoot: root,
    ref: 'taskwright-board',
    remote: 'origin',
    indexFile: path.join(root, '.taskwright/board.index'),
    backlogDir: 'backlog',
  });

  beforeEach(async () => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wt-origin-'));
    await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);

    primary = await makeTempGitRepo();
    await primary.git(['remote', 'add', 'origin', origin]);
    await primary.git(['push', '-q', 'origin', 'main']);
    primary.addGitignore(['.taskwright/', '.worktrees/', 'backlog/tasks/']);
    primary.writeFile(
      taskFile,
      '---\nid: TASK-1\ntitle: A\nstatus: To Do\nassignee: []\ndependencies: []\n---\n'
    );

    // Seed + publish the board from the primary checkout.
    await snapshotBoardToRef({
      repoRoot: primary.root,
      ref: 'taskwright-board',
      indexFile: path.join(primary.root, '.taskwright/board.index'),
      message: 'seed',
    });
    await pushRef(primary.root, 'origin', 'taskwright-board');
  });

  afterEach(() => {
    primary.cleanup();
    fs.rmSync(origin, { recursive: true, force: true });
  });

  it('reflects a claim made from a sibling worktree even though local === remote', async () => {
    // Steady state: the extension has materialized the seed into the primary.
    await refreshBoard(target(primary.root));
    expect(fs.readFileSync(path.join(primary.root, taskFile), 'utf-8')).not.toContain('claimed_by');

    // A dispatched session claims the task from a sibling git worktree. Worktrees
    // SHARE refs/heads/taskwright-board, so this advances the primary's local ref
    // AND the remote in lockstep — local stays === remote from the primary's view.
    const wt = path.join(primary.root, '.worktrees', 'task-1');
    await primary.git(['worktree', 'add', '-q', '-b', 'task-1', wt, 'main']);
    const outcome = await claimTaskSynced(target(wt), 'TASK-1', '@agent', { worktree: 'task-1' });
    expect(outcome.status).toBe('claimed');

    // Sanity: the primary's local ref now equals the remote (the worktree moved both).
    const primaryTip = (await fetchRef(primary.root, 'origin', 'taskwright-board'))!;
    expect(await refTip(primary.root, 'taskwright-board')).toBe(primaryTip);

    // The extension polls the primary. Despite local === remote, the primary's
    // working copy is still on the seed — it MUST re-materialize the claim.
    const refreshed = await refreshBoard(target(primary.root));
    expect(refreshed).toEqual({ changed: true });
    expect(fs.readFileSync(path.join(primary.root, taskFile), 'utf-8')).toContain(
      "claimed_by: '@agent'"
    );
  });
});
