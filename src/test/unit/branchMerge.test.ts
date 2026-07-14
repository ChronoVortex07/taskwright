// src/test/unit/branchMerge.test.ts
//
// TASK-127 — the task-less merge path. A multi-phase dev session working in an
// ad-hoc worktree (e.g. `tech-tree-p5`) has no board task, so it could not close
// through the merge queue and fell back to a manual `git merge --ff-only` in the
// repo root. These tests pin the core contract of the task-less path:
//
//   - it runs the SAME pipeline (rebase -> verify -> queue -> ff-merge) and reuses
//     the same abort codes;
//   - it makes NO board mutation (no Done, no release, no status parking);
//   - worktree/branch removal is OPT-IN (a dev branch keeps working after phase 1);
//   - it shares one FIFO with task merges (a concurrent task merge is ordered
//     against it, not run beside it).
import { describe, it, expect } from 'vitest';
import {
  requestMerge,
  NOOP_BOARD_OPS,
  type FinishDeps,
  type BoardOps,
  type GitExecFn,
  type RunFn,
} from '../../core/finishTask';
import type { VerifySlot } from '../../core/verifySlot';
import {
  MergeQueueStore,
  EMPTY_QUEUE,
  branchMergeKey,
  isBranchMergeKey,
  branchFromMergeKey,
  enqueueEntry,
  removeEntry,
  positionOf,
  type QueueFsDeps,
  type QueueEntry,
} from '../../core/mergeQueue';
import { DEFAULT_MERGE_CONFIG } from '../../core/mergeConfig';

function memQueue(): MergeQueueStore {
  const files: Record<string, string> = {};
  const fsDeps: QueueFsDeps = {
    exists: (p) => p in files,
    read: (p) => files[p],
    writeAtomic: (p, d) => (files[p] = d),
  };
  return new MergeQueueStore('/q.json', fsDeps);
}

/** A BoardOps that records every call, so "no board mutation" is provable. */
function spyBoard(): BoardOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setStatus: async (id, s) => void calls.push(`setStatus:${id}:${s}`),
    release: async (id) => void calls.push(`release:${id}`),
    resetTaskFile: async (id) => void calls.push(`resetTaskFile:${id}`),
  };
}

