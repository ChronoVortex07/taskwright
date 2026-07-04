import { describe, it, expect, vi, afterEach } from 'vitest';
import { BacklogParser } from '../../core/BacklogParser';
import * as fs from 'fs';
import { toPosix } from '../helpers/paths';

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
  describe('getMilestones', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should load milestones from milestone files as source of truth', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = toPosix(String(p));
        return pathStr.includes('/milestones') || pathStr.endsWith('config.yml');
      });
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation((p: fs.PathLike) => {
        const pathStr = toPosix(String(p));
        if (pathStr.endsWith('/milestones')) {
          return ['m-2 - Beta.md', 'README.md', 'm-1 - Launch.md'] as unknown as string[];
        }
        return [] as unknown as string[];
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
        const pathStr = toPosix(String(p));
        if (pathStr.includes('/milestones/m-1')) {
          return `---
id: m-1
title: Launch
---

## Description

Launch milestone`;
        }
        if (pathStr.includes('/milestones/m-2')) {
          return `---
id: m-2
title: Beta
---`;
        }
        if (pathStr.endsWith('config.yml')) {
          return `milestones: ["legacy-v1"]`;
        }
        return '';
      });

      const parser = new BacklogParser('/fake/backlog');
      const milestones = await parser.getMilestones();

      expect(milestones).toEqual([
        { id: 'm-1', name: 'Launch', description: 'Launch milestone' },
        { id: 'm-2', name: 'Beta' },
      ]);
    });

    it('should fallback to config string-array milestones when milestone files are absent', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = toPosix(String(p));
        return pathStr.endsWith('config.yml');
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
        const pathStr = toPosix(String(p));
        if (pathStr.endsWith('config.yml')) {
          return `milestones: ["v1.0", "v2.0"]`;
        }
        return '';
      });

      const parser = new BacklogParser('/fake/backlog');
      const milestones = await parser.getMilestones();

      expect(milestones).toEqual([
        { id: 'v1.0', name: 'v1.0' },
        { id: 'v2.0', name: 'v2.0' },
      ]);
    });

    it('should resolve milestone title to canonical milestone name (not ID)', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = toPosix(String(p));
        return pathStr.includes('/tasks') || pathStr.includes('/milestones');
      });
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation((p: fs.PathLike) => {
        const pathStr = toPosix(String(p));
        if (pathStr.endsWith('/tasks')) {
          return ['task-1 - Example.md'] as unknown as string[];
        }
        if (pathStr.endsWith('/milestones')) {
          return ['m-1 - Launch.md'] as unknown as string[];
        }
        return [] as unknown as string[];
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
        const pathStr = toPosix(String(p));
        if (pathStr.includes('/milestones/m-1')) {
          return `---
id: m-1
title: Launch
---`;
        }
        if (pathStr.includes('/tasks/task-1')) {
          return `---
id: TASK-1
title: Example
status: To Do
milestone: Launch
---
`;
        }
        return '';
      });

      const parser = new BacklogParser('/fake/backlog');
      const tasks = await parser.getTasks();

      expect(tasks).toHaveLength(1);
      // TASK-33: milestone should resolve to the canonical NAME, not the ID.
      // Downstream consumers (deriveTreeLayout, list_milestones, get_board)
      // compare task.milestone against milestone NAMES from getMilestones().
      // Returning the ID (m-1) causes every task to land in a spurious
      // "discovered" band named after its own ID instead of joining the real band.
      expect(tasks[0]?.milestone).toBe('Launch');
    });

    it('should resolve a raw milestone ID to the canonical milestone name', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = toPosix(String(p));
        return pathStr.includes('/tasks') || pathStr.includes('/milestones');
      });
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation((p: fs.PathLike) => {
        const pathStr = toPosix(String(p));
        if (pathStr.endsWith('/tasks')) {
          return ['task-1 - Example.md'] as unknown as string[];
        }
        if (pathStr.endsWith('/milestones')) {
          return ['m-1 - Launch.md'] as unknown as string[];
        }
        return [] as unknown as string[];
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
        const pathStr = toPosix(String(p));
        if (pathStr.includes('/milestones/m-1')) {
          return `---
id: m-1
title: Launch
---`;
        }
        if (pathStr.includes('/tasks/task-1')) {
          return `---
id: TASK-1
title: Example
status: To Do
milestone: m-1
---
`;
        }
        return '';
      });

      const parser = new BacklogParser('/fake/backlog');
      const tasks = await parser.getTasks();

      expect(tasks).toHaveLength(1);
      // Even when the task stores the milestone ID (m-1), it should be resolved
      // to the name (Launch) so downstream consumers can match against band names.
      expect(tasks[0]?.milestone).toBe('Launch');
    });

    it('should keep raw milestone value when title matches multiple milestone IDs', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = toPosix(String(p));
        return pathStr.includes('/tasks') || pathStr.includes('/milestones');
      });
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation((p: fs.PathLike) => {
        const pathStr = toPosix(String(p));
        if (pathStr.endsWith('/tasks')) {
          return ['task-1 - Example.md'] as unknown as string[];
        }
        if (pathStr.endsWith('/milestones')) {
          return ['m-1 - Launch-A.md', 'm-2 - Launch-B.md'] as unknown as string[];
        }
        return [] as unknown as string[];
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
        const pathStr = toPosix(String(p));
        if (pathStr.includes('/milestones/m-1')) {
          return `---
id: m-1
title: Launch
---`;
        }
        if (pathStr.includes('/milestones/m-2')) {
          return `---
id: m-2
title: Launch
---`;
        }
        if (pathStr.includes('/tasks/task-1')) {
          return `---
id: TASK-1
title: Example
status: To Do
milestone: Launch
---
`;
        }
        return '';
      });

      const parser = new BacklogParser('/fake/backlog');
      const tasks = await parser.getTasks();

      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.milestone).toBe('Launch');
    });
  });

  describe('getUniqueLabels', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return merged labels from config and all tasks, sorted', async () => {
      const configContent = `labels: ["bug", "feature"]`;
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const pathStr = toPosix(String(p));
        return pathStr.includes('config') || pathStr.includes('tasks');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1.md', 'task-2.md']);

      const parser = new BacklogParser('/fake/backlog');
      // Mock parseTaskFile to return tasks with labels
      vi.spyOn(parser, 'parseTaskFile').mockImplementation(async (filePath: string) => {
        if (filePath.includes('task-1')) {
          return {
            id: 'TASK-1',
            title: 'Task 1',
            status: 'To Do' as const,
            labels: ['urgent', 'bug'],
            assignee: [],
            dependencies: [],
            acceptanceCriteria: [],
            definitionOfDone: [],
            filePath,
          };
        }
        return {
          id: 'TASK-2',
          title: 'Task 2',
          status: 'To Do' as const,
          labels: ['enhancement'],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath,
        };
      });

      const labels = await parser.getUniqueLabels();
      expect(labels).toEqual(['bug', 'enhancement', 'feature', 'urgent']);
    });

    it('should return empty array when no config and no tasks', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const parser = new BacklogParser('/fake/backlog');
      const labels = await parser.getUniqueLabels();

      expect(labels).toEqual([]);
    });
  });

  describe('getUniqueAssignees', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return unique assignees from all tasks, sorted', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        return String(p).includes('tasks');
      });
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1.md', 'task-2.md']);

      const parser = new BacklogParser('/fake/backlog');
      vi.spyOn(parser, 'parseTaskFile').mockImplementation(async (filePath: string) => {
        if (filePath.includes('task-1')) {
          return {
            id: 'TASK-1',
            title: 'Task 1',
            status: 'To Do' as const,
            labels: [],
            assignee: ['alice', 'bob'],
            dependencies: [],
            acceptanceCriteria: [],
            definitionOfDone: [],
            filePath,
          };
        }
        return {
          id: 'TASK-2',
          title: 'Task 2',
          status: 'To Do' as const,
          labels: [],
          assignee: ['charlie', 'alice'],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath,
        };
      });

      const assignees = await parser.getUniqueAssignees();
      expect(assignees).toEqual(['alice', 'bob', 'charlie']);
    });

    it('should return empty array when no tasks have assignees', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        return String(p).includes('tasks');
      });
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1.md']);

      const parser = new BacklogParser('/fake/backlog');
      vi.spyOn(parser, 'parseTaskFile').mockResolvedValue({
        id: 'TASK-1',
        title: 'Task 1',
        status: 'To Do' as const,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-1.md',
      });

      const assignees = await parser.getUniqueAssignees();
      expect(assignees).toEqual([]);
    });
  });

  describe('getBlockedByThisTask', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return task IDs that depend on the given task', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        return String(p).includes('tasks');
      });
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'task-1.md',
        'task-2.md',
        'task-3.md',
      ]);

      const parser = new BacklogParser('/fake/backlog');
      vi.spyOn(parser, 'parseTaskFile').mockImplementation(async (filePath: string) => {
        if (filePath.includes('task-1')) {
          return {
            id: 'TASK-1',
            title: 'Task 1',
            status: 'To Do' as const,
            labels: [],
            assignee: [],
            dependencies: [], // No dependencies
            acceptanceCriteria: [],
            definitionOfDone: [],
            filePath,
          };
        }
        if (filePath.includes('task-2')) {
          return {
            id: 'TASK-2',
            title: 'Task 2',
            status: 'To Do' as const,
            labels: [],
            assignee: [],
            dependencies: ['TASK-1'], // Depends on TASK-1
            acceptanceCriteria: [],
            definitionOfDone: [],
            filePath,
          };
        }
        return {
          id: 'TASK-3',
          title: 'Task 3',
          status: 'To Do' as const,
          labels: [],
          assignee: [],
          dependencies: ['TASK-1'], // Also depends on TASK-1
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath,
        };
      });

      const blockedBy = await parser.getBlockedByThisTask('TASK-1');
      expect(blockedBy).toEqual(['TASK-2', 'TASK-3']);
    });

    it('should return empty array if no tasks depend on given task', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        return String(p).includes('tasks');
      });
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1.md', 'task-2.md']);

      const parser = new BacklogParser('/fake/backlog');
      vi.spyOn(parser, 'parseTaskFile').mockImplementation(async (filePath: string) => {
        if (filePath.includes('task-1')) {
          return {
            id: 'TASK-1',
            title: 'Task 1',
            status: 'To Do' as const,
            labels: [],
            assignee: [],
            dependencies: [],
            acceptanceCriteria: [],
            definitionOfDone: [],
            filePath,
          };
        }
        return {
          id: 'TASK-2',
          title: 'Task 2',
          status: 'To Do' as const,
          labels: [],
          assignee: [],
          dependencies: [], // No dependencies
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath,
        };
      });

      const blockedBy = await parser.getBlockedByThisTask('TASK-1');
      expect(blockedBy).toEqual([]);
    });

    it('should return empty array for non-existent task', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        return String(p).includes('tasks');
      });
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1.md']);

      const parser = new BacklogParser('/fake/backlog');
      vi.spyOn(parser, 'parseTaskFile').mockResolvedValue({
        id: 'TASK-1',
        title: 'Task 1',
        status: 'To Do' as const,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-1.md',
      });

      const blockedBy = await parser.getBlockedByThisTask('TASK-999');
      expect(blockedBy).toEqual([]);
    });
  });

  describe('getCategories (tech-tree P1)', () => {
    it('unions config categories (order preserved) with discovered non-bug categories (sorted)', async () => {
      const parser = new BacklogParser('/fake/path');
      vi.spyOn(parser, 'getConfig').mockResolvedValue({ categories: ['Platform', 'Backend'] });
      vi.spyOn(parser, 'getTasks').mockResolvedValue([
        { id: 'TASK-1', category: 'Backend' } as never, // already declared
        { id: 'TASK-2', category: 'UI' } as never, // discovered
        { id: 'TASK-3', category: 'Auth' } as never, // discovered
        { id: 'TASK-4', category: 'Ignored', type: 'bug' } as never, // bug: excluded
        { id: 'TASK-5' } as never, // no category: excluded (Misc)
      ]);
      expect(await parser.getCategories()).toEqual(['Platform', 'Backend', 'Auth', 'UI']);
    });
  });
});
