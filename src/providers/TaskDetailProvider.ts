import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BacklogParser, computeSubtasks } from '../core/BacklogParser';
import { BacklogWriter, computeContentHash, FileConflictError } from '../core/BacklogWriter';
import {
  isReadOnlyTask,
  getReadOnlyTaskContext,
  type Task,
  type TaskSource,
  type MergeTaskState,
} from '../core/types';
import { StatusCallbackRunner } from '../core/StatusCallbackRunner';
import { openWorkspaceFile, isValidLinkString } from '../core/openWorkspaceFile';
import { parseMarkdown } from '../core/parseMarkdown';
import { claimTaskForCurrentUser, releaseTaskClaim, getClaimIdentity } from './claimActions';
import { dispatchTask } from './dispatchActions';
import { attachPlanForTask, detachPlanForTask, openPlanForTask } from './planActions';
import { readActiveTask, writeActiveTask, clearActiveTask } from '../core/activeTask';
import { loadPlanProgress } from '../core/loadPlanProgress';
import { mergeStateForTask } from '../core/mergeBoard';
import { MergeQueueStore, mergeQueuePath, nodeQueueFs, type MergeMode } from '../core/mergeQueue';
import { resolvePriorities } from '../core/priorityOrder';
import { getTaskwrightConfig } from '../config';

const execFileAsyncDetail = promisify(execFile);

/**
 * Task detail data structure sent to the webview
 */
interface TaskDetailData {
  task: Task;
  statuses: string[];
  priorities: string[];
  uniqueLabels: string[];
  uniqueAssignees: string[];
  milestones: Array<{ id: string; label: string }>;
  blocksTaskIds: string[];
  linkableTasks: Array<{ id: string; title: string; status: string }>;
  isBlocked: boolean;
  missingDependencyIds?: string[];
  descriptionHtml: string;
  planHtml: string;
  notesHtml: string;
  finalSummaryHtml: string;
  isDraft?: boolean;
  isArchived?: boolean;
  isReadOnly?: boolean;
  readOnlyReason?: string;
  parentTask?: { id: string; title: string };
  subtaskSummaries?: Array<{ id: string; title: string; status: string }>;
  /** Identity the current user's claims are attributed to (for "claimed by you"). */
  claimIdentity?: string;
  /** Whether this task is the active (agent-handoff) task. */
  isActiveTask?: boolean;
  /** Checkbox progress of the task's attached superpowers plan, if any. */
  planProgress?: { total: number; done: number; percent: number; exists: boolean };
  /** Merge-queue state for this task, when it is awaiting integration. */
  mergeState?: MergeTaskState;
  /** Active merge mode (drives which review controls show). */
  mergeMode?: MergeMode;
}

interface OpenTaskRequest {
  taskId: string;
  filePath?: string;
  source?: TaskSource;
  branch?: string;
}

/**
 * Provides a webview panel for displaying task details
 *
 * This provider loads a compiled Svelte component (TaskDetail.svelte) that handles
 * all UI rendering. The provider is responsible for:
 * - Loading the Svelte bundle and styles
 * - Computing task data and sending it via postMessage
 * - Handling field updates and checklist toggles from the webview
 * - Conflict detection when files are modified externally
 */
export class TaskDetailProvider {
  private static currentPanel: vscode.WebviewPanel | undefined;
  private static currentTaskId: string | undefined;
  private static currentTaskRef: OpenTaskRequest | undefined;
  private static currentFileHash: string | undefined;
  private static currentFilePath: string | undefined;
  private readonly writer = new BacklogWriter();

  /**
   * Get the currently displayed task ID (for command palette commands)
   */
  public static getCurrentTaskId(): string | undefined {
    return TaskDetailProvider.currentTaskId;
  }

  /**
   * Check if a task detail panel is currently active and visible
   */
  public static hasActivePanel(): boolean {
    return TaskDetailProvider.currentPanel !== undefined && TaskDetailProvider.currentPanel.visible;
  }

  private static onActiveTaskChangedCallback: ((taskId: string | null) => void) | undefined;

  /**
   * Register a callback that fires when the active edited task changes
   */
  public static onActiveTaskChanged(callback: (taskId: string | null) => void): void {
    TaskDetailProvider.onActiveTaskChangedCallback = callback;
  }

  private static notifyActiveTaskChanged(taskId: string | null): void {
    TaskDetailProvider.onActiveTaskChangedCallback?.(taskId);
  }

