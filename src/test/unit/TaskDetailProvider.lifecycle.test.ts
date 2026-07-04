import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { TaskDetailProvider } from '../../providers/TaskDetailProvider';
import { BacklogParser } from '../../core/BacklogParser';

// vscode mock is provided via vitest.config.ts alias

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock marked module
vi.mock('marked', () => ({
  marked: {
    setOptions: vi.fn(),
    parse: vi.fn((markdown: string) => `<p>${markdown}</p>`),
  },
}));

// Mock BacklogWriter
const mockWriter = {
  updateTask: vi.fn().mockResolvedValue(undefined),
  toggleChecklistItem: vi.fn().mockResolvedValue(undefined),
  promoteDraft: vi.fn().mockResolvedValue(undefined),
  archiveTask: vi.fn().mockResolvedValue(undefined),
  restoreArchivedTask: vi.fn().mockResolvedValue('/fake/backlog/tasks/task-5.md'),
  deleteTask: vi.fn().mockResolvedValue(undefined),
  createMilestone: vi.fn().mockResolvedValue({ id: 'm-2', name: 'Launch' }),
  createSubtask: vi
    .fn()
    .mockResolvedValue({ id: 'TASK-99', filePath: '/fake/backlog/tasks/task-99.md' }),
};
vi.mock('../../core/BacklogWriter', () => ({
  BacklogWriter: vi.fn(function () {
    return mockWriter;
  }),
  computeContentHash: vi.fn(() => 'mock-hash'),
  FileConflictError: class FileConflictError extends Error {},
}));

