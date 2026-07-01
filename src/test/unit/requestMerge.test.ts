// src/test/unit/requestMerge.test.ts
import { describe, it, expect, vi } from 'vitest';
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

function board(): BoardOps & { statuses: string[]; completed: string[]; released: string[] } {
  const rec = {
    statuses: [] as string[],
    completed: [] as string[],
    released: [] as string[],
    setStatus: async (_id: string, s: string) => {
      rec.statuses.push(s);
    },
    complete: async (id: string) => {
      rec.completed.push(id);
    },
    release: async (id: string) => {
      rec.released.push(id);
    },
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
  it('merges immediately as sole head, completes, and dequeues', async () => {
    const q = memQueue();
    const b = board();
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    const merged: string[][] = [];
    const d = deps({
      queue: q.store,
      board: b,
      config: cfg,
      exec: okGit((a) => {
        if (a[0] === 'merge') merged.push(a);
        return undefined;
      }),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('merged');
    expect(b.statuses[0]).toBe('Awaiting Merge');
    expect(b.completed).toEqual(['TASK-7']);
    expect(b.released).toEqual(['TASK-7']);
    expect(merged).toContainEqual(['merge', '--ff-only', 'task-7-x']);
    expect(q.store.read().entries).toHaveLength(0); // dequeued
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
      exec: okGit((a) => {
        // primary status dirty with code; worktree status (also 'status') must stay clean
        if (a[0] === 'status') return { stdout: '' }; // keep worktree clean check happy
        return undefined;
      }),
    });
    // Override just the primary ff-merge path: make symbolic-ref ok but merge fail.
    d.exec = okGit((a) => {
      if (a[0] === 'merge') return new Error('not possible to fast-forward');
      return undefined;
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('aborted');
    expect(b.statuses).toContain('In Progress');
    expect(q.store.read().entries).toHaveLength(0);
  });
});
