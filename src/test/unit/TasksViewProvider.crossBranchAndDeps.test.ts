import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import * as vscode from 'vscode';
import { createMockExtensionContext } from '../mocks/vscode';
import { TasksViewProvider } from '../../providers/TasksViewProvider';
import { TaskDetailProvider } from '../../providers/TaskDetailProvider';
import { BacklogParser } from '../../core/BacklogParser';
import { Task } from '../../core/types';

describe('TasksViewProvider', () => {
  let extensionUri: vscode.Uri;
  let mockParser: BacklogParser;
  let mockWebviewView: Partial<vscode.WebviewView>;
  let mockWebview: Partial<vscode.Webview>;
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
    extensionUri = vscode.Uri.file('/test/extension');
    mockContext = createMockExtensionContext() as unknown as vscode.ExtensionContext;

    mockWebview = {
      html: '',
      asWebviewUri: vi.fn((uri) => uri),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
      postMessage: vi.fn().mockResolvedValue(true),
      cspSource: 'test-csp',
    };

    mockWebviewView = {
      webview: mockWebview as vscode.Webview,
      visible: true,
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    };

    mockParser = {
      getTasks: vi.fn().mockResolvedValue([]),
      getTasksWithCrossBranch: vi.fn().mockResolvedValue([]),
      getTask: vi.fn(),
      getConfig: vi.fn().mockResolvedValue({}),
      getStatuses: vi.fn().mockResolvedValue(['To Do', 'In Progress', 'Done']),
      getMilestones: vi.fn().mockResolvedValue([]),
      getBlockedByThisTask: vi.fn().mockResolvedValue([]),
      getDrafts: vi.fn().mockResolvedValue([]),
      getCompletedTasks: vi.fn().mockResolvedValue([]),
      getArchivedTasks: vi.fn().mockResolvedValue([]),
      getCategories: vi.fn().mockResolvedValue([]),
      getBacklogPath: vi.fn().mockReturnValue('/fake/backlog'),
      getPrimaryRoot: vi.fn().mockReturnValue('/fake'),
      resolveMilestone: vi.fn(),
    } as unknown as BacklogParser;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function resolveView(provider: TasksViewProvider) {
    provider.resolveWebviewView(
      mockWebviewView as vscode.WebviewView,
      {} as vscode.WebviewViewResolveContext,
      {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(),
      } as vscode.CancellationToken
    );
  }

  describe('read-only cross-branch task guards', () => {
    it('blocks updateTaskStatus for read-only tasks and posts explicit error', async () => {
      (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'TASK-REMOTE',
        title: 'Remote Task',
        status: 'To Do',
        source: 'local-branch',
        branch: 'feature/other',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/.backlog/branches/feature/remote-task.md',
      });

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({ type: 'updateTaskStatus', taskId: 'TASK-REMOTE', status: 'Done' });

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'taskUpdateError',
          taskId: 'TASK-REMOTE',
          originalStatus: 'To Do',
          message: expect.stringContaining('read-only'),
        })
      );
    });

    // TASK-133 removed the read-only guard for 'completeTask' along with the message case itself —
    // the strongest possible guard. The equivalent read-only protection for the surviving
    // destructive move (archive) is covered above/below; see completeTaskDewired.test.ts for the
    // contract that no completeTask entry point comes back.

    it('does not treat local tasks with branch metadata as read-only', async () => {
      (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'TASK-LOCAL',
        title: 'Local Task',
        status: 'To Do',
        source: 'local',
        branch: 'feature/current',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-local.md',
      });

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({ type: 'updateTaskStatus', taskId: 'TASK-LOCAL', status: 'Done' });

      expect(mockWebview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'taskUpdateError',
          taskId: 'TASK-LOCAL',
          message: expect.stringContaining('read-only'),
        })
      );
    });
  });
  describe('requestCompletedTasks', () => {
    it('should send completed tasks to webview', async () => {
      const completedTasks = [
        {
          id: 'TASK-1',
          title: 'Completed Task',
          status: 'Done' as const,
          folder: 'completed' as const,
          source: 'completed' as const,
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/fake/backlog/completed/task-1.md',
        },
      ];

      (mockParser as unknown as Record<string, unknown>).getCompletedTasks = vi
        .fn()
        .mockResolvedValue(completedTasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      // Simulate receiving requestCompletedTasks message
      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({ type: 'requestCompletedTasks' });

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'completedTasksUpdated',
        tasks: completedTasks,
      });
    });
  });
  describe('requestCreateMilestone', () => {
    it('routes requestCreateMilestone messages to the create milestone command', async () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({ type: 'requestCreateMilestone' });

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('taskwright.createMilestone');
    });
  });
  describe('cross-branch mode from config', () => {
    it('stays local-only when check_active_branches is true (Board Sync v2 Task C / TASK-35)', async () => {
      (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        check_active_branches: true,
      });

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockParser.getTasks).toHaveBeenCalled();
      expect(mockParser.getTasksWithCrossBranch).not.toHaveBeenCalled();
    });

    it('should stay in local-only mode when check_active_branches is false', async () => {
      (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        check_active_branches: false,
      });

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockParser.getTasks).toHaveBeenCalled();
      expect(mockParser.getTasksWithCrossBranch).not.toHaveBeenCalled();
    });

    it('should stay in local-only mode when check_active_branches is undefined', async () => {
      (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockParser.getTasks).toHaveBeenCalled();
      expect(mockParser.getTasksWithCrossBranch).not.toHaveBeenCalled();
    });
  });
  describe('reverse dependencies and subtask progress', () => {
    const baseTask = {
      title: 'Task',
      labels: [],
      assignee: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: '/t.md',
    };

    it('should compute blocksTaskIds from reverse dependency map', async () => {
      const tasks: Task[] = [
        { ...baseTask, id: 'T-1', status: 'To Do', dependencies: [] },
        { ...baseTask, id: 'T-2', status: 'To Do', dependencies: ['T-1'] },
        { ...baseTask, id: 'T-3', status: 'To Do', dependencies: ['T-1'] },
      ];

      (mockParser.getTasks as Mock).mockResolvedValue(tasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tasksUpdated',
          tasks: expect.arrayContaining([
            expect.objectContaining({ id: 'T-1', blocksTaskIds: ['T-2', 'T-3'] }),
            expect.objectContaining({ id: 'T-2', blocksTaskIds: [] }),
            expect.objectContaining({ id: 'T-3', blocksTaskIds: [] }),
          ]),
        })
      );
    });

    it('should not call getBlockedByThisTask during refresh', async () => {
      const tasks: Task[] = [
        { ...baseTask, id: 'T-1', status: 'To Do', dependencies: [] },
        { ...baseTask, id: 'T-2', status: 'To Do', dependencies: ['T-1'] },
      ];

      (mockParser.getTasks as Mock).mockResolvedValue(tasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      await provider.refresh();

      expect(mockParser.getBlockedByThisTask).not.toHaveBeenCalled();
    });

    it('should compute subtaskProgress via map lookup', async () => {
      const tasks: Task[] = [
        {
          ...baseTask,
          id: 'T-1',
          status: 'To Do',
          dependencies: [],
          subtasks: ['T-2', 'T-3'],
          parentTaskId: undefined,
        },
        {
          ...baseTask,
          id: 'T-2',
          status: 'Done',
          dependencies: [],
          parentTaskId: 'T-1',
        },
        {
          ...baseTask,
          id: 'T-3',
          status: 'To Do',
          dependencies: [],
          parentTaskId: 'T-1',
        },
      ];

      (mockParser.getTasks as Mock).mockResolvedValue(tasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tasksUpdated',
          tasks: expect.arrayContaining([
            expect.objectContaining({
              id: 'T-1',
              subtaskProgress: { total: 2, done: 1 },
            }),
          ]),
        })
      );
    });

    it('should not include subtaskProgress when task has no subtasks', async () => {
      const tasks: Task[] = [{ ...baseTask, id: 'T-1', status: 'To Do', dependencies: [] }];

      (mockParser.getTasks as Mock).mockResolvedValue(tasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      const tasksUpdatedCall = (
        mockWebview.postMessage as ReturnType<typeof vi.fn>
      ).mock.calls.find((call: unknown[]) => (call[0] as { type: string }).type === 'tasksUpdated');
      const sentTasks = (tasksUpdatedCall![0] as { tasks: Task[] }).tasks;
      expect(sentTasks[0]).not.toHaveProperty('subtaskProgress');
    });

    it('computes blockingDependencyIds and excludes completed/archived dependencies', async () => {
      const tasks: Task[] = [
        { ...baseTask, id: 'T-1', status: 'To Do', dependencies: ['T-2', 'T-3', 'T-4', 'T-99'] },
        { ...baseTask, id: 'T-2', status: 'In Progress', dependencies: [] },
        { ...baseTask, id: 'T-3', status: 'Done', dependencies: [] },
      ];

      (mockParser.getTasks as Mock).mockResolvedValue(tasks);
      (mockParser.getCompletedTasks as Mock).mockResolvedValue([
        { ...baseTask, id: 'T-4', status: 'Done', dependencies: [], source: 'completed' },
      ]);
      (mockParser.getArchivedTasks as Mock).mockResolvedValue([
        { ...baseTask, id: 'T-5', status: 'Done', dependencies: [], folder: 'archive' },
      ]);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tasksUpdated',
          tasks: expect.arrayContaining([
            expect.objectContaining({
              id: 'T-1',
              blockingDependencyIds: ['T-2', 'T-99'],
            }),
          ]),
        })
      );
    });
  });
  describe('selectTask routing and active task highlighting', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should route to openTaskDetail command and update preview when TaskDetailProvider has an active panel', async () => {
      vi.spyOn(TaskDetailProvider, 'hasActivePanel').mockReturnValue(true);

      const onSelectTask = vi.fn().mockResolvedValue(undefined);
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      provider.setTaskSelectionHandler(onSelectTask);
      resolveView(provider);

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({
        type: 'selectTask',
        taskId: 'TASK-10',
        filePath: '/fake/backlog/tasks/task-10.md',
        source: 'local',
        branch: 'main',
      });

      const taskRef = {
        taskId: 'TASK-10',
        filePath: '/fake/backlog/tasks/task-10.md',
        source: 'local',
        branch: 'main',
      };
      // Both preview and editor should be updated
      expect(onSelectTask).toHaveBeenCalledWith(taskRef);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'taskwright.openTaskDetail',
        taskRef,
        { preserveFocus: true }
      );
    });

    it('should call onSelectTask handler when TaskDetailProvider has no active panel', async () => {
      vi.spyOn(TaskDetailProvider, 'hasActivePanel').mockReturnValue(false);

      const onSelectTask = vi.fn().mockResolvedValue(undefined);
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      provider.setTaskSelectionHandler(onSelectTask);
      resolveView(provider);

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({
        type: 'selectTask',
        taskId: 'TASK-20',
        filePath: '/fake/backlog/tasks/task-20.md',
        source: 'local',
        branch: 'feature/test',
      });

      expect(onSelectTask).toHaveBeenCalledWith({
        taskId: 'TASK-20',
        filePath: '/fake/backlog/tasks/task-20.md',
        source: 'local',
        branch: 'feature/test',
      });
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'taskwright.openTaskDetail',
        expect.anything()
      );
    });

    it('should post activeEditedTaskChanged message when setActiveEditedTaskId is called with a task ID', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      provider.setActiveEditedTaskId('TASK-55');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'activeEditedTaskChanged',
        taskId: 'TASK-55',
      });
    });

    it('should post activeEditedTaskChanged message with null when setActiveEditedTaskId is called with null', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      provider.setActiveEditedTaskId(null);

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'activeEditedTaskChanged',
        taskId: null,
      });
    });
  });
});
