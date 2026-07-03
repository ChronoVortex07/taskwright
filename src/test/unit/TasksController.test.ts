import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { createMockExtensionContext } from '../mocks/vscode';
import { TasksController, TasksHost } from '../../providers/TasksController';
import { TaskDetailProvider } from '../../providers/TaskDetailProvider';
import { BacklogParser } from '../../core/BacklogParser';
import { ExtensionMessage, Task } from '../../core/types';
import { getClaimIdentity } from '../../providers/claimActions';
import { BacklogWriter } from '../../core/BacklogWriter';
import { TreeFieldService } from '../../core/TreeFieldService';
const currentIdentity = () => getClaimIdentity();

/**
 * Direct unit tests for the host-agnostic TasksController, driven through a mock
 * host with no VS Code WebviewView/WebviewPanel involved. This proves the
 * controller's data loading and message handling depend only on the injected
 * TasksHost interface (TASK-164.1 AC#1, AC#6).
 */
describe('TasksController', () => {
  let mockParser: BacklogParser;
  let mockContext: vscode.ExtensionContext;
  let posted: ExtensionMessage[];
  let ready: boolean;
  let host: TasksHost;

  function createHost(kind: 'sidebar' | 'editor' = 'editor'): TasksHost {
    return {
      kind,
      postMessage: (message) => {
        posted.push(message);
      },
      isReady: () => ready,
    };
  }

  function postedTypes(): string[] {
    return posted.map((m) => m.type);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    posted = [];
    ready = true;
    mockContext = createMockExtensionContext() as unknown as vscode.ExtensionContext;
    host = createHost();

    mockParser = {
      getTasks: vi.fn().mockResolvedValue([]),
      getTasksWithCrossBranch: vi.fn().mockResolvedValue([]),
      getTask: vi.fn(),
      getConfig: vi.fn().mockResolvedValue({}),
      getStatuses: vi.fn().mockResolvedValue(['To Do', 'In Progress', 'Done']),
      getMilestones: vi.fn().mockResolvedValue([]),
      getDrafts: vi.fn().mockResolvedValue([]),
      getCompletedTasks: vi.fn().mockResolvedValue([]),
      getArchivedTasks: vi.fn().mockResolvedValue([]),
      getCategories: vi.fn().mockResolvedValue([]),
      getBacklogPath: vi.fn().mockReturnValue('/fake/backlog'),
      resolveMilestone: vi.fn(),
    } as unknown as BacklogParser;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the host kind discriminator path (works with an editor host)', async () => {
    const editor = new TasksController(createHost('editor'), mockParser, mockContext);
    await editor.refresh();
    expect(postedTypes()).toContain('tasksUpdated');
  });

  it('routes all output through the injected host.postMessage', async () => {
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.refresh();
    expect(posted.length).toBeGreaterThan(0);
    expect(postedTypes()).toContain('statusesUpdated');
    expect(postedTypes()).toContain('tasksUpdated');
  });

  it('does no work and posts nothing when the host is not ready', async () => {
    ready = false;
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.refresh();
    expect(posted).toHaveLength(0);
    expect(mockParser.getTasks).not.toHaveBeenCalled();
  });

  it('posts noBacklogFolder when there is no parser', async () => {
    const controller = new TasksController(host, undefined, mockContext);
    await controller.refresh();
    expect(postedTypes()).toEqual(['noBacklogFolder']);
  });

  it('setViewMode persists to globalState and posts activeTabChanged', () => {
    const controller = new TasksController(host, mockParser, mockContext);
    controller.setViewMode('list');
    expect(mockContext.globalState.get('backlog.viewMode')).toBe('list');
    expect(posted).toContainEqual({ type: 'activeTabChanged', tab: 'list' });
    expect(posted).toContainEqual({ type: 'viewModeChanged', viewMode: 'list' });
  });

  it('setFilter and setLabelFilter post their messages', () => {
    const controller = new TasksController(host, mockParser, mockContext);
    controller.setFilter('status:To Do');
    controller.setLabelFilter('bug');
    expect(posted).toContainEqual({ type: 'setFilter', filter: 'status:To Do' });
    expect(posted).toContainEqual({ type: 'setLabelFilter', label: 'bug' });
  });

  it('setActiveEditedTaskId posts activeEditedTaskChanged', () => {
    const controller = new TasksController(host, mockParser, mockContext);
    controller.setActiveEditedTaskId('TASK-7');
    expect(posted).toContainEqual({ type: 'activeEditedTaskChanged', taskId: 'TASK-7' });
  });

  it('sidebar host: selectTask drives the Details preview via the selection handler', async () => {
    vi.spyOn(TaskDetailProvider, 'hasActivePanel').mockReturnValue(false);
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const controller = new TasksController(createHost('sidebar'), mockParser, mockContext);
    controller.setTaskSelectionHandler(onSelect);

    await controller.handleMessage({
      type: 'selectTask',
      taskId: 'TASK-42',
      filePath: '/fake/backlog/tasks/task-42.md',
      source: 'local',
      branch: 'main',
    });

    expect(onSelect).toHaveBeenCalledWith({
      taskId: 'TASK-42',
      filePath: '/fake/backlog/tasks/task-42.md',
      source: 'local',
      branch: 'main',
    });
    // Sidebar single-click must not open a detail editor in a specific column.
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      'taskwright.openTaskDetail',
      expect.anything(),
      expect.objectContaining({ viewColumn: vscode.ViewColumn.Active })
    );
  });

  it('editor host: single-click opens the detail as a tab in the board group, focus kept on board', async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const controller = new TasksController(createHost('editor'), mockParser, mockContext);
    controller.setTaskSelectionHandler(onSelect);

    await controller.handleMessage({
      type: 'selectTask',
      taskId: 'TASK-42',
      filePath: '/fake/backlog/tasks/task-42.md',
      source: 'local',
      branch: 'main',
    });

    // No sidebar preview handler from the editor host...
    expect(onSelect).not.toHaveBeenCalled();
    // ...instead the detail opens in the board's own group, focus retained on the board.
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'taskwright.openTaskDetail',
      {
        taskId: 'TASK-42',
        filePath: '/fake/backlog/tasks/task-42.md',
        source: 'local',
        branch: 'main',
      },
      { preserveFocus: true, viewColumn: vscode.ViewColumn.Active }
    );
  });

  it('editor host: double-click opens the detail in the board group and takes focus', async () => {
    const controller = new TasksController(createHost('editor'), mockParser, mockContext);

    await controller.handleMessage({
      type: 'openTask',
      taskId: 'TASK-9',
      filePath: '/fake/backlog/tasks/task-9.md',
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'taskwright.openTaskDetail',
      {
        taskId: 'TASK-9',
        filePath: '/fake/backlog/tasks/task-9.md',
        source: undefined,
        branch: undefined,
      },
      { viewColumn: vscode.ViewColumn.Active }
    );
  });

  it('sidebar host: double-click opens the detail without the beside hint', async () => {
    const controller = new TasksController(createHost('sidebar'), mockParser, mockContext);

    await controller.handleMessage({
      type: 'openTask',
      taskId: 'TASK-9',
      filePath: '/fake/backlog/tasks/task-9.md',
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'taskwright.openTaskDetail',
      {
        taskId: 'TASK-9',
        filePath: '/fake/backlog/tasks/task-9.md',
        source: undefined,
        branch: undefined,
      },
      // Sidebar passes no placement options (opens in the default column).
      undefined
    );
  });

  it('blocks status updates for read-only cross-branch tasks', async () => {
    (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'TASK-REMOTE',
      title: 'Remote Task',
      status: 'To Do',
      source: 'remote',
      branch: 'origin/main',
      labels: [],
      assignee: [],
      dependencies: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: '/fake/.backlog/branches/origin-main/remote-task.md',
    } as Task);

    const controller = new TasksController(host, mockParser, mockContext);
    await controller.handleMessage({
      type: 'updateTaskStatus',
      taskId: 'TASK-REMOTE',
      status: 'Done',
    });

    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'taskUpdateError',
        taskId: 'TASK-REMOTE',
        message: expect.stringContaining('read-only'),
      })
    );
  });

  it('loadPersistedState restores the saved view mode from globalState', async () => {
    await mockContext.globalState.update('backlog.viewMode', 'list');
    const controller = new TasksController(host, mockParser, mockContext);
    controller.loadPersistedState();
    await controller.refresh();
    expect(posted).toContainEqual({ type: 'activeTabChanged', tab: 'list' });
  });

  it('uses the cross-branch loader when check_active_branches is enabled', async () => {
    (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      check_active_branches: true,
    });
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.refresh();
    expect(mockParser.getTasksWithCrossBranch).toHaveBeenCalled();
    expect(mockParser.getTasks).not.toHaveBeenCalled();
  });

  it('enriches tasks with mergeState from the injected queue reader', async () => {
    (mockParser.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'TASK-1',
        title: 'Reviewed task',
        status: 'Pending Review',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-1.md',
      } as Task,
    ]);

    const controller = new TasksController(host, mockParser, mockContext);
    controller.setMergeQueueReader(() => ({
      version: 1,
      entries: [
        {
          taskId: 'TASK-1',
          branch: 'b',
          worktree: '.worktrees/b',
          mode: 'manual-review',
          submittedAt: '2026-07-01T00:00:00Z',
          approved: false,
          active: false,
          activeAt: null,
        },
      ],
    }));

    await controller.refresh();

    const tasksMsg = posted.find((m) => m.type === 'tasksUpdated') as {
      type: 'tasksUpdated';
      tasks: Array<Task & { mergeState?: { queued: boolean; position: number; mode: string } }>;
    };
    const task = tasksMsg.tasks.find((t) => t.id === 'TASK-1');
    expect(task?.mergeState).toMatchObject({ queued: true, position: 1, mode: 'manual-review' });

    const settingsMsg = posted.find((m) => m.type === 'settingsUpdated') as {
      type: 'settingsUpdated';
      settings: { mergeMode?: string };
    };
    expect(settingsMsg.settings.mergeMode).toBe('manual-review');
  });

  it('omits mergeState when no queue reader is injected', async () => {
    (mockParser.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'TASK-1',
        title: 'Plain task',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-1.md',
      } as Task,
    ]);

    const controller = new TasksController(host, mockParser, mockContext);
    await controller.refresh();

    const tasksMsg = posted.find((m) => m.type === 'tasksUpdated') as {
      type: 'tasksUpdated';
      tasks: Array<Task & { mergeState?: unknown }>;
    };
    const task = tasksMsg.tasks.find((t) => t.id === 'TASK-1');
    expect(task?.mergeState).toBeUndefined();
  });

  it('handles approveMerge and sendBackMerge by executing the matching commands', async () => {
    const controller = new TasksController(host, mockParser, mockContext);

    await controller.handleMessage({ type: 'approveMerge', taskId: 'TASK-5' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'taskwright.approveMerge',
      'TASK-5'
    );

    await controller.handleMessage({ type: 'sendBackMerge', taskId: 'TASK-6' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'taskwright.sendBackMerge',
      'TASK-6'
    );
  });

  describe('TasksController — P2b board-bus enrichment', () => {
    it('emits prioritiesUpdated from config priorities', async () => {
      (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        statuses: ['To Do', 'In Progress', 'Done'],
        priorities: ['P0', 'P1', 'P2'],
      });
      const controller = new TasksController(host, mockParser, mockContext);
      await controller.refresh();
      expect(posted).toContainEqual({ type: 'prioritiesUpdated', priorities: ['P0', 'P1', 'P2'] });
    });

    it('marks claimedByMe true only for tasks claimed by the current identity', async () => {
      (mockParser.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'TASK-1', title: 'Mine', status: 'In Progress', labels: [], assignee: [],
          dependencies: [], acceptanceCriteria: [], definitionOfDone: [],
          filePath: '/fake/backlog/tasks/task-1.md', claimedBy: currentIdentity(),
        } as Task,
        {
          id: 'TASK-2', title: 'Theirs', status: 'In Progress', labels: [], assignee: [],
          dependencies: [], acceptanceCriteria: [], definitionOfDone: [],
          filePath: '/fake/backlog/tasks/task-2.md', claimedBy: 'someone-else',
        } as Task,
      ]);
      const controller = new TasksController(host, mockParser, mockContext);
      await controller.refresh();
      const upd = posted.find((m) => m.type === 'tasksUpdated') as Extract<
        ExtensionMessage, { type: 'tasksUpdated' }
      >;
      const byId = new Map(upd.tasks.map((t) => [t.id, t]));
      expect((byId.get('TASK-1') as Task).claimedByMe).toBe(true);
      expect((byId.get('TASK-2') as Task).claimedByMe).toBe(false);
    });
  });

  // Q1 (adjudicated): widen the updateTask priority write path. P1 §10 made priority a
  // user-configured list; the popover/detail quick-edit must persist any configured value
  // and keep rejecting unknown strings. TDD — these fail until Step 6b lands.
  describe('TasksController — updateTask priority write path (Q1)', () => {
    it('persists any configured priority (not just high/medium/low)', async () => {
      const updateSpy = vi
        .spyOn(BacklogWriter.prototype, 'updateTask')
        .mockResolvedValue(undefined as never);
      (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        statuses: ['To Do', 'In Progress', 'Done'],
        priorities: ['P0', 'P1', 'P2'],
      });
      (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'TASK-1', title: 'T', status: 'To Do', labels: [], assignee: [],
        dependencies: [], acceptanceCriteria: [], definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-1.md',
      } as Task);
      const controller = new TasksController(host, mockParser, mockContext);
      await controller.handleMessage({
        type: 'updateTask', taskId: 'TASK-1', updates: { priority: 'P0' },
      });
      expect(updateSpy).toHaveBeenCalledWith('TASK-1', { priority: 'P0' }, mockParser);
    });

    it('rejects an unknown priority string (no write)', async () => {
      const updateSpy = vi
        .spyOn(BacklogWriter.prototype, 'updateTask')
        .mockResolvedValue(undefined as never);
      (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ priorities: ['P0', 'P1', 'P2'] });
      (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'TASK-1', title: 'T', status: 'To Do', labels: [], assignee: [],
        dependencies: [], acceptanceCriteria: [], definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-1.md',
      } as Task);
      const controller = new TasksController(host, mockParser, mockContext);
      await controller.handleMessage({
        type: 'updateTask', taskId: 'TASK-1', updates: { priority: 'nope' },
      });
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  describe('TasksController — P3a create case', () => {
    it('createTask routes through the shared writer sequence, then refreshes', async () => {
      const createSpy = vi
        .spyOn(BacklogWriter.prototype, 'createTask')
        .mockResolvedValue({ id: 'TASK-9', filePath: '/fake/backlog/tasks/task-9.md' });
      (mockParser.getBacklogPath as ReturnType<typeof vi.fn>).mockReturnValue('/fake/backlog');
      const controller = new TasksController(host, mockParser, mockContext);
      await controller.handleMessage({
        type: 'createTask',
        title: 'Brand new task',
        priority: 'high',
      });
      expect(createSpy).toHaveBeenCalledWith(
        '/fake/backlog',
        expect.objectContaining({ title: 'Brand new task', priority: 'high' }),
        mockParser
      );
      // refresh() re-emitted the board:
      expect(posted.some((m) => m.type === 'tasksUpdated')).toBe(true);
    });

    it('createTask with openAfter opens the new task detail', async () => {
      vi.spyOn(BacklogWriter.prototype, 'createTask').mockResolvedValue({
        id: 'TASK-9',
        filePath: '/fake/backlog/tasks/task-9.md',
      });
      (mockParser.getBacklogPath as ReturnType<typeof vi.fn>).mockReturnValue('/fake/backlog');
      const execSpy = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
      execSpy.mockClear();
      const controller = new TasksController(host, mockParser, mockContext);
      await controller.handleMessage({ type: 'createTask', title: 'Open me', openAfter: true });
      expect(execSpy).toHaveBeenCalledWith('taskwright.openTaskDetail', { taskId: 'TASK-9' });
    });
  });
});

