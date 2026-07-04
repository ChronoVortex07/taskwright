import * as vscode from 'vscode';
import {
  WebviewMessage,
  ExtensionMessage,
  DataSourceMode,
  Task,
  TaskSource,
  TaskIdDisplayMode,
  TasksViewSettings,
  isReadOnlyTask,
  getReadOnlyTaskContext,
} from '../core/types';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser, computeSubtasks } from '../core/BacklogParser';
import { BacklogWriter } from '../core/BacklogWriter';
import { TreeFieldService } from '../core/TreeFieldService';
import { createTaskWithTreeFields } from '../core/createTaskCore';
import { promoteDrafts } from '../core/promoteDrafts';
import { wouldCreateCycle } from '../core/treeGate';
import { TaskDetailProvider } from './TaskDetailProvider';
import { StatusCallbackRunner } from '../core/StatusCallbackRunner';
import { detectIntegration } from '../core/AgentIntegrationDetector';
import { BacklogCli } from '../core/BacklogCli';
import { readActiveTask, writeActiveTask, clearActiveTask } from '../core/activeTask';
import { isClaimStale } from '../core/claims';
import { getClaimStalenessMs, getClaimIdentity } from './claimActions';
import { getTaskwrightConfig } from '../config';
import { mergeStateForTask, type MergeTaskState } from '../core/mergeBoard';
import type { MergeQueue, MergeMode } from '../core/mergeQueue';
import { loadTreeBoardFromParser } from '../core/treeDerived';
import { loadPlanProgress } from '../core/loadPlanProgress';
import { dispatchBranchName } from '../core/dispatchPrompt';
import { worktreePathFor } from '../core/WorktreeService';
import { resolvePriorities } from '../core/priorityOrder';
import { laneOf } from '../core/treeLayout';
import { readReleaseChecklist, toggleReleaseChecklist } from '../core/milestoneReleaseChecklist';

export type TasksViewMode =
  | 'tree'
  | 'kanban'
  | 'list'
  | 'drafts'
  | 'archived'
  | 'dashboard'
  | 'docs'
  | 'decisions';

export interface TaskSelectionRef {
  taskId: string;
  filePath?: string;
  source?: TaskSource;
  branch?: string;
}

/**
 * The surface that hosts a Tasks board webview.
 *
 * `TasksController` holds all board state and logic but never touches a
 * `WebviewView` or `WebviewPanel` directly — it communicates only through this
 * interface, so the same controller can drive the sidebar view
 * (`TasksViewProvider`, kind `'sidebar'`) or an editor tab
 * (`TasksPanelProvider`, kind `'editor'`).
 */
export interface TasksHost {
  /** Discriminator so the controller can vary select/open policy per host. */
  readonly kind: 'sidebar' | 'editor';
  /** Post a message to the webview. Safe to call when the host is not ready (no-op). */
  postMessage(message: ExtensionMessage): void;
  /** Whether the webview currently exists and can receive messages / be refreshed. */
  isReady(): boolean;
}

/**
 * Host-agnostic controller for the unified Tasks board (Kanban + List + the
 * dashboard/docs/decisions/drafts/archived tabs).
 *
 * Responsible for loading tasks/statuses/milestones, handling webview messages
 * (status changes, reordering, archive/complete/promote, view-mode switching,
 * collapse state, integration banner, etc.), and persisting view preferences.
 * Rendering host setup (HTML, message wiring, lifecycle) lives in the adapters.
 */
export class TasksController {
  private viewMode: TasksViewMode = 'kanban';
  private groupingMode: 'status' | 'milestone' | 'label' = 'status';
  private dataSourceMode: DataSourceMode = 'local-only';
  private dataSourceReason?: string;
  private collapsedColumns: Set<string> = new Set();
  private collapsedMilestones: Set<string> = new Set();
  private activeEditedTaskId: string | null = null;
  private readonly writer = new BacklogWriter();
  private readonly treeFieldService = new TreeFieldService();
  private workspaceRoot: string | undefined;
  private onSelectTask?: (taskRef: TaskSelectionRef) => void | Promise<void>;
  private mergeQueueReader?: () => MergeQueue | undefined;

  constructor(
    private readonly host: TasksHost,
    private parser: BacklogParser | undefined,
    private readonly context?: vscode.ExtensionContext
  ) {}

  private getTasksViewSettings(): TasksViewSettings {
    const configuredMode = getTaskwrightConfig<TaskIdDisplayMode>('taskIdDisplay', 'full');

    const taskIdDisplay: TaskIdDisplayMode =
      configuredMode === 'number' || configuredMode === 'hidden' ? configuredMode : 'full';

    const mergeMode = getTaskwrightConfig<MergeMode>('mergeMode', 'manual-review');

    return { taskIdDisplay, mergeMode };
  }

  setParser(parser: BacklogParser): void {
    this.parser = parser;
  }

  /** Inject a reader for the shared merge queue (best-effort board enrichment). */
  setMergeQueueReader(reader: () => MergeQueue | undefined): void {
    this.mergeQueueReader = reader;
  }

  setTaskSelectionHandler(handler: (taskRef: TaskSelectionRef) => void | Promise<void>): void {
    this.onSelectTask = handler;
  }

  /**
   * Update the active edited task ID and notify the webview for highlighting
   */
  setActiveEditedTaskId(taskId: string | null): void {
    this.activeEditedTaskId = taskId;
    this.host.postMessage({ type: 'activeEditedTaskChanged', taskId });
  }