  private backlogPath: string | undefined;
  private commonDir: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private parser: BacklogParser | undefined
  ) {}

  setBacklogPath(backlogPath: string): void {
    this.backlogPath = backlogPath;
  }

  setParser(parser: BacklogParser): void {
    this.parser = parser;
  }

  /** Cache the git common dir so resolveMergeState reuses it instead of spawning
   *  `git rev-parse --git-common-dir` per panel open. */
  setCommonDir(commonDir: string): void {
    this.commonDir = commonDir;
  }

  /**
   * Handle file change events from the FileWatcher.
   * Refreshes the view if the changed file matches the currently displayed task.
   */
  public static onFileChanged(uri: vscode.Uri, provider: TaskDetailProvider): void {
    if (!this.currentPanel || !this.currentTaskId || !this.currentFilePath) {
      return;
    }

    if (uri.fsPath === this.currentFilePath) {
      if (!fs.existsSync(uri.fsPath)) {
        vscode.window.showWarningMessage(
          `Task file was deleted: ${uri.fsPath.split('/').pop() || uri.fsPath}`
        );
        this.currentPanel?.dispose();
        return;
      }

      provider.openTask(this.currentTaskRef ?? this.currentTaskId, { preserveFocus: true });
    }
  }

  /**
   * Re-render the open panel for the current task (e.g. after active-task state
   * changed out of band). No-op when no panel is open.
   */
  public static refreshCurrent(provider: TaskDetailProvider): void {
    if (!this.currentPanel || !this.currentTaskId) return;
    provider.openTask(this.currentTaskRef ?? this.currentTaskId, { preserveFocus: true });
  }

  /**
   * Open or update the task detail panel for a specific task
   */
  async openTask(
    taskRef: string | OpenTaskRequest,
    options?: { preserveFocus?: boolean; viewColumn?: vscode.ViewColumn }
  ): Promise<void> {
    if (!this.parser) {
      vscode.window.showErrorMessage('No backlog folder found');
      return;
    }

    const requestedTask = typeof taskRef === 'string' ? { taskId: taskRef } : taskRef;
    const task = await this.resolveTaskForOpen(requestedTask);
    if (!task) {
      vscode.window.showErrorMessage(`Task ${requestedTask.taskId} not found`);
      return;
    }

    // Capture file state for conflict detection and auto-refresh
    if (task.filePath && fs.existsSync(task.filePath)) {
      const fileContent = fs.readFileSync(task.filePath, 'utf-8');
      TaskDetailProvider.currentFileHash = computeContentHash(fileContent);
      TaskDetailProvider.currentFilePath = task.filePath;
    } else {
      TaskDetailProvider.currentFileHash = undefined;
      TaskDetailProvider.currentFilePath = undefined;
    }

    // Default placement is the first editor column (sidebar-originated opens).
    // The editor-tab board passes ViewColumn.Active so the detail opens as a tab
    // in the board's own editor group rather than a split.
    const column = options?.viewColumn ?? vscode.ViewColumn.One;

    // If we already have a panel, show it and update content
    if (TaskDetailProvider.currentPanel) {
      // Keep an existing detail panel where the user has it (don't yank it to a
      // new column on every peek); only fall back to `column` if it has none.
      const revealColumn = TaskDetailProvider.currentPanel.viewColumn ?? column;
      TaskDetailProvider.currentPanel.reveal(revealColumn, options?.preserveFocus);
      TaskDetailProvider.currentPanel.title = `${task.id}: ${task.title}`;
      TaskDetailProvider.currentTaskId = task.id;
      TaskDetailProvider.currentTaskRef = {
        taskId: task.id,
        filePath: task.filePath,
        source: task.source,
        branch: task.branch,
      };
      await this.sendTaskData(TaskDetailProvider.currentPanel.webview, task);
      TaskDetailProvider.notifyActiveTaskChanged(task.id);
      return;
    }

    // Otherwise, create a new panel. Honor preserveFocus here too (not just on
    // the reveal path above), so the first single-click from the editor-tab
    // board keeps focus on the board like subsequent clicks do.
    const panel = vscode.window.createWebviewPanel(
      'taskwright.taskDetail',
      `${task.id}: ${task.title}`,
      { viewColumn: column, preserveFocus: options?.preserveFocus },
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri],
        retainContextWhenHidden: true,
      }
    );

    TaskDetailProvider.currentPanel = panel;
    TaskDetailProvider.currentTaskId = task.id;
    TaskDetailProvider.currentTaskRef = {
      taskId: task.id,
      filePath: task.filePath,
      source: task.source,
      branch: task.branch,
    };
    panel.webview.html = this.getHtmlContent(panel.webview, task.title);

    // Send task data after a short delay to ensure component is mounted
    setTimeout(() => this.sendTaskData(panel.webview, task), 100);

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(async (message) => {
      await this.handleMessage(message);
    });

    // Track visibility changes for active task highlighting
    panel.onDidChangeViewState(() => {
      if (panel.visible) {
        TaskDetailProvider.notifyActiveTaskChanged(TaskDetailProvider.currentTaskId ?? null);
      } else {
        TaskDetailProvider.notifyActiveTaskChanged(null);
      }
    });

    // Reset when the panel is closed
    panel.onDidDispose(() => {
      TaskDetailProvider.currentPanel = undefined;
      TaskDetailProvider.currentTaskId = undefined;
      TaskDetailProvider.currentTaskRef = undefined;
      TaskDetailProvider.currentFileHash = undefined;
      TaskDetailProvider.currentFilePath = undefined;
      TaskDetailProvider.notifyActiveTaskChanged(null);
    });

    TaskDetailProvider.notifyActiveTaskChanged(task.id);
  }

  /**
   * Resolve a task by identity for detail-open actions.
   * Prefers exact filePath matches from cross-branch task loading when provided,
   * while preserving local getTask behavior for legacy ID-only callers.
   */
  private async resolveTaskForOpen(taskRef: OpenTaskRequest): Promise<Task | undefined> {
    if (!this.parser) return undefined;

    const localTask = await this.parser.getTask(taskRef.taskId);
    const hasExtendedIdentity = Boolean(taskRef.filePath || taskRef.source || taskRef.branch);
    if (!hasExtendedIdentity) {
      return localTask;
    }

    if (localTask?.filePath && taskRef.filePath && localTask.filePath === taskRef.filePath) {
      return localTask;
    }

    const crossBranchTasks = await this.parser.getTasksWithCrossBranch();

    if (taskRef.filePath) {
      const exactByPath = crossBranchTasks.find(
        (task) => task.id === taskRef.taskId && task.filePath === taskRef.filePath
      );
      if (exactByPath) return exactByPath;
    }

    const bySource = crossBranchTasks.find(
      (task) =>
        task.id === taskRef.taskId &&
        task.source === taskRef.source &&
        task.branch === taskRef.branch
    );
    if (bySource) return bySource;

    return localTask ?? crossBranchTasks.find((task) => task.id === taskRef.taskId);
  }

  /**
   * Get URI for a resource file
   */
  private getResourceUri(webview: vscode.Webview, ...pathSegments: string[]): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', ...pathSegments)
    );
  }

  /**
   * Generate HTML content for the webview (loads Svelte bundle)
   */
  private getHtmlContent(webview: vscode.Webview, taskTitle: string): string {
    const styleUri = this.getResourceUri(webview, 'styles.css');
    const componentStyleUri = this.getResourceUri(webview, 'task-detail.css');
    const scriptUri = this.getResourceUri(webview, 'task-detail.js');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};">
    <link href="${styleUri}" rel="stylesheet">
    <link href="${componentStyleUri}" rel="stylesheet">
    <title>${this.escapeHtml(taskTitle)}</title>