describe('TaskDetailProvider', () => {
  let extensionUri: vscode.Uri;
  let mockParser: BacklogParser;
  let mockPanel: Partial<vscode.WebviewPanel>;
  let mockWebview: Partial<vscode.Webview>;

  beforeEach(() => {
    extensionUri = vscode.Uri.file('/test/extension');

    mockWebview = {
      html: '',
      asWebviewUri: vi.fn((uri) => uri),
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(true),
      cspSource: 'test-csp',
    };

    mockPanel = {
      webview: mockWebview as vscode.Webview,
      reveal: vi.fn(),
      title: '',
      visible: true,
      dispose: vi.fn(),
      onDidDispose: vi.fn((callback: () => void) => {
        // Store callback for later invocation in tests
        (mockPanel as { _disposeCallback?: () => void })._disposeCallback = callback;
        return { dispose: vi.fn() };
      }),
      onDidChangeViewState: vi.fn(() => {
        return { dispose: vi.fn() };
      }),
    };

    (vscode.window.createWebviewPanel as Mock).mockReturnValue(mockPanel);

    mockParser = {
      getTask: vi.fn(),
      getTasksWithCrossBranch: vi.fn().mockResolvedValue([]),
      getStatuses: vi.fn().mockResolvedValue(['To Do', 'In Progress', 'Done']),
      getUniqueLabels: vi.fn().mockResolvedValue([]),
      getUniqueAssignees: vi.fn().mockResolvedValue([]),
      getMilestones: vi.fn().mockResolvedValue([]),
      getTasks: vi.fn().mockResolvedValue([]),
      getBlockedByThisTask: vi.fn().mockResolvedValue([]),
      getCompletedTasks: vi.fn().mockResolvedValue([]),
      getArchivedTasks: vi.fn().mockResolvedValue([]),
      resolveMilestone: vi.fn().mockImplementation(async (raw: string) => {
        const normalized = String(raw || '').trim();
        if (!normalized) return undefined;
        const milestones = await mockParser.getMilestones();
        const inputKey = normalized.toLowerCase();
        const idMatch = milestones.find(
          (m: { id: string }) => m.id.trim().toLowerCase() === inputKey
        );
        if (idMatch) return idMatch.id;
        const titleMatches = milestones.filter(
          (m: { name: string }) => m.name.trim().toLowerCase() === inputKey
        );
        if (titleMatches.length === 1) return titleMatches[0].id;
        return normalized;
      }),
      invalidateMilestoneCache: vi.fn(),
      getConfig: vi.fn().mockResolvedValue({}),
    } as unknown as BacklogParser;

    // Reset fs mocks
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockReturnValue('# Test Task\nContent');

    // Reset writer mocks
    mockWriter.updateTask.mockResolvedValue(undefined);
    mockWriter.toggleChecklistItem.mockResolvedValue(undefined);
    mockWriter.promoteDraft.mockResolvedValue(undefined);
    mockWriter.archiveTask.mockResolvedValue(undefined);
    mockWriter.restoreArchivedTask.mockResolvedValue('/fake/backlog/tasks/task-5.md');
    mockWriter.deleteTask.mockResolvedValue(undefined);
    mockWriter.createMilestone.mockResolvedValue({ id: 'm-2', name: 'Launch' });
    mockWriter.createSubtask.mockResolvedValue({
      id: 'TASK-99',
      filePath: '/fake/backlog/tasks/task-99.md',
    });

    // Clear static state between tests
    TaskDetailProvider['currentPanel'] = undefined;
    TaskDetailProvider['currentTaskId'] = undefined;
    TaskDetailProvider['currentTaskRef'] = undefined;
    TaskDetailProvider['currentFileHash'] = undefined;
    TaskDetailProvider['currentFilePath'] = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('onFileChanged', () => {
    it('should ignore events when no panel is open', () => {
      const provider = new TaskDetailProvider(extensionUri, mockParser);
      const uri = vscode.Uri.file('/test/backlog/tasks/task-1.md');

      // No panel is open - should not throw or call anything
      TaskDetailProvider.onFileChanged(uri, provider);

      expect(mockParser.getTask).not.toHaveBeenCalled();
    });

    it('should ignore events when no task ID is set', async () => {
      const provider = new TaskDetailProvider(extensionUri, mockParser);
      const uri = vscode.Uri.file('/test/backlog/tasks/task-1.md');

      // Set panel but not task ID
      TaskDetailProvider['currentPanel'] = mockPanel as vscode.WebviewPanel;
      TaskDetailProvider['currentTaskId'] = undefined;

      TaskDetailProvider.onFileChanged(uri, provider);

      expect(mockParser.getTask).not.toHaveBeenCalled();
    });

    it('should ignore events when no file path is tracked', async () => {
      const provider = new TaskDetailProvider(extensionUri, mockParser);
      const uri = vscode.Uri.file('/test/backlog/tasks/task-1.md');

      // Set panel and task ID but not file path
      TaskDetailProvider['currentPanel'] = mockPanel as vscode.WebviewPanel;
      TaskDetailProvider['currentTaskId'] = 'TASK-1';
      TaskDetailProvider['currentFilePath'] = undefined;

      TaskDetailProvider.onFileChanged(uri, provider);

      expect(mockParser.getTask).not.toHaveBeenCalled();
    });

    it('should ignore events for non-matching files', async () => {
      const provider = new TaskDetailProvider(extensionUri, mockParser);
      const uri = vscode.Uri.file('/test/backlog/tasks/task-2.md');

      // Set up state for task-1, but file change is for task-2
      TaskDetailProvider['currentPanel'] = mockPanel as vscode.WebviewPanel;
      TaskDetailProvider['currentTaskId'] = 'TASK-1';
      TaskDetailProvider['currentFilePath'] = '/test/backlog/tasks/task-1.md';

      TaskDetailProvider.onFileChanged(uri, provider);

      expect(mockParser.getTask).not.toHaveBeenCalled();
    });

    it('should refresh view when matching file changes', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';
      const uri = vscode.Uri.file(filePath);

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Test Task',
        description: 'Description',
        status: 'To Do',
        priority: undefined,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: filePath,
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      // Set up state as if task-1 is currently displayed
      TaskDetailProvider['currentPanel'] = mockPanel as vscode.WebviewPanel;
      TaskDetailProvider['currentTaskId'] = 'TASK-1';
      TaskDetailProvider['currentFilePath'] = filePath;

      TaskDetailProvider.onFileChanged(uri, provider);

      // Should trigger a refresh by calling getTask
      expect(mockParser.getTask).toHaveBeenCalledWith('TASK-1');
    });

    it('should show warning and close panel when file is deleted', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';
      const uri = vscode.Uri.file(filePath);

      // File no longer exists
      (fs.existsSync as Mock).mockReturnValue(false);

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      // Set up state as if task-1 is currently displayed
      TaskDetailProvider['currentPanel'] = mockPanel as vscode.WebviewPanel;
      TaskDetailProvider['currentTaskId'] = 'TASK-1';
      TaskDetailProvider['currentFilePath'] = filePath;

      TaskDetailProvider.onFileChanged(uri, provider);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('deleted')
      );
      expect(mockPanel.dispose).toHaveBeenCalled();
    });
  });
  describe('openTask', () => {
    it('should set currentFilePath when opening a task', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Test Task',
        description: 'Description',
        status: 'To Do',
        priority: undefined,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: filePath,
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      await provider.openTask('TASK-1');

      expect(TaskDetailProvider['currentFilePath']).toBe(filePath);
    });

    it('honors viewColumn and preserveFocus when creating the first panel', async () => {
      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Test Task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-1.md',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      await provider.openTask('TASK-1', {
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.Active,
      });

      // The create path must pass the column + preserveFocus through (not a bare
      // ViewColumn), so the first open keeps focus on the originating board.
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
        'taskwright.taskDetail',
        expect.any(String),
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
        expect.objectContaining({ enableScripts: true })
      );
    });

    it('should clear currentFilePath when task has no file path', async () => {
      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Test Task',
        description: 'Description',
        status: 'To Do',
        priority: undefined,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: undefined,
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      await provider.openTask('TASK-1');

      expect(TaskDetailProvider['currentFilePath']).toBeUndefined();
    });

    it('should clear currentFilePath on panel dispose', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Test Task',
        description: 'Description',
        status: 'To Do',
        priority: undefined,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: filePath,
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      await provider.openTask('TASK-1');
      expect(TaskDetailProvider['currentFilePath']).toBe(filePath);

      // Simulate panel disposal
      const disposeCallback = (mockPanel as { _disposeCallback?: () => void })._disposeCallback;
      if (disposeCallback) {
        disposeCallback();
      }

      expect(TaskDetailProvider['currentFilePath']).toBeUndefined();
    });

    it('should resolve cross-branch task by filePath when opening with source metadata', async () => {
      const localPath = '/test/backlog/tasks/task-1.md';
      const branchPath = '/test/.backlog/branches/feature-x/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Local Task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: localPath,
        source: 'local',
      });
      (mockParser.getTasksWithCrossBranch as Mock).mockResolvedValue([
        {
          id: 'TASK-1',
          title: 'Local Task',
          status: 'To Do',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: localPath,
          source: 'local',
        },
        {
          id: 'TASK-1',
          title: 'Branch Task',
          status: 'In Progress',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: branchPath,
          source: 'local-branch',
          branch: 'feature/x',
        },
      ]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask({
        taskId: 'TASK-1',
        filePath: branchPath,
        source: 'local-branch',
        branch: 'feature/x',
      });

      expect(TaskDetailProvider['currentFilePath']).toBe(branchPath);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.task.title).toBe('Branch Task');
    });

    it('should keep local resolution when metadata matches the local file', async () => {
      const localPath = '/test/backlog/tasks/task-1.md';
      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Local Task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: localPath,
        source: 'local',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask({
        taskId: 'TASK-1',
        filePath: localPath,
        source: 'local',
      });

      expect(mockParser.getTasksWithCrossBranch).not.toHaveBeenCalled();
      expect(TaskDetailProvider['currentFilePath']).toBe(localPath);
    });
  });
  describe('getCurrentTaskId', () => {
    it('should return undefined when no task is open', () => {
      expect(TaskDetailProvider.getCurrentTaskId()).toBeUndefined();
    });

    it('should return the current task ID when a task is open', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Test Task',
        description: 'Description',
        status: 'To Do',
        priority: undefined,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: filePath,
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      await provider.openTask('TASK-1');

      expect(TaskDetailProvider.getCurrentTaskId()).toBe('TASK-1');
    });

    it('should return undefined after panel is disposed', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Test Task',
        description: 'Description',
        status: 'To Do',
        priority: undefined,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: filePath,
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      await provider.openTask('TASK-1');
      expect(TaskDetailProvider.getCurrentTaskId()).toBe('TASK-1');

      // Simulate panel disposal
      const disposeCallback = (mockPanel as { _disposeCallback?: () => void })._disposeCallback;
      if (disposeCallback) {
        disposeCallback();
      }

      expect(TaskDetailProvider.getCurrentTaskId()).toBeUndefined();
    });
  });
});