  /**
   * Set the workspace root path for integration detection
   */
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  /**
   * Load saved view mode, milestone grouping, and collapsed columns from globalState.
   * Called by the host when its webview is (re)created.
   */
  loadPersistedState(): void {
    if (!this.context) return;
    // Derive from saved state: check legacy showingDrafts flag for migration
    const legacyDrafts = this.context.globalState.get<boolean>('backlog.showingDrafts', false);
    this.viewMode = legacyDrafts
      ? 'drafts'
      : this.context.globalState.get<TasksViewMode>('backlog.viewMode', 'tree');
    this.groupingMode = this.context.globalState.get('backlog.groupingMode', 'status');
    // Migrate legacy milestoneGrouping boolean if present
    if (this.groupingMode === 'status') {
      const legacyMilestoneGrouping = this.context.globalState.get<boolean>(
        'backlog.milestoneGrouping',
        false
      );
      if (legacyMilestoneGrouping) {
        this.groupingMode = 'milestone';
      }
    }
    const savedCollapsed = this.context.globalState.get<string[]>('backlog.collapsedColumns', []);
    this.collapsedColumns = new Set(savedCollapsed);
    const savedCollapsedMilestones = this.context.globalState.get<string[]>(
      'backlog.collapsedMilestones',
      []
    );
    this.collapsedMilestones = new Set(savedCollapsedMilestones);
  }

  /**
   * Check agent integration status and send banner state to webview.
   * Respects dismissal persisted in globalState.
   */
  async checkAndSendIntegrationState(): Promise<void> {
    if (!this.host.isReady() || !this.workspaceRoot) return;

    // Check if banner was dismissed for this workspace
    const dismissKey = `backlog.integrationBannerDismissed.${this.workspaceRoot}`;
    if (this.context?.globalState.get<boolean>(dismissKey, false)) {
      this.host.postMessage({ type: 'integrationBannerState', show: false, cliAvailable: false });
      return;
    }

    try {
      const status = await detectIntegration(this.workspaceRoot);
      if (status.hasAnyIntegration) {
        this.host.postMessage({ type: 'integrationBannerState', show: false, cliAvailable: false });
        return;
      }

      const cliResult = await BacklogCli.isAvailable();
      this.host.postMessage({
        type: 'integrationBannerState',
        show: true,
        cliAvailable: cliResult.available,
      });
    } catch (error) {
      console.error('[Taskwright] Error checking integration status:', error);
      this.host.postMessage({ type: 'integrationBannerState', show: false, cliAvailable: false });
    }
  }