/** Happy-path git: clean tree, `main` exists, rebase/ff-merge succeed. */
function okGit(
  over?: (args: string[]) => { stdout?: string } | Error | undefined,
  record?: string[][]
): GitExecFn {
  return async (_cwd, args) => {
    record?.push(args);
    const custom = over?.(args);
    if (custom instanceof Error) throw custom;
    if (custom) return { stdout: custom.stdout ?? '', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('refs/heads/main'))
      return { stdout: 'abc', stderr: '' };
    if (args[0] === 'rev-parse') throw new Error('no such ref');
    if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
    if (args[0] === 'remote') return { stdout: 'origin\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
}

const greenRun: RunFn = async () => ({ code: 0, stdout: '', stderr: '' });

function devDeps(over: Partial<FinishDeps> = {}): FinishDeps {
  return {
    root: '/wt/tech-tree-p5',
    primaryRoot: '/primary',
    branch: 'tech-tree-p5',
    worktreeRel: '.worktrees/tech-tree-p5',
    config: { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' },
    queue: memQueue(),
    board: NOOP_BOARD_OPS,
    exec: okGit(),
    run: greenRun,
    now: () => new Date('2026-07-14T12:00:00.000Z'),
    sleep: async () => {},
    pollIntervalMs: 1,
    ...over,
  };
}

describe('branch-merge queue keys (TASK-127)', () => {
  it('namespaces a task-less entry so it can never collide with a task ID', () => {
    expect(branchMergeKey('tech-tree-p5')).toBe('branch:tech-tree-p5');
    expect(isBranchMergeKey('branch:tech-tree-p5')).toBe(true);
    expect(isBranchMergeKey('TASK-7')).toBe(false);
    expect(branchFromMergeKey('branch:tech-tree-p5')).toBe('tech-tree-p5');
    expect(branchFromMergeKey('TASK-7')).toBeNull();
  });

  it('round-trips a branch name containing slashes', () => {
    const key = branchMergeKey('feature/tech-tree/p5');
    expect(branchFromMergeKey(key)).toBe('feature/tech-tree/p5');
  });
});

describe('requestMerge — task-less (branch) merge', () => {
  it('runs the full pipeline and merges, with ZERO board mutations', async () => {
    // The board here is a REAL one, deliberately: the no-board-mutation guarantee
    // must hold in the core, from the queue key alone — not because the caller
    // remembered to inject NOOP_BOARD_OPS.
    const board = spyBoard();
    const calls: string[][] = [];
    const d = devDeps({ board, exec: okGit(undefined, calls) });

    const r = await requestMerge(d, branchMergeKey('tech-tree-p5'));

    expect(r.status).toBe('merged');
    // AC2: no Done marking, no claim release, no intermediate status parking.
    expect(board.calls).toEqual([]);
    // AC1: it really rebased and fast-forwarded (same pipeline as a task merge).
    expect(calls).toContainEqual(['rebase', 'main']);
    expect(calls).toContainEqual(['merge', '--ff-only', 'tech-tree-p5']);
    // Dequeued on the way out.
    expect(d.queue.read()).toEqual(EMPTY_QUEUE);
  });

  it('keeps the dev worktree AND its branch by default (removal is opt-in)', async () => {
    const calls: string[][] = [];
    // No opts at all: the task-less DEFAULT is "keep", derived from the key.
    const r = await requestMerge(devDeps({ exec: okGit(undefined, calls) }), branchMergeKey('p5'));

    expect(r.status).toBe('merged');
    expect(calls.some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(false);
    expect(calls.some((a) => a[0] === 'branch' && a[1] === '-D')).toBe(false);
  });

  it('removes the worktree and deletes the branch when removal is opted into', async () => {
    const calls: string[][] = [];
    const r = await requestMerge(
      devDeps({ exec: okGit(undefined, calls), branch: 'p5', worktreeRel: '.worktrees/p5' }),
      branchMergeKey('p5'),
      { removeWorktreeOnSuccess: true }
    );

    expect(r.status).toBe('merged');
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '.worktrees/p5']);
    expect(calls).toContainEqual(['branch', '-D', 'p5']);
  });

  it('a task merge still cleans up by default (no opts = historical behavior)', async () => {
    const calls: string[][] = [];
    const board = spyBoard();
    const r = await requestMerge(
      devDeps({
        board,
        exec: okGit(undefined, calls),
        branch: 'task-7-x',
        worktreeRel: '.worktrees/task-7-x',
      }),
      'TASK-7'
    );

    expect(r.status).toBe('merged');
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '.worktrees/task-7-x']);
    expect(board.calls).toContain('release:TASK-7');
    expect(board.calls).toContain('setStatus:TASK-7:Done');
  });

  it('aborts a red verify with the SAME verify_failed code, without enqueuing or touching the board', async () => {
    const board = spyBoard();
    const q = memQueue();
    const run: RunFn = async (_c, cmd) =>
      cmd === 'bun run test'
        ? { code: 1, stdout: 'FAIL src/x.test.ts', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };

    const r = await requestMerge(devDeps({ board, queue: q, run }), branchMergeKey('tech-tree-p5'));

    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') {
      expect(r.code).toBe('verify_failed');
      expect(r.detail).toContain('FAIL src/x.test.ts');
    }
    expect(q.read()).toEqual(EMPTY_QUEUE); // aborts before enqueue never touch the queue
    expect(board.calls).toEqual([]); // AC2 holds on the failure path too
  });

  it('aborts a dirty dev worktree with the SAME dirty_worktree code', async () => {
    const r = await requestMerge(
      devDeps({
        exec: okGit((a) => (a[0] === 'status' ? { stdout: ' M src/x.ts\n' } : undefined)),
      }),
      branchMergeKey('tech-tree-p5')
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.code).toBe('dirty_worktree');
  });

  it('aborts a rebase conflict with the SAME rebase_conflict code', async () => {
    const r = await requestMerge(
      devDeps({
        exec: okGit((a) => {
          if (a[0] === 'rebase' && a[1] === 'main') return new Error('conflict');
          if (a.join(' ') === 'diff --name-only --diff-filter=U') return { stdout: 'src/a.ts\n' };
          return undefined;
        }),
      }),
      branchMergeKey('tech-tree-p5')
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') {
      expect(r.code).toBe('rebase_conflict');
      expect(r.detail).toContain('src/a.ts');
    }
  });

  it('honors the manual-review gate: it waits for approval, then merges', async () => {
    const q = memQueue();
    const key = branchMergeKey('tech-tree-p5');
    let polls = 0;
    const d = devDeps({
      queue: q,
      config: { ...DEFAULT_MERGE_CONFIG, mode: 'manual-review' },
      sleep: async () => {
        // The human approves on the 3rd poll (the board's Approve control writes
        // exactly this: approved:true on our queue entry).
        if (++polls === 3)
          q.mutate((cur) => ({
            version: 1,
            entries: cur.entries.map((e) => (e.taskId === key ? { ...e, approved: true } : e)),
          }));
      },
    });

    const r = await requestMerge(d, key);

    expect(r.status).toBe('merged');
    expect(polls).toBeGreaterThanOrEqual(3); // it really blocked on the gate
  });

  it('returns { pending, ticket } on a bounded wait and KEEPS the entry (resumable, like a task)', async () => {
    const q = memQueue();
    const key = branchMergeKey('tech-tree-p5');
    // A foreign, fresh head holds the right of way, so we never reach the front.
    const head: QueueEntry = {
      taskId: 'TASK-9',
      branch: 'task-9-y',
      worktree: '.worktrees/task-9-y',
      mode: 'auto-merge',
      submittedAt: '2026-07-14T11:59:00.000Z',
      approved: false,
      active: false,
      activeAt: null,
    };
    q.mutate((cur) => enqueueEntry(cur, head));

    let t = Date.parse('2026-07-14T12:00:00.000Z');
    const d = devDeps({
      queue: q,
      now: () => new Date(t),
      sleep: async () => {
        t += 30_000;
      },
    });

    const r = await requestMerge(d, key, { waitMinutes: 1 });

    expect(r.status).toBe('pending');
    if (r.status === 'pending') {
      expect(r.taskId).toBe(key);
      expect(r.ticket).toContain(key);
      expect(r.queuePosition).toBe(2);
    }
    expect(positionOf(q.read(), key)).toBe(2); // entry kept for the resume
  });

  it('shares ONE FIFO with task merges: a concurrent task merge waits behind the branch merge', async () => {
    const q = memQueue();
    const key = branchMergeKey('tech-tree-p5');

    // The branch merge submitted first and is the head.
    q.mutate((cur) =>
      enqueueEntry(cur, {
        taskId: key,
        branch: 'tech-tree-p5',
        worktree: '.worktrees/tech-tree-p5',
        mode: 'auto-merge',
        submittedAt: '2026-07-14T11:58:00.000Z',
        approved: false,
        active: true,
        activeAt: '2026-07-14T11:58:00.000Z',
      })
    );

    const order: string[] = [];
    const taskBoard = spyBoard();
    let polls = 0;
    const taskDeps = devDeps({
      queue: q,
      board: taskBoard,
      branch: 'task-9-y',
      worktreeRel: '.worktrees/task-9-y',
      exec: okGit((a) => {
        if (a[0] === 'merge') order.push('TASK-9 merged');
        return undefined;
      }),
      sleep: async () => {
        // The branch merge finishes (dequeues) after the task merge has spun twice.
        if (++polls === 2) {
          order.push('branch merge released the queue');
          q.mutate((cur) => removeEntry(cur, key));
        }
      },
    });

    const r = await requestMerge(taskDeps, 'TASK-9');

    expect(r.status).toBe('merged');
    // The task merge did NOT jump the task-less head: it waited for it to leave.
    expect(order).toEqual(['branch merge released the queue', 'TASK-9 merged']);
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it('serializes its verify through the shared verify slot, like a task merge (TASK-126)', async () => {
    const owners: string[] = [];
    const verifySlot: VerifySlot = {
      acquire: async (owner) => {
        owners.push(owner);
        return async () => {};
      },
    };
    const r = await requestMerge(devDeps({ verifySlot }), branchMergeKey('tech-tree-p5'));
    expect(r.status).toBe('merged');
    // Every verify run (pre-enqueue + the queue-head re-verify) took the slot,
    // labeled by the queue key so a waiter can name who holds it.
    expect(owners.length).toBeGreaterThan(0);
    expect(new Set(owners)).toEqual(new Set(['branch:tech-tree-p5']));
  });
});

describe('NOOP_BOARD_OPS', () => {
  it('is a real BoardOps that mutates nothing', async () => {
    await expect(NOOP_BOARD_OPS.setStatus('branch:x', 'Done')).resolves.toBeUndefined();
    await expect(NOOP_BOARD_OPS.release('branch:x')).resolves.toBeUndefined();
    await expect(NOOP_BOARD_OPS.resetTaskFile('branch:x')).resolves.toBeUndefined();
  });
});
