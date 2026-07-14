// src/test/unit/requestMerge.test.ts
import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import {
  requestMerge,
  type FinishDeps,
  type BoardOps,
  type GitExecFn,
  type RunFn,
  type MergeProgress,
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
  it('aborts on a dirty worktree without enqueuing, with code dirty_worktree', async () => {
    const q = memQueue();
    const d = deps({
      queue: q.store,
      exec: okGit((a) => (a[0] === 'status' ? { stdout: ' M x.ts\n' } : undefined)),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.code).toBe('dirty_worktree');
    expect(q.store.read()).toEqual(EMPTY_QUEUE);
  });

  it('aborts on rebase conflict with the conflict list and code rebase_conflict', async () => {
    const d = deps({
      exec: okGit((a) => {
        if (a[0] === 'rebase' && a[1] === 'main') return new Error('conflict');
        if (a.join(' ') === 'diff --name-only --diff-filter=U') return { stdout: 'src/a.ts\n' };
        return undefined;
      }),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') {
      expect(r.detail).toContain('src/a.ts');
      expect(r.code).toBe('rebase_conflict');
    }
  });

  it('aborts on red verification without enqueuing, with code verify_failed', async () => {
    const q = memQueue();
    const run: RunFn = async (_c, cmd) =>
      cmd === 'bun run lint'
        ? { code: 1, stdout: 'lint fail', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    const r = await requestMerge(deps({ queue: q.store, run }), 'TASK-7');
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') {
      expect(r.reason).toContain('bun run lint');
      expect(r.code).toBe('verify_failed');
    }
    expect(q.store.read()).toEqual(EMPTY_QUEUE);
  });
});

describe('requestMerge — verify timeout', () => {
  it('passes config.verifyTimeoutMs to each verify command', async () => {
    const timeouts: Array<number | undefined> = [];
    const run: RunFn = async (_c, _cmd, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { code: 0, stdout: '', stderr: '' };
    };
    const cfg: MergeConfig = {
      ...DEFAULT_MERGE_CONFIG,
      mode: 'auto-merge',
      verifyTimeoutMs: 1_500_000,
    };
    const r = await requestMerge(deps({ config: cfg, run }), 'TASK-7');
    expect(r.status).toBe('merged');
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((t) => t === 1_500_000)).toBe(true);
  });

  it('returns code verify_timeout with an actionable reason, never "Verification failed"', async () => {
    const q = memQueue();
    const run: RunFn = async (_c, cmd) =>
      cmd === 'bun run test'
        ? { code: 1, stdout: '', stderr: '', timedOut: true }
        : { code: 0, stdout: '', stderr: '' };
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, verifyTimeoutMs: 900_000 };
    const r = await requestMerge(deps({ queue: q.store, run, config: cfg }), 'TASK-7');
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') {
      expect(r.code).toBe('verify_timeout');
      expect(r.reason).toContain('verify timed out after 900s on `bun run test`');
      expect(r.reason).toContain('taskwright.mergeVerifyTimeoutMinutes');
      expect(r.reason).toContain('verifyTimeoutMinutes');
      expect(r.reason).not.toContain('Verification failed');
    }
    expect(q.store.read()).toEqual(EMPTY_QUEUE);
  });

  it('returns code verify_timeout on the post-wait re-verify too', async () => {
    const q = memQueue();
    const b = board();
    let calls = 0;
    // Green pre-verify; the re-verify (2nd pass over the single command) times out.
    const run: RunFn = async () => {
      calls++;
      return calls > 1
        ? { code: 1, stdout: '', stderr: '', timedOut: true }
        : { code: 0, stdout: '', stderr: '' };
    };
    const cfg: MergeConfig = {
      ...DEFAULT_MERGE_CONFIG,
      mode: 'auto-merge',
      verifyCommands: ['bun run test'],
    };
    const r = await requestMerge(deps({ queue: q.store, board: b, run, config: cfg }), 'TASK-7');
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.code).toBe('verify_timeout');
    expect(b.statuses).toContain('In Progress'); // status reset after enqueue
  });

  // TASK-126 AC5. Agents were reading load-flaked RED suites as "timeouts",
  // pushing verifyTimeoutMinutes higher and blind-retrying an unchanged tree.
  // The two aborts must be unmistakable in prose, not just in the abort code.
  it('a red suite and a killed suite produce unmistakably different reasons', async () => {
    const cfg: MergeConfig = {
      ...DEFAULT_MERGE_CONFIG,
      verifyCommands: ['bun run test'],
      verifyTimeoutMs: 900_000,
    };
    const red: RunFn = async () => ({ code: 1, stdout: 'x', stderr: '' });
    const killed: RunFn = async () => ({ code: 1, stdout: '', stderr: '', timedOut: true });

    const rRed = await requestMerge(deps({ run: red, config: cfg }), 'TASK-7');
    const rKilled = await requestMerge(deps({ run: killed, config: cfg }), 'TASK-7');
    expect(rRed.status).toBe('aborted');
    expect(rKilled.status).toBe('aborted');
    if (rRed.status !== 'aborted' || rKilled.status !== 'aborted') return;

    expect(rRed.code).toBe('verify_failed');
    expect(rRed.reason).toMatch(/FAILED \(non-zero exit, not a timeout\)/);
    expect(rRed.reason).toMatch(/fail the same way/i); // don't blind-retry
    expect(rRed.reason).not.toMatch(/timed out/i);
    expect(rRed.reason).not.toContain('mergeVerifyTimeoutMinutes'); // never suggest a bigger timeout for a red suite

    expect(rKilled.code).toBe('verify_timeout');
    expect(rKilled.reason).toMatch(/timed out/i);
    expect(rKilled.reason).toMatch(/KILLED/);
    expect(rKilled.reason).not.toMatch(/Verification failed/i);
  });

  it('says the run was not competing with another merge when the slot serialized it', async () => {
    // With a slot injected, a red verify cannot be blamed on a parallel verify —
    // and the reason says so, which is what stops the retry loop.
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, verifyCommands: ['bun run test'] };
    const red: RunFn = async () => ({ code: 1, stdout: 'x', stderr: '' });
    const slot = { acquire: async () => async (): Promise<void> => {} };
    const r = await requestMerge(deps({ run: red, config: cfg, verifySlot: slot }), 'TASK-7');
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') {
      expect(r.code).toBe('verify_failed');
      expect(r.reason).toMatch(/ran alone|verify slot/i);
      expect(r.reason).toMatch(/not load contention/i);
    }
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