describe('TasksController — tree tab', () => {
  let mockParser: BacklogParser;
  let mockContext: vscode.ExtensionContext;
  let posted: ExtensionMessage[];
  let ready: boolean;
  let host: TasksHost;

  function createHost(kind: 'sidebar' | 'editor' = 'editor'): TasksHost {
    return {
      kind,
      postMessage: (message) => {
        posted.push(message);
      },
      isReady: () => ready,
    };
  }

  function postedTypes(): string[] {
    return posted.map((m) => m.type);
  }

  function treeTasks(): Task[] {
    return [
      {
        id: 'TASK-1',
        title: 'Root',
        status: 'Done',
        category: 'Features',
        milestone: 'v1',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-1.md',
      } as Task,
      {
        id: 'TASK-2',
        title: 'Child',
        status: 'To Do',
        category: 'Features',
        milestone: 'v1',
        labels: [],
        assignee: [],
        dependencies: ['TASK-1'],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-2.md',
      } as Task,
    ];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    posted = [];
    ready = true;
    mockContext = createMockExtensionContext() as unknown as vscode.ExtensionContext;
    host = createHost();

    mockParser = {
      getTasks: vi.fn().mockResolvedValue(treeTasks()),
      getTasksWithCrossBranch: vi.fn().mockResolvedValue([]),
      getTask: vi.fn(),
      getConfig: vi.fn().mockResolvedValue({}),
      getStatuses: vi.fn().mockResolvedValue(['To Do', 'In Progress', 'Done']),
      getMilestones: vi.fn().mockResolvedValue([{ id: 'v1', name: 'v1' }]),
      getDrafts: vi.fn().mockResolvedValue([]),
      getCompletedTasks: vi.fn().mockResolvedValue([]),
      getArchivedTasks: vi.fn().mockResolvedValue([]),
      getCategories: vi.fn().mockResolvedValue(['Features']),
      getBacklogPath: vi.fn().mockReturnValue('/fake/backlog'),
      resolveMilestone: vi.fn(),
    } as unknown as BacklogParser;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits treeLayoutUpdated immediately after tasksUpdated', async () => {
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.refresh();
    const types = postedTypes();
    const tasksIdx = types.indexOf('tasksUpdated');
    const treeIdx = types.indexOf('treeLayoutUpdated');
    expect(tasksIdx).toBeGreaterThanOrEqual(0);
    expect(treeIdx).toBe(tasksIdx + 1);
    const msg = posted[treeIdx] as Extract<ExtensionMessage, { type: 'treeLayoutUpdated' }>;
    expect(msg.laneOrder).toEqual(['Features', 'Misc', 'Bugs']);
    expect(msg.bandOrder[msg.bandOrder.length - 1]).toBe('Backburner');
    expect(Array.isArray(msg.warnings)).toBe(true);
  });

  it('defaults the persisted view mode to tree when nothing is stored', async () => {
    const controller = new TasksController(host, mockParser, mockContext);
    controller.loadPersistedState();
    await controller.refresh();
    expect(posted).toContainEqual({ type: 'activeTabChanged', tab: 'tree' });
  });

  it('respects a persisted kanban choice (default only applies when unset)', async () => {
    await mockContext.globalState.update('backlog.viewMode', 'kanban');
    const controller = new TasksController(host, mockParser, mockContext);
    controller.loadPersistedState();
    await controller.refresh();
    expect(posted).toContainEqual({ type: 'activeTabChanged', tab: 'kanban' });
    expect(posted).not.toContainEqual({ type: 'activeTabChanged', tab: 'tree' });
  });

  it('setViewMode(tree) posts activeTabChanged tree and no legacy viewModeChanged', () => {
    const controller = new TasksController(host, mockParser, mockContext);
    controller.setViewMode('tree');
    expect(posted).toContainEqual({ type: 'activeTabChanged', tab: 'tree' });
    expect(posted.some((m) => m.type === 'viewModeChanged')).toBe(false);
  });

  describe('TasksController — P3b drag writes', () => {
    it('reslotTask: category via TreeFieldService.setCategory, milestone via updateTask (resolved)', async () => {
      const setCat = vi.spyOn(TreeFieldService.prototype, 'setCategory').mockResolvedValue('Features');
      const updateSpy = vi.spyOn(BacklogWriter.prototype, 'updateTask').mockResolvedValue(undefined as never);
      (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'TASK-1', title: 'T', status: 'To Do', labels: [], assignee: [], dependencies: [],
        acceptanceCriteria: [], definitionOfDone: [], filePath: '/fake/backlog/tasks/task-1.md',
      } as Task);
      (mockParser.resolveMilestone as ReturnType<typeof vi.fn>).mockResolvedValue('v1');
      const controller = new TasksController(host, mockParser, mockContext);
      await controller.handleMessage({ type: 'reslotTask', taskId: 'TASK-1', category: 'Features', milestone: 'v1' });
      expect(setCat).toHaveBeenCalledWith('TASK-1', 'Features', mockParser);
      expect(updateSpy).toHaveBeenCalledWith('TASK-1', { milestone: 'v1' }, mockParser);
    });

    it('reslotTask: Misc clears the category, Backburner clears the milestone', async () => {
      const clearCat = vi.spyOn(TreeFieldService.prototype, 'clearCategory').mockResolvedValue(undefined as never);
      const updateSpy = vi.spyOn(BacklogWriter.prototype, 'updateTask').mockResolvedValue(undefined as never);
      (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'TASK-1', title: 'T', status: 'To Do', labels: [], assignee: [], dependencies: [],
        acceptanceCriteria: [], definitionOfDone: [], filePath: '/fake/backlog/tasks/task-1.md',
      } as Task);
      const controller = new TasksController(host, mockParser, mockContext);
      await controller.handleMessage({ type: 'reslotTask', taskId: 'TASK-1', category: 'Misc', milestone: 'Backburner' });
      expect(clearCat).toHaveBeenCalledWith('TASK-1', mockParser);
      // Backburner clears milestone via an empty string (updateTask omits empty milestone on write).
      expect(updateSpy).toHaveBeenCalledWith('TASK-1', { milestone: '' }, mockParser);
    });

    it('addDependency: writes task[taskId].dependencies += dependsOn (deduped) via updateTask', async () => {
      const updateSpy = vi.spyOn(BacklogWriter.prototype, 'updateTask').mockResolvedValue(undefined as never);
      (mockParser.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'TASK-1', dependencies: [] }, { id: 'TASK-2', dependencies: [] },
      ]);
      (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'TASK-1', title: 'T', status: 'To Do', labels: [], assignee: [], dependencies: [],
        acceptanceCriteria: [], definitionOfDone: [], filePath: '/fake/backlog/tasks/task-1.md',
      } as Task);
      const controller = new TasksController(host, mockParser, mockContext);
      await controller.handleMessage({ type: 'addDependency', taskId: 'TASK-1', dependsOn: 'TASK-2' });
      expect(updateSpy).toHaveBeenCalledWith('TASK-1', { dependencies: ['TASK-2'] }, mockParser);
    });

    it('addDependency: refuses a cycle (no write)', async () => {
      const updateSpy = vi.spyOn(BacklogWriter.prototype, 'updateTask').mockResolvedValue(undefined as never);
      // TASK-2 already depends on TASK-1, so adding TASK-2 to TASK-1 closes 1→2→1.
      (mockParser.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'TASK-1', dependencies: [] }, { id: 'TASK-2', dependencies: ['TASK-1'] },
      ]);
      // getTask must return a real task so the handler reaches the cycle guard
      // (otherwise it bails at `if (!task) break;` and the test is vacuous).
      (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'TASK-1', title: 'T', status: 'To Do', labels: [], assignee: [], dependencies: [],
        acceptanceCriteria: [], definitionOfDone: [], filePath: '/fake/backlog/tasks/task-1.md',
      } as Task);
      const controller = new TasksController(host, mockParser, mockContext);
      await controller.handleMessage({ type: 'addDependency', taskId: 'TASK-1', dependsOn: 'TASK-2' });
      // Assert BOTH the user-visible refusal and the no-write, so deleting the
      // cycle guard turns this test red instead of leaving it vacuously green.
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Linking TASK-2 into TASK-1 would create a dependency cycle.'
      );
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('removeDependency: writes the pruned dependency array via updateTask', async () => {
      const updateSpy = vi.spyOn(BacklogWriter.prototype, 'updateTask').mockResolvedValue(undefined as never);
      (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'TASK-1', title: 'T', status: 'To Do', labels: [], assignee: [], dependencies: ['TASK-2', 'TASK-3'],
        acceptanceCriteria: [], definitionOfDone: [], filePath: '/fake/backlog/tasks/task-1.md',
      } as Task);
      const controller = new TasksController(host, mockParser, mockContext);
      await controller.handleMessage({ type: 'removeDependency', taskId: 'TASK-1', dependsOn: 'TASK-2' });
      expect(updateSpy).toHaveBeenCalledWith('TASK-1', { dependencies: ['TASK-3'] }, mockParser);
    });
  });
});
