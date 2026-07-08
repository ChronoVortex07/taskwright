import { describe, it, expect } from 'vitest';
import type { Task } from '../../core/types';
import { deriveTreeBoard, type TreeBoard } from '../../core/treeDerived';
import { claimTimestamp } from '../../core/claims';
import { selectReadyTasks, type SelectReadyOptions } from '../../core/readyTasks';

/** Minimal Task factory: an active To-Do task with no deps/claims. */
const T = (over: Partial<Task> & { id: string }): Task => ({
  title: over.id,
  status: 'To Do',
  labels: [],
  assignee: [],
  dependencies: [],
  acceptanceCriteria: [],
  definitionOfDone: [],
  filePath: `backlog/tasks/${over.id}.md`,
  folder: 'tasks',
  ...over,
});

/** Build a real derived board (real locked/blockedBy) from the task universe. */
const boardOf = (tasks: Task[]): TreeBoard =>
  deriveTreeBoard(tasks, {
    doneStatus: 'Done',
    milestoneOrder: [],
    priorities: ['high', 'medium', 'low'],
    categories: [],
  });

/** Base options: 12h staleness, a fixed clock so claim freshness is deterministic. */
const opts = (over: Partial<SelectReadyOptions> = {}): SelectReadyOptions => ({
  doneStatus: 'Done',
  priorities: ['high', 'medium', 'low'],
  stalenessMs: 12 * 3600_000,
  now: new Date('2026-07-08T12:00:00').getTime(),
  ...over,
});

describe('selectReadyTasks', () => {
  it('excludes a task with an undone dependency; includes it once the dep is Done', () => {
    const blocked = [
      T({ id: 'TASK-1', status: 'To Do' }),
      T({ id: 'TASK-2', dependencies: ['TASK-1'] }),
    ];
    expect(selectReadyTasks(blocked, boardOf(blocked), opts()).map((t) => t.id)).toEqual([
      'TASK-1',
    ]); // TASK-2 is blocked by the undone TASK-1

    const unblocked = [
      T({ id: 'TASK-1', status: 'Done' }),
      T({ id: 'TASK-2', dependencies: ['TASK-1'] }),
    ];
    // TASK-1 is Done (excluded); TASK-2's only dep is satisfied ⇒ ready.
    expect(selectReadyTasks(unblocked, boardOf(unblocked), opts()).map((t) => t.id)).toEqual([
      'TASK-2',
    ]);
  });

  it('excludes a task under a LIVE claim but includes one whose claim is STALE', () => {
    const now = new Date('2026-07-08T12:00:00');
    const live = T({
      id: 'TASK-1',
      claimedBy: '@other',
      claimedAt: claimTimestamp(new Date(now.getTime() - 1 * 3600_000)), // 1h ago → live
    });
    const stale = T({
      id: 'TASK-2',
      claimedBy: '@other',
      claimedAt: claimTimestamp(new Date(now.getTime() - 13 * 3600_000)), // 13h ago → stale (>12h)
    });
    const tasks = [live, stale];
    // Live claim hides TASK-1; a stale claim is abandoned/reclaimable ⇒ TASK-2 stays.
    expect(selectReadyTasks(tasks, boardOf(tasks), opts({ now: now.getTime() })).map((t) => t.id)).toEqual(
      ['TASK-2']
    );
  });

  it('treats every claim as live when staleness is disabled (stalenessMs <= 0)', () => {
    const now = new Date('2026-07-08T12:00:00');
    const old = T({
      id: 'TASK-1',
      claimedBy: '@x',
      claimedAt: claimTimestamp(new Date(now.getTime() - 100 * 3600_000)), // ancient, but…
    });
    // …staleness disabled ⇒ the claim is still LIVE ⇒ excluded (matches resolveClaimAction).
    expect(selectReadyTasks([old], boardOf([old]), opts({ stalenessMs: 0, now: now.getTime() }))).toEqual(
      []
    );
  });

  it('excludes a task that is currently in the merge queue', () => {
    const tasks = [T({ id: 'TASK-1' }), T({ id: 'TASK-2' })];
    expect(
      selectReadyTasks(tasks, boardOf(tasks), opts({ inMergeQueue: ['TASK-2'] })).map((t) => t.id)
    ).toEqual(['TASK-1']); // TASK-2 is mid-integration
  });

  it('orders by priority (high>medium>low), then ordinal ascending', () => {
    const tasks = [
      T({ id: 'TASK-1', priority: 'low' }),
      T({ id: 'TASK-2', priority: 'high', ordinal: 2000 }),
      T({ id: 'TASK-3', priority: 'high', ordinal: 1000 }),
      T({ id: 'TASK-4', priority: 'medium' }),
    ];
    // high(ord 1000) < high(ord 2000) < medium < low
    expect(selectReadyTasks(tasks, boardOf(tasks), opts()).map((t) => t.id)).toEqual([
      'TASK-3',
      'TASK-2',
      'TASK-4',
      'TASK-1',
    ]);
  });

  it('filters by category and milestone (Backburner matches unset), and clamps the limit', () => {
    const tasks = [
      T({ id: 'TASK-1', category: 'Features', milestone: 'v1', priority: 'high' }),
      T({ id: 'TASK-2', category: 'Platform', milestone: 'v1', priority: 'high' }),
      T({ id: 'TASK-3', category: 'Features', priority: 'medium' }), // no milestone ⇒ Backburner
    ];
    const board = boardOf(tasks);
    expect(selectReadyTasks(tasks, board, opts({ category: 'Features' })).map((t) => t.id)).toEqual([
      'TASK-1',
      'TASK-3',
    ]);
    expect(selectReadyTasks(tasks, board, opts({ milestone: 'v1' })).map((t) => t.id)).toEqual([
      'TASK-1',
      'TASK-2',
    ]);
    expect(
      selectReadyTasks(tasks, board, opts({ milestone: 'Backburner' })).map((t) => t.id)
    ).toEqual(['TASK-3']);
    // limit clamps to >= 1 and floors; omitted ⇒ all.
    expect(selectReadyTasks(tasks, board, opts({ limit: 0 }))).toHaveLength(1);
    expect(selectReadyTasks(tasks, board, opts({ limit: 2 }))).toHaveLength(2);
    expect(selectReadyTasks(tasks, board, opts())).toHaveLength(3);
  });
});
