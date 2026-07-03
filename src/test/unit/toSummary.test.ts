import { describe, it, expect } from 'vitest';
import { toSummary } from '../../mcp/handlers';
import type { Task } from '../../core/types';

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'TASK-5',
    title: 'Parent',
    status: 'To Do',
    labels: [],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: '/b/tasks/TASK-5 - Parent.md',
    ...over,
  } as Task;
}

describe('toSummary — subtasks + parentTaskId (GAP-5)', () => {
  it('surfaces subtasks when present', () => {
    const s = toSummary(makeTask({ subtasks: ['TASK-5.1', 'TASK-5.2'] }), '/b');
    expect(s.subtasks).toEqual(['TASK-5.1', 'TASK-5.2']);
  });

  it('surfaces parentTaskId on a child', () => {
    const s = toSummary(makeTask({ id: 'TASK-5.1', parentTaskId: 'TASK-5' }), '/b');
    expect(s.parentTaskId).toBe('TASK-5');
  });

  it('leaves both undefined on a plain task (negative control)', () => {
    const s = toSummary(makeTask(), '/b');
    expect(s.subtasks).toBeUndefined();
    expect(s.parentTaskId).toBeUndefined();
  });
});
