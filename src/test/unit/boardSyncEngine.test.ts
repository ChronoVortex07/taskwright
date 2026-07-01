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
  refreshBoard,
  MAX_SYNC_ATTEMPTS,
  type SyncEngineDeps,
  type SyncTarget,
} from '../../core/boardSyncEngine';
import type { Claim } from '../../core/claims';
import { snapshotBoardToRef, pushRef, fetchRef, setLocalRef } from '../../core/boardRef';
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
    findTaskFile: () => '/repo/backlog/tasks/task-1 - A.md',
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

describe('refreshBoard', () => {
  it('materializes when the remote tip advanced', async () => {
    let materialized = 0;
    const out = await refreshBoard(TARGET, {
      deps: fakeDeps({
        refTip: async () => 'old',
        fetchRef: async () => 'new',
        materialize: async () => {
          materialized += 1;
        },
      }),
    });
    expect(out).toEqual({ changed: true });
    expect(materialized).toBe(1);
  });

  it('does nothing when local already matches the remote tip', async () => {
    let materialized = 0;
    const out = await refreshBoard(TARGET, {
      deps: fakeDeps({
        refTip: async () => 'same',
        fetchRef: async () => 'same',
        materialize: async () => {
          materialized += 1;
        },
      }),
    });
    expect(out).toEqual({ changed: false });
    expect(materialized).toBe(0);
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
