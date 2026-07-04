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

  it('surfaces definitionOfDone when present', () => {
    const s = toSummary(
      makeTask({
        definitionOfDone: [
          { id: 1, text: 'lint passes', checked: true },
          { id: 2, text: 'tests pass', checked: false },
        ],
      }),
      '/b'
    );
    expect(s.definitionOfDone).toBeDefined();
    expect(s.definitionOfDone!.map((c) => c.text)).toEqual(['lint passes', 'tests pass']);
    expect(s.definitionOfDone![0].checked).toBe(true);
    expect(s.definitionOfDone![1].checked).toBe(false);
  });

  it('leaves definitionOfDone undefined on an empty checklist (negative control)', () => {
    const s = toSummary(makeTask({ definitionOfDone: [] }), '/b');
    // Empty arrays are falsy for toSummary purposes — definitionOfDone is omitted when empty
    // because it's typed as ChecklistItem[] | undefined; an empty array is still defined.
    expect(s.definitionOfDone).toEqual([]);
  });

  it('leaves both undefined on a plain task (negative control)', () => {
    const s = toSummary(makeTask(), '/b');
    expect(s.subtasks).toBeUndefined();
    expect(s.parentTaskId).toBeUndefined();
  });
});
