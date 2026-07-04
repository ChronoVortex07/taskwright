import { describe, it, expect, vi } from 'vitest';
import { BacklogParser, computeSubtasks } from '../../core/BacklogParser';
import type { Task } from '../../core/types';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 1000 }),
  };
});

describe('BacklogParser', () => {
  describe('parseTaskContent', () => {
    it('should parse a task with YAML frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test Task Title
status: To Do
priority: high
labels:
  - bug
  - urgent
milestone: MVP Release
assignee: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
This is the task description.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 First criterion
- [x] #2 Second criterion completed
<!-- AC:END -->
`;

      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');

      expect(task).toBeDefined();
      expect(task?.id).toBe('TASK-1');
      expect(task?.title).toBe('Test Task Title');
      expect(task?.status).toBe('To Do');
      expect(task?.priority).toBe('high');
      expect(task?.labels).toEqual(['bug', 'urgent']);
      expect(task?.milestone).toBe('MVP Release');
      expect(task?.description).toBe('This is the task description.');
      expect(task?.acceptanceCriteria).toHaveLength(2);
      expect(task?.acceptanceCriteria[0].checked).toBe(false);
      expect(task?.acceptanceCriteria[1].checked).toBe(true);
    });

    it('should parse status values correctly', () => {
      const parser = new BacklogParser('/fake/path');

      const testCases = [
        { status: 'To Do', expected: 'To Do' },
        { status: 'In Progress', expected: 'In Progress' },
        { status: 'Done', expected: 'Done' },
        { status: 'Draft', expected: 'Draft' },
        { status: 'Review', expected: 'Review' },
        { status: 'QA', expected: 'QA' },
        { status: 'Backlog', expected: 'Backlog' },
        { status: 'Blocked', expected: 'Blocked' },
      ];

      for (const { status, expected } of testCases) {
        const content = `---
id: TASK-1
title: Test
status: ${status}
---
`;
        const task = parser.parseTaskContent(content, '/fake/task-1.md');
        expect(task?.status).toBe(expected);
      }
    });

    it('should preserve custom status values', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Custom Status Test
status: Code Review
---
`;
      const task = parser.parseTaskContent(content, '/fake/task-1.md');
      expect(task?.status).toBe('Code Review');
    });

    it('should preserve custom status with unicode prefix stripped', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: "◑ Waiting"
---
`;
      const task = parser.parseTaskContent(content, '/fake/task-1.md');
      expect(task?.status).toBe('Waiting');
    });

    it('should parse multiple assignees as multi-line array', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
assignee:
  - alice
  - bob
  - charlie
---
`;

      const task = parser.parseTaskContent(content, '/fake/task-1.md');
      expect(task?.assignee).toEqual(['alice', 'bob', 'charlie']);
    });

    it('should handle minimal task with just required fields', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Minimal Task
status: To Do
---
`;

      const task = parser.parseTaskContent(content, '/fake/task-1.md');

      expect(task).toBeDefined();
      expect(task?.title).toBe('Minimal Task');
      expect(task?.description).toBeUndefined();
      expect(task?.labels).toEqual([]);
      expect(task?.acceptanceCriteria).toEqual([]);
    });

    it('should parse definition of done items', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Definition of Done

- [ ] #1 Code reviewed
- [ ] #2 Tests passing
- [x] #3 Documentation updated
`;

      const task = parser.parseTaskContent(content, '/fake/task-1.md');

      expect(task?.definitionOfDone).toHaveLength(3);
      expect(task?.definitionOfDone[2].checked).toBe(true);
    });

    it('should parse inline array syntax for labels', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test with inline labels
status: To Do
labels: []
dependencies: []
---
`;

      const task = parser.parseTaskContent(content, '/fake/task-1.md');
      expect(task?.labels).toEqual([]);
      expect(task?.dependencies).toEqual([]);
    });

    it('should extract task ID from filename if not in frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
title: Test without ID
status: To Do
---
`;

      const task = parser.parseTaskContent(content, '/fake/path/task-42 - Some-Task-Name.md');
      expect(task?.id).toBe('TASK-42');
    });

    it('should extract custom-prefix ID from filename', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
title: Custom Prefix Task
status: To Do
---
`;

      const task = parser.parseTaskContent(content, '/fake/path/proj-7 - Custom-Prefix-Task.md');
      expect(task?.id).toBe('PROJ-7');
    });

    it('should extract subtask ID with dot notation from filename', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
title: Subtask
status: To Do
---
`;

      const task = parser.parseTaskContent(content, '/fake/path/issue-3.2 - Subtask.md');
      expect(task?.id).toBe('ISSUE-3.2');
    });
  });

  describe('computeSubtasks', () => {
    function makeTask(overrides: Partial<Task>): Task {
      return {
        id: 'TASK-1',
        title: 'Test',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/path/task.md',
        ...overrides,
      };
    }

    it('should populate subtasks on parent from child parentTaskId', () => {
      const tasks = [
        makeTask({ id: 'TASK-2', title: 'Parent' }),
        makeTask({ id: 'TASK-2.1', title: 'Child 1', parentTaskId: 'TASK-2' }),
        makeTask({ id: 'TASK-2.2', title: 'Child 2', parentTaskId: 'TASK-2' }),
      ];

      computeSubtasks(tasks);

      expect(tasks[0].subtasks).toEqual(['TASK-2.1', 'TASK-2.2']);
    });

    it('should sort subtask IDs', () => {
      const tasks = [
        makeTask({ id: 'TASK-1' }),
        makeTask({ id: 'TASK-1.3', parentTaskId: 'TASK-1' }),
        makeTask({ id: 'TASK-1.1', parentTaskId: 'TASK-1' }),
        makeTask({ id: 'TASK-1.2', parentTaskId: 'TASK-1' }),
      ];

      computeSubtasks(tasks);

      expect(tasks[0].subtasks).toEqual(['TASK-1.1', 'TASK-1.2', 'TASK-1.3']);
    });

    it('should not add subtasks to tasks with no children', () => {
      const tasks = [makeTask({ id: 'TASK-1' }), makeTask({ id: 'TASK-2' })];

      computeSubtasks(tasks);

      expect(tasks[0].subtasks).toBeUndefined();
      expect(tasks[1].subtasks).toBeUndefined();
    });

    it('should handle orphaned children (parent not in list)', () => {
      const tasks = [
        makeTask({ id: 'TASK-5.1', parentTaskId: 'TASK-5' }),
        makeTask({ id: 'TASK-5.2', parentTaskId: 'TASK-5' }),
      ];

      computeSubtasks(tasks);

      // No parent in the list, so no subtasks array is set
      expect(tasks[0].subtasks).toBeUndefined();
      expect(tasks[1].subtasks).toBeUndefined();
    });

    it('should overwrite existing subtasks from frontmatter', () => {
      const tasks = [
        makeTask({ id: 'TASK-3', subtasks: ['TASK-3.1', 'TASK-3.99'] }),
        makeTask({ id: 'TASK-3.1', parentTaskId: 'TASK-3' }),
        makeTask({ id: 'TASK-3.2', parentTaskId: 'TASK-3' }),
      ];

      computeSubtasks(tasks);

      // Should be computed from parentTaskId, not from the existing array
      expect(tasks[0].subtasks).toEqual(['TASK-3.1', 'TASK-3.2']);
    });

    it('should handle multiple parents with different children', () => {
      const tasks = [
        makeTask({ id: 'TASK-1' }),
        makeTask({ id: 'TASK-2' }),
        makeTask({ id: 'TASK-1.1', parentTaskId: 'TASK-1' }),
        makeTask({ id: 'TASK-2.1', parentTaskId: 'TASK-2' }),
        makeTask({ id: 'TASK-2.2', parentTaskId: 'TASK-2' }),
      ];

      computeSubtasks(tasks);

      expect(tasks[0].subtasks).toEqual(['TASK-1.1']);
      expect(tasks[1].subtasks).toEqual(['TASK-2.1', 'TASK-2.2']);
    });

    it('should handle empty task list', () => {
      const tasks: Task[] = [];
      computeSubtasks(tasks);
      expect(tasks).toEqual([]);
    });

    it('should populate subtaskSummaries with title and status', () => {
      const tasks = [
        makeTask({ id: 'TASK-1', title: 'Parent', status: 'In Progress' }),
        makeTask({ id: 'TASK-1.1', title: 'Child One', status: 'Done', parentTaskId: 'TASK-1' }),
        makeTask({ id: 'TASK-1.2', title: 'Child Two', status: 'To Do', parentTaskId: 'TASK-1' }),
      ];

      computeSubtasks(tasks);

      expect(tasks[0].subtaskSummaries).toEqual([
        { id: 'TASK-1.1', title: 'Child One', status: 'Done' },
        { id: 'TASK-1.2', title: 'Child Two', status: 'To Do' },
      ]);
    });

    it('should not set subtaskSummaries for tasks without children', () => {
      const tasks = [makeTask({ id: 'TASK-1' })];
      computeSubtasks(tasks);
      expect(tasks[0].subtaskSummaries).toBeUndefined();
    });
  });
});
