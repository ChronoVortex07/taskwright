import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import * as vscode from 'vscode';
import { createMockExtensionContext } from '../mocks/vscode';
import { TasksViewProvider } from '../../providers/TasksViewProvider';
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

  describe('computeStatistics (via refreshDashboard)', () => {
    it('should compute correct counts by status', async () => {
      const tasks: Task[] = [
        {
          id: 'T-1',
          title: 'Task 1',
          status: 'To Do',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t1.md',
        },
        {
          id: 'T-2',
          title: 'Task 2',
          status: 'To Do',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t2.md',
        },
        {
          id: 'T-3',
          title: 'Task 3',
          status: 'In Progress',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t3.md',
        },
        {
          id: 'T-4',
          title: 'Task 4',
          status: 'Done',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t4.md',
        },
      ];

      (mockParser.getTasks as Mock).mockResolvedValue(tasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setViewMode('dashboard');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'statsUpdated',
          stats: expect.objectContaining({
            totalTasks: 4,
            byStatus: expect.objectContaining({
              'To Do': 2,
              'In Progress': 1,
              Done: 1,
            }),
          }),
        })
      );
    });

    it('should compute correct priority counts', async () => {
      const tasks: Task[] = [
        {
          id: 'T-1',
          title: 'Task 1',
          status: 'To Do',
          priority: 'high',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t1.md',
        },
        {
          id: 'T-2',
          title: 'Task 2',
          status: 'To Do',
          priority: 'medium',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t2.md',
        },
        {
          id: 'T-3',
          title: 'Task 3',
          status: 'To Do',
          priority: 'low',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t3.md',
        },
        {
          id: 'T-4',
          title: 'Task 4',
          status: 'To Do',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t4.md',
        },
      ];

      (mockParser.getTasks as Mock).mockResolvedValue(tasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setViewMode('dashboard');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'statsUpdated',
          stats: expect.objectContaining({
            byPriority: expect.objectContaining({
              high: 1,
              medium: 1,
              low: 1,
              none: 1,
            }),
          }),
        })
      );
    });

    it('should compute milestone statistics', async () => {
      const tasks: Task[] = [
        {
          id: 'T-1',
          title: 'Task 1',
          status: 'To Do',
          milestone: 'v1.0',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t1.md',
        },
        {
          id: 'T-2',
          title: 'Task 2',
          status: 'Done',
          milestone: 'v1.0',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t2.md',
        },
        {
          id: 'T-3',
          title: 'Task 3',
          status: 'To Do',
          milestone: 'v2.0',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t3.md',
        },
      ];

      (mockParser.getTasks as Mock).mockResolvedValue(tasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setViewMode('dashboard');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'statsUpdated',
          stats: expect.objectContaining({
            milestones: expect.arrayContaining([
              expect.objectContaining({ name: 'v2.0', total: 1, done: 0 }),
              expect.objectContaining({ name: 'v1.0', total: 2, done: 1 }),
            ]),
          }),
        })
      );
    });

    it('should count custom statuses in dashboard stats', async () => {
      const baseTask = {
        title: 'Task',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/t.md',
      };

      const tasks: Task[] = [
        { ...baseTask, id: 'T-1', status: 'Review' },
        { ...baseTask, id: 'T-2', status: 'Review' },
        { ...baseTask, id: 'T-3', status: 'QA' },
        { ...baseTask, id: 'T-4', status: 'To Do' },
      ];

      (mockParser.getTasks as Mock).mockResolvedValue(tasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setViewMode('dashboard');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'statsUpdated',
          stats: expect.objectContaining({
            totalTasks: 4,
            byStatus: expect.objectContaining({
              Review: 2,
              QA: 1,
              'To Do': 1,
            }),
          }),
        })
      );
    });

    it('should build byStatus from config statuses', async () => {
      const baseTask = {
        title: 'Task',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/t.md',
      };

      const tasks: Task[] = [
        { ...baseTask, id: 'T-1', status: 'Backlog' },
        { ...baseTask, id: 'T-2', status: 'Review' },
      ];

      // Config returns custom statuses
      (mockParser.getStatuses as Mock).mockResolvedValue([
        'Backlog',
        'In Dev',
        'Review',
        'Deployed',
      ]);
      (mockParser.getTasks as Mock).mockResolvedValue(tasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setViewMode('dashboard');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'statsUpdated',
          stats: expect.objectContaining({
            totalTasks: 2,
            byStatus: {
              Backlog: 1,
              'In Dev': 0,
              Review: 1,
              Deployed: 0,
            },
          }),
        })
      );
    });

    it('should use last config status as done status for milestones', async () => {
      const baseTask = {
        title: 'Task',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/t.md',
      };

      const tasks: Task[] = [
        { ...baseTask, id: 'T-1', status: 'Backlog', milestone: 'v1' },
        { ...baseTask, id: 'T-2', status: 'Deployed', milestone: 'v1' },
      ];

      // Last status (Deployed) is treated as "done"
      (mockParser.getStatuses as Mock).mockResolvedValue([
        'Backlog',
        'In Dev',
        'Review',
        'Deployed',
      ]);
      (mockParser.getTasks as Mock).mockResolvedValue(tasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setViewMode('dashboard');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'statsUpdated',
          stats: expect.objectContaining({
            milestones: [expect.objectContaining({ name: 'v1', total: 2, done: 1 })],
          }),
        })
      );
    });

    it('should include completedCount from completed folder', async () => {
      const tasks: Task[] = [
        {
          id: 'T-1',
          title: 'Task 1',
          status: 'To Do',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t1.md',
        },
      ];

      const completedTasks: Task[] = [
        {
          id: 'T-2',
          title: 'Completed 1',
          status: 'Done',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/completed/t2.md',
          source: 'completed',
        },
        {
          id: 'T-3',
          title: 'Completed 2',
          status: 'Done',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/completed/t3.md',
          source: 'completed',
        },
      ];

      (mockParser.getTasks as Mock).mockResolvedValue(tasks);
      (mockParser.getCompletedTasks as Mock).mockResolvedValue(completedTasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setViewMode('dashboard');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'statsUpdated',
          stats: expect.objectContaining({
            totalTasks: 1,
            completedCount: 2,
          }),
        })
      );
    });
  });
  describe('draftCountUpdated', () => {
    it('should send draftCountUpdated with count of draft tasks on refresh', async () => {
      const draftTasks = [
        {
          id: 'TASK-10',
          title: 'Draft Task 1',
          status: 'Draft' as const,
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/fake/backlog/drafts/task-10.md',
        },
        {
          id: 'TASK-11',
          title: 'Draft Task 2',
          status: 'Draft' as const,
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/fake/backlog/drafts/task-11.md',
        },
      ];

      (mockParser as unknown as Record<string, unknown>).getDrafts = vi
        .fn()
        .mockResolvedValue(draftTasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'draftCountUpdated',
        count: 2,
      });
    });

    it('should send draftCountUpdated with 0 when no drafts exist', async () => {
      (mockParser as unknown as Record<string, unknown>).getDrafts = vi.fn().mockResolvedValue([]);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'draftCountUpdated',
        count: 0,
      });
    });

    it('should use tasks.length as draft count when in drafts mode', async () => {
      const draftTasks = [
        {
          id: 'TASK-10',
          title: 'Draft Task 1',
          status: 'Draft' as const,
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/fake/backlog/drafts/task-10.md',
        },
        {
          id: 'TASK-11',
          title: 'Draft Task 2',
          status: 'Draft' as const,
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/fake/backlog/drafts/task-11.md',
        },
        {
          id: 'TASK-12',
          title: 'Draft Task 3',
          status: 'Draft' as const,
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/fake/backlog/drafts/task-12.md',
        },
      ];

      (mockParser as unknown as Record<string, unknown>).getDrafts = vi
        .fn()
        .mockResolvedValue(draftTasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      // Switch to drafts mode
      provider.setViewMode('drafts');
      await new Promise((resolve) => setTimeout(resolve, 0));
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      // In drafts mode, count comes from tasks.length (the loaded drafts), not a separate getDrafts call
      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'draftCountUpdated',
        count: 3,
      });
    });
  });
});
