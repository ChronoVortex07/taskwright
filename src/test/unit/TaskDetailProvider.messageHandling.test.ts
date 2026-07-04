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

  describe('read-only cross-branch task behavior', () => {
    it('includes read-only metadata in taskData for cross-branch tasks', async () => {
      const filePath = '/test/.backlog/branches/feature/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Cross Branch Task',
        description: 'Description',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath,
        source: 'local-branch',
        branch: 'feature/other',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.isReadOnly).toBe(true);
      expect(taskDataCall![0].data.readOnlyReason).toContain('feature/other');
    });

    it('blocks updateField writes for read-only tasks', async () => {
      const filePath = '/test/.backlog/branches/feature/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Cross Branch Task',
        description: 'Description',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath,
        source: 'local-branch',
        branch: 'feature/other',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];
      await messageHandler({ type: 'updateField', field: 'title', value: 'Should not save' });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('read-only')
      );
      expect(mockWriter.updateTask).not.toHaveBeenCalled();
    });

    it('keeps local tasks editable even when branch metadata exists', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Local Task',
        description: 'Description',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath,
        source: 'local',
        branch: 'feature/current',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.isReadOnly).toBe(false);
      expect(taskDataCall![0].data.readOnlyReason).toBeUndefined();
    });
  });
  describe('handleMessage restoreTask', () => {
    it('should call restoreArchivedTask and close panel', async () => {
      const filePath = '/test/backlog/archive/tasks/task-5.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-5',
        title: 'Archived Task',
        status: 'Done',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath,
        folder: 'archive',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-5');

      // Get message handler
      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];

      await messageHandler({ type: 'restoreTask', taskId: 'TASK-5' });

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('restored')
      );
      expect(mockPanel.dispose).toHaveBeenCalled();
    });
  });
  describe('handleMessage deleteTask', () => {
    it('should show confirmation dialog before deleting', async () => {
      const filePath = '/test/backlog/archive/tasks/task-5.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-5',
        title: 'Task to Delete',
        status: 'Done',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath,
        folder: 'archive',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-5');

      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];

      await messageHandler({ type: 'deleteTask', taskId: 'TASK-5' });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Task to Delete'),
        expect.objectContaining({ modal: true }),
        'Delete'
      );
    });
  });
  describe('handleMessage dependency linking', () => {
    it('creates a milestone and assigns it to the current task', async () => {
      const currentTask = {
        id: 'TASK-1',
        title: 'Current Task',
        status: 'In Progress',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-1.md',
        folder: 'tasks',
      };

      (mockParser.getTask as Mock).mockResolvedValue(currentTask);
      (mockParser.getTasks as Mock).mockResolvedValue([currentTask]);
      mockWriter.createMilestone.mockResolvedValue({ id: 'm-2', name: 'Launch' });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      mockWriter.createMilestone.mockClear();
      mockWriter.updateTask.mockClear();
      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];
      await messageHandler({ type: 'createMilestone', milestoneTitle: 'Launch' });

      expect(mockWriter.createMilestone).toHaveBeenCalledWith(
        '/test/backlog',
        'Launch',
        undefined,
        mockParser
      );
      expect(mockWriter.updateTask).toHaveBeenCalledWith(
        'TASK-1',
        { milestone: 'm-2' },
        mockParser,
        expect.any(String)
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Created milestone "Launch"'
      );
    });

    it('canonicalizes milestone title updates to known milestone IDs', async () => {
      const currentTask = {
        id: 'TASK-1',
        title: 'Current Task',
        status: 'In Progress',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-1.md',
        folder: 'tasks',
      };

      (mockParser.getTask as Mock).mockResolvedValue(currentTask);
      (mockParser.getTasks as Mock).mockResolvedValue([currentTask]);
      (mockParser.getMilestones as Mock).mockResolvedValue([{ id: 'm-1', name: 'Launch' }]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      mockWriter.updateTask.mockClear();
      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];
      await messageHandler({ type: 'updateField', field: 'milestone', value: 'Launch' });

      expect(mockWriter.updateTask).toHaveBeenCalledWith(
        'TASK-1',
        { milestone: 'm-1' },
        mockParser,
        expect.any(String)
      );
    });

    it('adds blocked-by link by updating current task dependencies', async () => {
      const currentTask = {
        id: 'TASK-1',
        title: 'Current Task',
        status: 'In Progress',
        labels: [],
        assignee: [],
        dependencies: ['TASK-2'],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-1.md',
        folder: 'tasks',
      };
      const candidateTask = {
        id: 'TASK-4',
        title: 'Candidate Task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-4.md',
        folder: 'tasks',
      };

      (mockParser.getTask as Mock).mockImplementation(async (id: string) => {
        if (id === 'TASK-1') return currentTask;
        if (id === 'TASK-4') return candidateTask;
        return undefined;
      });
      (mockParser.getTasks as Mock).mockResolvedValue([currentTask, candidateTask]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      mockWriter.updateTask.mockClear();
      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];
      await messageHandler({ type: 'addBlockedByLink', taskId: 'TASK-4' });

      expect(mockWriter.updateTask).toHaveBeenCalledWith(
        'TASK-1',
        { dependencies: ['TASK-2', 'TASK-4'] },
        mockParser,
        expect.any(String)
      );
    });

    it('adds blocks link by updating target task dependencies', async () => {
      const currentTask = {
        id: 'TASK-1',
        title: 'Current Task',
        status: 'In Progress',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-1.md',
        folder: 'tasks',
      };
      const targetTask = {
        id: 'TASK-4',
        title: 'Target Task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: ['TASK-8'],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-4.md',
        folder: 'tasks',
      };

      (mockParser.getTask as Mock).mockImplementation(async (id: string) => {
        if (id === 'TASK-1') return currentTask;
        if (id === 'TASK-4') return targetTask;
        return undefined;
      });
      (mockParser.getTasks as Mock).mockResolvedValue([currentTask, targetTask]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      mockWriter.updateTask.mockClear();
      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];
      await messageHandler({ type: 'addBlocksLink', taskId: 'TASK-4' });

      expect(mockWriter.updateTask).toHaveBeenCalledWith(
        'TASK-4',
        { dependencies: ['TASK-8', 'TASK-1'] },
        mockParser
      );
    });

    it('ignores duplicate blocked-by link additions', async () => {
      const currentTask = {
        id: 'TASK-1',
        title: 'Current Task',
        status: 'In Progress',
        labels: [],
        assignee: [],
        dependencies: ['TASK-2'],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-1.md',
        folder: 'tasks',
      };
      (mockParser.getTask as Mock).mockResolvedValue(currentTask);
      (mockParser.getTasks as Mock).mockResolvedValue([currentTask]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      mockWriter.updateTask.mockClear();
      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];
      await messageHandler({ type: 'addBlockedByLink', taskId: 'TASK-2' });

      expect(mockWriter.updateTask).not.toHaveBeenCalled();
    });

    it('blocks dependency link mutations for read-only current task', async () => {
      const filePath = '/test/.backlog/branches/feature/task-1.md';
      const readOnlyTask = {
        id: 'TASK-1',
        title: 'Cross Branch Task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath,
        source: 'local-branch',
        branch: 'feature/other',
      };
      (mockParser.getTask as Mock).mockResolvedValue(readOnlyTask);
      (mockParser.getTasksWithCrossBranch as Mock).mockResolvedValue([readOnlyTask]);
      (mockParser.getTasks as Mock).mockResolvedValue([]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      mockWriter.updateTask.mockClear();
      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];
      await messageHandler({ type: 'addBlockedByLink', taskId: 'TASK-4' });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('read-only')
      );
      expect(mockWriter.updateTask).not.toHaveBeenCalled();
    });

    it('removes blocked-by link by filtering dependency from current task', async () => {
      const currentTask = {
        id: 'TASK-1',
        title: 'Current Task',
        status: 'In Progress',
        labels: [],
        assignee: [],
        dependencies: ['TASK-2', 'TASK-4'],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-1.md',
        folder: 'tasks',
      };

      (mockParser.getTask as Mock).mockResolvedValue(currentTask);
      (mockParser.getTasks as Mock).mockResolvedValue([currentTask]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      mockWriter.updateTask.mockClear();
      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];
      await messageHandler({ type: 'removeBlockedByLink', taskId: 'TASK-2' });

      expect(mockWriter.updateTask).toHaveBeenCalledWith(
        'TASK-1',
        { dependencies: ['TASK-4'] },
        mockParser,
        expect.any(String)
      );
    });

    it('removes blocks link by filtering current task from target task dependencies', async () => {
      const currentTask = {
        id: 'TASK-1',
        title: 'Current Task',
        status: 'In Progress',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-1.md',
        folder: 'tasks',
      };
      const targetTask = {
        id: 'TASK-4',
        title: 'Target Task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: ['TASK-8', 'TASK-1'],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-4.md',
        folder: 'tasks',
      };

      (mockParser.getTask as Mock).mockImplementation(async (id: string) => {
        if (id === 'TASK-1') return currentTask;
        if (id === 'TASK-4') return targetTask;
        return undefined;
      });
      (mockParser.getTasks as Mock).mockResolvedValue([currentTask, targetTask]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      mockWriter.updateTask.mockClear();
      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];
      await messageHandler({ type: 'removeBlocksLink', taskId: 'TASK-4' });

      expect(mockWriter.updateTask).toHaveBeenCalledWith(
        'TASK-4',
        { dependencies: ['TASK-8'] },
        mockParser
      );
    });

    it('ignores removeBlockedByLink when taskId not in dependencies', async () => {
      const currentTask = {
        id: 'TASK-1',
        title: 'Current Task',
        status: 'In Progress',
        labels: [],
        assignee: [],
        dependencies: ['TASK-2'],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/test/backlog/tasks/task-1.md',
        folder: 'tasks',
      };
      (mockParser.getTask as Mock).mockResolvedValue(currentTask);
      (mockParser.getTasks as Mock).mockResolvedValue([currentTask]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      mockWriter.updateTask.mockClear();
      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];
      await messageHandler({ type: 'removeBlockedByLink', taskId: 'TASK-99' });

      expect(mockWriter.updateTask).not.toHaveBeenCalled();
    });

    it('blocks removeBlockedByLink for read-only current task', async () => {
      const filePath = '/test/.backlog/branches/feature/task-1.md';
      const readOnlyTask = {
        id: 'TASK-1',
        title: 'Cross Branch Task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: ['TASK-2'],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath,
        source: 'local-branch',
        branch: 'feature/other',
      };
      (mockParser.getTask as Mock).mockResolvedValue(readOnlyTask);
      (mockParser.getTasksWithCrossBranch as Mock).mockResolvedValue([readOnlyTask]);
      (mockParser.getTasks as Mock).mockResolvedValue([]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      mockWriter.updateTask.mockClear();
      const messageHandler = (mockWebview.onDidReceiveMessage as Mock).mock.calls[0][0];
      await messageHandler({ type: 'removeBlockedByLink', taskId: 'TASK-2' });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('read-only')
      );
      expect(mockWriter.updateTask).not.toHaveBeenCalled();
    });
  });
});
