// src/test/unit/requestMerge.test.ts
import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import {
  requestMerge,
  type FinishDeps,
  type BoardOps,
  type GitExecFn,
  type RunFn,
} from '../../core/finishTask';
import {
  MergeQueueStore,
  enqueueEntry,
  removeEntry,
  EMPTY_QUEUE,
  type QueueFsDeps,
} from '../../core/mergeQueue';
import { DEFAULT_MERGE_CONFIG, type MergeConfig } from '../../core/mergeConfig';

/** In-memory queue store fixture. */
function memQueue(): { store: MergeQueueStore; file: () => string } {
  const files: Record<string, string> = {};
  const fsDeps: QueueFsDeps = {
    exists: (p) => p in files,
    read: (p) => files[p],
    writeAtomic: (p, d) => (files[p] = d),
  };
  return { store: new MergeQueueStore('/q.json', fsDeps), file: () => files['/q.json'] };
}

function board(): BoardOps & {
  statuses: string[];
  released: string[];
  resetTaskFile: MockedFunction<(taskId: string) => Promise<void>>;
} {
  const rec = {
    statuses: [] as string[],
    released: [] as string[],
    setStatus: async (_id: string, s: string) => {
      rec.statuses.push(s);
    },
    release: async (id: string) => {
      rec.released.push(id);
    },
    resetTaskFile: vi.fn(async (_taskId: string) => {}),
  };
  return rec;
}

