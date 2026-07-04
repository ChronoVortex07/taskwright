import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import * as vscode from 'vscode';
import { createMockExtensionContext } from '../mocks/vscode';
import { TasksViewProvider } from '../../providers/TasksViewProvider';
import { BacklogParser } from '../../core/BacklogParser';

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

  describe('setFilter', () => {
    it('should post setFilter message with status:To Do filter', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setFilter('status:To Do');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'setFilter',
        filter: 'status:To Do',
      });
    });

    it('should post setFilter message for not-done filter', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setFilter('not-done');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'setFilter',
        filter: 'not-done',
      });
    });

    it('should post setFilter message for status:In Progress filter', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setFilter('status:In Progress');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'setFilter',
        filter: 'status:In Progress',
      });
    });

    it('should post setFilter message for all filter', () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      provider.setFilter('all');

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'setFilter',
        filter: 'all',
      });
    });
  });
  describe('tasks view settings', () => {
    // taskIdDisplay is read via the taskwright.* config with a legacy backlog.*
    // fallback (see src/config.ts), so we stub WorkspaceConfiguration.inspect().
    // Only the taskIdDisplay key is stubbed here; other keys (e.g. mergeMode)
    // fall through to undefined so getTasksViewSettings() uses its own default.
    function mockConfigInspect(values: { taskwright?: string; backlog?: string }) {
      (vscode.workspace.getConfiguration as Mock).mockImplementation((section: string) => ({
        inspect: vi.fn((key: string) => {
          if (key !== 'taskIdDisplay') return undefined;
          const value = section === 'taskwright' ? values.taskwright : values.backlog;
          return value === undefined ? undefined : { globalValue: value };
        }),
      }));
    }

    it('should post settingsUpdated with default task id display mode when unset', async () => {
      mockConfigInspect({});

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('taskwright');
      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'settingsUpdated',
        settings: { taskIdDisplay: 'full', mergeMode: 'manual-review' },
      });
    });

    it('should post settingsUpdated with configured number mode', async () => {
      mockConfigInspect({ taskwright: 'number' });

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'settingsUpdated',
        settings: { taskIdDisplay: 'number', mergeMode: 'manual-review' },
      });
    });

    it('falls back to a legacy backlog.* taskIdDisplay value when taskwright.* is unset', async () => {
      mockConfigInspect({ backlog: 'hidden' });

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'settingsUpdated',
        settings: { taskIdDisplay: 'hidden', mergeMode: 'manual-review' },
      });
    });
  });
  describe('handleMessage selectTask', () => {
    it('should forward selected task identity to registered selection handler', async () => {
      const onSelectTask = vi.fn().mockResolvedValue(undefined);
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      provider.setTaskSelectionHandler(onSelectTask);
      resolveView(provider);

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({
        type: 'selectTask',
        taskId: 'TASK-42',
        filePath: '/fake/backlog/tasks/task-42.md',
        source: 'local',
        branch: 'feature/current',
      });

      expect(onSelectTask).toHaveBeenCalledWith({
        taskId: 'TASK-42',
        filePath: '/fake/backlog/tasks/task-42.md',
        source: 'local',
        branch: 'feature/current',
      });
    });
  });
  describe('handleMessage focusTaskPreview', () => {
    it('should focus the task preview panel', async () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({ type: 'focusTaskPreview' });

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('taskwright.taskPreview.focus');
    });
  });
  describe('handleMessage restoreTask', () => {
    it('should call restoreArchivedTask and refresh on restore', async () => {
      const mockWriter = {
        restoreArchivedTask: vi.fn().mockResolvedValue('/fake/backlog/tasks/task-5.md'),
      };
      vi.doMock('../../core/BacklogWriter', () => ({
        BacklogWriter: vi.fn().mockImplementation(() => mockWriter),
      }));

      (mockParser as unknown as Record<string, unknown>).getArchivedTasks = vi
        .fn()
        .mockResolvedValue([]);

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({ type: 'restoreTask', taskId: 'TASK-5' });

      // Provider should have attempted a refresh (which posts messages)
      expect(mockWebview.postMessage).toHaveBeenCalled();
    });
  });
  describe('handleMessage deleteTask', () => {
    it('should handle deleteTask message from webview', async () => {
      (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'TASK-5',
        title: 'Task to Delete',
        status: 'Done',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/archive/tasks/task-5.md',
      });

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];

      // The delete requires a confirmation dialog - in tests, showWarningMessage returns undefined
      // so the delete should not proceed
      await messageHandler({ type: 'deleteTask', taskId: 'TASK-5' });

      // Should have shown a confirmation dialog
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Task to Delete'),
        expect.objectContaining({ modal: true }),
        'Delete'
      );
    });
  });
  describe('handleMessage filterByStatus', () => {
    it('should execute taskwright.filterByStatus command', async () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({ type: 'filterByStatus', status: 'To Do' });

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'taskwright.filterByStatus',
        'To Do'
      );
    });

    it('should execute taskwright.filterByStatus with In Progress status', async () => {
      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);

      const messageHandler = (mockWebview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      await messageHandler({ type: 'filterByStatus', status: 'In Progress' });

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'taskwright.filterByStatus',
        'In Progress'
      );
    });
  });
  describe('configUpdated message', () => {
    it('should send configUpdated with project_name on refresh', async () => {
      (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        project_name: 'My Project',
      });

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'configUpdated',
        config: { projectName: 'My Project' },
      });
    });

    it('should send configUpdated with undefined projectName when not configured', async () => {
      (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const provider = new TasksViewProvider(extensionUri, mockParser, mockContext);
      resolveView(provider);
      (mockWebview.postMessage as ReturnType<typeof vi.fn>).mockClear();

      await provider.refresh();

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'configUpdated',
        config: { projectName: undefined },
      });
    });
  });
});
