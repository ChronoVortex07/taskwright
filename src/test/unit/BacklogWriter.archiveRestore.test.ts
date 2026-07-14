import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BacklogWriter } from '../../core/BacklogWriter';
import { BacklogParser } from '../../core/BacklogParser';
import * as fs from 'fs';
import * as path from 'path';
import { posixPath } from '../helpers/paths';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 1000 }),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// Helper to mock readdirSync with string array (simulating withFileTypes: false)
function mockReaddirSync(files: string[]) {
  vi.mocked(fs.readdirSync).mockReturnValue(files as unknown as ReturnType<typeof fs.readdirSync>);
}

describe('BacklogWriter', () => {
  let writer: BacklogWriter;
  let mockParser: BacklogParser;

  beforeEach(() => {
    writer = new BacklogWriter();
    mockParser = new BacklogParser('/fake/backlog');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Task Archiving', () => {
    beforeEach(() => {
      vi.spyOn(mockParser, 'getTasks').mockResolvedValue([]);
    });

    it('should move task to completed/ folder', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync(['task-1 - Test-Task.md']);

      // Mock parser.getTask to return a task with file path
      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-1',
        title: 'Test Task',
        status: 'Done',
        filePath: '/fake/backlog/tasks/task-1 - Test-Task.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      const result = await writer.completeTask('TASK-1', mockParser);

      expect(fs.renameSync).toHaveBeenCalledWith(
        posixPath('/fake/backlog/tasks/task-1 - Test-Task.md'),
        posixPath('/fake/backlog/completed/task-1 - Test-Task.md')
      );
      expect(result).toEqual(posixPath('/fake/backlog/completed/task-1 - Test-Task.md'));
    });

    it('should move task to archive/tasks/ folder', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync(['task-2 - Cancelled-Task.md']);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-2',
        title: 'Cancelled Task',
        status: 'To Do',
        filePath: '/fake/backlog/tasks/task-2 - Cancelled-Task.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      const result = await writer.archiveTask('TASK-2', mockParser);

      expect(fs.renameSync).toHaveBeenCalledWith(
        posixPath('/fake/backlog/tasks/task-2 - Cancelled-Task.md'),
        posixPath('/fake/backlog/archive/tasks/task-2 - Cancelled-Task.md')
      );
      expect(result).toEqual(posixPath('/fake/backlog/archive/tasks/task-2 - Cancelled-Task.md'));
    });

    it('should create destination folder if it does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockReaddirSync(['task-1 - Test-Task.md']);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-1',
        title: 'Test Task',
        status: 'Done',
        filePath: '/fake/backlog/tasks/task-1 - Test-Task.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      await writer.completeTask('TASK-1', mockParser);

      expect(fs.mkdirSync).toHaveBeenCalledWith(posixPath('/fake/backlog/completed'), {
        recursive: true,
      });
    });

    it('should throw error for non-existent task', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue(undefined);

      await expect(writer.archiveTask('TASK-999', mockParser)).rejects.toThrow(
        'Task TASK-999 not found'
      );
    });

    it('should return new file path after move', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync(['task-5 - Feature.md']);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-5',
        title: 'Feature',
        status: 'Done',
        filePath: '/fake/backlog/tasks/task-5 - Feature.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      const newPath = await writer.completeTask('TASK-5', mockParser);

      expect(newPath).toEqual(posixPath('/fake/backlog/completed/task-5 - Feature.md'));
    });

    it('should handle task file in nested backlog structure', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync(['task-1.md']);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-1',
        title: 'Test',
        status: 'Done',
        filePath: '/project/my-backlog/tasks/task-1.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      await writer.completeTask('TASK-1', mockParser);

      expect(fs.renameSync).toHaveBeenCalledWith(
        posixPath('/project/my-backlog/tasks/task-1.md'),
        posixPath('/project/my-backlog/completed/task-1.md')
      );
    });

    it('should sanitize archived task ID from dependencies and exact references in active tasks', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-2',
        title: 'Cancelled Task',
        status: 'To Do',
        filePath: '/fake/backlog/tasks/task-2 - Cancelled-Task.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      vi.spyOn(mockParser, 'getTasks').mockResolvedValue([
        {
          id: 'TASK-9',
          title: 'Depends on archived task',
          status: 'To Do',
          filePath: '/fake/backlog/tasks/task-9 - Depends.md',
          description: 'body content',
          labels: [],
          assignee: [],
          dependencies: ['TASK-2', 'TASK-3'],
          references: ['TASK-2', 'https://example.com/tasks/TASK-2', 'docs/task-2.md'],
          acceptanceCriteria: [],
          definitionOfDone: [],
        },
      ]);

      const updateTaskSpy = vi.spyOn(writer, 'updateTask').mockResolvedValue(undefined);

      await writer.archiveTask('TASK-2', mockParser);

      expect(updateTaskSpy).toHaveBeenCalledTimes(1);
      expect(updateTaskSpy).toHaveBeenCalledWith(
        'TASK-9',
        {
          dependencies: ['TASK-3'],
          references: ['https://example.com/tasks/TASK-2', 'docs/task-2.md'],
        },
        mockParser
      );
    });

    it('should treat task ID reference matching as case-insensitive exact match only', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-2',
        title: 'Cancelled Task',
        status: 'To Do',
        filePath: '/fake/backlog/tasks/task-2 - Cancelled-Task.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      vi.spyOn(mockParser, 'getTasks').mockResolvedValue([
        {
          id: 'TASK-10',
          title: 'Reference variants',
          status: 'To Do',
          filePath: '/fake/backlog/tasks/task-10 - Refs.md',
          description: '',
          labels: [],
          assignee: [],
          dependencies: ['task-2', 'TASK-20'],
          references: [' task-2 ', 'TASK-20', 'https://x.example/TASK-2'],
          acceptanceCriteria: [],
          definitionOfDone: [],
        },
      ]);

      const updateTaskSpy = vi.spyOn(writer, 'updateTask').mockResolvedValue(undefined);

      await writer.archiveTask('TASK-2', mockParser);

      expect(updateTaskSpy).toHaveBeenCalledTimes(1);
      expect(updateTaskSpy).toHaveBeenCalledWith(
        'TASK-10',
        {
          dependencies: ['TASK-20'],
          references: ['TASK-20', 'https://x.example/TASK-2'],
        },
        mockParser
      );
    });

    it('should scope cleanup to active tasks by querying parser.getTasks only', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-2',
        title: 'Cancelled Task',
        status: 'To Do',
        filePath: '/fake/backlog/tasks/task-2 - Cancelled-Task.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      const getTasksSpy = vi.spyOn(mockParser, 'getTasks').mockResolvedValue([]);
      const getDraftsSpy = vi.spyOn(mockParser, 'getDrafts');
      const getCompletedTasksSpy = vi.spyOn(mockParser, 'getCompletedTasks');
      const getArchivedTasksSpy = vi.spyOn(mockParser, 'getArchivedTasks');
      const updateTaskSpy = vi.spyOn(writer, 'updateTask').mockResolvedValue(undefined);

      await writer.archiveTask('TASK-2', mockParser);

      expect(getTasksSpy).toHaveBeenCalledTimes(1);
      expect(getDraftsSpy).not.toHaveBeenCalled();
      expect(getCompletedTasksSpy).not.toHaveBeenCalled();
      expect(getArchivedTasksSpy).not.toHaveBeenCalled();
      expect(updateTaskSpy).not.toHaveBeenCalled();
    });
  });
  describe('restoreArchivedTask', () => {
    it('should move task from archive/tasks/ to tasks/', async () => {
      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-5',
        title: 'Archived Task',
        status: 'Done' as const,
        folder: 'archive' as const,
        // Build with path.join so it carries native separators, matching what
        // BacklogParser produces. moveTaskToFolder detects the archive folder
        // via filePath.includes(path.join('archive', 'tasks')), which needs
        // native separators (a forward-slash fixture breaks that check on Windows).
        filePath: path.join('/fake/backlog/archive/tasks', 'task-5 - Archived-Task.md'),
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      const result = await writer.restoreArchivedTask('TASK-5', mockParser);

      expect(fs.renameSync).toHaveBeenCalledWith(
        posixPath('/fake/backlog/archive/tasks/task-5 - Archived-Task.md'),
        posixPath('/fake/backlog/tasks/task-5 - Archived-Task.md')
      );
      expect(result).toEqual(posixPath('/fake/backlog/tasks/task-5 - Archived-Task.md'));
    });

    // TASK-133: complete_task is dewired, but tasks ALREADY sitting in completed/ must not be
    // orphaned by that — restore still has to bring them back to tasks/. (completed/ is not an
    // archive subfolder, so it restores as a task, never as a draft.)
    it('should move an already-completed task from completed/ back to tasks/', async () => {
      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-7',
        title: 'Completed Task',
        status: 'Done' as const,
        folder: 'completed' as const,
        filePath: path.join('/fake/backlog/completed', 'task-7 - Completed-Task.md'),
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      const result = await writer.restoreArchivedTask('TASK-7', mockParser);

      expect(fs.renameSync).toHaveBeenCalledWith(
        posixPath('/fake/backlog/completed/task-7 - Completed-Task.md'),
        posixPath('/fake/backlog/tasks/task-7 - Completed-Task.md')
      );
      expect(result).toEqual(posixPath('/fake/backlog/tasks/task-7 - Completed-Task.md'));
    });

    it('should throw when task is not found', async () => {
      vi.spyOn(mockParser, 'getTask').mockResolvedValue(undefined);

      await expect(writer.restoreArchivedTask('TASK-999', mockParser)).rejects.toThrow(
        'Task TASK-999 not found'
      );
    });
  });
  describe('deleteTask', () => {
    it('should permanently delete the task file', async () => {
      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-5',
        title: 'Task to Delete',
        status: 'Done' as const,
        folder: 'archive' as const,
        filePath: '/fake/backlog/archive/tasks/task-5 - Task-to-Delete.md',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      await writer.deleteTask('TASK-5', mockParser);

      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/fake/backlog/archive/tasks/task-5 - Task-to-Delete.md'
      );
    });

    it('should throw when task is not found', async () => {
      vi.spyOn(mockParser, 'getTask').mockResolvedValue(undefined);

      await expect(writer.deleteTask('TASK-999', mockParser)).rejects.toThrow(
        'Task TASK-999 not found'
      );
    });
  });
  describe('completeTask (3.4: sanitize on complete)', () => {
    it('should call moveTaskToFolder and sanitizeArchivedTaskLinks', async () => {
      // completeTask now calls sanitizeArchivedTaskLinks just like archiveTask
      const content = '---\nid: TASK-1\ntitle: Done Task\nstatus: Done\n---\n';
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1 - Done-Task.md']);

      await writer.completeTask('TASK-1', mockParser);

      // moveTaskToFolder should rename the file
      expect(fs.renameSync).toHaveBeenCalled();
    });
  });
});