  /**
   * Refresh the board with current data.
   * Uses cross-branch loading when configured.
   */
  async refresh(): Promise<void> {
    if (!this.host.isReady()) return;

    if (!this.parser) {
      this.host.postMessage({ type: 'noBacklogFolder' });
      return;
    }

    try {
      // Determine which tasks to load based on mode
      if (this.viewMode === 'dashboard') {
        await this.refreshDashboard();
        return;
      }

      if (this.viewMode === 'docs') {
        await this.refreshDocuments();
        return;
      }

      if (this.viewMode === 'decisions') {
        await this.refreshDecisions();
        return;
      }

      // Read config for project name and cross-branch mode
      const config = await this.parser.getConfig();
      this.host.postMessage({
        type: 'configUpdated',
        config: { projectName: config.project_name },
      });
      this.host.postMessage({ type: 'settingsUpdated', settings: this.getTasksViewSettings() });

      let taskLoader: Promise<Task[]>;
      if (this.viewMode === 'archived') {
        taskLoader = this.parser.getArchivedTasks();
      } else if (this.viewMode === 'drafts') {
        taskLoader = this.parser.getDrafts();
      } else if (this.dataSourceMode === 'cross-branch') {
        taskLoader = this.parser.getTasksWithCrossBranch();
      } else {
        taskLoader = this.parser.getTasks();
      }

      const [tasks, statuses, milestones, draftCountFromFolder, completedTasks, archivedTasks] =
        await Promise.all([
          taskLoader,
          this.parser.getStatuses(),
          this.parser.getMilestones(),
          this.viewMode !== 'drafts'
            ? this.parser.getDrafts().then((d) => d.length)
            : Promise.resolve(0),
          this.parser.getCompletedTasks(),
          this.parser.getArchivedTasks(),
        ]);

      // GAP-1(b): the tree canvas must show draft proposals as nodes (they gate deps
      // and carry their own lane/band). Union drafts into the payload for the TREE tab
      // ONLY — kanban/list/drafts/archived tabs are unchanged, and cross-branch mode
      // skips tree derivation (treeBoard stays undefined) so there is nothing to render.
      if (this.viewMode === 'tree' && this.dataSourceMode !== 'cross-branch') {
        const treeDrafts = await this.parser.getDrafts();
        tasks.push(...treeDrafts);
      }

      // Compute subtask relationships from parentTaskId fields
      computeSubtasks(tasks);

      // The last configured status is treated as the "done" status
      const doneStatus = statuses.length > 0 ? statuses[statuses.length - 1] : 'Done';
      const completedTaskIds = new Set(completedTasks.map((task) => task.id));
      const archivedTaskIds = new Set(archivedTasks.map((task) => task.id));

      // Tech-tree P1 derived state (locked/blockedBy/bugs/activeBugIds/layout).
      // Best-effort: a failure must not break loading the board. Skipped in
      // cross-branch mode, where the displayed tasks come from the cross-branch
      // loader — deriving tree state from the local getTasks universe would not
      // match the board (the tech-tree is a local-board feature).
      let treeBoard: Awaited<ReturnType<typeof loadTreeBoardFromParser>> | undefined;
      if (this.dataSourceMode !== 'cross-branch') {
        try {
          treeBoard = await loadTreeBoardFromParser(this.parser);
        } catch {
          treeBoard = undefined;
        }
      }

      // Build reverse dependency map and task-by-id lookup once — O(n)
      const taskById = new Map<string, Task>();
      const reverseDeps = new Map<string, string[]>();
      for (const task of tasks) {
        taskById.set(task.id, task);
        for (const depId of task.dependencies) {
          let blocked = reverseDeps.get(depId);
          if (!blocked) {
            blocked = [];
            reverseDeps.set(depId, blocked);
          }
          blocked.push(task.id);
        }
      }

      // Active-task + claim-staleness markers for board indicators. Both are
      // auxiliary; a lookup failure must not break loading the board.
      let activeTaskId: string | undefined;
      try {
        activeTaskId = readActiveTask(path.dirname(this.parser.getBacklogPath()))?.taskId;
      } catch {
        activeTaskId = undefined;
      }
      const stalenessMs = getClaimStalenessMs();
      const claimIdentity = getClaimIdentity();
      // Repo root for plan-progress lookups. Best-effort: mirror the guarded
      // active-task read above — a missing/failing getBacklogPath must not break
      // loading the board (plan-progress enrichment is simply skipped).
      let repoRoot = '';
      try {
        repoRoot = path.dirname(this.parser.getBacklogPath());
      } catch {
        repoRoot = '';
      }

      // Merge-queue enrichment for the board's review badge. Best-effort: a
      // reader failure (e.g. corrupt/missing shared queue file) must not break
      // loading the board.
      let mergeQueue: MergeQueue | undefined;
      try {
        mergeQueue = this.mergeQueueReader?.();
      } catch {
        mergeQueue = undefined;
      }

      // Cancel-dispatch affordance (GAP-7): a dispatched task's worktree dir may exist on
      // disk before the agent writes a claim (dispatch seeds active-task + handoff, not a
      // claim). Flag it so the popover offers Cancel-dispatch. Tree tab only (the sole
      // consumer); best-effort (a stat failure must not break loading the board).
      const dispatchedWorktreeFor = (task: Task): boolean => {
        if (this.viewMode !== 'tree' || !repoRoot) return false;
        try {
          return fs.existsSync(worktreePathFor(repoRoot, dispatchBranchName(task)));
        } catch {
          return false;
        }
      };

      const tasksWithBlocks = tasks.map((task) => {
        const enhanced: Task & {
          blocksTaskIds?: string[];
          subtaskProgress?: { total: number; done: number };
          blockingDependencyIds?: string[];
          isActiveTask?: boolean;
          claimStale?: boolean;
          claimedByMe?: boolean;
          planProgress?: { done: number; total: number };
          mergeState?: MergeTaskState;
        } = {
          ...task,
          blocksTaskIds: reverseDeps.get(task.id) || [],
          isActiveTask: !!activeTaskId && task.id === activeTaskId,
          claimStale: !!task.claimedBy && isClaimStale(task.claimedAt, stalenessMs),
          claimedByMe: !!task.claimedBy && task.claimedBy === claimIdentity,
          mergeState: mergeQueue ? mergeStateForTask(mergeQueue, task.id) : undefined,
          dispatchedWorktree: dispatchedWorktreeFor(task),
        };
        // Plan-progress for the tree node bar + popover. Synchronous, never throws
        // (missing plan file → exists:false, zeros). Only set when a plan is linked.
        if (task.plan) {
          try {
            const loaded = loadPlanProgress(repoRoot, task.plan);
            if (loaded.progress.total > 0) {
              enhanced.planProgress = { done: loaded.progress.done, total: loaded.progress.total };
            }
          } catch {
            /* best-effort */
          }
        }
        const derived = treeBoard?.states.get(task.id.trim().toUpperCase());
        if (derived) {
          enhanced.locked = derived.locked;
          enhanced.blockedBy = derived.blockedBy;
          enhanced.bugs = derived.bugs;
          enhanced.activeBugIds = derived.activeBugIds;
          enhanced.layout = derived.layout;
        }
        const blockingDependencyIds = task.dependencies.filter((depId) => {
          if (completedTaskIds.has(depId) || archivedTaskIds.has(depId)) return false;
          const depTask = taskById.get(depId);
          if (!depTask) return true;
          return depTask.status !== doneStatus;
        });
        if (blockingDependencyIds.length > 0) {
          enhanced.blockingDependencyIds = blockingDependencyIds;
        }
        if (task.subtasks && task.subtasks.length > 0) {
          const total = task.subtasks.length;
          const done = task.subtasks.filter((childId) => {
            const child = taskById.get(childId);
            return child?.status === doneStatus;
          }).length;
          enhanced.subtaskProgress = { total, done };
        }
        return enhanced;
      });

      // Send initial state along with data
      this.host.postMessage({ type: 'activeTabChanged', tab: this.viewMode });
      // Backward compatibility: also send legacy messages
      this.host.postMessage({
        type: 'draftsModeChanged',
        enabled: this.viewMode === 'drafts',
      });
      if (this.viewMode !== 'tree') {
        this.host.postMessage({
          type: 'viewModeChanged',
          viewMode:
            this.viewMode === 'drafts' || this.viewMode === 'archived' ? 'list' : this.viewMode,
        });
      }
      this.host.postMessage({
        type: 'columnCollapseChanged',
        collapsedColumns: Array.from(this.collapsedColumns),
      });
      this.host.postMessage({
        type: 'milestoneCollapseChanged',
        collapsedMilestones: Array.from(this.collapsedMilestones),
      });
      this.host.postMessage({ type: 'groupingModeChanged', mode: this.groupingMode });
      this.host.postMessage({ type: 'statusesUpdated', statuses });
      this.host.postMessage({ type: 'prioritiesUpdated', priorities: resolvePriorities(config) });
      this.host.postMessage({ type: 'milestonesUpdated', milestones });
      this.host.postMessage({ type: 'tasksUpdated', tasks: tasksWithBlocks });
      this.host.postMessage({
        type: 'treeLayoutUpdated',
        laneOrder: treeBoard?.laneOrder ?? [],
        bandOrder: treeBoard?.bandOrder ?? [],
        warnings: treeBoard?.warnings ?? [],
      });

      // Send draft count for tab badge
      const draftCount = this.viewMode === 'drafts' ? tasks.length : draftCountFromFolder;
      this.host.postMessage({ type: 'draftCountUpdated', count: draftCount });
    } catch (error) {
      console.error('[Taskwright] Error refreshing Tasks view:', error);
      this.host.postMessage({ type: 'error', message: 'Failed to load tasks' });
    }
  }

