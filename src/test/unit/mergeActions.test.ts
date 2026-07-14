import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  approveMergeInQueue,
  sendBackInQueue,
  sendBackMerge,
  pendingBranchMerges,
} from '../../providers/mergeActions';
import {
  MergeQueueStore,
  branchMergeKey,
  mergeQueuePath,
  nodeQueueFs,
} from '../../core/mergeQueue';
import type { BacklogParser } from '../../core/BacklogParser';
import type { BacklogWriter } from '../../core/BacklogWriter';

let dir: string;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function seed(commonDir: string): void {
  const store = new MergeQueueStore(mergeQueuePath(commonDir), nodeQueueFs);
  store.mutate(() => ({
    version: 1,
    entries: [
      {
        taskId: 'TASK-7',
        branch: 'task-7-x',
        worktree: '.worktrees/task-7-x',
        mode: 'manual-review',
        submittedAt: '2026-07-01T00:00:00Z',
        approved: false,
        active: false,
        activeAt: null,
      },
    ],
  }));
}

describe('approveMergeInQueue', () => {
  it('sets approved:true on the entry', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ma-'));
    seed(dir);
    approveMergeInQueue(dir, 'TASK-7');
    const store = new MergeQueueStore(mergeQueuePath(dir), nodeQueueFs);
    expect(store.read().entries[0].approved).toBe(true);
  });
});

describe('sendBackInQueue', () => {
  it('removes the entry', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-mb-'));
    seed(dir);
    sendBackInQueue(dir, 'TASK-7');
    const store = new MergeQueueStore(mergeQueuePath(dir), nodeQueueFs);
    expect(store.read().entries).toHaveLength(0);
  });
});

describe('pendingBranchMerges (TASK-127)', () => {
  /** A queue holding one task merge (head) and one task-less branch merge behind it. */
  function seedMixed(commonDir: string): void {
    new MergeQueueStore(mergeQueuePath(commonDir), nodeQueueFs).mutate(() => ({
      version: 1,
      entries: [
        {
          taskId: 'TASK-7',
          branch: 'task-7-x',
          worktree: '.worktrees/task-7-x',
          mode: 'manual-review',
          submittedAt: '2026-07-14T10:00:00Z',
          approved: false,
          active: false,
          activeAt: null,
        },
        {
          taskId: branchMergeKey('tech-tree-p5'),
          branch: 'tech-tree-p5',
          worktree: '.worktrees/tech-tree-p5',
          mode: 'manual-review',
          submittedAt: '2026-07-14T11:00:00Z',
          approved: false,
          active: false,
          activeAt: null,
        },
      ],
    }));
  }

  it('lists ONLY the task-less entries — a task merge is reviewed from its board card', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-pbm-'));
    seedMixed(dir);
    expect(pendingBranchMerges(dir)).toEqual([
      {
        key: 'branch:tech-tree-p5',
        branch: 'tech-tree-p5',
        worktree: '.worktrees/tech-tree-p5',
        submittedAt: '2026-07-14T11:00:00Z',
        approved: false,
        position: 2, // its place in the ONE shared FIFO, task merges included
      },
    ]);
  });

  it('approving one by key grants the gate the waiting session is blocked on', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-pbm2-'));
    seedMixed(dir);
    approveMergeInQueue(dir, 'branch:tech-tree-p5');
    expect(pendingBranchMerges(dir)[0].approved).toBe(true);
    // The task entry is untouched.
    const store = new MergeQueueStore(mergeQueuePath(dir), nodeQueueFs);
    expect(store.read().entries[0].approved).toBe(false);
  });

  it('is empty when nothing task-less is queued', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-pbm3-'));
    seed(dir);
    expect(pendingBranchMerges(dir)).toEqual([]);
  });
});

describe('sendBackMerge', () => {
  it('removes the queue entry and resets the task status to In Progress', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-mc-'));
    seed(dir);
    const parser = {
      getTask: async () => ({ id: 'TASK-7', title: 'x', status: 'Blocked' }),
    } as unknown as BacklogParser;
    const updateTask = vi.fn(async () => undefined);
    const writer = { updateTask } as unknown as BacklogWriter;

    await sendBackMerge(dir, 'TASK-7', parser, writer);

    const store = new MergeQueueStore(mergeQueuePath(dir), nodeQueueFs);
    expect(store.read().entries).toHaveLength(0);
    expect(updateTask).toHaveBeenCalledWith('TASK-7', { status: 'In Progress' }, parser);
  });

  it('still removes the queue entry and skips the status write when the task no longer exists', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-md-'));
    seed(dir);
    const parser = {
      getTask: async () => undefined,
    } as unknown as BacklogParser;
    const updateTask = vi.fn(async () => undefined);
    const writer = { updateTask } as unknown as BacklogWriter;

    await expect(sendBackMerge(dir, 'TASK-7', parser, writer)).resolves.toBeUndefined();

    const store = new MergeQueueStore(mergeQueuePath(dir), nodeQueueFs);
    expect(store.read().entries).toHaveLength(0);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('still removes the queue entry and resolves when updateTask rejects (best-effort reset)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-me-'));
    seed(dir);
    const parser = {
      getTask: async () => ({ id: 'TASK-7', title: 'x', status: 'Blocked' }),
    } as unknown as BacklogParser;
    const updateTask = vi.fn(async () => {
      throw new Error('boom');
    });
    const writer = { updateTask } as unknown as BacklogWriter;

    await expect(sendBackMerge(dir, 'TASK-7', parser, writer)).resolves.toBeUndefined();

    const store = new MergeQueueStore(mergeQueuePath(dir), nodeQueueFs);
    expect(store.read().entries).toHaveLength(0);
  });
});