/** Happy-path git exec: clean, main exists, rebase/merge succeed, remote present. */
function okGit(over?: (args: string[]) => { stdout?: string } | Error | undefined): GitExecFn {
  return async (_cwd, args) => {
    const custom = over?.(args);
    if (custom instanceof Error) throw custom;
    if (custom) return { stdout: custom.stdout ?? '', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' }; // clean
    if (args[0] === 'rev-parse' && args.includes('refs/heads/main'))
      return { stdout: 'abc', stderr: '' };
    if (args[0] === 'rev-parse') throw new Error('no such ref');
    if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
    if (args[0] === 'remote') return { stdout: 'origin\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
}

const greenRun: RunFn = async () => ({ code: 0, stdout: '', stderr: '' });

function deps(over: Partial<FinishDeps>): FinishDeps {
  return {
    root: '/wt',
    primaryRoot: '/primary',
    branch: 'task-7-x',
    worktreeRel: '.worktrees/task-7-x',
    config: DEFAULT_MERGE_CONFIG,
    queue: memQueue().store,
    board: board(),
    exec: okGit(),
    run: greenRun,
    now: () => new Date('2026-07-01T12:00:00.000Z'),
    sleep: async () => {},
    pollIntervalMs: 1,
    ...over,
  };
}

describe('requestMerge — abort before enqueue', () => {
  it('aborts on a dirty worktree without enqueuing', async () => {
    const q = memQueue();
    const d = deps({
      queue: q.store,
      exec: okGit((a) => (a[0] === 'status' ? { stdout: ' M x.ts\n' } : undefined)),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('aborted');
    expect(q.store.read()).toEqual(EMPTY_QUEUE);
  });

  it('aborts on rebase conflict with the conflict list', async () => {
    const d = deps({
      exec: okGit((a) => {
        if (a[0] === 'rebase' && a[1] === 'main') return new Error('conflict');
        if (a.join(' ') === 'diff --name-only --diff-filter=U') return { stdout: 'src/a.ts\n' };
        return undefined;
      }),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.detail).toContain('src/a.ts');
  });

  it('aborts on red verification without enqueuing', async () => {
    const q = memQueue();
    const run: RunFn = async (_c, cmd) =>
      cmd === 'bun run lint'
        ? { code: 1, stdout: 'lint fail', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    const r = await requestMerge(deps({ queue: q.store, run }), 'TASK-7');
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toContain('bun run lint');
    expect(q.store.read()).toEqual(EMPTY_QUEUE);
  });
});

describe('requestMerge — auto-merge happy path', () => {
  it('merges immediately as sole head, marks Done, and dequeues', async () => {
    const q = memQueue();
    const b = board();
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    // Track call order for Fix 1 (resetTaskFile before merge) and Fix 2 (removeWorktree before branch -D)
    const calls: string[] = [];
    b.resetTaskFile = vi.fn(async (_taskId: string) => {
      calls.push('reset');
    });
    const d = deps({
      queue: q.store,
      board: b,
      config: cfg,
      exec: okGit((a) => {
        if (a[0] === 'merge') calls.push('merge');
        if (a[0] === 'worktree' && a[1] === 'remove') calls.push('worktree-remove');
        if (a[0] === 'branch' && a[1] === '-D') calls.push('branch-delete');
        return undefined;
      }),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('merged');
    expect(b.statuses[0]).toBe('Awaiting Merge');
    // The merge marks the task Done on the board but does NOT file it into
    // completed/ — that is a separate, opt-in action now.
    expect(b.statuses.at(-1)).toBe('Done');
    expect(b.released).toEqual(['TASK-7']);
    expect(q.store.read().entries).toHaveLength(0); // dequeued
    // Fix 1: resetTaskFile called with taskId, and before the ff-merge
    expect(b.resetTaskFile).toHaveBeenCalledWith('TASK-7');
    const resetIdx = calls.indexOf('reset');
    const mergeIdx = calls.indexOf('merge');
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(resetIdx); // reset precedes merge
    // Fix 2: worktree remove before branch delete
    const removeIdx = calls.indexOf('worktree-remove');
    const deleteIdx = calls.indexOf('branch-delete');
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(removeIdx); // remove precedes delete
  });
});

describe('requestMerge — manual-review gate', () => {
  it('waits until approved, then merges', async () => {
    const q = memQueue();
    // pre-approve on the 2nd queue read by flipping approved after the first poll
    let polls = 0;
    const sleep = vi.fn(async () => {
      polls++;
      if (polls === 1) {
        const cur = q.store.read();
        q.store.mutate(() => ({
          version: 1,
          entries: cur.entries.map((e) => ({ ...e, approved: true })),
        }));
      }
    });
    const r = await requestMerge(
      deps({ queue: q.store, sleep, config: DEFAULT_MERGE_CONFIG }),
      'TASK-7'
    );
    expect(r.status).toBe('merged');
    expect(sleep).toHaveBeenCalled();
  });

  it('returns sent_back and resets status when its entry is removed during the wait', async () => {
    const q = memQueue();
    const b = board();
    const sleep = vi.fn(async () => {
      q.store.mutate((cur) => ({
        version: 1,
        entries: cur.entries.filter((e) => e.taskId !== 'TASK-7'),
      }));
    });
    const r = await requestMerge(deps({ queue: q.store, board: b, sleep }), 'TASK-7');
    expect(r.status).toBe('sent_back');
    expect(b.statuses).toContain('In Progress'); // reset
  });
});

describe('requestMerge — waits behind a fresh head', () => {
  it('sleeps behind a non-stale foreign head, then proceeds once it dequeues', async () => {
    const q = memQueue();
    // TASK-1 is the active head but only ~1m old → NOT stale, so we must wait.
    q.store.mutate((cur) =>
      enqueueEntry(cur, {
        taskId: 'TASK-1',
        branch: 'task-1-y',
        worktree: '.worktrees/task-1-y',
        mode: 'auto-merge',
        submittedAt: '2026-07-01T11:59:00.000Z',
        approved: false,
        active: true,
        activeAt: '2026-07-01T11:59:00.000Z', // ~1m before now → not stale
      })
    );
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    let polls = 0;
    const sleep = vi.fn(async () => {
      polls++;
      if (polls === 1) q.store.mutate((cur) => removeEntry(cur, 'TASK-1')); // head finishes
    });
    const r = await requestMerge(deps({ queue: q.store, config: cfg, sleep }), 'TASK-7');
    expect(r.status).toBe('merged');
    expect(sleep).toHaveBeenCalledTimes(1); // waited exactly one poll behind the fresh head
    expect(q.store.read().entries).toHaveLength(0);
  });
});

describe('requestMerge — stale head reclaim', () => {
  it('reclaims a stale foreign head and proceeds', async () => {
    const q = memQueue();
    // TASK-1 is an active, stale head ahead of us
    q.store.mutate((cur) =>
      enqueueEntry(cur, {
        taskId: 'TASK-1',
        branch: 'task-1-y',
        worktree: '.worktrees/task-1-y',
        mode: 'auto-merge',
        submittedAt: '2026-07-01T10:00:00.000Z',
        approved: false,
        active: true,
        activeAt: '2026-07-01T11:00:00.000Z', // ~60m before now → stale (>30m)
      })
    );
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    const r = await requestMerge(deps({ queue: q.store, config: cfg }), 'TASK-7');
    expect(r.status).toBe('merged');
    expect(q.store.read().entries.some((e) => e.taskId === 'TASK-1')).toBe(false); // reclaimed
  });
});

describe('requestMerge — auto-pr', () => {
  it('opens a PR, keeps the branch, and returns the URL', async () => {
    const q = memQueue();
    const b = board();
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-pr' };
    const deleted: string[][] = [];
    const run: RunFn = async (_c, cmd) =>
      cmd.startsWith('gh pr create')
        ? { code: 0, stdout: 'https://github.com/o/r/pull/9\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    const d = deps({
      queue: q.store,
      board: b,
      config: cfg,
      run,
      exec: okGit((a) => {
        if (a[0] === 'branch') deleted.push(a);
        return undefined;
      }),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('pr_opened');
    if (r.status === 'pr_opened') expect(r.url).toBe('https://github.com/o/r/pull/9');
    expect(b.statuses[0]).toBe('Awaiting PR');
    expect(deleted).toHaveLength(0); // branch kept for the PR
  });
});

describe('requestMerge — abort at ff-merge resets status and dequeues', () => {
  it('resets to In Progress and dequeues when the primary tree has code WIP', async () => {
    const q = memQueue();
    const b = board();
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    const d = deps({
      queue: q.store,
      board: b,
      config: cfg,
      // Worktree checks stay green (okGit); only the primary ff-merge fails.
      exec: okGit((a) => {
        if (a[0] === 'merge') return new Error('not possible to fast-forward');
        return undefined;
      }),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('aborted');
    expect(b.statuses).toContain('In Progress');
    expect(q.store.read().entries).toHaveLength(0);
  });
});

describe('requestMerge — Fix 3: setStatus failure leaves queue empty (no phantom head)', () => {
  it('rejects and leaves the queue empty when setStatus throws', async () => {
    const q = memQueue();
    const b = board();
    b.setStatus = async () => {
      throw new Error('board write failed');
    };
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    const d = deps({ queue: q.store, board: b, config: cfg });
    await expect(requestMerge(d, 'TASK-7')).rejects.toThrow('board write failed');
    // The finally block must have dequeued — no phantom head left.
    expect(q.store.read().entries).toHaveLength(0);
  });
});