  private async sendMilestoneData(milestone: string): Promise<void> {
    if (!this.parser) return;
    try {
      const [tasks, statuses] = await Promise.all([
        this.parser.getTasks(),
        this.parser.getStatuses(),
      ]);
      const doneStatus = statuses.length > 0 ? statuses[statuses.length - 1] : 'Done';
      const inMilestone = tasks.filter((t) => (t.milestone ?? 'Backburner') === milestone);
      const laneMap = new Map<string, { total: number; done: number }>();
      let total = 0;
      let done = 0;
      for (const t of inMilestone) {
        total++;
        const isDone = t.status === doneStatus;
        if (isDone) done++;
        const lane = laneOf(t);
        const l = laneMap.get(lane) ?? { total: 0, done: 0 };
        l.total++;
        if (isDone) l.done++;
        laneMap.set(lane, l);
      }
      const checklist = readReleaseChecklist(this.parser.getBacklogPath(), milestone);
      this.host.postMessage({
        type: 'milestoneData',
        milestone,
        total,
        done,
        lanes: Array.from(laneMap.entries()).map(([name, v]) => ({ name, ...v })),
        checklist,
      });
    } catch (error) {
      console.error('[Taskwright] milestone data failed:', error);
    }
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'refresh':
        await this.refresh();
        break;

      case 'openTask': {
        const ref = {
          taskId: message.taskId,
          filePath: message.filePath,
          source: message.source,
          branch: message.branch,
        };
        // From the editor-tab board, open the detail as a tab in the board's own
        // editor group (and focus it); the sidebar opens it in the default column.
        const options =
          this.host.kind === 'editor' ? { viewColumn: vscode.ViewColumn.Active } : undefined;
        vscode.commands.executeCommand('taskwright.openTaskDetail', ref, options);
        break;
      }

      case 'selectTask': {
        const taskRef = {
          taskId: message.taskId,
          filePath: message.filePath,
          source: message.source,
          branch: message.branch,
        };
        // From the editor-tab board, a single-click opens/updates the detail as a
        // tab in the board's own editor group (reusing one detail tab), keeping
        // focus on the board so quick card-to-card browsing stays fluid.
        if (this.host.kind === 'editor') {
          vscode.commands.executeCommand('taskwright.openTaskDetail', taskRef, {
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.Active,
          });
          break;
        }
        // Sidebar: drive the Details preview pane...
        await this.onSelectTask?.(taskRef);
        // ...and also update the full edit view when a detail panel is already active.
        if (TaskDetailProvider.hasActivePanel()) {
          vscode.commands.executeCommand('taskwright.openTaskDetail', taskRef, {
            preserveFocus: true,
          });
        }
        break;
      }

      case 'focusTaskPreview': {
        await vscode.commands.executeCommand('taskwright.taskPreview.focus');
        break;
      }

      case 'updateTaskStatus': {
        if (!this.parser) break;
        const taskId = message.taskId;
        // Get original status before update for rollback
        const task = await this.parser.getTask(taskId);
        if (task && isReadOnlyTask(task)) {
          this.host.postMessage({
            type: 'taskUpdateError',
            taskId,
            originalStatus: task.status,
            message: `Cannot update status: ${task.id} is read-only from ${getReadOnlyTaskContext(task)}.`,
          });
          break;
        }
        const originalStatus = task?.status || 'To Do';

        try {
          // Update status and optionally ordinal (for cross-column drops with position)
          const updates: Partial<Task> = { status: message.status };
          if (message.ordinal !== undefined) {
            updates.ordinal = message.ordinal;
          }
          await this.writer.updateTask(taskId, updates, this.parser);

          // Run status change callback
          if (task && this.parser) {
            const config = await this.parser.getConfig();
            const backlogPath = this.parser.getBacklogPath();
            const taskContent = task.filePath ? fs.readFileSync(task.filePath, 'utf-8') : '';
            const taskFm = taskContent.match(/onStatusChange:\s*(.+)/);
            const taskCallback = taskFm?.[1]?.trim().replace(/^['"]|['"]$/g, '');
            await StatusCallbackRunner.run(backlogPath, taskCallback, config.on_status_change, {
              taskId,
              oldStatus: originalStatus,
              newStatus: message.status,
              taskTitle: task.title,
            });
          }

          // Also update any additional cards that needed ordinals assigned
          if (message.additionalOrdinalUpdates && message.additionalOrdinalUpdates.length > 0) {
            for (const update of message.additionalOrdinalUpdates) {
              await this.writer.updateTask(update.taskId, { ordinal: update.ordinal }, this.parser);
            }
          }

          // Send success - no need to refresh since we did optimistic update
          this.host.postMessage({ type: 'taskUpdateSuccess', taskId });
        } catch (error) {
          console.error('Error updating task status:', error);
          this.host.postMessage({
            type: 'taskUpdateError',
            taskId,
            originalStatus,
            message: 'Failed to update task status',
          });
        }
        break;
      }

      case 'updateTask': {
        if (!this.parser) break;
        const taskId = message.taskId;
        const task = await this.parser.getTask(taskId);
        if (!task) {
          this.host.postMessage({
            type: 'taskUpdateError',
            taskId,
            originalStatus: 'To Do',
            message: `Task not found: ${taskId}`,
          });
          break;
        }
        if (isReadOnlyTask(task)) {
          this.host.postMessage({
            type: 'taskUpdateError',
            taskId,
            originalStatus: task.status,
            message: `Cannot update task: ${task.id} is read-only from ${getReadOnlyTaskContext(task)}.`,
          });
          break;
        }

        const updates: Partial<Task> = {};
        if (typeof message.updates.status === 'string') {
          updates.status = message.updates.status;
        }
        // Priority: accept any configured priority (P1 §10 made priority a user-defined
        // list); `undefined` clears it; unknown strings are rejected (no write).
        const configuredPriorities = resolvePriorities(await this.parser.getConfig());
        if (
          message.updates.priority === undefined ||
          configuredPriorities.some(
            (p) => p.toLowerCase() === String(message.updates.priority).toLowerCase()
          )
        ) {
          updates.priority = message.updates.priority;
        }

        if (Object.keys(updates).length === 0) break;

        try {
          await this.writer.updateTask(taskId, updates, this.parser);
          this.host.postMessage({ type: 'taskUpdateSuccess', taskId });
        } catch (error) {
          console.error('Error updating task:', error);
          this.host.postMessage({
            type: 'taskUpdateError',
            taskId,
            originalStatus: task.status,
            message: 'Failed to update task',
          });
        }
        break;
      }

      case 'reorderTask': {
        if (!this.parser) break;
        const taskId = message.taskId;
        const task = await this.parser.getTask(taskId);
        if (task && isReadOnlyTask(task)) {
          this.host.postMessage({
            type: 'taskUpdateError',
            taskId,
            originalStatus: task.status,
            message: `Cannot reorder task: ${task.id} is read-only from ${getReadOnlyTaskContext(task)}.`,
          });
          break;
        }
        try {
          await this.writer.updateTask(taskId, { ordinal: message.ordinal }, this.parser);
          this.host.postMessage({ type: 'taskUpdateSuccess', taskId });
        } catch (error) {
          console.error('Error reordering task:', error);
          // For reorder errors, just remove saving state - no need to restore position
          // since the UI already shows the new position optimistically
          this.host.postMessage({ type: 'taskUpdateSuccess', taskId });
        }
        break;
      }

      case 'reorderTasks': {
        if (!this.parser) break;
        const readonlyTasks: Task[] = [];
        for (const update of message.updates) {
          const task = await this.parser.getTask(update.taskId);
          if (task && isReadOnlyTask(task)) {
            readonlyTasks.push(task);
          }
        }
        if (readonlyTasks.length > 0) {
          for (const task of readonlyTasks) {
            this.host.postMessage({
              type: 'taskUpdateError',
              taskId: task.id,
              originalStatus: task.status,
              message: `Cannot reorder task: ${task.id} is read-only from ${getReadOnlyTaskContext(task)}.`,
            });
          }
          for (const update of message.updates) {
            if (!readonlyTasks.some((t) => t.id === update.taskId)) {
              this.host.postMessage({ type: 'taskUpdateSuccess', taskId: update.taskId });
            }
          }
          break;
        }
        try {
          // Update all tasks with new ordinals
          for (const update of message.updates) {
            await this.writer.updateTask(update.taskId, { ordinal: update.ordinal }, this.parser);
          }
          // Send success for each task
          for (const update of message.updates) {
            this.host.postMessage({ type: 'taskUpdateSuccess', taskId: update.taskId });
          }
        } catch (error) {
          console.error('Error reordering tasks:', error);
          // For reorder errors, just remove saving state
          for (const update of message.updates) {
            this.host.postMessage({ type: 'taskUpdateSuccess', taskId: update.taskId });
          }
        }
        break;
      }

      case 'reslotTask': {
        if (!this.parser) break;
        const task = await this.parser.getTask(message.taskId);
        if (!task) break;
        if (isReadOnlyTask(task)) {
          vscode.window.showErrorMessage(
            `Cannot move task: ${task.id} is read-only from ${getReadOnlyTaskContext(task)}.`
          );
          break;
        }
        try {
          // Category (lane) via the surgical Taskwright-only writer. Misc = no category.
          if (message.category !== undefined) {
            if (message.category === 'Misc' || message.category.trim() === '') {
              await this.treeFieldService.clearCategory(message.taskId, this.parser);
            } else {
              await this.treeFieldService.setCategory(
                message.taskId,
                message.category,
                this.parser
              );
            }
          }
          // Milestone (band) via BacklogWriter. Backburner = no milestone (empty string,
          // which updateTask omits on write); otherwise resolve to the canonical id.
          if (message.milestone !== undefined) {
            if (message.milestone === 'Backburner' || message.milestone.trim() === '') {
              await this.writer.updateTask(message.taskId, { milestone: '' }, this.parser);
            } else {
              const resolved =
                (await this.parser.resolveMilestone(message.milestone)) ?? message.milestone;
              await this.writer.updateTask(message.taskId, { milestone: resolved }, this.parser);
            }
          }
          await this.refresh();
        } catch (error) {
          console.error('[Taskwright] reslotTask failed:', error);
          vscode.window.showErrorMessage(
            `Failed to move task: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
      }

      case 'addDependency': {
        if (!this.parser) break;
        const task = await this.parser.getTask(message.taskId);
        if (!task) break;
        if (isReadOnlyTask(task)) break;
        try {
          // Re-validate the cycle guard extension-side (defense in depth; same predicate
          // MCP edit_task uses). wouldCreateCycle(all, taskId, dependsOn) matches the
          // addDependency direction: task[taskId].dependencies += dependsOn.
          const all = await this.parser.getTasks();
          if (wouldCreateCycle(all, message.taskId, message.dependsOn)) {
            vscode.window.showWarningMessage(
              `Linking ${message.dependsOn} into ${message.taskId} would create a dependency cycle.`
            );
            break;
          }
          const key = message.dependsOn.trim().toUpperCase();
          if (task.dependencies.some((d) => d.trim().toUpperCase() === key)) break; // dupe
          const next = [...task.dependencies, message.dependsOn];
          await this.writer.updateTask(message.taskId, { dependencies: next }, this.parser);
          await this.refresh();
        } catch (error) {
          console.error('[Taskwright] addDependency failed:', error);
        }
        break;
      }

      case 'removeDependency': {
        if (!this.parser) break;
        const task = await this.parser.getTask(message.taskId);
        if (!task) break;
        if (isReadOnlyTask(task)) break;
        try {
          const key = message.dependsOn.trim().toUpperCase();
          const next = task.dependencies.filter((d) => d.trim().toUpperCase() !== key);
          if (next.length === task.dependencies.length) break; // nothing removed
          await this.writer.updateTask(message.taskId, { dependencies: next }, this.parser);
          await this.refresh();
        } catch (error) {
          console.error('[Taskwright] removeDependency failed:', error);
        }
        break;
      }

      case 'archiveTask': {
        if (!this.parser || !message.taskId) break;
        const task = await this.parser.getTask(message.taskId);
        if (task && isReadOnlyTask(task)) {
          vscode.window.showErrorMessage(
            `Cannot archive task: ${task.id} is read-only from ${getReadOnlyTaskContext(task)}.`
          );
          break;
        }
        const confirmation = await vscode.window.showWarningMessage(
          `Archive task "${task?.title}"?`,
          { modal: true },
          'Archive'
        );

        if (confirmation === 'Archive') {
          try {
            await this.writer.archiveTask(message.taskId, this.parser);
            await this.refresh();
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to archive: ${error}`);
          }
        }
        break;
      }

      case 'completeTask': {
        if (!this.parser || !message.taskId) break;
        const completeTarget = await this.parser.getTask(message.taskId);
        if (completeTarget && isReadOnlyTask(completeTarget)) {
          vscode.window.showErrorMessage(
            `Cannot complete task: ${completeTarget.id} is read-only from ${getReadOnlyTaskContext(completeTarget)}.`
          );
          break;
        }
        const completeConfirmation = await vscode.window.showWarningMessage(
          `Move task "${completeTarget?.title}" to completed?`,
          { modal: true },
          'Complete'
        );

        if (completeConfirmation === 'Complete') {
          try {
            await this.writer.completeTask(message.taskId, this.parser);
            await this.refresh();
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to complete: ${error}`);
          }
        }
        break;
      }

      case 'promoteDraft': {
        if (!this.parser || !message.taskId) break;
        const draft = await this.parser.getTask(message.taskId);
        if (draft && isReadOnlyTask(draft)) {
          vscode.window.showErrorMessage(
            `Cannot promote draft: ${draft.id} is read-only from ${getReadOnlyTaskContext(draft)}.`
          );
          break;
        }
        try {
          await promoteDrafts(
            { parser: this.parser, writer: this.writer, treeFieldService: this.treeFieldService },
            [message.taskId]
          );
          await this.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to promote draft: ${error}`);
        }
        break;
      }

      case 'promoteDrafts': {
        if (!this.parser) break;
        const ids = message.taskIds ?? [];
        if (ids.length === 0) break;
        try {
          await promoteDrafts(
            { parser: this.parser, writer: this.writer, treeFieldService: this.treeFieldService },
            ids
          );
          await this.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to promote drafts: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
      }

      case 'restoreTask': {
        if (!this.parser || !message.taskId) break;
        const task = await this.parser.getTask(message.taskId);
        if (task && isReadOnlyTask(task)) {
          vscode.window.showErrorMessage(
            `Cannot restore task: ${task.id} is read-only from ${getReadOnlyTaskContext(task)}.`
          );
          break;
        }
        try {
          await this.writer.restoreArchivedTask(message.taskId, this.parser);
          await this.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to restore task: ${error}`);
        }
        break;
      }

      case 'deleteTask': {
        if (!this.parser || !message.taskId) break;
        const taskToDelete = await this.parser.getTask(message.taskId);
        if (taskToDelete && isReadOnlyTask(taskToDelete)) {
          vscode.window.showErrorMessage(
            `Cannot delete task: ${taskToDelete.id} is read-only from ${getReadOnlyTaskContext(taskToDelete)}.`
          );
          break;
        }
        const deleteConfirmation = await vscode.window.showWarningMessage(
          `Permanently delete task "${taskToDelete?.title}"? This cannot be undone.`,
          { modal: true },
          'Delete'
        );

        if (deleteConfirmation === 'Delete') {
          try {
            await this.writer.deleteTask(message.taskId, this.parser);
            await this.refresh();
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete task: ${error}`);
          }
        }
        break;
      }

      case 'requestCompletedTasks': {
        if (!this.parser) break;
        try {
          const completedTasks = await this.parser.getCompletedTasks();
          this.host.postMessage({ type: 'completedTasksUpdated', tasks: completedTasks });
        } catch (error) {
          console.error('[Taskwright] Error loading completed tasks:', error);
          this.host.postMessage({ type: 'error', message: 'Failed to load completed tasks' });
        }
        break;
      }

      case 'setViewMode': {
        this.setViewMode(message.mode);
        break;
      }

      case 'openDocument': {
        vscode.commands.executeCommand('taskwright.openDocumentDetail', message.documentId);
        break;
      }

      case 'openDecision': {
        vscode.commands.executeCommand('taskwright.openDecisionDetail', message.decisionId);
        break;
      }

      case 'filterByStatus': {
        vscode.commands.executeCommand('taskwright.filterByStatus', message.status);
        break;
      }

      case 'approveMerge': {
        vscode.commands.executeCommand('taskwright.approveMerge', message.taskId);
        break;
      }

      case 'sendBackMerge': {
        vscode.commands.executeCommand('taskwright.sendBackMerge', message.taskId);
        break;
      }

      // Q6 (adjudicated, accepted for v1): a full refresh() on every open/close keeps
      // the isActiveTask board indicator correct and matches the existing setActiveTask
      // flow; on rapid node-clicking this re-emits the whole board. Accepted debt — a
      // targeted taskUpdated-style patch is a later optimization if it reads janky.
      case 'popoverActiveChanged': {
        if (!this.parser) break;
        try {
          const root = path.dirname(this.parser.getBacklogPath());
          if (message.taskId) {
            writeActiveTask(root, message.taskId);
          } else {
            clearActiveTask(root);
          }
          await this.refresh();
        } catch (error) {
          console.error('[Taskwright] popoverActiveChanged failed:', error);
        }
        break;
      }

      case 'minimapViewport': {
        vscode.commands.executeCommand(
          'taskwright.navigatorMinimap',
          message.x,
          message.y,
          message.w,
          message.h
        );
        break;
      }

      case 'claimTask': {
        vscode.commands.executeCommand('taskwright.claimTask', message.taskId);
        break;
      }

      case 'dispatchTask': {
        vscode.commands.executeCommand('taskwright.dispatchTask', message.taskId);
        break;
      }

      case 'forceClaimTask': {
        vscode.commands.executeCommand('taskwright.forceClaimTask', message.taskId);
        break;
      }

      case 'releaseTask': {
        vscode.commands.executeCommand('taskwright.releaseTask', message.taskId);
        break;
      }

      case 'cancelDispatch': {
        vscode.commands.executeCommand('taskwright.cancelDispatch', message.taskId);
        break;
      }

      case 'requestMilestoneData': {
        await this.sendMilestoneData(message.milestone);
        break;
      }

      case 'toggleReleaseChecklistItem': {
        if (!this.parser) break;
        toggleReleaseChecklist(this.parser.getBacklogPath(), message.milestone, message.itemId);
        this.parser.invalidateMilestoneCache();
        await this.sendMilestoneData(message.milestone);
        break;
      }

      case 'createTask': {
        if (!this.parser) break;
        try {
          const { id } = await createTaskWithTreeFields(
            {
              parser: this.parser,
              writer: this.writer,
              backlogPath: this.parser.getBacklogPath(),
              treeFieldService: this.treeFieldService,
            },
            {
              title: message.title,
              description: message.description,
              status: message.status,
              priority: message.priority,
              category: message.category,
              milestone: message.milestone,
              // Q1: the wire field is `taskType` (message.type is the envelope discriminant);
              // the core arg keeps the canonical name `type` (MCP parity).
              type: message.taskType,
              causedBy: message.causedBy,
              dependencies: message.dependencies,
              // linkTo is built for P3b; the P3a form never sets it. When P3b feeds it,
              // re-validate with wouldCreateCycle extension-side before this call.
              linkTo: message.linkTo,
            }
          );
          await this.refresh();
          if (message.openAfter) {
            vscode.commands.executeCommand('taskwright.openTaskDetail', { taskId: id });
          }
        } catch (error) {
          console.error('[Taskwright] createTask failed:', error);
          vscode.window.showErrorMessage(
            `Failed to create task: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
      }

      case 'requestCreateMilestone': {
        vscode.commands.executeCommand('taskwright.createMilestone');
        break;
      }

      case 'toggleColumnCollapse': {
        const status = message.status;
        if (this.collapsedColumns.has(status)) {
          this.collapsedColumns.delete(status);
        } else {
          this.collapsedColumns.add(status);
        }
        // Persist to globalState
        if (this.context) {
          await this.context.globalState.update(
            'backlog.collapsedColumns',
            Array.from(this.collapsedColumns)
          );
        }
        // Notify webview
        this.host.postMessage({
          type: 'columnCollapseChanged',
          collapsedColumns: Array.from(this.collapsedColumns),
        });
        break;
      }

      case 'toggleMilestoneGrouping': {
        this.groupingMode = message.enabled ? 'milestone' : 'status';
        // Persist to globalState
        if (this.context) {
          await this.context.globalState.update('backlog.groupingMode', this.groupingMode);
        }
        // Notify webview (for consistency, though UI already updated)
        this.host.postMessage({
          type: 'groupingModeChanged',
          mode: this.groupingMode,
        });
        break;
      }

      case 'toggleGroupingMode': {
        this.groupingMode = message.mode;
        // Persist to globalState
        if (this.context) {
          await this.context.globalState.update('backlog.groupingMode', this.groupingMode);
        }
        // Notify webview (for consistency, though UI already updated)
        this.host.postMessage({
          type: 'groupingModeChanged',
          mode: this.groupingMode,
        });
        break;
      }

      case 'initBacklog': {
        if (message.mode === 'defaults') {
          vscode.commands.executeCommand('taskwright.init', { defaults: true });
        } else {
          vscode.commands.executeCommand('taskwright.init');
        }
        break;
      }

      case 'setupAgentIntegration': {
        vscode.commands.executeCommand('taskwright.setupAgentIntegration');
        break;
      }

      case 'dismissIntegrationBanner': {
        if (this.context && this.workspaceRoot) {
          const dismissKey = `backlog.integrationBannerDismissed.${this.workspaceRoot}`;
          await this.context.globalState.update(dismissKey, true);
        }
        this.host.postMessage({ type: 'integrationBannerState', show: false, cliAvailable: false });
        break;
      }

      case 'toggleMilestoneCollapse': {
        const milestone = message.milestone;
        if (this.collapsedMilestones.has(milestone)) {
          this.collapsedMilestones.delete(milestone);
        } else {
          this.collapsedMilestones.add(milestone);
        }
        // Persist to globalState
        if (this.context) {
          await this.context.globalState.update(
            'backlog.collapsedMilestones',
            Array.from(this.collapsedMilestones)
          );
        }
        // Notify webview
        this.host.postMessage({
          type: 'milestoneCollapseChanged',
          collapsedMilestones: Array.from(this.collapsedMilestones),
        });
        break;
      }
    }
  }

  /**
   * Set the data source mode and notify the webview
   */
  setDataSourceMode(mode: DataSourceMode, reason?: string): void {
    this.dataSourceMode = mode;
    this.dataSourceReason = reason;
    this.host.postMessage({ type: 'dataSourceChanged', mode, reason });
  }

  /**
   * Get the current data source mode
   */
  getDataSourceMode(): DataSourceMode {
    return this.dataSourceMode;
  }

  /** Relay a navigator-originated message (from the sidebar navigator) to this board's webview. */
  relayNavigator(message: ExtensionMessage): void {
    this.host.postMessage(message);
  }

  /**
   * Set the view mode (kanban, list, or drafts) from external command.
   * Drafts mode is treated as a special list view showing draft tasks.
   */
  setViewMode(mode: TasksViewMode): void {
    if (this.viewMode === mode) return;
    const previousMode = this.viewMode;
    this.viewMode = mode;

    const isDrafts = mode === 'drafts';
    const isArchived = mode === 'archived';
    const isDashboard = mode === 'dashboard';
    const isDocs = mode === 'docs';
    const isDecisions = mode === 'decisions';

    if (this.context) {
      this.context.globalState.update('backlog.viewMode', mode);
      this.context.globalState.update('backlog.showingDrafts', isDrafts);
    }

    // Send unified tab message
    this.host.postMessage({ type: 'activeTabChanged', tab: mode });
    // Backward compatibility: also send legacy messages
    this.host.postMessage({ type: 'draftsModeChanged', enabled: isDrafts });
    if (!isDashboard && !isDocs && !isDecisions && mode !== 'tree') {
      this.host.postMessage({
        type: 'viewModeChanged',
        viewMode: isDrafts || isArchived ? 'list' : mode,
      });
    }

    // Refresh dashboard stats when switching to dashboard
    if (isDashboard) {
      this.refreshDashboard();
      return;
    }

    // Refresh docs/decisions when switching to those tabs
    if (isDocs) {
      this.refreshDocuments();
      return;
    }
    if (isDecisions) {
      this.refreshDecisions();
      return;
    }

    // Refresh to load correct task set when switching to/from special modes
    const specialModes = ['drafts', 'archived', 'dashboard', 'docs', 'decisions'];
    const needsRefresh = specialModes.includes(mode) || specialModes.includes(previousMode);
    if (needsRefresh) {
      this.refresh();
    }
  }

  /**
   * Set the filter in the list view from external command
   */
  setFilter(filter: string): void {
    this.host.postMessage({ type: 'setFilter', filter });
  }

  /**
   * Set the label filter in the list view from external command
   */
  setLabelFilter(label: string): void {
    this.host.postMessage({ type: 'setLabelFilter', label });
  }

  /**
   * Refresh documents list and send to webview
   */
  async refreshDocuments(): Promise<void> {
    if (!this.host.isReady() || !this.parser) return;

    try {
      const documents = await this.parser.getDocuments();
      this.host.postMessage({ type: 'activeTabChanged', tab: 'docs' });
      this.host.postMessage({ type: 'documentsUpdated', documents });
    } catch (error) {
      console.error('[Taskwright] Error refreshing documents:', error);
      this.host.postMessage({ type: 'error', message: 'Failed to load documents' });
    }
  }

  /**
   * Refresh decisions list and send to webview
   */
  async refreshDecisions(): Promise<void> {
    if (!this.host.isReady() || !this.parser) return;

    try {
      const decisions = await this.parser.getDecisions();
      this.host.postMessage({ type: 'activeTabChanged', tab: 'decisions' });
      this.host.postMessage({ type: 'decisionsUpdated', decisions });
    } catch (error) {
      console.error('[Taskwright] Error refreshing decisions:', error);
      this.host.postMessage({ type: 'error', message: 'Failed to load decisions' });
    }
  }

  /**
   * Refresh dashboard statistics and send to webview
   */
  async refreshDashboard(): Promise<void> {
    if (!this.host.isReady() || !this.parser) return;

    try {
      const [tasks, completedTasks, statuses] = await Promise.all([
        this.parser.getTasks(),
        this.parser.getCompletedTasks(),
        this.parser.getStatuses(),
      ]);
      const stats = this.computeStatistics(tasks, completedTasks.length, statuses);
      this.host.postMessage({ type: 'statsUpdated', stats });
    } catch (error) {
      console.error('[Taskwright] Error refreshing dashboard stats:', error);
      this.host.postMessage({ type: 'error', message: 'Failed to load statistics' });
    }
  }

  /**
   * Compute statistics from tasks.
   * The statuses array comes from the backlog config. The last status in the list
   * is treated as the "done" status for milestone completion tracking.
   */
  private computeStatistics(
    tasks: Task[],
    completedCount: number = 0,
    statuses: string[] = ['To Do', 'In Progress', 'Done']
  ): {
    totalTasks: number;
    completedCount: number;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    milestones: Array<{ name: string; total: number; done: number }>;
  } {
    // Build byStatus dynamically: start with all config statuses (preserving order)
    const byStatus: Record<string, number> = {};
    for (const status of statuses) {
      byStatus[status] = 0;
    }

    const byPriority: Record<string, number> = {
      high: 0,
      medium: 0,
      low: 0,
      none: 0,
    };

    // The last configured status is treated as the "done" status
    const doneStatus = statuses.length > 0 ? statuses[statuses.length - 1] : 'Done';

    const milestoneMap = new Map<string, { total: number; done: number }>();

    for (const task of tasks) {
      byStatus[task.status] = (byStatus[task.status] || 0) + 1;

      const priority = task.priority || 'none';
      byPriority[priority] = (byPriority[priority] || 0) + 1;

      if (task.milestone) {
        if (!milestoneMap.has(task.milestone)) {
          milestoneMap.set(task.milestone, { total: 0, done: 0 });
        }
        const m = milestoneMap.get(task.milestone)!;
        m.total++;
        if (task.status === doneStatus) {
          m.done++;
        }
      }
    }

    const milestones = Array.from(milestoneMap.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => {
        const aPct = a.total > 0 ? a.done / a.total : 0;
        const bPct = b.total > 0 ? b.done / b.total : 0;
        return aPct - bPct;
      });

    return {
      totalTasks: tasks.length,
      completedCount,
      byStatus,
      byPriority,
      milestones,
    };
  }
}
