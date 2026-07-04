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
  describe('Multi-folder support', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    describe('getTasksFromFolder', () => {
      it('should read tasks from specified subfolder', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1 - My-Task.md']);
        vi.mocked(fs.readFileSync).mockReturnValue(`---
id: TASK-1
title: My Task
status: To Do
---
`);

        const parser = new BacklogParser('/fake/backlog');
        const tasks = await parser.getTasksFromFolder('tasks');

        expect(tasks).toHaveLength(1);
        expect(tasks[0].folder).toBe('tasks');
        expect(tasks[0].id).toBe('TASK-1');
      });

      it('should return empty array when folder does not exist', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const parser = new BacklogParser('/fake/backlog');
        const tasks = await parser.getTasksFromFolder('drafts');

        expect(tasks).toEqual([]);
      });

      it('should set the correct folder property on each task', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['draft-1 - My-Draft.md']);
        vi.mocked(fs.readFileSync).mockReturnValue(`---
id: DRAFT-1
title: My Draft
status: Draft
---
`);

        const parser = new BacklogParser('/fake/backlog');
        const tasks = await parser.getTasksFromFolder('drafts');

        expect(tasks).toHaveLength(1);
        expect(tasks[0].folder).toBe('drafts');
      });

      it('should deduplicate tasks with the same ID, keeping the last file', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
          'back-239 - Feature-Auto-link-old.md',
          'back-239 - Feature-Auto-link-new.md',
        ]);
        vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
          if (String(filePath).includes('old')) {
            return `---\nid: BACK-239\ntitle: Old version\nstatus: To Do\n---\n`;
          }
          return `---\nid: BACK-239\ntitle: New version\nstatus: In Progress\n---\n`;
        });

        const parser = new BacklogParser('/fake/backlog');
        const tasks = await parser.getTasksFromFolder('tasks');

        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe('BACK-239');
        expect(tasks[0].title).toBe('New version');
      });

      it('should not deduplicate tasks with distinct IDs', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
          'task-1 - First.md',
          'task-2 - Second.md',
        ]);
        vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
          if (String(filePath).includes('task-1')) {
            return `---\nid: TASK-1\ntitle: First\nstatus: To Do\n---\n`;
          }
          return `---\nid: TASK-2\ntitle: Second\nstatus: To Do\n---\n`;
        });

        const parser = new BacklogParser('/fake/backlog');
        const tasks = await parser.getTasksFromFolder('tasks');

        expect(tasks).toHaveLength(2);
      });
    });

    describe('getDrafts', () => {
      it('should return tasks with folder set to drafts', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['draft-1 - My-Draft.md']);
        vi.mocked(fs.readFileSync).mockReturnValue(`---
id: DRAFT-1
title: My Draft
status: To Do
---
`);

        const parser = new BacklogParser('/fake/backlog');
        const drafts = await parser.getDrafts();

        expect(drafts).toHaveLength(1);
        expect(drafts[0].folder).toBe('drafts');
        expect(drafts[0].status).toBe('To Do');
      });

      it('reflects the real frontmatter status of a draft (P6/D2c)', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['draft-1 - Active-Draft.md']);
        vi.mocked(fs.readFileSync).mockReturnValue(`---
id: DRAFT-1
title: Active Draft
status: In Progress
---
`);

        const parser = new BacklogParser('/fake/backlog');
        const drafts = await parser.getDrafts();

        expect(drafts).toHaveLength(1);
        expect(drafts[0].status).toBe('In Progress');
      });

      it('aliases a legacy status: Draft on-disk draft to the board default (P6 back-compat)', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['draft-1 - Legacy.md']);
        vi.mocked(fs.readFileSync).mockReturnValue(
          '---\nid: DRAFT-1\ntitle: Legacy\nstatus: Draft\n---\n'
        );
        const parser = new BacklogParser('/fake/backlog');
        const drafts = await parser.getDrafts();
        expect(drafts[0].status).toBe('To Do'); // no config default → 'To Do'
        expect(drafts[0].folder).toBe('drafts'); // provisional marker intact
      });

      it('aliases a legacy status: Draft draft to the CONFIGURED non-default default_status (P6 back-compat)', async () => {
        // Exercises the `config.default_status || 'To Do'` config-read branch, not just the
        // fallback: a board whose default is 'Backlog' must alias the legacy draft there, so a
        // regression that dropped the config read and hardcoded 'To Do' would fail here.
        vi.mocked(fs.existsSync).mockReturnValue(true);
        (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['draft-1 - Legacy.md']);
        vi.mocked(fs.readFileSync).mockReturnValue(
          '---\nid: DRAFT-1\ntitle: Legacy\nstatus: Draft\n---\n'
        );
        const parser = new BacklogParser('/fake/backlog');
        vi.spyOn(parser, 'getConfig').mockResolvedValue({ default_status: 'Backlog' });
        const drafts = await parser.getDrafts();
        expect(drafts[0].status).toBe('Backlog'); // reads config.default_status, not hardcoded 'To Do'
        expect(drafts[0].folder).toBe('drafts'); // provisional marker intact
      });

      it('should return empty array when no drafts folder exists', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const parser = new BacklogParser('/fake/backlog');
        const drafts = await parser.getDrafts();

        expect(drafts).toEqual([]);
      });
    });

    describe('getCompletedTasks', () => {
      it('should return tasks with folder set to completed', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1 - Done-Task.md']);
        vi.mocked(fs.readFileSync).mockReturnValue(`---
id: TASK-1
title: Done Task
status: Done
---
`);

        const parser = new BacklogParser('/fake/backlog');
        const completed = await parser.getCompletedTasks();

        expect(completed).toHaveLength(1);
        expect(completed[0].folder).toBe('completed');
        expect(completed[0].source).toBe('completed');
      });

      it('should return empty array when no completed folder exists', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const parser = new BacklogParser('/fake/backlog');
        const completed = await parser.getCompletedTasks();

        expect(completed).toEqual([]);
      });
    });

    describe('getTask across folders', () => {
      it('should find task in tasks folder first', async () => {
        const parser = new BacklogParser('/fake/backlog');

        // Mock getTasksFromFolder to return tasks from different folders
        vi.spyOn(parser, 'getTasksFromFolder').mockImplementation(async (folder: string) => {
          if (folder === 'tasks') {
            return [
              {
                id: 'TASK-1',
                title: 'In Tasks',
                status: 'To Do' as const,
                folder: 'tasks' as const,
                filePath: '/fake/backlog/tasks/task-1.md',
                labels: [],
                assignee: [],
                dependencies: [],
                acceptanceCriteria: [],
                definitionOfDone: [],
              },
            ];
          }
          return [];
        });

        const task = await parser.getTask('TASK-1');
        expect(task?.folder).toBe('tasks');
        expect(task?.title).toBe('In Tasks');
      });

      it('should find task in drafts folder when not in tasks', async () => {
        const parser = new BacklogParser('/fake/backlog');

        vi.spyOn(parser, 'getTasksFromFolder').mockImplementation(async (folder: string) => {
          if (folder === 'tasks') return [];
          if (folder === 'drafts') {
            return [
              {
                id: 'DRAFT-1',
                title: 'In Drafts',
                status: 'Draft' as const,
                folder: 'drafts' as const,
                filePath: '/fake/backlog/drafts/draft-1.md',
                labels: [],
                assignee: [],
                dependencies: [],
                acceptanceCriteria: [],
                definitionOfDone: [],
              },
            ];
          }
          return [];
        });

        const task = await parser.getTask('DRAFT-1');
        expect(task?.folder).toBe('drafts');
      });

      it('aliases a legacy status: Draft draft read via getTask to the board default (P6/D2c cross-path parity)', async () => {
        const parser = new BacklogParser('/fake/backlog');
        vi.spyOn(parser, 'getConfig').mockResolvedValue({});
        vi.spyOn(parser, 'getTasksFromFolder').mockImplementation(async (folder: string) => {
          if (folder === 'drafts') {
            return [
              {
                id: 'DRAFT-1',
                title: 'Legacy',
                status: 'Draft' as const,
                folder: 'drafts' as const,
                filePath: '/fake/backlog/drafts/draft-1.md',
                labels: [],
                assignee: [],
                dependencies: [],
                acceptanceCriteria: [],
                definitionOfDone: [],
              },
            ];
          }
          return [];
        });

        const task = await parser.getTask('DRAFT-1');
        expect(task?.status).toBe('To Do'); // was 'Draft' before the getTask alias; agrees with getDrafts now
        expect(task?.folder).toBe('drafts'); // provisional marker intact
      });

      it('aliases a legacy status: Draft draft via getTask to the CONFIGURED non-default default_status', async () => {
        // Config-read branch parity with getDrafts: a board default of 'Backlog' must flow through
        // getTask's alias too, falsifying a regression that hardcodes 'To Do' on this read path.
        const parser = new BacklogParser('/fake/backlog');
        vi.spyOn(parser, 'getConfig').mockResolvedValue({ default_status: 'Backlog' });
        vi.spyOn(parser, 'getTasksFromFolder').mockImplementation(async (folder: string) => {
          if (folder === 'drafts') {
            return [
              {
                id: 'DRAFT-1',
                title: 'Legacy',
                status: 'Draft' as const,
                folder: 'drafts' as const,
                filePath: '/fake/backlog/drafts/draft-1.md',
                labels: [],
                assignee: [],
                dependencies: [],
                acceptanceCriteria: [],
                definitionOfDone: [],
              },
            ];
          }
          return [];
        });

        const task = await parser.getTask('DRAFT-1');
        expect(task?.status).toBe('Backlog'); // reads config.default_status, not hardcoded 'To Do'
        expect(task?.folder).toBe('drafts'); // provisional marker intact
      });

      it('does not alter a P6 draft carrying a real status read via getTask', async () => {
        const parser = new BacklogParser('/fake/backlog');
        vi.spyOn(parser, 'getTasksFromFolder').mockImplementation(async (folder: string) => {
          if (folder === 'drafts') {
            return [
              {
                id: 'DRAFT-2',
                title: 'Baseline',
                status: 'Done' as const,
                folder: 'drafts' as const,
                filePath: '/fake/backlog/drafts/draft-2.md',
                labels: [],
                assignee: [],
                dependencies: [],
                acceptanceCriteria: [],
                definitionOfDone: [],
              },
            ];
          }
          return [];
        });

        const task = await parser.getTask('DRAFT-2');
        expect(task?.status).toBe('Done'); // real status untouched (no aliasing)
      });

      it('should find task in completed folder as last resort', async () => {
        const parser = new BacklogParser('/fake/backlog');

        vi.spyOn(parser, 'getTasksFromFolder').mockImplementation(async (folder: string) => {
          if (folder === 'completed') {
            return [
              {
                id: 'TASK-5',
                title: 'Completed',
                status: 'Done' as const,
                folder: 'completed' as const,
                filePath: '/fake/backlog/completed/task-5.md',
                labels: [],
                assignee: [],
                dependencies: [],
                acceptanceCriteria: [],
                definitionOfDone: [],
              },
            ];
          }
          return [];
        });

        const task = await parser.getTask('TASK-5');
        expect(task?.folder).toBe('completed');
      });

      it('should return undefined when task not found in any folder', async () => {
        const parser = new BacklogParser('/fake/backlog');
        vi.spyOn(parser, 'getTasksFromFolder').mockResolvedValue([]);

        const task = await parser.getTask('TASK-999');
        expect(task).toBeUndefined();
      });
    });

    describe('Draft filename parsing', () => {
      it('should parse draft- prefix in filename for ID extraction', () => {
        const parser = new BacklogParser('/fake/path');
        const content = `---
title: My Draft Task
status: Draft
---
`;
        const task = parser.parseTaskContent(content, '/fake/path/draft-1 - My-Draft.md');
        expect(task?.id).toBe('DRAFT-1');
      });

      it('should still parse task- prefix as before', () => {
        const parser = new BacklogParser('/fake/path');
        const content = `---
title: Regular Task
status: To Do
---
`;
        const task = parser.parseTaskContent(content, '/fake/path/task-42 - Regular.md');
        expect(task?.id).toBe('TASK-42');
      });
    });
  });

  describe('getArchivedTasks', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return tasks from archive/tasks/ folder with folder set to archive', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1 - Archived-Task.md']);
      vi.mocked(fs.readFileSync).mockReturnValue(`---
id: TASK-1
title: Archived Task
status: Done
---
`);

      const parser = new BacklogParser('/fake/backlog');
      const archived = await parser.getArchivedTasks();

      expect(archived).toHaveLength(1);
      expect(archived[0].folder).toBe('archive');
      expect(archived[0].id).toBe('TASK-1');
      expect(archived[0].title).toBe('Archived Task');
    });

    it('should return empty array when no archive/tasks/ folder exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const parser = new BacklogParser('/fake/backlog');
      const archived = await parser.getArchivedTasks();

      expect(archived).toEqual([]);
    });

    it('should parse multiple archived tasks', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'task-1 - First.md',
        'task-2 - Second.md',
      ]);

      const parser = new BacklogParser('/fake/backlog');
      vi.spyOn(parser, 'parseTaskFile').mockImplementation(async (filePath: string) => {
        if (filePath.includes('task-1')) {
          return {
            id: 'TASK-1',
            title: 'First Archived',
            status: 'Done' as const,
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
          title: 'Second Archived',
          status: 'To Do' as const,
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath,
        };
      });

      const archived = await parser.getArchivedTasks();

      expect(archived).toHaveLength(2);
      expect(archived[0].folder).toBe('archive');
      expect(archived[1].folder).toBe('archive');
    });
  });

  describe('getTask searches archive folder', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should find task in archive/tasks/ folder when not in other folders', async () => {
      const parser = new BacklogParser('/fake/backlog');

      vi.spyOn(parser, 'getTasksFromFolder').mockImplementation(async (folder: string) => {
        if (folder === 'archive/tasks') {
          return [
            {
              id: 'TASK-10',
              title: 'Archived Task',
              status: 'Done' as const,
              folder: 'archive' as const,
              filePath: '/fake/backlog/archive/tasks/task-10.md',
              labels: [],
              assignee: [],
              dependencies: [],
              acceptanceCriteria: [],
              definitionOfDone: [],
            },
          ];
        }
        return [];
      });

      const task = await parser.getTask('TASK-10');
      expect(task).toBeDefined();
      expect(task?.id).toBe('TASK-10');
      expect(task?.folder).toBe('archive');
    });

    it('should prefer tasks/ over archive/tasks/ when task exists in both', async () => {
      const parser = new BacklogParser('/fake/backlog');

      vi.spyOn(parser, 'getTasksFromFolder').mockImplementation(async (folder: string) => {
        if (folder === 'tasks') {
          return [
            {
              id: 'TASK-1',
              title: 'Active Task',
              status: 'To Do' as const,
              folder: 'tasks' as const,
              filePath: '/fake/backlog/tasks/task-1.md',
              labels: [],
              assignee: [],
              dependencies: [],
              acceptanceCriteria: [],
              definitionOfDone: [],
            },
          ];
        }
        if (folder === 'archive/tasks') {
          return [
            {
              id: 'TASK-1',
              title: 'Archived Task',
              status: 'Done' as const,
              folder: 'archive' as const,
              filePath: '/fake/backlog/archive/tasks/task-1.md',
              labels: [],
              assignee: [],
              dependencies: [],
              acceptanceCriteria: [],
              definitionOfDone: [],
            },
          ];
        }
        return [];
      });

      const task = await parser.getTask('TASK-1');
      expect(task?.folder).toBe('tasks');
      expect(task?.title).toBe('Active Task');
    });

    it('should set folder to archive (not archive/tasks) when found via getTask', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = toPosix(String(p));
        return s.includes('archive/tasks') || s === '/fake/backlog';
      });
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation((p) => {
        if (toPosix(String(p)).includes('archive/tasks')) {
          return ['task-10 - Archived.md'];
        }
        return [];
      });
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1 } as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readFileSync).mockReturnValue(`---
id: TASK-10
title: Archived
status: Done
---
`);

      const parser = new BacklogParser('/fake/backlog');
      const task = await parser.getTask('TASK-10');

      expect(task).toBeDefined();
      expect(task?.folder).toBe('archive');
    });
  });
});
