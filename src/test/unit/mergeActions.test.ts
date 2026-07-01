import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { approveMergeInQueue, sendBackInQueue } from '../../providers/mergeActions';
import { MergeQueueStore, mergeQueuePath, nodeQueueFs } from '../../core/mergeQueue';

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
