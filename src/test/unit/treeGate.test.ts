import { describe, it, expect } from 'vitest';
import type { Task } from '../../core/types';
import {
  resolveDoneStatus,
  dependencySatisfied,
  computeBlockedBy,
  isLocked,
  wouldCreateCycle,
  blockedByMessage,
} from '../../core/treeGate';

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    ...partial,
    title: partial.title ?? partial.id,
    status: partial.status ?? 'To Do',
    labels: partial.labels ?? [],
    assignee: partial.assignee ?? [],
    dependencies: partial.dependencies ?? [],
    acceptanceCriteria: partial.acceptanceCriteria ?? [],
    definitionOfDone: partial.definitionOfDone ?? [],
    filePath: partial.filePath ?? `/b/tasks/${partial.id}.md`,
  } as Task;
}

function byId(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((t) => [t.id.toUpperCase(), t]));
}

describe('resolveDoneStatus', () => {
  it('uses the last configured status, else Done', () => {
    expect(resolveDoneStatus(['To Do', 'In Progress', 'Pending Review', 'Done'])).toBe('Done');
    expect(resolveDoneStatus(['Backlog', 'Shipped'])).toBe('Shipped');
    expect(resolveDoneStatus([])).toBe('Done');
    expect(resolveDoneStatus(undefined)).toBe('Done');
  });
});

describe('dependencySatisfied', () => {
  it('undefined dep is never satisfied (missing = blocking)', () => {
    expect(dependencySatisfied(undefined, 'Done')).toBe(false);
  });
  it('done status or completed/archive folder satisfies', () => {
    expect(dependencySatisfied({ status: 'Done', folder: 'tasks' }, 'Done')).toBe(true);
    expect(dependencySatisfied({ status: 'To Do', folder: 'completed' }, 'Done')).toBe(true);
    expect(dependencySatisfied({ status: 'To Do', folder: 'archive' }, 'Done')).toBe(true);
    expect(dependencySatisfied({ status: 'In Progress', folder: 'tasks' }, 'Done')).toBe(false);
  });
});

describe('computeBlockedBy / isLocked', () => {
  const done = 'Done';
  it('lists unsatisfied and missing deps; a done dep does not block', () => {
    const t = task({ id: 'TASK-1', dependencies: ['TASK-2', 'TASK-3', 'TASK-404'] });
    const map = byId([
      t,
      task({ id: 'TASK-2', status: 'Done' }),
      task({ id: 'TASK-3', status: 'In Progress' }),
    ]);
    expect(computeBlockedBy(t, map, done)).toEqual(['TASK-3', 'TASK-404']);
    expect(isLocked(t, map, done)).toBe(true);
  });
  it('a completed-folder dep satisfies the gate', () => {
    const t = task({ id: 'TASK-1', dependencies: ['TASK-2'] });
    const map = byId([t, task({ id: 'TASK-2', status: 'To Do', folder: 'completed' })]);
    expect(computeBlockedBy(t, map, done)).toEqual([]);
    expect(isLocked(t, map, done)).toBe(false);
  });
  it('no dependencies means unlocked', () => {
    const t = task({ id: 'TASK-1' });
    expect(isLocked(t, byId([t]), done)).toBe(false);
  });

  it('a Done baseline draft satisfies a dependent (P6/D2 — Done draft unlocks its gap dependent)', () => {
    const dependent = task({ id: 'TASK-2', dependencies: ['DRAFT-1'] });
    const map = byId([
      dependent,
      task({ id: 'DRAFT-1', status: 'Done', folder: 'drafts' }), // a Done baseline draft
    ]);
    expect(computeBlockedBy(dependent, map, done)).toEqual([]); // unlocked
    expect(isLocked(dependent, map, done)).toBe(false);
  });
});

describe('wouldCreateCycle', () => {
  it('detects self edge', () => {
    expect(wouldCreateCycle([task({ id: 'TASK-1' })], 'TASK-1', 'TASK-1')).toBe(true);
  });
  it('detects a direct back-edge', () => {
    const tasks = [task({ id: 'TASK-1' }), task({ id: 'TASK-2', dependencies: ['TASK-1'] })];
    // TASK-2 already depends on TASK-1; adding TASK-1 -> TASK-2 closes the cycle.
    expect(wouldCreateCycle(tasks, 'TASK-1', 'TASK-2')).toBe(true);
  });
  it('detects a transitive cycle', () => {
    const tasks = [
      task({ id: 'TASK-1' }),
      task({ id: 'TASK-2', dependencies: ['TASK-1'] }),
      task({ id: 'TASK-3', dependencies: ['TASK-2'] }),
    ];
    expect(wouldCreateCycle(tasks, 'TASK-1', 'TASK-3')).toBe(true);
  });
  it('allows a diamond with no cycle', () => {
    const tasks = [
      task({ id: 'TASK-1' }),
      task({ id: 'TASK-2', dependencies: ['TASK-1'] }),
      task({ id: 'TASK-3', dependencies: ['TASK-1'] }),
      task({ id: 'TASK-4' }),
    ];
    // TASK-4 depending on both TASK-2 and TASK-3 introduces no cycle.
    expect(wouldCreateCycle(tasks, 'TASK-4', 'TASK-2')).toBe(false);
    expect(wouldCreateCycle(tasks, 'TASK-4', 'TASK-3')).toBe(false);
  });
  it('is case-insensitive over IDs', () => {
    const tasks = [task({ id: 'TASK-1' }), task({ id: 'TASK-2', dependencies: ['task-1'] })];
    expect(wouldCreateCycle(tasks, 'task-1', 'TASK-2')).toBe(true);
  });
});

describe('blockedByMessage', () => {
  it('names the blockers', () => {
    expect(blockedByMessage('TASK-1', ['TASK-2', 'TASK-3'])).toContain('TASK-2, TASK-3');
    expect(blockedByMessage('TASK-1', ['TASK-2'])).toContain('TASK-1');
  });
});