</head>
<body class="task-detail-page">
    <div id="app"></div>
    <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Best-effort resolution of this task's place in the shared merge queue.
   * Prefers the cached `commonDir` (set via `setCommonDir`) over spawning
   * `git rev-parse --git-common-dir` every panel open. Falls back to spawning
   * git when no cache is available. Any failure yields `undefined` rather than
   * breaking the rest of the task-detail payload.
   */
  private async resolveMergeState(
    taskId: string,
    repoRoot: string
  ): Promise<MergeTaskState | undefined> {
    try {
      const commonDir =
        this.commonDir ??
        path.resolve(
          repoRoot,
          (
            await execFileAsyncDetail('git', ['rev-parse', '--git-common-dir'], {
              cwd: repoRoot,
              timeout: 15_000,
            })
          ).stdout.trim()
        );
      const store = new MergeQueueStore(mergeQueuePath(commonDir), nodeQueueFs);
      return mergeStateForTask(store.read(), taskId);
    } catch {
      return undefined;
    }
  }

  /**
   * Send task data to the webview
   */
  private async sendTaskData(webview: vscode.Webview, task: Task): Promise<void> {
    if (!this.parser) return;

    try {
      const contextTasks = await this.getContextTasks(task);
      const contextTask = this.resolveTaskFromCollection(contextTasks, task) ?? task;

      // Fetch all supporting data
      const [
        statuses,
        uniqueLabels,
        uniqueAssignees,
        configMilestones,
        completedTasks,
        archivedTasks,
        localTasks,
      ] = await Promise.all([
        this.parser.getStatuses(),
        this.parser.getUniqueLabels(),
        this.parser.getUniqueAssignees(),
        this.parser.getMilestones(),
        this.parser.getCompletedTasks(),
        this.parser.getArchivedTasks(),
        this.parser.getTasks(),
      ]);

      // Combine config milestones with unique milestones from tasks
      const milestoneOptions = configMilestones.map((milestone) => ({
        id: milestone.id,
        label: milestone.name,
      }));
      const knownMilestoneIds = new Set(milestoneOptions.map((option) => option.id));
      const taskMilestones = [
        ...new Set(contextTasks.map((t) => t.milestone).filter(Boolean)),
      ] as string[];
      for (const milestone of taskMilestones) {
        if (!knownMilestoneIds.has(milestone)) {
          milestoneOptions.push({ id: milestone, label: milestone });
          knownMilestoneIds.add(milestone);
        }
      }

      const blocksTaskIds = contextTasks
        .filter((candidateTask) => candidateTask.dependencies.includes(contextTask.id))
        .map((candidateTask) => candidateTask.id);

      const linkableTasks = localTasks
        .filter(
          (candidateTask) => candidateTask.id !== contextTask.id && candidateTask.folder === 'tasks'
        )
        .map((candidateTask) => ({
          id: candidateTask.id,
          title: candidateTask.title,
          status: candidateTask.status,
        }))
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

      // Check if task is blocked by active dependencies and track unresolved links
      const doneStatus = statuses.length > 0 ? statuses[statuses.length - 1] : 'Done';
      const activeTaskById = new Map(contextTasks.map((activeTask) => [activeTask.id, activeTask]));
      const completedTaskIds = new Set(completedTasks.map((completedTask) => completedTask.id));
      const archivedTaskIds = new Set(archivedTasks.map((archivedTask) => archivedTask.id));
      const missingDependencyIds: string[] = [];
      const blockingDependencyIds = contextTask.dependencies.filter((depId) => {
        if (completedTaskIds.has(depId) || archivedTaskIds.has(depId)) {
          return false;
        }
        const depTask = activeTaskById.get(depId);
        if (!depTask) {
          missingDependencyIds.push(depId);
          return true;
        }
        return depTask.status !== doneStatus;
      });
      const isBlocked = blockingDependencyIds.length > 0;

      // Parse body section markdown
      const descriptionHtml = task.description ? await parseMarkdown(task.description) : '';
      const planHtml = task.implementationPlan ? await parseMarkdown(task.implementationPlan) : '';
      const notesHtml = task.implementationNotes
        ? await parseMarkdown(task.implementationNotes)
        : '';
      const finalSummaryHtml = task.finalSummary ? await parseMarkdown(task.finalSummary) : '';

      // Compute parent task info
      let parentTask: { id: string; title: string } | undefined;
      if (contextTask.parentTaskId) {
        let parent = this.findPreferredTaskById(
          contextTasks,
          contextTask.parentTaskId,
          contextTask
        );
        if (!parent) {
          parent = await this.parser!.getTask(contextTask.parentTaskId);
        }
        if (parent) {
          parentTask = { id: parent.id, title: parent.title };
        }
      }

      // Compute subtask summaries
      computeSubtasks(contextTasks);
      let subtaskSummaries: Array<{ id: string; title: string; status: string }> | undefined;
      if (contextTask.subtasks && contextTask.subtasks.length > 0) {
        const summaries: Array<{ id: string; title: string; status: string }> = [];
        for (const childId of contextTask.subtasks) {
          const child = this.findPreferredTaskById(contextTasks, childId, contextTask);
          if (child) {
            summaries.push({ id: child.id, title: child.title, status: child.status });
          }
        }
        if (summaries.length > 0) {
          subtaskSummaries = summaries;
        }
      }

      // Active-task state, plan progress, and merge-queue state are auxiliary
      // metadata; a lookup failure must not break rendering the task itself.
      let isActiveTask = false;
      let planProgress: TaskDetailData['planProgress'];
      let mergeState: MergeTaskState | undefined;
      try {
        const repoRoot = path.dirname(this.parser.getBacklogPath());
        isActiveTask = readActiveTask(repoRoot)?.taskId === contextTask.id;
        if (contextTask.plan) {
          const loaded = loadPlanProgress(repoRoot, contextTask.plan);
          planProgress = {
            total: loaded.progress.total,
            done: loaded.progress.done,
            percent: loaded.progress.percent,
            exists: loaded.exists,
          };
        }
        mergeState = await this.resolveMergeState(contextTask.id, repoRoot);
      } catch {
        isActiveTask = false;
      }
      const mergeMode = getTaskwrightConfig<MergeMode>('mergeMode', 'manual-review');

      const config = await this.parser.getConfig();
      const priorities = resolvePriorities(config);

      const data: TaskDetailData = {
        task: contextTask,
        statuses,
        priorities,
        uniqueLabels,
        uniqueAssignees,
        milestones: milestoneOptions,
        blocksTaskIds,
        linkableTasks,
        isBlocked,
        missingDependencyIds: missingDependencyIds.length > 0 ? missingDependencyIds : undefined,
        descriptionHtml,
        planHtml,
        notesHtml,
        finalSummaryHtml,
        isDraft: task.folder === 'drafts',
        isArchived: task.folder === 'archive',
        isReadOnly: isReadOnlyTask(task),
        readOnlyReason: isReadOnlyTask(task)
          ? `Task is from ${getReadOnlyTaskContext(task)} and is read-only.`
          : undefined,
        parentTask,
        subtaskSummaries,
        claimIdentity: getClaimIdentity(),
        isActiveTask,
        planProgress,
        mergeState,
        mergeMode,
      };

      webview.postMessage({ type: 'taskData', data });
    } catch (error) {
      console.error('[Taskwright] Error sending task data:', error);
      webview.postMessage({ type: 'error', message: 'Failed to load task data' });
    }
  }

  private async getContextTasks(task: Task): Promise<Task[]> {
    if (!this.parser) return [];
    if (task.source === 'remote' || task.source === 'local-branch') {
      return this.parser.getTasksWithCrossBranch();
    }
    return this.parser.getTasks();
  }

  private resolveTaskFromCollection(tasks: Task[], task: Task): Task | undefined {
    if (task.filePath) {
      const byPath = tasks.find(
        (candidate) => candidate.id === task.id && candidate.filePath === task.filePath
      );
      if (byPath) return byPath;
    }
    const bySource = tasks.find(
      (candidate) =>
        candidate.id === task.id &&
        candidate.source === task.source &&
        candidate.branch === task.branch
    );
    if (bySource) return bySource;
    return tasks.find((candidate) => candidate.id === task.id);
  }

  private findPreferredTaskById(
    tasks: Task[],
    taskId: string,
    contextTask: Task
  ): Task | undefined {
    const sameSourceAndBranch = tasks.find(
      (candidate) =>
        candidate.id === taskId &&
        candidate.source === contextTask.source &&
        candidate.branch === contextTask.branch
    );
    if (sameSourceAndBranch) return sameSourceAndBranch;

    const sameSource = tasks.find(
      (candidate) => candidate.id === taskId && candidate.source === contextTask.source
    );
    if (sameSource) return sameSource;

    return tasks.find((candidate) => candidate.id === taskId);
  }

  /**
   * Handle messages from the webview
   */
  private async handleMessage(message: {
    type: string;
    taskId?: string;
    parentTaskId?: string;
    milestoneTitle?: string;
    listType?: 'acceptanceCriteria' | 'definitionOfDone';
    itemId?: number;
    field?: string;
    value?: string | string[];
    label?: string;
    relativePath?: string;
    fragment?: string | null;
  }): Promise<void> {
    switch (message.type) {
      case 'refresh':
        if (TaskDetailProvider.currentTaskId) {
          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId }
          );
        }
        break;

      case 'openFile':
        if (TaskDetailProvider.currentTaskId && this.parser) {
          const task = await this.getCurrentTaskFromContext();
          if (task?.filePath) {
            vscode.commands.executeCommand('vscode.open', vscode.Uri.file(task.filePath));
          }
        }
        break;

      case 'openWorkspaceFile': {
        // Shape-check the IPC payload: a compromised or buggy webview could
        // post a non-string / oversized value. Drop it silently rather than
        // letting it coerce via `decodeURIComponent` downstream.
        if (!isValidLinkString(message.relativePath)) break;
        const fragment = message.fragment ?? null;
        if (fragment !== null && !isValidLinkString(fragment)) break;
        await openWorkspaceFile(message.relativePath, fragment, TaskDetailProvider.currentFilePath);
        break;
      }

      case 'openTask':
        if (message.taskId) {
          await this.openTask(message.taskId);
        }
        break;

      case 'filterByLabel':
        if (message.label) {
          vscode.commands.executeCommand('taskwright.filterByLabel', message.label);
        }
        break;

      case 'toggleChecklistItem':
        if (
          TaskDetailProvider.currentTaskId &&
          this.parser &&
          message.listType &&
          message.itemId !== undefined
        ) {
          const currentTask = await this.getCurrentTaskFromContext();
          if (this.blockReadOnlyMutation(currentTask, 'update checklist items')) break;
          try {
            await this.writer.toggleChecklistItem(
              TaskDetailProvider.currentTaskId,
              message.listType,
              message.itemId,
              this.parser
            );
            await this.openTask(
              TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
              { preserveFocus: true }
            );
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to toggle checklist item: ${error}`);
          }
        }
        break;

      case 'updateField':
        if (TaskDetailProvider.currentTaskId && this.parser && message.field) {
          const task = await this.getCurrentTaskFromContext();
          if (this.blockReadOnlyMutation(task, `update ${message.field}`)) break;
          if (!task?.filePath || !fs.existsSync(task.filePath)) {
            const choice = await vscode.window.showErrorMessage(
              'The task file has been deleted or moved.',
              'Close Panel'
            );
            if (choice === 'Close Panel') {
              TaskDetailProvider.currentPanel?.dispose();
            }
            return;
          }

          try {
            const updates: Record<string, unknown> = {};
            if (message.field === 'milestone') {
              updates[message.field] = await this.parser.resolveMilestone(message.value as string);
            } else {
              updates[message.field] = message.value;
            }
            const oldStatus = task.status;
            await this.writer.updateTask(
              TaskDetailProvider.currentTaskId,
              updates,
              this.parser,
              TaskDetailProvider.currentFileHash
            );
            // Run status change callback if status was updated
            if (message.field === 'status' && this.parser) {
              const config = await this.parser.getConfig();
              const backlogPath = path.dirname(path.dirname(task.filePath));
              const taskContent = fs.readFileSync(task.filePath, 'utf-8');
              const taskFm = taskContent.match(/onStatusChange:\s*(.+)/);
              const taskCallback = taskFm?.[1]?.trim().replace(/^['"]|['"]$/g, '');
              await StatusCallbackRunner.run(backlogPath, taskCallback, config.on_status_change, {
                taskId: TaskDetailProvider.currentTaskId,
                oldStatus,
                newStatus: String(message.value),
                taskTitle: task.title,
              });
            }
            // Update stored hash after successful write
            const newContent = fs.readFileSync(task.filePath, 'utf-8');
            TaskDetailProvider.currentFileHash = computeContentHash(newContent);
            await this.openTask(
              TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
              { preserveFocus: true }
            );
          } catch (error) {
            if (error instanceof FileConflictError) {
              await this.handleConflict(message.field, message.value);
            } else {
              vscode.window.showErrorMessage(`Failed to update task: ${error}`);
            }
          }
        }
        break;

      case 'promoteDraft': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;
        const task = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(task, 'promote this draft')) break;

        try {
          const newTaskId = await this.writer.promoteDraft(
            TaskDetailProvider.currentTaskId,
            this.parser
          );
          vscode.window.showInformationMessage(`Draft promoted to task: ${newTaskId}`);
          await this.openTask(newTaskId);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to promote draft: ${error}`);
        }
        break;
      }

      case 'demoteTask': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;
        const taskToDemote = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(taskToDemote, 'demote this task')) break;

        try {
          const newDraftId = await this.writer.demoteTask(
            TaskDetailProvider.currentTaskId,
            this.parser
          );
          vscode.window.showInformationMessage(`Task demoted to draft: ${newDraftId}`);
          await this.openTask(newDraftId);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to demote task: ${error}`);
        }
        break;
      }

      case 'discardDraft': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;

        const draftTask = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(draftTask, 'discard this draft')) break;
        if (!draftTask) break;

        const discardConfirmation = await vscode.window.showWarningMessage(
          `Discard draft "${draftTask.title}"? This will permanently delete the file.`,
          { modal: true },
          'Discard'
        );

        if (discardConfirmation === 'Discard') {
          try {
            if (draftTask.filePath && fs.existsSync(draftTask.filePath)) {
              fs.unlinkSync(draftTask.filePath);
            }
            vscode.window.showInformationMessage('Draft discarded');
            TaskDetailProvider.currentPanel?.dispose();
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to discard draft: ${error}`);
          }
        }
        break;
      }

      case 'archiveTask': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;
        const task = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(task, 'archive this task')) break;

        try {
          await this.writer.archiveTask(TaskDetailProvider.currentTaskId, this.parser);
          vscode.window.showInformationMessage(`Task ${TaskDetailProvider.currentTaskId} archived`);
          TaskDetailProvider.currentPanel?.dispose();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to archive task: ${error}`);
        }
        break;
      }

      case 'claimTask': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;
        const task = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(task, 'claim this task')) break;
        try {
          const claim = await claimTaskForCurrentUser(
            TaskDetailProvider.currentTaskId,
            this.parser
          );
          if (!claim) break;
          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
            { preserveFocus: true }
          );
          vscode.window.showInformationMessage(
            `Claimed ${TaskDetailProvider.currentTaskId} as ${claim.claimedBy}`
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to claim task: ${error}`);
        }
        break;
      }

      case 'releaseTask': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;
        const task = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(task, 'release this task')) break;
        try {
          await releaseTaskClaim(TaskDetailProvider.currentTaskId, this.parser);
          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
            { preserveFocus: true }
          );
          vscode.window.showInformationMessage(`Released ${TaskDetailProvider.currentTaskId}`);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to release task: ${error}`);
        }
        break;
      }

      case 'setActiveTask': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;
        try {
          const root = path.dirname(this.parser.getBacklogPath());
          writeActiveTask(root, TaskDetailProvider.currentTaskId);
          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
            { preserveFocus: true }
          );
          vscode.window.showInformationMessage(
            `${TaskDetailProvider.currentTaskId} is now the active task for agents.`
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to set active task: ${error}`);
        }
        break;
      }

      case 'clearActiveTask': {
        if (!this.parser) break;
        try {
          clearActiveTask(path.dirname(this.parser.getBacklogPath()));
          if (TaskDetailProvider.currentTaskId) {
            await this.openTask(
              TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
              { preserveFocus: true }
            );
          }
          vscode.window.showInformationMessage('Cleared the active task.');
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to clear active task: ${error}`);
        }
        break;
      }

      case 'dispatchTask': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;
        const task = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(task, 'dispatch this task')) break;
        try {
          const result = await dispatchTask(TaskDetailProvider.currentTaskId, this.parser);
          if (!result) break;
          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
            { preserveFocus: true }
          );
          const detail = result.worktreePath
            ? `Prompt copied. Worktree: ${result.worktreePath}`
            : 'Prompt copied to clipboard. Paste it into a fresh Claude Code session.';
          const choice = await vscode.window.showInformationMessage(
            `Dispatched ${result.taskId}. ${detail}`,
            'Open handoff'
          );
          if (choice === 'Open handoff') {
            const doc = await vscode.workspace.openTextDocument(result.handoffFile);
            await vscode.window.showTextDocument(doc);
          }
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to dispatch task: ${error}`);
        }
        break;
      }

      case 'approveMerge': {
        if (TaskDetailProvider.currentTaskId) {
          vscode.commands.executeCommand(
            'taskwright.approveMerge',
            TaskDetailProvider.currentTaskId
          );
        }
        break;
      }

      case 'sendBackMerge': {
        if (TaskDetailProvider.currentTaskId) {
          vscode.commands.executeCommand(
            'taskwright.sendBackMerge',
            TaskDetailProvider.currentTaskId
          );
        }
        break;
      }

      case 'attachPlan': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;
        const task = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(task, 'attach a plan to this task')) break;
        try {
          const stored = await attachPlanForTask(TaskDetailProvider.currentTaskId, this.parser);
          if (!stored) break;
          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
            { preserveFocus: true }
          );
          vscode.window.showInformationMessage(`Attached plan ${stored}`);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to attach plan: ${error}`);
        }
        break;
      }

      case 'detachPlan': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;
        const task = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(task, 'detach the plan from this task')) break;
        try {
          await detachPlanForTask(TaskDetailProvider.currentTaskId, this.parser);
          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
            { preserveFocus: true }
          );
          vscode.window.showInformationMessage('Detached the plan.');
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to detach plan: ${error}`);
        }
        break;
      }

      case 'openPlan': {
        if (!this.parser) break;
        const task = await this.getCurrentTaskFromContext();
        if (!task?.plan) break;
        try {
          await openPlanForTask(task.plan, this.parser);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to open plan: ${error}`);
        }
        break;
      }

      case 'restoreTask': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;
        const task = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(task, 'restore this task')) break;

        try {
          await this.writer.restoreArchivedTask(TaskDetailProvider.currentTaskId, this.parser);
          vscode.window.showInformationMessage(
            `Task ${TaskDetailProvider.currentTaskId} restored to tasks`
          );
          TaskDetailProvider.currentPanel?.dispose();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to restore task: ${error}`);
        }
        break;
      }

      case 'deleteTask': {
        if (!TaskDetailProvider.currentTaskId || !this.parser) break;

        const deleteTarget = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(deleteTarget, 'delete this task')) break;
        if (!deleteTarget) break;

        const deleteConfirmation = await vscode.window.showWarningMessage(
          `Permanently delete task "${deleteTarget.title}"? This cannot be undone.`,
          { modal: true },
          'Delete'
        );

        if (deleteConfirmation === 'Delete') {
          try {
            await this.writer.deleteTask(TaskDetailProvider.currentTaskId, this.parser);
            vscode.window.showInformationMessage(
              `Task ${TaskDetailProvider.currentTaskId} deleted`
            );
            TaskDetailProvider.currentPanel?.dispose();
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete task: ${error}`);
          }
        }
        break;
      }

      case 'createSubtask': {
        if (!message.parentTaskId || !this.parser) break;
        const parentTask =
          TaskDetailProvider.currentTaskRef &&
          TaskDetailProvider.currentTaskRef.taskId === message.parentTaskId
            ? await this.resolveTaskForOpen(TaskDetailProvider.currentTaskRef)
            : await this.parser.getTask(message.parentTaskId);
        if (this.blockReadOnlyMutation(parentTask, 'create a subtask')) break;

        try {
          const backlogPath =
            this.backlogPath ?? path.dirname(path.dirname(parentTask?.filePath || ''));
          if (!backlogPath) break;

          const result = await this.writer.createSubtask(
            message.parentTaskId,
            backlogPath,
            this.parser
          );

          // Open the new subtask in the detail panel
          await this.openTask(result.id);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to create subtask: ${error}`);
        }
        break;
      }

      case 'createMilestone': {
        if (!this.parser) break;
        const currentTask = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(currentTask, 'create a milestone')) break;

        const backlogPath =
          this.backlogPath ??
          (currentTask?.filePath
            ? this.resolveBacklogPathFromTaskPath(currentTask.filePath)
            : undefined);
        if (!backlogPath) {
          vscode.window.showErrorMessage('Unable to resolve backlog path for milestone creation.');
          break;
        }

        const providedTitle = message.milestoneTitle?.trim();
        const milestoneTitle =
          providedTitle ||
          (
            await vscode.window.showInputBox({
              prompt: 'Enter milestone title',
              placeHolder: 'e.g., v1.0 Launch',
              ignoreFocusOut: true,
            })
          )?.trim();

        if (!milestoneTitle) {
          break;
        }

        try {
          const created = await this.writer.createMilestone(
            backlogPath,
            milestoneTitle,
            undefined,
            this.parser
          );

          this.parser.invalidateMilestoneCache();

          if (TaskDetailProvider.currentTaskId && currentTask?.filePath) {
            await this.writer.updateTask(
              TaskDetailProvider.currentTaskId,
              { milestone: created.id },
              this.parser,
              TaskDetailProvider.currentFileHash
            );
            const newContent = fs.readFileSync(currentTask.filePath, 'utf-8');
            TaskDetailProvider.currentFileHash = computeContentHash(newContent);
          }

          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? {
              taskId: TaskDetailProvider.currentTaskId ?? (currentTask?.id || ''),
            },
            { preserveFocus: true }
          );
          vscode.window.showInformationMessage(`Created milestone "${created.name}"`);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to create milestone: ${error}`);
        }
        break;
      }

      case 'addBlockedByLink': {
        if (!message.taskId || !this.parser || !TaskDetailProvider.currentTaskId) break;
        const currentTask = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(currentTask, 'add blocked-by links')) break;
        if (!currentTask) break;
        if (message.taskId === currentTask.id) {
          vscode.window.showErrorMessage('A task cannot be blocked by itself.');
          break;
        }

        const localTasks = await this.parser.getTasks();
        const linkedTask = localTasks.find((task) => task.id === message.taskId);
        if (!linkedTask) {
          vscode.window.showErrorMessage(`Cannot link task ${message.taskId}: task not found.`);
          break;
        }

        if (currentTask.dependencies.includes(message.taskId)) break;

        try {
          await this.writer.updateTask(
            currentTask.id,
            { dependencies: [...currentTask.dependencies, message.taskId] },
            this.parser,
            TaskDetailProvider.currentFileHash
          );
          if (currentTask.filePath && fs.existsSync(currentTask.filePath)) {
            const newContent = fs.readFileSync(currentTask.filePath, 'utf-8');
            TaskDetailProvider.currentFileHash = computeContentHash(newContent);
          }
          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
            { preserveFocus: true }
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to link dependency: ${error}`);
        }
        break;
      }

      case 'addBlocksLink': {
        if (!message.taskId || !this.parser || !TaskDetailProvider.currentTaskId) break;
        const currentTask = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(currentTask, 'add blocks links')) break;
        if (!currentTask) break;
        if (message.taskId === currentTask.id) {
          vscode.window.showErrorMessage('A task cannot block itself.');
          break;
        }

        const localTasks = await this.parser.getTasks();
        const targetTask = localTasks.find((task) => task.id === message.taskId);
        if (!targetTask) {
          vscode.window.showErrorMessage(`Cannot link task ${message.taskId}: task not found.`);
          break;
        }
        if (this.blockReadOnlyMutation(targetTask, 'add blocks links')) break;

        if (targetTask.dependencies.includes(currentTask.id)) break;

        try {
          await this.writer.updateTask(
            targetTask.id,
            { dependencies: [...targetTask.dependencies, currentTask.id] },
            this.parser
          );
          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
            { preserveFocus: true }
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update blocked task: ${error}`);
        }
        break;
      }

      case 'removeBlockedByLink': {
        if (!message.taskId || !this.parser || !TaskDetailProvider.currentTaskId) break;
        const currentTask = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(currentTask, 'remove blocked-by links')) break;
        if (!currentTask) break;

        if (!currentTask.dependencies.includes(message.taskId)) break;

        try {
          await this.writer.updateTask(
            currentTask.id,
            { dependencies: currentTask.dependencies.filter((dep) => dep !== message.taskId) },
            this.parser,
            TaskDetailProvider.currentFileHash
          );
          if (currentTask.filePath && fs.existsSync(currentTask.filePath)) {
            const newContent = fs.readFileSync(currentTask.filePath, 'utf-8');
            TaskDetailProvider.currentFileHash = computeContentHash(newContent);
          }
          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
            { preserveFocus: true }
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to remove dependency: ${error}`);
        }
        break;
      }

      case 'removeBlocksLink': {
        if (!message.taskId || !this.parser || !TaskDetailProvider.currentTaskId) break;
        const currentTask = await this.getCurrentTaskFromContext();
        if (this.blockReadOnlyMutation(currentTask, 'remove blocks links')) break;
        if (!currentTask) break;

        const localTasks = await this.parser.getTasks();
        const targetTask = localTasks.find((task) => task.id === message.taskId);
        if (!targetTask) break;
        if (this.blockReadOnlyMutation(targetTask, 'remove blocks links')) break;

        if (!targetTask.dependencies.includes(currentTask.id)) break;

        try {
          await this.writer.updateTask(
            targetTask.id,
            { dependencies: targetTask.dependencies.filter((dep) => dep !== currentTask.id) },
            this.parser
          );
          await this.openTask(
            TaskDetailProvider.currentTaskRef ?? { taskId: TaskDetailProvider.currentTaskId },
            { preserveFocus: true }
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update blocked task: ${error}`);
        }
        break;
      }
    }
  }

  /**
   * Handle file conflict when saving changes
   */
  private async handleConflict(field: string, value: unknown): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'This file has been modified externally since you opened it.',
      { modal: true },
      'Reload from Disk',
      'Overwrite Anyway',
      'View Diff'
    );

    const taskId = TaskDetailProvider.currentTaskId;
    if (!taskId || !this.parser) return;

    const task = await this.parser.getTask(taskId);

    switch (choice) {
      case 'Reload from Disk':
        await this.openTask(taskId);
        break;

      case 'Overwrite Anyway': {
        try {
          const updates: Record<string, unknown> = {};
          updates[field] = value;
          await this.writer.updateTask(taskId, updates, this.parser);
          if (task?.filePath && fs.existsSync(task.filePath)) {
            const newContent = fs.readFileSync(task.filePath, 'utf-8');
            TaskDetailProvider.currentFileHash = computeContentHash(newContent);
          }
          await this.openTask(taskId);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to overwrite task: ${error}`);
        }
        break;
      }

      case 'View Diff':
        if (task?.filePath) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(task.filePath));
        }
        break;
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private blockReadOnlyMutation(task: Task | undefined, action: string): boolean {
    if (!task || !isReadOnlyTask(task)) return false;
    vscode.window.showErrorMessage(
      `Cannot ${action}: ${task.id} is read-only from ${getReadOnlyTaskContext(task)}.`
    );
    return true;
  }

  private resolveBacklogPathFromTaskPath(taskFilePath: string): string | undefined {
    let currentDir = path.dirname(taskFilePath);
    while (true) {
      if (path.basename(currentDir) === 'backlog') {
        return currentDir;
      }
      const parent = path.dirname(currentDir);
      if (parent === currentDir) {
        return undefined;
      }
      currentDir = parent;
    }
  }

  private async getCurrentTaskFromContext(): Promise<Task | undefined> {
    if (!this.parser || !TaskDetailProvider.currentTaskId) {
      return undefined;
    }
    if (TaskDetailProvider.currentTaskRef) {
      return this.resolveTaskForOpen(TaskDetailProvider.currentTaskRef);
    }
    return this.parser.getTask(TaskDetailProvider.currentTaskId);
  }
}
