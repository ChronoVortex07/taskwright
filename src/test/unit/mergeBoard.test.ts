import { describe, it, expect } from 'vitest';
import { mergeStateForTask } from '../../core/mergeQueueState';
import type { MergeQueue } from '../../core/mergeQueue';

function q(entries: Partial<MergeQueue['entries'][number]>[]): MergeQueue {
  return {
    version: 1,
    entries: entries.map((e) => ({
      taskId: e.taskId ?? 'TASK-1',
      branch: e.branch ?? 'b',
      worktree: e.worktree ?? '.worktrees/b',
      mode: e.mode ?? 'manual-review',
      submittedAt: e.submittedAt ?? '2026-07-01T00:00:00Z',
      approved: e.approved ?? false,
      active: e.active ?? false,
      activeAt: e.activeAt ?? null,
    })),
  };
}

describe('mergeStateForTask', () => {
  it('returns undefined when the task is not queued', () => {
    expect(mergeStateForTask(q([{ taskId: 'TASK-1' }]), 'TASK-9')).toBeUndefined();
  });
  it('reports 1-based position and the entry mode', () => {
    const queue = q([{ taskId: 'TASK-1' }, { taskId: 'TASK-2', mode: 'auto-merge' }]);
    expect(mergeStateForTask(queue, 'TASK-2')).toEqual({
      queued: true,
      position: 2,
      approved: false,
      active: false,
      mode: 'auto-merge',
    });
  });
  it('reflects approved + active flags', () => {
    const queue = q([
      { taskId: 'TASK-1', approved: true, active: true, activeAt: '2026-07-01T00:00:00Z' },
    ]);
    expect(mergeStateForTask(queue, 'TASK-1')).toMatchObject({
      approved: true,
      active: true,
      position: 1,
    });
  });
});
