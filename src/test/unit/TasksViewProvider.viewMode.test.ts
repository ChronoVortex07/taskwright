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

  describe('setViewMode', () => {
    it('should post activeTabChanged and viewModeChanged when mode changes', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      // Default is tree, so changing to list should trigger messages
      provider.setViewMode('list');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'activeTabChanged',
        tab: 'list',
      });
      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'viewModeChanged',
        viewMode: 'list',
      });
    });

    it('should not post message when mode is already set', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      // Reset mock to clear any initialization calls
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      // Default is tree, setting to tree again should not trigger message
      provider.setViewMode('tree');

      expect(mockWebview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'activeTabChanged' })
      );
      expect(mockWebview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'viewModeChanged' })
      );
    });

    it('should persist viewMode to globalState', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setViewMode('list');

      expect(mockContext.globalState.get('backlog.viewMode')).toBe('list');
    });
  });
  describe('setViewMode with drafts', () => {
    it('should send activeTabChanged, draftsModeChanged and viewModeChanged when switching to drafts', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      provider.setViewMode('drafts');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'activeTabChanged',
        tab: 'drafts',
      });
      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'draftsModeChanged',
        enabled: true,
      });
      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'viewModeChanged',
        viewMode: 'list',
      });
    });

    it('should disable drafts mode when switching from drafts to kanban', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      // First switch to drafts
      provider.setViewMode('drafts');
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      // Then switch to kanban
      provider.setViewMode('kanban');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'activeTabChanged',
        tab: 'kanban',
      });
      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'draftsModeChanged',
        enabled: false,
      });
      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'viewModeChanged',
        viewMode: 'kanban',
      });
    });

    it('should disable drafts mode when switching from drafts to list', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      // First switch to drafts
      provider.setViewMode('drafts');
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      // Then switch to list
      provider.setViewMode('list');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'activeTabChanged',
        tab: 'list',
      });
      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'draftsModeChanged',
        enabled: false,
      });
      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'viewModeChanged',
        viewMode: 'list',
      });
    });

    it('should not send messages when setting same mode', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setViewMode('drafts');
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      // Setting drafts again should be a no-op
      provider.setViewMode('drafts');

      expect(mockWebview.postMessage).not.toHaveBeenCalled();
    });
  });
  describe('setViewMode with archived', () => {
    it('should send activeTabChanged with archived tab', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      provider.setViewMode('archived');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'activeTabChanged',
        tab: 'archived',
      });
    });

    it('should send viewModeChanged with list for archived mode', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      provider.setViewMode('archived');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'viewModeChanged',
        viewMode: 'list',
      });
    });

    it('should persist archived mode to globalState', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setViewMode('archived');

      expect(mockContext.globalState.get('backlog.viewMode')).toBe('archived');
    });
  });
  describe('refresh with archived mode', () => {
    it('should load archived tasks when viewMode is archived', async () => {
      const archivedTasks = [
        {
          id: 'TASK-5',
          title: 'Archived Task',
          status: 'Done' as const,
          folder: 'archive' as const,
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/fake/backlog/archive/tasks/task-5.md',
        },
      ];

      (mockParser as unknown as Record<string, unknown>).getArchivedTasks = vi
        .fn()
        .mockResolvedValue(archivedTasks);
      (mockParser as unknown as Record<string, unknown>).getDrafts = vi.fn().mockResolvedValue([]);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      // Switch to archived mode
      provider.setViewMode('archived');
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(
        (mockParser as unknown as Record<string, ReturnType<typeof vi.fn>>).getArchivedTasks
      ).toHaveBeenCalled();
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tasksUpdated',
          tasks: expect.arrayContaining([
            expect.objectContaining({ id: 'TASK-5', folder: 'archive' }),
          ]),
        })
      );
    });

    it('should trigger refresh when switching to archived mode', async () => {
      (mockParser as unknown as Record<string, unknown>).getArchivedTasks = vi
        .fn()
        .mockResolvedValue([]);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      // Clear any initialization calls
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      provider.setViewMode('archived');

      // Should have triggered refresh which calls getArchivedTasks
      // Wait a tick for the async refresh to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        (mockParser as unknown as Record<string, ReturnType<typeof vi.fn>>).getArchivedTasks
      ).toHaveBeenCalled();
    });

    it('should trigger refresh when switching from archived back to kanban', async () => {
      (mockParser as unknown as Record<string, unknown>).getArchivedTasks = vi
        .fn()
        .mockResolvedValue([]);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      // Switch to archived first
      provider.setViewMode('archived');
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Clear mocks
      (mockParser.getTasks as ReturnType<typeof vi.fn>).mockClear();

      // Switch back to kanban
      provider.setViewMode('kanban');
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Should load regular tasks again
      expect(mockParser.getTasks).toHaveBeenCalled();
    });
  });
  describe('setViewMode with tree', () => {
    it('should trigger refresh when switching from kanban to tree', async () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      // resolveView calls loadPersistedState, which defaults to 'tree'.
      // Switch away first so the tree switch is a real mode change.
      provider.setViewMode('kanban');
      await new Promise((resolve) => setTimeout(resolve, 0));

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      // Switch to tree â€” should trigger refresh (TASK-23)
      provider.setViewMode('tree');
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Refresh must have posted tasks â€” the tree tab unions drafts into the
      // task payload, so a missing refresh means pre-existing drafts stay hidden.
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tasksUpdated' })
      );
    });

    it('should trigger refresh when switching from tree back to kanban', async () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      // resolveView defaults to 'tree' (from persisted state default) â€”
      // switching away should also trigger refresh
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      provider.setViewMode('kanban');
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Refresh must have posted tasks for the kanban view
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tasksUpdated' })
      );
    });
  });
  describe('handleMessage setViewMode', () => {
    it('should handle setViewMode message from webview', async () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      // Simulate receiving setViewMode message from webview
      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({ type: 'setViewMode', mode: 'list' });

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'activeTabChanged',
        tab: 'list',
      });
    });

    it('should handle setViewMode archived from webview', async () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({ type: 'setViewMode', mode: 'archived' });

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'activeTabChanged',
        tab: 'archived',
      });
      expect(mockContext.globalState.get('backlog.viewMode')).toBe('archived');
    });
  });
  describe('setViewMode with dashboard', () => {
    it('should send activeTabChanged with dashboard tab', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      provider.setViewMode('dashboard');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'activeTabChanged',
        tab: 'dashboard',
      });
    });

    it('should not send viewModeChanged for dashboard mode', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      provider.setViewMode('dashboard');

      expect(mockWebview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'viewModeChanged' })
      );
    });

    it('should persist dashboard mode to globalState', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setViewMode('dashboard');

      expect(mockContext.globalState.get('backlog.viewMode')).toBe('dashboard');
    });

    it('should refresh dashboard stats when switching to dashboard', async () => {
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
          status: 'In Progress',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/t2.md',
        },
      ];

      (mockParser.getTasks as Mock).mockResolvedValue(tasks);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      provider.setViewMode('dashboard');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'statsUpdated',
          stats: expect.objectContaining({
            totalTasks: 2,
            byStatus: expect.objectContaining({
              'To Do': 1,
              'In Progress': 1,
            }),
          }),
        })
      );
    });
  });
});