describe('requestMerge — skips redundant queue-head re-verify when base did not move', () => {
  /** Single verify command so run-call counts map 1:1 to verify passes. */
  const oneCommand: MergeConfig = {
    ...DEFAULT_MERGE_CONFIG,
    mode: 'auto-merge',
    verifyCommands: ['bun run test'],
  };

  it('runs verify only once when the post-wait rebase is a no-op (HEAD unchanged)', async () => {
    let verifyRuns = 0;
    const run: RunFn = async () => {
      verifyRuns++;
      return { code: 0, stdout: '', stderr: '' };
    };
    const exec = okGit((a) =>
      a[0] === 'rev-parse' && a[1] === 'HEAD' ? { stdout: 'headsha\n' } : undefined
    );
    const r = await requestMerge(deps({ run, config: oneCommand, exec }), 'TASK-7');
    expect(r.status).toBe('merged');
    expect(verifyRuns).toBe(1); // pre-enqueue only; queue-head re-verify skipped
  });

  it('re-verifies when the rebase moved HEAD (base advanced during the wait)', async () => {
    let verifyRuns = 0;
    const run: RunFn = async () => {
      verifyRuns++;
      return { code: 0, stdout: '', stderr: '' };
    };
    let headReads = 0;
    const exec = okGit((a) =>
      a[0] === 'rev-parse' && a[1] === 'HEAD' ? { stdout: `sha-${++headReads}\n` } : undefined
    );
    const r = await requestMerge(deps({ run, config: oneCommand, exec }), 'TASK-7');
    expect(r.status).toBe('merged');
    expect(verifyRuns).toBe(2); // base moved → strictly re-verify
  });

  it('re-verifies when HEAD cannot be resolved (fail-safe)', async () => {
    let verifyRuns = 0;
    const run: RunFn = async () => {
      verifyRuns++;
      return { code: 0, stdout: '', stderr: '' };
    };
    // okGit's default rev-parse throws for anything but refs/heads/main.
    const r = await requestMerge(deps({ run, config: oneCommand }), 'TASK-7');
    expect(r.status).toBe('merged');
    expect(verifyRuns).toBe(2);
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
  it('resets to In Progress and dequeues when the ff-merge fails', async () => {
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

  it('returns code dirty_primary when primary WIP collides with the merge footprint', async () => {
    const q = memQueue();
    const b = board();
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    const base = okGit();
    // Worktree ('/wt') status is clean; the PRIMARY tree ('/primary') has WIP on a
    // file the fast-forward would update.
    const exec: GitExecFn = async (cwd, args) => {
      if (args[0] === 'status' && cwd === '/primary')
        return { stdout: ' M src/x.ts\n', stderr: '' };
      if (args[0] === 'diff' && cwd === '/primary' && args.includes('main..task-7-x'))
        return { stdout: 'src/x.ts\n', stderr: '' };
      return base(cwd, args);
    };
    const r = await requestMerge(deps({ queue: q.store, board: b, config: cfg, exec }), 'TASK-7');
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') {
      expect(r.code).toBe('dirty_primary');
      expect(r.reason).toContain('src/x.ts'); // names the blocking file
    }
    expect(b.statuses).toContain('In Progress');
    expect(q.store.read().entries).toHaveLength(0);
  });

  it('merges despite primary WIP that does not collide with the merge footprint', async () => {
    const q = memQueue();
    const b = board();
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    const base = okGit();
    // Primary has an unrelated untracked file + unrelated tracked mod; the
    // branch's footprint does not include them — the merge must proceed.
    const exec: GitExecFn = async (cwd, args) => {
      if (args[0] === 'status' && cwd === '/primary')
        return { stdout: '?? scratch.txt\n M docs/readme.md\n', stderr: '' };
      if (args[0] === 'diff' && cwd === '/primary' && args.includes('main..task-7-x'))
        return { stdout: 'src/feature.ts\n', stderr: '' };
      return base(cwd, args);
    };
    const r = await requestMerge(deps({ queue: q.store, board: b, config: cfg, exec }), 'TASK-7');
    expect(r.status).toBe('merged');
    expect(q.store.read().entries).toHaveLength(0);
  });
});

describe('requestMerge — waitMinutes returns pending instead of blocking (TASK-88)', () => {
  it('returns pending with queuePosition + ticket when the wait exceeds waitMinutes, keeping the entry and status', async () => {
    const q = memQueue();
    const b = board();
    // manual-review, never approved; the clock advances 30s per poll.
    let t = Date.parse('2026-07-01T12:00:00.000Z');
    const d = deps({
      queue: q.store,
      board: b,
      now: () => new Date(t),
      sleep: async () => {
        t += 30_000;
      },
    });
    const r = await requestMerge(d, 'TASK-7', { waitMinutes: 1 });
    expect(r.status).toBe('pending');
    if (r.status === 'pending') {
      expect(r.taskId).toBe('TASK-7');
      expect(r.queuePosition).toBe(1);
      expect(r.ticket).toContain('TASK-7@');
    }
    // The queue entry is KEPT (no dequeue) and the board stays parked in the
    // intermediate status — pending is not an abort.
    expect(q.store.read().entries.map((e) => e.taskId)).toEqual(['TASK-7']);
    expect(b.statuses).toEqual(['Pending Review']);
  });

  it('waitMinutes: 0 checks once and returns pending immediately when not proceedable', async () => {
    const q = memQueue();
    const sleep = vi.fn(async () => {});
    const r = await requestMerge(deps({ queue: q.store, sleep }), 'TASK-7', { waitMinutes: 0 });
    expect(r.status).toBe('pending');
    expect(sleep).not.toHaveBeenCalled();
    expect(q.store.read().entries).toHaveLength(1);
  });

  it('still merges within waitMinutes when the gate opens in time', async () => {
    const q = memQueue();
    let t = Date.parse('2026-07-01T12:00:00.000Z');
    let polls = 0;
    const sleep = async (): Promise<void> => {
      t += 1_000;
      polls++;
      if (polls === 1) {
        q.store.mutate((cur) => ({
          version: 1,
          entries: cur.entries.map((e) => ({ ...e, approved: true })),
        }));
      }
    };
    const r = await requestMerge(
      deps({ queue: q.store, now: () => new Date(t), sleep }),
      'TASK-7',
      {
        waitMinutes: 5,
      }
    );
    expect(r.status).toBe('merged');
    expect(q.store.read().entries).toHaveLength(0);
  });
});

describe('requestMerge — re-entrant resume of a pending queue entry (TASK-88)', () => {
  /** Single verify command so run-call counts map 1:1 to verify passes. */
  const oneCommand: MergeConfig = {
    ...DEFAULT_MERGE_CONFIG,
    mode: 'auto-merge',
    verifyCommands: ['bun run test'],
  };

  it('resumes the existing entry without re-enqueueing and skips verify when the base did not move', async () => {
    const q = memQueue();
    q.store.mutate((cur) =>
      enqueueEntry(cur, {
        taskId: 'TASK-7',
        branch: 'task-7-x',
        worktree: '.worktrees/task-7-x',
        mode: 'auto-merge',
        submittedAt: '2026-07-01T11:30:00.000Z',
        approved: false,
        active: false,
        activeAt: null,
        verifiedHeadSha: 'headsha',
      })
    );
    let verifyRuns = 0;
    const run: RunFn = async () => {
      verifyRuns++;
      return { code: 0, stdout: '', stderr: '' };
    };
    const exec = okGit((a) =>
      a[0] === 'rev-parse' && a[1] === 'HEAD' ? { stdout: 'headsha\n' } : undefined
    );
    const b = board();
    const r = await requestMerge(
      deps({ queue: q.store, board: b, run, exec, config: oneCommand }),
      'TASK-7'
    );
    expect(r.status).toBe('merged');
    expect(verifyRuns).toBe(0); // recorded sha matches HEAD ⇒ no pre-verify, no head re-verify
    // Resume does NOT re-park the task in the intermediate status.
    expect(b.statuses).toEqual(['Done']);
    expect(q.store.read().entries).toHaveLength(0);
  });

  it('re-verifies on resume when the base moved (HEAD differs from the recorded sha)', async () => {
    const q = memQueue();
    q.store.mutate((cur) =>
      enqueueEntry(cur, {
        taskId: 'TASK-7',
        branch: 'task-7-x',
        worktree: '.worktrees/task-7-x',
        mode: 'auto-merge',
        submittedAt: '2026-07-01T11:30:00.000Z',
        approved: false,
        active: false,
        activeAt: null,
        verifiedHeadSha: 'oldsha',
      })
    );
    let verifyRuns = 0;
    const run: RunFn = async () => {
      verifyRuns++;
      return { code: 0, stdout: '', stderr: '' };
    };
    const exec = okGit((a) =>
      a[0] === 'rev-parse' && a[1] === 'HEAD' ? { stdout: 'newsha\n' } : undefined
    );
    const r = await requestMerge(deps({ queue: q.store, run, exec, config: oneCommand }), 'TASK-7');
    expect(r.status).toBe('merged');
    expect(verifyRuns).toBe(1); // fresh verify against the moved base; head re-verify skipped (no-op)
  });

  it('a pending call then a resume runs verify exactly once and keeps one ticket', async () => {
    const q = memQueue();
    let verifyRuns = 0;
    const run: RunFn = async () => {
      verifyRuns++;
      return { code: 0, stdout: '', stderr: '' };
    };
    const exec = okGit((a) =>
      a[0] === 'rev-parse' && a[1] === 'HEAD' ? { stdout: 'headsha\n' } : undefined
    );
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, verifyCommands: ['bun run test'] };
    // First call: manual-review, never approved, waitMinutes 0 ⇒ pending.
    const first = await requestMerge(deps({ queue: q.store, run, exec, config: cfg }), 'TASK-7', {
      waitMinutes: 0,
    });
    expect(first.status).toBe('pending');
    expect(verifyRuns).toBe(1);
    const firstTicket = first.status === 'pending' ? first.ticket : '';

    // Second call (still unapproved): resumes the SAME entry, no duplicate verify.
    const second = await requestMerge(deps({ queue: q.store, run, exec, config: cfg }), 'TASK-7', {
      waitMinutes: 0,
      ticket: firstTicket,
    });
    expect(second.status).toBe('pending');
    if (second.status === 'pending') expect(second.ticket).toBe(firstTicket);
    expect(verifyRuns).toBe(1); // base unchanged ⇒ verify skipped on resume
    expect(q.store.read().entries).toHaveLength(1); // never duplicated
  });

  it('returns sent_back when a ticket is presented but the entry vanished (reviewer send-back while parked)', async () => {
    const q = memQueue();
    let verifyRuns = 0;
    const run: RunFn = async () => {
      verifyRuns++;
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await requestMerge(deps({ queue: q.store, run }), 'TASK-7', {
      ticket: 'TASK-7@2026-07-01T11:30:00.000Z',
    });
    expect(r.status).toBe('sent_back');
    expect(verifyRuns).toBe(0); // detected before any expensive work
    expect(q.store.read().entries).toHaveLength(0); // never re-enqueued
  });
});

describe('requestMerge — onProgress (TASK-88)', () => {
  it('emits verify progress with command name, index, and count', async () => {
    const events: MergeProgress[] = [];
    const cfg: MergeConfig = {
      ...DEFAULT_MERGE_CONFIG,
      mode: 'auto-merge',
      verifyCommands: ['cmd-a', 'cmd-b'],
    };
    const r = await requestMerge(
      deps({ config: cfg, onProgress: (e) => events.push(e) }),
      'TASK-7'
    );
    expect(r.status).toBe('merged');
    const verify = events.filter((e) => e.phase === 'verify');
    expect(
      verify.some((e) => e.command === 'cmd-a' && e.commandIndex === 1 && e.commandCount === 2)
    ).toBe(true);
    expect(verify.some((e) => e.command === 'cmd-b' && e.commandIndex === 2)).toBe(true);
    expect(verify.every((e) => typeof e.message === 'string' && e.message.length > 0)).toBe(true);
  });

  it('emits elapsed ticks while a long verify command runs', async () => {
    const events: MergeProgress[] = [];
    let t = Date.parse('2026-07-01T12:00:00.000Z');
    let resolveRun!: (v: { code: number; stdout: string; stderr: string }) => void;
    const run: RunFn = () =>
      new Promise((res) => {
        resolveRun = res;
      });
    let ticks = 0;
    const sleep = async (): Promise<void> => {
      ticks++;
      t += 10_000;
      if (ticks >= 2) resolveRun({ code: 0, stdout: '', stderr: '' });
    };
    const cfg: MergeConfig = {
      ...DEFAULT_MERGE_CONFIG,
      mode: 'auto-merge',
      verifyCommands: ['slow suite'],
    };
    // Constant HEAD so the queue-head re-verify is skipped (run is called once).
    const exec = okGit((a) =>
      a[0] === 'rev-parse' && a[1] === 'HEAD' ? { stdout: 'headsha\n' } : undefined
    );
    const r = await requestMerge(
      deps({
        config: cfg,
        run,
        exec,
        sleep,
        now: () => new Date(t),
        onProgress: (e) => events.push(e),
        progressIntervalMs: 5_000,
      }),
      'TASK-7'
    );
    expect(r.status).toBe('merged');
    const ticksEmitted = events.filter(
      (e) => e.phase === 'verify' && (e.elapsedSeconds ?? 0) >= 10
    );
    expect(ticksEmitted.length).toBeGreaterThanOrEqual(1);
    expect(ticksEmitted[0].command).toBe('slow suite');
  });

  it('emits queue-wait progress with position and approval state', async () => {
    const q = memQueue();
    const events: MergeProgress[] = [];
    // No verify commands: the verify ticker also consumes deps.sleep when an
    // observer is attached, and this fake must only serve the queue poll.
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, verifyCommands: [] };
    const sleep = async (): Promise<void> => {
      q.store.mutate((cur) => ({
        version: 1,
        entries: cur.entries.map((e) => ({ ...e, approved: true })),
      }));
    };
    const r = await requestMerge(
      deps({ queue: q.store, config: cfg, sleep, onProgress: (e) => events.push(e) }),
      'TASK-7'
    );
    expect(r.status).toBe('merged');
    const waits = events.filter((e) => e.phase === 'queue-wait');
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits[0].queuePosition).toBe(1);
    expect(waits[0].approved).toBe(false);
    expect(waits[0].message).toMatch(/approval/i);
  });

  it('a throwing onProgress observer never breaks the merge', async () => {
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    const r = await requestMerge(
      deps({
        config: cfg,
        onProgress: () => {
          throw new Error('observer exploded');
        },
      }),
      'TASK-7'
    );
    expect(r.status).toBe('merged');
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
