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

  describe('sendTaskData isDraft', () => {
    it('should set isDraft: true when task folder is drafts', async () => {
      const filePath = '/test/backlog/drafts/draft-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'DRAFT-1',
        title: 'Draft Task',
        description: 'Description',
        status: 'Draft',
        priority: undefined,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: filePath,
        folder: 'drafts',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      await provider.openTask('DRAFT-1');

      // Wait for setTimeout in openTask
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.isDraft).toBe(true);
    });

    it('should set isDraft: false when task folder is tasks', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Regular Task',
        description: 'Description',
        status: 'To Do',
        priority: undefined,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: filePath,
        folder: 'tasks',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      await provider.openTask('TASK-1');

      // Wait for setTimeout in openTask
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.isDraft).toBe(false);
    });
  });
  describe('sendTaskData priorities', () => {
    it('sends config-driven priorities in taskData (tech-tree P1)', async () => {
      (mockParser.getConfig as Mock).mockResolvedValue({
        priorities: ['Critical', 'Normal', 'Low'],
      });
      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'T',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-1.md',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      provider.setBacklogPath('/fake/backlog');
      await provider.openTask('TASK-1');
      // openTask defers the first send by 100ms.
      await new Promise((r) => setTimeout(r, 150));

      const taskDataCall = (mockWebview.postMessage as Mock).mock.calls
        .map((c) => c[0])
        .find((m) => m?.type === 'taskData');
      expect(taskDataCall?.data.priorities).toEqual(['Critical', 'Normal', 'Low']);
    });
  });
  describe('sendTaskData subtask info', () => {
    it('sends milestone options as id/label pairs and keeps unknown task milestone as fallback option', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';
      const task = {
        id: 'TASK-1',
        title: 'Task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath,
        milestone: 'custom-milestone',
      };

      (mockParser.getTask as Mock).mockResolvedValue(task);
      (mockParser.getTasks as Mock).mockResolvedValue([task]);
      (mockParser.getMilestones as Mock).mockResolvedValue([{ id: 'm-1', name: 'Launch' }]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.milestones).toEqual([
        { id: 'm-1', label: 'Launch' },
        { id: 'custom-milestone', label: 'custom-milestone' },
      ]);
    });

    it('should include parentTask when task has parentTaskId', async () => {
      const filePath = '/test/backlog/tasks/task-2.1.md';

      (mockParser.getTask as Mock).mockImplementation(async (id: string) => {
        if (id === 'TASK-2.1') {
          return {
            id: 'TASK-2.1',
            title: 'Subtask',
            status: 'To Do',
            labels: [],
            assignee: [],
            dependencies: [],
            acceptanceCriteria: [],
            definitionOfDone: [],
            filePath,
            parentTaskId: 'TASK-2',
          };
        }
        if (id === 'TASK-2') {
          return {
            id: 'TASK-2',
            title: 'Parent Task',
            status: 'In Progress',
            labels: [],
            assignee: [],
            dependencies: [],
            acceptanceCriteria: [],
            definitionOfDone: [],
            filePath: '/test/backlog/tasks/task-2.md',
          };
        }
        return undefined;
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-2.1');

      // Wait for setTimeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.parentTask).toEqual({
        id: 'TASK-2',
        title: 'Parent Task',
      });
    });

    it('should resolve parentTask from cross-branch context for read-only subtasks', async () => {
      const childPath = '/test/.backlog/branches/feature/backlog/tasks/task-2.1.md';
      const parentPath = '/test/.backlog/branches/feature/backlog/tasks/task-2.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-2.1',
        title: 'Remote Subtask',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: childPath,
        source: 'local-branch',
        branch: 'feature/x',
        parentTaskId: 'TASK-2',
      });
      (mockParser.getTasks as Mock).mockResolvedValue([]);
      (mockParser.getTasksWithCrossBranch as Mock).mockResolvedValue([
        {
          id: 'TASK-2',
          title: 'Remote Parent',
          status: 'In Progress',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: parentPath,
          source: 'local-branch',
          branch: 'feature/x',
        },
        {
          id: 'TASK-2.1',
          title: 'Remote Subtask',
          status: 'To Do',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: childPath,
          source: 'local-branch',
          branch: 'feature/x',
          parentTaskId: 'TASK-2',
        },
      ]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask({
        taskId: 'TASK-2.1',
        filePath: childPath,
        source: 'local-branch',
        branch: 'feature/x',
      });

      await new Promise((resolve) => setTimeout(resolve, 150));
      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.parentTask).toEqual({
        id: 'TASK-2',
        title: 'Remote Parent',
      });
    });

    it('should include subtaskSummaries when task has subtask children', async () => {
      const filePath = '/test/backlog/tasks/task-3.md';

      (mockParser.getTask as Mock).mockImplementation(async (id: string) => {
        if (id === 'TASK-3') {
          return {
            id: 'TASK-3',
            title: 'Parent',
            status: 'In Progress',
            labels: [],
            assignee: [],
            dependencies: [],
            acceptanceCriteria: [],
            definitionOfDone: [],
            filePath,
          };
        }
        return undefined;
      });

      // getTasks returns parent + children
      (mockParser.getTasks as Mock).mockResolvedValue([
        {
          id: 'TASK-3',
          title: 'Parent',
          status: 'In Progress',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath,
        },
        {
          id: 'TASK-3.1',
          title: 'Child 1',
          status: 'Done',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/test/backlog/tasks/task-3.1.md',
          parentTaskId: 'TASK-3',
        },
        {
          id: 'TASK-3.2',
          title: 'Child 2',
          status: 'To Do',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/test/backlog/tasks/task-3.2.md',
          parentTaskId: 'TASK-3',
        },
      ]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-3');

      // Wait for setTimeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.subtaskSummaries).toEqual([
        { id: 'TASK-3.1', title: 'Child 1', status: 'Done' },
        { id: 'TASK-3.2', title: 'Child 2', status: 'To Do' },
      ]);
    });

    it('should not include parentTask when task has no parentTaskId', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Regular Task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath,
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');

      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.parentTask).toBeUndefined();
      expect(taskDataCall![0].data.subtaskSummaries).toBeUndefined();
    });

    it('should include missingDependencyIds and blocked state for unresolved dependency links', async () => {
      const filePath = '/test/backlog/tasks/task-10.md';
      (mockParser.getTask as Mock).mockImplementation(async (taskId: string) => {
        if (taskId === 'TASK-10') {
          return {
            id: 'TASK-10',
            title: 'Needs missing dependency',
            status: 'To Do',
            labels: [],
            assignee: [],
            dependencies: ['TASK-404'],
            acceptanceCriteria: [],
            definitionOfDone: [],
            filePath,
          };
        }
        return undefined;
      });
      (mockParser.getTasks as Mock).mockResolvedValue([
        {
          id: 'TASK-10',
          title: 'Needs missing dependency',
          status: 'To Do',
          labels: [],
          assignee: [],
          dependencies: ['TASK-404'],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath,
        },
      ]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-10');
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.isBlocked).toBe(true);
      expect(taskDataCall![0].data.missingDependencyIds).toEqual(['TASK-404']);
    });

    it('should compute blocksTaskIds from cross-branch context for read-only tasks', async () => {
      const depPath = '/test/.backlog/branches/feature/backlog/tasks/task-10.md';
      const blockerPath = '/test/.backlog/branches/feature/backlog/tasks/task-11.md';
      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-10',
        title: 'Dependency Task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: depPath,
        source: 'local-branch',
        branch: 'feature/x',
      });
      (mockParser.getTasks as Mock).mockResolvedValue([]);
      (mockParser.getBlockedByThisTask as Mock).mockResolvedValue([]);
      (mockParser.getTasksWithCrossBranch as Mock).mockResolvedValue([
        {
          id: 'TASK-10',
          title: 'Dependency Task',
          status: 'To Do',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: depPath,
          source: 'local-branch',
          branch: 'feature/x',
        },
        {
          id: 'TASK-11',
          title: 'Blocked Task',
          status: 'In Progress',
          labels: [],
          assignee: [],
          dependencies: ['TASK-10'],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: blockerPath,
          source: 'local-branch',
          branch: 'feature/x',
        },
      ]);

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask({
        taskId: 'TASK-10',
        filePath: depPath,
        source: 'local-branch',
        branch: 'feature/x',
      });
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.blocksTaskIds).toEqual(['TASK-11']);
    });
  });
  describe('sendTaskData body section HTML', () => {
    it('should include planHtml when task has a plan', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Task with plan',
        description: '',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        implementationPlan: '1. Step one\n2. Step two',
        filePath,
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.planHtml).toContain('Step one');
    });

    it('should include notesHtml when task has implementationNotes', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Task with notes',
        description: '',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        implementationNotes: 'Found that X required Y approach.',
        filePath,
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.notesHtml).toContain('Found that X required Y approach');
    });

    it('should include finalSummaryHtml when task has finalSummary', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Task with summary',
        description: '',
        status: 'Done',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        finalSummary: 'Completed with approach Z.',
        filePath,
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.finalSummaryHtml).toContain('Completed with approach Z');
    });

    it('should send empty strings for missing body sections', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Task with no body sections',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath,
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);
      await provider.openTask('TASK-1');
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.planHtml).toBe('');
      expect(taskDataCall![0].data.notesHtml).toBe('');
      expect(taskDataCall![0].data.finalSummaryHtml).toBe('');
    });
  });
  describe('sendTaskData isArchived', () => {
    it('should set isArchived: true when task folder is archive', async () => {
      const filePath = '/test/backlog/archive/tasks/task-5.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-5',
        title: 'Archived Task',
        description: 'Description',
        status: 'Done',
        priority: undefined,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: filePath,
        folder: 'archive',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      await provider.openTask('TASK-5');

      // Wait for setTimeout in openTask
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.isArchived).toBe(true);
      expect(taskDataCall![0].data.isDraft).toBe(false);
    });

    it('should set isArchived: false when task folder is tasks', async () => {
      const filePath = '/test/backlog/tasks/task-1.md';

      (mockParser.getTask as Mock).mockResolvedValue({
        id: 'TASK-1',
        title: 'Regular Task',
        description: 'Description',
        status: 'To Do',
        priority: undefined,
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: filePath,
        folder: 'tasks',
      });

      const provider = new TaskDetailProvider(extensionUri, mockParser);

      await provider.openTask('TASK-1');

      // Wait for setTimeout in openTask
      await new Promise((resolve) => setTimeout(resolve, 150));

      const postMessageCalls = (mockWebview.postMessage as Mock).mock.calls;
      const taskDataCall = postMessageCalls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'taskData'
      );
      expect(taskDataCall).toBeTruthy();
      expect(taskDataCall![0].data.isArchived).toBe(false);
    });
  });
});
