import * as vscode from 'vscode';
import { TasksViewProvider } from './providers/TasksViewProvider';
import { TasksPanelProvider } from './providers/TasksPanelProvider';
import { TaskDetailProvider } from './providers/TaskDetailProvider';
import { ContentDetailProvider } from './providers/ContentDetailProvider';
import { TaskPreviewViewProvider } from './providers/TaskPreviewViewProvider';
import { BacklogParser } from './core/BacklogParser';
import { BacklogWriter } from './core/BacklogWriter';
import { TaskCreatePanel } from './providers/TaskCreatePanel';
import { FileWatcher } from './core/FileWatcher';
import { BacklogCli } from './core/BacklogCli';
import { createDebouncedHandler } from './core/debounce';
import type { TaskSource, DataSourceMode } from './core/types';
import { createBacklogDocumentSelector } from './language/documentSelector';
import { BacklogCompletionProvider } from './language/BacklogCompletionProvider';
import { BacklogDocumentLinkProvider } from './language/BacklogDocumentLinkProvider';
import { BacklogHoverProvider } from './language/BacklogHoverProvider';
import { initializeBacklog, type InitBacklogOptions } from './core/initBacklog';
import { BacklogWorkspaceManager, type BacklogRoot } from './core/BacklogWorkspaceManager';
import { detectPackageManager } from './core/AgentIntegrationDetector';
import { claimTaskForCurrentUser, releaseTaskClaim } from './providers/claimActions';
import { dispatchTask } from './providers/dispatchActions';
import { cancelDispatch } from './core/cancelDispatch';
import { removeWorktree } from './core/finishTask';
import { dispatchBranchName } from './core/dispatchPrompt';
import type { GitExecFn } from './core/WorktreeService';
import { approveMergeInQueue, sendBackMerge } from './providers/mergeActions';
import { categorizeWithClaude } from './providers/intakeActions';
import { attachPlanForTask, detachPlanForTask } from './providers/planActions';
import { writeActiveTask, clearActiveTask } from './core/activeTask';
import * as path from 'path';
import * as fs from 'fs';
import {
  isClaudeCliAvailable,
  isTaskwrightMcpRegistered,
  registerTaskwrightMcp,
  unregisterTaskwrightMcp,
} from './core/claudeMcp';
import { injectConvention } from './core/agentConvention';
import { affectsTaskwrightConfig, getTaskwrightConfig } from './config';
import { installGuard, uninstallGuard, type HookFsDeps } from './core/hookInstaller';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  resolveMergeConfigFromSettings,
  writeMergeConfig,
  mergeConfigPath,
} from './core/mergeConfig';
import { nodeQueueFs, MergeQueueStore, mergeQueuePath, type MergeQueue } from './core/mergeQueue';
import {
  resolveSyncConfigFromSettings,
  writeSyncConfig,
  syncConfigPath,
  type SyncMode,
} from './core/syncConfig';
import { applyBoardIgnore, boardTrackedPaths } from './core/boardMigration';
import { reconcileBoardRef } from './core/boardLifecycle';
import { BoardSyncController } from './providers/BoardSyncController';
import { planStatusSync, parseStatusesLine, rewriteStatusesLine } from './core/mergeStatusConfig';
import type { MergeMode } from './core/mergeQueue';

const execFileAsync = promisify(execFile);

let fileWatcher: FileWatcher | undefined;
let crossBranchStatusBarItem: vscode.StatusBarItem | undefined;
let workspaceStatusBarItem: vscode.StatusBarItem | undefined;
// True once this session has (re-)registered the Taskwright MCP server with
// Claude Code, so deactivate only attempts cleanup for users who set it up.
let claudeMcpRegistered = false;

const GUARD_REL = '.taskwright/hooks/worktree-guard.js';

const guardFs: HookFsDeps = {
  exists: fs.existsSync,
  read: (p) => fs.readFileSync(p, 'utf8'),
  write: (p, c) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  },
};

/**
 * Install or remove the worktree-isolation pre-commit guard for `repoRoot`,
 * per the `taskwright.enforceWorktreeIsolation` setting. When enabling, copy the
 * extension's bundled guard into the repo's gitignored `.taskwright/hooks/` so
 * the hook references a stable in-repo path.
 */
function syncWorktreeGuard(repoRoot: string, extensionUri: vscode.Uri): void {
  try {
    if (!getTaskwrightConfig<boolean>('enforceWorktreeIsolation', true)) {
      uninstallGuard(repoRoot, guardFs);
      return;
    }
    const bundled = path.join(extensionUri.fsPath, 'dist', 'hooks', 'worktree-guard.js');
    if (!fs.existsSync(bundled)) return; // dev build without the bundle yet
    const dest = path.join(repoRoot, GUARD_REL);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(bundled, dest);
    const manager = installGuard(repoRoot, GUARD_REL, guardFs);
    if (manager === 'plain') {
      try {
        fs.chmodSync(path.join(repoRoot, '.git', 'hooks', 'pre-commit'), 0o755);
      } catch {
        /* chmod is a no-op / unsupported on Windows */
      }
    }
  } catch (e) {
    console.warn('[Taskwright] Worktree guard sync failed:', e);
  }
}

/**
 * Publish the merge settings to the shared config file the out-of-process MCP
 * server reads. Written under the git common dir so every worktree sees it.
 */
async function syncMergeConfig(repoRoot: string): Promise<void> {
  let commonDir: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoRoot,
      timeout: 15_000,
    });
    commonDir = path.resolve(repoRoot, stdout.trim());
  } catch {
    return; // not a git repo — nothing to publish
  }
  const cfg = vscode.workspace.getConfiguration('taskwright');
  const merged = resolveMergeConfigFromSettings({
    mode: cfg.get('mergeMode'),
    verifyCommands: cfg.get('mergeVerifyCommands'),
    staleMinutes: cfg.get('mergeQueueStaleMinutes'),
  });
  writeMergeConfig(mergeConfigPath(commonDir), merged, nodeQueueFs);
}

/**
 * Publish taskwright.sync.* to the shared config the out-of-process MCP server
 * reads, so agents' claim_task/release_task route through the sync engine.
 * (Manifest key `sync.pollIntervalSeconds` maps to the config field `pollSeconds`.)
 */
async function publishSyncConfig(repoRoot: string): Promise<void> {
  const commonDir = await resolveCommonDir(repoRoot);
  if (!commonDir) return;
  const cfg = vscode.workspace.getConfiguration('taskwright');
  const merged = resolveSyncConfigFromSettings({
    mode: cfg.get('sync.mode'),
    ref: cfg.get('sync.ref'),
    remote: cfg.get('sync.remote'),
    pollSeconds: cfg.get('sync.pollIntervalSeconds'),
  });
  writeSyncConfig(syncConfigPath(commonDir), merged, nodeQueueFs);
}

/**
 * The one-time, one-consent "move board off code branches" migration + enable.
 * Adds the gitignore block, untracks the board dirs in a single commit, sets the
 * chosen sync mode, publishes the shared config, and seeds/pushes the board ref.
 * Returns the chosen mode, or undefined when the user cancels.
 */
async function runEnableSync(repoRoot: string): Promise<SyncMode | undefined> {
  const pick = await vscode.window.showWarningMessage(
    'Enable Taskwright board sync? This makes ONE commit that moves board task files off your code branches (they will live on the "taskwright-board" ref instead). This removes the read-only cross-branch "ghost" cards. You can pick GitHub sharing or local-only.',
    { modal: true },
    'Enable (GitHub sharing)',
    'Enable (local only)'
  );
  if (!pick) return undefined;
  const mode: SyncMode = pick === 'Enable (GitHub sharing)' ? 'github' : 'local';

  const git = (args: string[]) => execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });

  // 1. Idempotently add the board .gitignore block.
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  fs.writeFileSync(gitignorePath, applyBoardIgnore(existing), 'utf-8');

  // 2. Untrack the board dirs (no-op when already untracked) + commit the move.
  try {
    await git(['rm', '-r', '--cached', '--ignore-unmatch', ...boardTrackedPaths()]);
    await git(['add', '.gitignore']);
    await git(['commit', '-m', 'chore(taskwright): move board off code branches (synced)']);
  } catch (err) {
    // A "nothing to commit" case is fine (already migrated); surface other errors.
    console.warn('[Taskwright] enableSync migration commit skipped/failed:', err);
  }

  // 3. Persist the setting + publish the shared config for the MCP server.
  await vscode.workspace
    .getConfiguration('taskwright')
    .update('sync.mode', mode, vscode.ConfigurationTarget.Workspace);
  await publishSyncConfig(repoRoot);

  // 4. Seed + push the board ref.
  const cfg = vscode.workspace.getConfiguration('taskwright');
  try {
    await reconcileBoardRef({
      repoRoot,
      ref: cfg.get('sync.ref') ?? 'taskwright-board',
      remote: mode === 'github' ? (cfg.get('sync.remote') ?? 'origin') : undefined,
      indexFile: path.join(repoRoot, '.taskwright', 'board.index'),
      backlogDir: 'backlog',
    });
  } catch (err) {
    console.error('[Taskwright] enableSync reconcile failed:', err);
    void vscode.window.showWarningMessage(
      'Board sync enabled locally, but seeding the shared ref failed (check your git remote/credentials). It will retry on the next poll.'
    );
  }
  return mode;
}

/** Resolve the shared git common dir (identical from every worktree). */
async function resolveCommonDir(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoRoot,
      timeout: 15_000,
    });
    return path.resolve(repoRoot, stdout.trim());
  } catch {
    return undefined;
  }
}

/**
 * Ensure `backlog/config.yml` carries the intermediate board status that matches
 * the current `taskwright.mergeMode`, renaming it (and migrating any in-flight
 * task parked in the old intermediate status) when the mode changes. Idempotent:
 * writes only when the statuses line actually differs. Best-effort — never throws
 * into activation.
 */
async function syncMergeStatus(
  backlogPath: string,
  parser: BacklogParser | undefined,
  writer: BacklogWriter,
  onChanged: () => void
): Promise<void> {
  try {
    const configPath = path.join(backlogPath, 'config.yml');
    if (!fs.existsSync(configPath)) return;
    const mode = getTaskwrightConfig<MergeMode>('mergeMode', 'manual-review');
    const text = fs.readFileSync(configPath, 'utf-8');
    const current = parseStatusesLine(text);
    if (current.length === 0) return;
    const plan = planStatusSync(current, mode);
    if (!plan.changed) return;

    fs.writeFileSync(configPath, rewriteStatusesLine(text, plan.statuses), 'utf-8');

    // Migrate any task currently sitting in the old intermediate status.
    if (plan.migrateFrom && plan.migrateTo && parser) {
      const tasks = await parser.getTasks();
      for (const task of tasks) {
        if (task.status === plan.migrateFrom) {
          await writer.updateTask(task.id, { status: plan.migrateTo }, parser);
        }
      }
    }
    onChanged();
  } catch (e) {
    console.warn('[Taskwright] Merge status sync failed:', e);
  }
}

/**
 * The cross-cutting surface both Tasks board hosts (sidebar `TasksViewProvider`
 * and editor-tab `TasksPanelProvider`) expose, so activation can fan updates out
 * to all of them at once instead of poking each by name.
 */
interface TasksBoardSurface {
  refresh(): Promise<void>;
  setParser(parser: BacklogParser): void;
  setWorkspaceRoot(root: string): void;
  setDataSourceMode(mode: DataSourceMode, reason?: string): void;
  setActiveEditedTaskId(taskId: string | null): void;
  checkAndSendIntegrationState(): Promise<void>;
  setMergeQueueReader(reader: () => MergeQueue | undefined): void;
}

export function activate(context: vscode.ExtensionContext) {
  console.log('[Taskwright] Extension activating...');
  console.log('[Taskwright] Extension URI:', context.extensionUri.toString());
  console.log(
    '[Taskwright] Workspace folders:',
    vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath)
  );

  // Initialize workspace manager
  const manager = new BacklogWorkspaceManager(context.workspaceState);
  context.subscriptions.push(manager);
  const activeRoot = manager.initialize();
  manager.startWatching();

  const backlogFolder = activeRoot?.backlogPath;

  if (!backlogFolder) {
    console.log('[Taskwright] No backlog folder found in workspace');
  } else {
    console.log('[Taskwright] Found backlog folder:', backlogFolder);
  }

  // Initialize parser (may be undefined if no backlog folder)
  let parser = activeRoot
    ? new BacklogParser(
        activeRoot.backlogPath,
        activeRoot.configPath,
        activeRoot.workspaceFolder.uri.fsPath
      )
    : undefined;

  // Language providers: re-registered on backlog switch (selector varies per backlog dir)
  let completionProvider: BacklogCompletionProvider | undefined;
  let linkProvider: BacklogDocumentLinkProvider | undefined;
  let hoverProvider: BacklogHoverProvider | undefined;
  let languageProviderDisposables: vscode.Disposable[] = [];

  // Ensure language provider registrations are cleaned up on deactivation
  context.subscriptions.push({
    dispose: () => languageProviderDisposables.forEach((d) => d.dispose()),
  });

  function registerLanguageProviders(activeParser: BacklogParser, backlogDir: string) {
    for (const d of languageProviderDisposables) d.dispose();
    languageProviderDisposables = [];

    const selector = createBacklogDocumentSelector(backlogDir);
    completionProvider = new BacklogCompletionProvider(activeParser);
    linkProvider = new BacklogDocumentLinkProvider(activeParser);
    hoverProvider = new BacklogHoverProvider(activeParser);

    languageProviderDisposables.push(
      vscode.languages.registerCompletionItemProvider(
        selector,
        completionProvider,
        '-' // Trigger on '-' for task ID prefixes like TASK-
      ),
      vscode.languages.registerDocumentLinkProvider(selector, linkProvider),
      vscode.languages.registerHoverProvider(selector, hoverProvider)
    );
    console.log('[Taskwright] Language providers registered for:', backlogDir);
  }

  if (parser && activeRoot) {
    console.log('[Taskwright] Parser initialized');
    registerLanguageProviders(parser, activeRoot.backlogDir);
  }

  // Initialize file watcher (only if backlog folder exists)
  if (backlogFolder) {
    fileWatcher = new FileWatcher(backlogFolder);
    console.log('[Taskwright] File watcher initialized');
    context.subscriptions.push(fileWatcher);
  }

  // Register Tasks view provider (unified Kanban + List view)
  const tasksProvider = new TasksViewProvider(context.extensionUri, parser, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('taskwright.kanban', tasksProvider)
  );
  console.log('[Taskwright] Tasks view provider registered');

  // Editor-tab host for the same Tasks board (opened on demand, synced via disk)
  const tasksPanelProvider = new TasksPanelProvider(context.extensionUri, parser, context);
  context.subscriptions.push(tasksPanelProvider);

  // Both Tasks board surfaces (sidebar + editor tab) are driven together — fan
  // every cross-cutting update out to all of them so they stay in sync.
  const tasksHosts: TasksBoardSurface[] = [tasksProvider, tasksPanelProvider];
  const workspaceRootPath = activeRoot?.workspaceFolder?.uri.fsPath;
  if (workspaceRootPath) {
    tasksHosts.forEach((host) => host.setWorkspaceRoot(workspaceRootPath));
  }

  if (workspaceRootPath) {
    syncWorktreeGuard(workspaceRootPath, context.extensionUri);
    void syncMergeConfig(workspaceRootPath);
    void publishSyncConfig(workspaceRootPath);
  }

  // Synced-board controller: reconcile the board ref, poll the shared remote to
  // reflect teammates' changes, and reflect state in the status bar. No-ops when
  // taskwright.sync.mode is 'off'. Refreshing the board hosts materializes any
  // incoming changes into the UI.
  let boardSync: BoardSyncController | undefined;
  if (workspaceRootPath) {
    boardSync = new BoardSyncController(workspaceRootPath, () =>
      tasksHosts.forEach((host) => host.refresh())
    );
    context.subscriptions.push(boardSync);
    void boardSync.start();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.enableSync', async () => {
      if (!workspaceRootPath) {
        void vscode.window.showWarningMessage('Open a Taskwright workspace folder first.');
        return;
      }
      const mode = await runEnableSync(workspaceRootPath);
      if (!mode) return;
      await boardSync?.start(); // restart with the new mode
      tasksHosts.forEach((host) => host.refresh());
      void vscode.window.showInformationMessage(
        mode === 'github'
          ? 'Taskwright board sync enabled (GitHub). Claims are now collision-proof across sessions and machines.'
          : 'Taskwright board sync enabled (local). Cross-branch ghost cards are gone; enable GitHub sharing later to sync with others.'
      );
    })
  );

  // Merge-queue board enrichment: resolve the shared queue location once, inject
  // a reader into both board hosts, and watch the queue file so out-of-process
  // mutations (request_merge merging/dequeuing, approve/send-back) refresh the
  // board without a manual reload.
  if (workspaceRootPath) {
    void (async () => {
      const commonDir = await resolveCommonDir(workspaceRootPath);
      if (!commonDir) return;
      const store = new MergeQueueStore(mergeQueuePath(commonDir), nodeQueueFs);
      const reader = (): MergeQueue => store.read();
      tasksHosts.forEach((host) => host.setMergeQueueReader(reader));
      tasksHosts.forEach((host) => host.refresh());

      const queueFile = mergeQueuePath(commonDir);
      const onQueueChange = () => tasksHosts.forEach((host) => host.refresh());
      // The queue lives inside .git (outside the workspace + in VS Code's default
      // watcher-exclude), so vscode.workspace.createFileSystemWatcher never fires for
      // it. Poll it with fs.watchFile instead — it also tolerates the file not
      // existing until the first enqueue. Refreshes the board when another session's
      // request_merge mutates the queue out-of-process.
      fs.watchFile(queueFile, { interval: 1000 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) onQueueChange();
      });
      context.subscriptions.push({ dispose: () => fs.unwatchFile(queueFile) });
    })();
  }

  const taskPreviewProvider = new TaskPreviewViewProvider(
    context.extensionUri,
    parser,
    context,
    () => tasksHosts.forEach((host) => host.refresh())
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('taskwright.taskPreview', taskPreviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  tasksProvider.setTaskSelectionHandler((taskRef) => taskPreviewProvider.selectTask(taskRef));
  console.log('[Taskwright] Task preview view provider registered');

  // Create Task Detail provider for opening task details in editor
  const taskDetailProvider = new TaskDetailProvider(context.extensionUri, parser);
  if (backlogFolder) {
    taskDetailProvider.setBacklogPath(backlogFolder);
  }
  console.log('[Taskwright] Task detail provider created');

  // Track active edited task for board highlighting and routing
  TaskDetailProvider.onActiveTaskChanged((taskId) => {
    tasksHosts.forEach((host) => host.setActiveEditedTaskId(taskId));
  });

  // Create Content Detail provider for opening docs/decisions in editor
  const contentDetailProvider = new ContentDetailProvider(context.extensionUri, parser);
  console.log('[Taskwright] Content detail provider created');

  // --- switchActiveBacklog: consolidated reinit logic ---
  function switchActiveBacklog(root: BacklogRoot | undefined) {
    if (!root) return;

    console.log('[Taskwright] Switching active backlog to:', root.backlogPath);

    // Dispose old file watcher
    if (fileWatcher) {
      fileWatcher.dispose();
    }

    // Create new parser and file watcher
    parser = new BacklogParser(root.backlogPath, root.configPath, root.workspaceFolder.uri.fsPath);
    fileWatcher = new FileWatcher(root.backlogPath);
    context.subscriptions.push(fileWatcher);

    // Wire debounced refresh
    const debouncedRefresh = createDebouncedHandler((uri: vscode.Uri) => {
      console.log('[Taskwright] Debounced refresh triggered');
      tasksHosts.forEach((host) => host.refresh());
      taskPreviewProvider.refresh();
      TaskDetailProvider.onFileChanged(uri, taskDetailProvider);
    }, 300);
    fileWatcher.onDidChange((uri) => {
      debouncedRefresh(uri);
    });

    // Update all view providers
    if (root.workspaceFolder) {
      const fsPath = root.workspaceFolder.uri.fsPath;
      tasksHosts.forEach((host) => host.setWorkspaceRoot(fsPath));
    }
    tasksHosts.forEach((host) => host.setParser(parser!));
    taskPreviewProvider.setParser(parser);
    taskDetailProvider.setParser(parser);
    taskDetailProvider.setBacklogPath(root.backlogPath);
    contentDetailProvider.setParser(parser);

    // Re-register language providers (selector may differ per backlog dir)
    registerLanguageProviders(parser, root.backlogDir);

    // Refresh views
    tasksHosts.forEach((host) => host.refresh());

    // Check cross-branch config for the new root
    checkCrossBranchConfig(parser, context, tasksHosts);

    // Check agent integration status for the new root
    tasksHosts.forEach((host) => host.checkAndSendIntegrationState());

    // Update workspace status bar
    updateWorkspaceStatusBar(manager);
  }

  // Subscribe to active root changes (e.g. from selectBacklog or addRoot)
  context.subscriptions.push(
    manager.onDidChangeActiveRoot((root) => {
      switchActiveBacklog(root);
    })
  );

  // --- Workspace status bar (shown when multiple roots) ---
  function updateWorkspaceStatusBar(mgr: BacklogWorkspaceManager) {
    const roots = mgr.getRoots();
    if (roots.length <= 1) {
      workspaceStatusBarItem?.hide();
      return;
    }
    if (!workspaceStatusBarItem) {
      workspaceStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        99
      );
      workspaceStatusBarItem.command = 'taskwright.selectBacklog';
      context.subscriptions.push(workspaceStatusBarItem);
    }
    const active = mgr.getActiveRoot();
    workspaceStatusBarItem.text = `$(checklist) ${active?.label ?? 'No backlog'}`;
    workspaceStatusBarItem.tooltip = active
      ? `${active.backlogPath} — Click to switch`
      : 'Click to select a backlog';
    workspaceStatusBarItem.show();
  }
  updateWorkspaceStatusBar(manager);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.openKanban', () => {
      vscode.commands.executeCommand('taskwright.kanban.focus');
    })
  );

  // Open the Tasks board as a full editor tab (synced with the sidebar)
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.openTasksInEditor', () => {
      tasksPanelProvider.reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.openTaskList', () => {
      vscode.commands.executeCommand('taskwright.taskList.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.openDashboard', () => {
      tasksProvider.setViewMode('dashboard');
      vscode.commands.executeCommand('taskwright.kanban.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.refresh', () => {
      tasksHosts.forEach((host) => host.refresh());
    })
  );

  // Register 3-way view mode toggle commands (kanban | list | drafts)
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.showListView', () => {
      tasksProvider.setViewMode('list');
      vscode.commands.executeCommand('setContext', 'backlog.viewMode', 'list');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.showKanbanView', () => {
      tasksProvider.setViewMode('kanban');
      vscode.commands.executeCommand('setContext', 'backlog.viewMode', 'kanban');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.showDraftsView', () => {
      tasksProvider.setViewMode('drafts');
      vscode.commands.executeCommand('setContext', 'backlog.viewMode', 'drafts');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.showArchivedView', () => {
      tasksProvider.setViewMode('archived');
      vscode.commands.executeCommand('setContext', 'backlog.viewMode', 'archived');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.showDocsView', () => {
      tasksProvider.setViewMode('docs');
      vscode.commands.executeCommand('setContext', 'backlog.viewMode', 'docs');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.showDecisionsView', () => {
      tasksProvider.setViewMode('decisions');
      vscode.commands.executeCommand('setContext', 'backlog.viewMode', 'decisions');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.openDocumentDetail', (docId: string) => {
      contentDetailProvider.openDocument(docId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.openDecisionDetail', (decisionId: string) => {
      contentDetailProvider.openDecision(decisionId);
    })
  );

  // Initialize context for view mode: derive from saved state
  const savedDraftsMode = context.globalState.get<boolean>('backlog.showingDrafts', false);
  const savedViewMode = savedDraftsMode
    ? 'drafts'
    : context.globalState.get<
        'kanban' | 'list' | 'drafts' | 'archived' | 'dashboard' | 'docs' | 'decisions'
      >('backlog.viewMode', 'kanban');
  vscode.commands.executeCommand('setContext', 'backlog.viewMode', savedViewMode);

  // Register filter by status command (used by dashboard clickable cards)
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.filterByStatus', (status: string) => {
      const filter = status ? `status:${status}` : 'all';

      // Switch to list view and apply filter
      tasksProvider.setViewMode('list');
      vscode.commands.executeCommand('setContext', 'backlog.viewMode', 'list');
      tasksProvider.setFilter(filter);
    })
  );

  // Register filter by label command (used by task detail clickable labels)
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.filterByLabel', (label: string) => {
      // Switch to list view and apply label filter
      tasksProvider.setViewMode('list');
      vscode.commands.executeCommand('setContext', 'backlog.viewMode', 'list');
      tasksProvider.setLabelFilter(label);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'taskwright.openTaskDetail',
      (
        task: string | { taskId: string; filePath?: string; source?: TaskSource; branch?: string },
        options?: { preserveFocus?: boolean; viewColumn?: vscode.ViewColumn }
      ) => {
        taskDetailProvider.openTask(task, options);
      }
    )
  );

  // Register open markdown command
  const openMarkdownCommand = async () => {
    const taskId = TaskDetailProvider.getCurrentTaskId();
    if (!taskId) {
      vscode.window.showInformationMessage('No task is currently open');
      return;
    }
    if (!parser) {
      vscode.window.showErrorMessage('No backlog folder found');
      return;
    }
    const task = await parser.getTask(taskId);
    if (task?.filePath) {
      vscode.commands.executeCommand('vscode.open', vscode.Uri.file(task.filePath));
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.openMarkdown', openMarkdownCommand)
  );

  // Backward-compatible alias for older keybindings/macros
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.openRawMarkdown', openMarkdownCommand)
  );

  // Register taskwright.selectBacklog command
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.selectBacklog', async () => {
      await manager.selectBacklog();
    })
  );

  // Register backlog init command
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.init', async (args?: { defaults?: boolean }) => {
      // Get workspace root
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
        return;
      }

      let selectedFolder: vscode.WorkspaceFolder;
      if (workspaceFolders.length === 1) {
        selectedFolder = workspaceFolders[0];
      } else {
        const picked = await vscode.window.showWorkspaceFolderPick({
          placeHolder: 'Select workspace folder to initialize backlog in',
        });
        if (!picked) return;
        selectedFolder = picked;
      }

      // Check if this specific folder already has a backlog
      const { resolveBacklogDirectory } = await import('./core/resolveBacklogDirectory.js');
      const existingResolution = resolveBacklogDirectory(selectedFolder.uri.fsPath);
      if (existingResolution.backlogPath) {
        const { existsSync } = await import('fs');
        if (existsSync(existingResolution.backlogPath)) {
          vscode.window.showInformationMessage(
            `A backlog folder already exists in ${selectedFolder.name} at ${existingResolution.backlogDir}/.`
          );
          return;
        }
      }

      const workspaceRoot = selectedFolder.uri.fsPath;
      let options: InitBacklogOptions;

      if (args?.defaults) {
        // Quick init with defaults
        const folderName = workspaceRoot.split(/[\\/]/).pop() || 'My Project';
        options = {
          projectName: folderName,
          taskPrefix: 'task',
          statuses: ['To Do', 'In Progress', 'Done'],
        };
      } else {
        // Customization wizard
        const folderName = workspaceRoot.split(/[\\/]/).pop() || 'My Project';

        const projectName = await vscode.window.showInputBox({
          prompt: 'Project name',
          value: folderName,
          validateInput: (value) => (value.trim() ? null : 'Project name cannot be empty'),
        });
        if (projectName === undefined) return;

        const taskPrefix = await vscode.window.showInputBox({
          prompt: 'Task ID prefix (letters only, e.g. "task" → TASK-1)',
          value: 'task',
          validateInput: (value) =>
            /^[a-zA-Z]+$/.test(value) ? null : 'Prefix must contain only letters (a-z, A-Z)',
        });
        if (taskPrefix === undefined) return;

        const statusesInput = await vscode.window.showInputBox({
          prompt: 'Statuses (comma-separated)',
          value: 'To Do, In Progress, Done',
          validateInput: (value) => {
            const items = value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            return items.length >= 2 ? null : 'At least 2 statuses required';
          },
        });
        if (statusesInput === undefined) return;

        options = {
          projectName: projectName.trim(),
          taskPrefix: taskPrefix.trim(),
          statuses: statusesInput
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        };

        // Advanced settings wizard (matches upstream advanced-config-wizard flow)
        const advancedChoice = await vscode.window.showQuickPick(['No', 'Yes'], {
          placeHolder: 'Configure advanced settings now?',
        });
        if (advancedChoice === undefined) return;

        if (advancedChoice === 'Yes') {
          // Cross-branch tracking
          const crossBranch = await vscode.window.showQuickPick(['Yes', 'No'], {
            placeHolder: 'Check task states across active branches?',
          });
          if (crossBranch === undefined) return;
          options.checkActiveBranches = crossBranch === 'Yes';

          if (options.checkActiveBranches) {
            const remoteOps = await vscode.window.showQuickPick(['Yes', 'No'], {
              placeHolder: 'Check task states in remote branches?',
            });
            if (remoteOps === undefined) return;
            options.remoteOperations = remoteOps === 'Yes';

            const branchDays = await vscode.window.showInputBox({
              prompt: 'How many days should a branch be considered active?',
              value: '30',
              validateInput: (value) => {
                const n = parseInt(value, 10);
                return n >= 1 && n <= 365 ? null : 'Enter a number between 1 and 365';
              },
            });
            if (branchDays === undefined) return;
            options.activeBranchDays = parseInt(branchDays, 10);
          }

          // Git settings
          const bypassHooks = await vscode.window.showQuickPick(['No', 'Yes'], {
            placeHolder: 'Bypass git hooks when committing?',
          });
          if (bypassHooks === undefined) return;
          options.bypassGitHooks = bypassHooks === 'Yes';

          const autoCommit = await vscode.window.showQuickPick(['No', 'Yes'], {
            placeHolder: 'Enable automatic commits for Backlog operations?',
          });
          if (autoCommit === undefined) return;
          options.autoCommit = autoCommit === 'Yes';

          // Zero-padded IDs
          const zeroPadded = await vscode.window.showQuickPick(['No', 'Yes'], {
            placeHolder: 'Enable zero-padded IDs for consistent formatting? (e.g. TASK-001)',
          });
          if (zeroPadded === undefined) return;

          if (zeroPadded === 'Yes') {
            const padWidth = await vscode.window.showInputBox({
              prompt: 'Number of digits for zero-padding (e.g. 3 → TASK-001)',
              value: '3',
              validateInput: (value) => {
                const n = parseInt(value, 10);
                return n >= 1 && n <= 10 ? null : 'Enter a number between 1 and 10';
              },
            });
            if (padWidth === undefined) return;
            options.zeroPaddedIds = parseInt(padWidth, 10);
          }

          // Editor
          const editorCmd = await vscode.window.showInputBox({
            prompt: 'Default editor command (leave blank to use system default)',
            placeHolder: "e.g. 'code --wait', 'vim', 'nano'",
            value: '',
          });
          if (editorCmd === undefined) return;
          if (editorCmd.trim()) {
            options.defaultEditor = editorCmd.trim();
          }

          // Web UI settings
          const webUi = await vscode.window.showQuickPick(['No', 'Yes'], {
            placeHolder: 'Configure web UI settings now?',
          });
          if (webUi === undefined) return;

          if (webUi === 'Yes') {
            const port = await vscode.window.showInputBox({
              prompt: 'Default web UI port',
              value: '6420',
              validateInput: (value) => {
                const n = parseInt(value, 10);
                return n >= 1 && n <= 65535 ? null : 'Enter a port between 1 and 65535';
              },
            });
            if (port === undefined) return;
            options.defaultPort = parseInt(port, 10);

            const autoOpen = await vscode.window.showQuickPick(['Yes', 'No'], {
              placeHolder: 'Automatically open browser when starting web UI?',
            });
            if (autoOpen === undefined) return;
            options.autoOpenBrowser = autoOpen === 'Yes';
          }
        }
      }

      try {
        const newBacklogPath = initializeBacklog(workspaceRoot, options);
        console.log('[Taskwright] Backlog initialized at:', newBacklogPath);

        // Add the new root to the manager — this fires onDidChangeActiveRoot → switchActiveBacklog
        manager.addRoot({
          backlogPath: newBacklogPath,
          backlogDir: 'backlog', // init always creates backlog/
          workspaceFolder: selectedFolder,
          label: selectedFolder.name,
        });

        vscode.window.showInformationMessage(`Backlog initialized in ${newBacklogPath}`);

        // Check agent integration after init (switchActiveBacklog already fires,
        // but we also need to check in case the view was already resolved)
        tasksProvider.checkAndSendIntegrationState();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to initialize backlog: ${error}`);
      }
    })
  );

  // Register agent integration setup command
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.setupAgentIntegration', async () => {
      const cliResult = await BacklogCli.isAvailable();

      if (cliResult.available) {
        // CLI available — run backlog init in terminal (re-init shows integration wizard)
        const terminal = vscode.window.createTerminal('Taskwright Agent Setup');
        terminal.show();
        terminal.sendText('backlog init');
        return;
      }

      // CLI not available — detect package manager and offer install
      const pm = await detectPackageManager();

      if (pm) {
        const installCmd =
          pm === 'bun'
            ? 'bun install -g backlog.md && backlog init'
            : 'npm install -g backlog.md && backlog init';

        const terminal = vscode.window.createTerminal('Taskwright Agent Setup');
        terminal.show();
        terminal.sendText(installCmd);
      } else {
        // No package manager found — offer to open documentation
        const selection = await vscode.window.showInformationMessage(
          'No package manager (bun or npm) found. Install Backlog.md CLI manually to set up agent integration.',
          'Open Documentation'
        );
        if (selection === 'Open Documentation') {
          vscode.env.openExternal(vscode.Uri.parse('https://github.com/MrLesk/Backlog.md'));
        }
      }
    })
  );

  // Register create task command (opens form to create a draft)
  const writer = new BacklogWriter();
  const activeBacklogForStatus = manager.getActiveRoot()?.backlogPath;
  if (activeBacklogForStatus) {
    void syncMergeStatus(activeBacklogForStatus, parser, writer, () =>
      tasksHosts.forEach((host) => host.refresh())
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.createTask', () => {
      const activeBacklogPath = manager.getActiveRoot()?.backlogPath;
      if (!activeBacklogPath || !parser) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }

      TaskCreatePanel.show(context.extensionUri, writer, parser, activeBacklogPath, {
        tasksProvider,
        taskDetailProvider,
      });
    })
  );

  // Register create milestone command
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.createMilestone', async () => {
      const activeBacklogPath = manager.getActiveRoot()?.backlogPath;
      if (!activeBacklogPath || !parser) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }

      const title = await vscode.window.showInputBox({
        prompt: 'Enter milestone title',
        placeHolder: 'e.g., v1.0 Launch',
        ignoreFocusOut: true,
      });
      const normalizedTitle = title?.trim();
      if (!normalizedTitle) {
        return;
      }

      try {
        const milestone = await writer.createMilestone(
          activeBacklogPath,
          normalizedTitle,
          undefined,
          parser
        );
        parser.invalidateMilestoneCache();
        vscode.window.showInformationMessage(`Created milestone "${milestone.name}"`);
        tasksProvider.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to create milestone: ${error}`);
      }
    })
  );

  // Register claim / release commands. Both target an explicit task ID argument
  // (e.g. from a future context menu) or fall back to the task open in the
  // detail panel. The file watcher refreshes the board/preview/detail after the
  // claim file is written; we also refresh eagerly for immediate feedback.
  const refreshAllViews = (): void => {
    tasksHosts.forEach((host) => host.refresh());
    taskPreviewProvider.refresh();
  };
  const resolveClaimTarget = (arg: unknown): string | undefined => {
    if (typeof arg === 'string' && arg.trim()) return arg;
    if (arg && typeof arg === 'object' && typeof (arg as { taskId?: string }).taskId === 'string') {
      return (arg as { taskId: string }).taskId;
    }
    return TaskDetailProvider.getCurrentTaskId();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.claimTask', async (arg?: unknown) => {
      if (!parser) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }
      const taskId = resolveClaimTarget(arg);
      if (!taskId) {
        vscode.window.showInformationMessage('Open a task to claim it.');
        return;
      }
      try {
        const claim = await claimTaskForCurrentUser(taskId, parser);
        if (!claim) return;
        refreshAllViews();
        vscode.window.showInformationMessage(`Claimed ${taskId} as ${claim.claimedBy}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to claim task: ${error}`);
      }
    }),
    vscode.commands.registerCommand('taskwright.forceClaimTask', async (arg?: unknown) => {
      if (!parser) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }
      const taskId = resolveClaimTarget(arg);
      if (!taskId) {
        vscode.window.showInformationMessage('Open a task to force-claim it.');
        return;
      }
      try {
        const claim = await claimTaskForCurrentUser(taskId, parser, { force: true });
        if (!claim) return;
        refreshAllViews();
        vscode.window.showInformationMessage(`Force-claimed ${taskId} as ${claim.claimedBy}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to force-claim task: ${error}`);
      }
    }),
    vscode.commands.registerCommand('taskwright.releaseTask', async (arg?: unknown) => {
      if (!parser) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }
      const taskId = resolveClaimTarget(arg);
      if (!taskId) {
        vscode.window.showInformationMessage('Open a task to release it.');
        return;
      }
      try {
        await releaseTaskClaim(taskId, parser);
        refreshAllViews();
        vscode.window.showInformationMessage(`Released ${taskId}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to release task: ${error}`);
      }
    })
  );

  // Cancel dispatch (P2 spec §7, v1): reverse a dispatch by releasing the claim,
  // resetting the task to the first configured status, removing its worktree, and
  // disposing the terminal the extension launched. Orchestrated by the pure
  // cancelDispatch core; this wires the real deps.
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.cancelDispatch', async (arg: unknown) => {
      const taskId = resolveClaimTarget(arg);
      if (!taskId || !parser) return;
      // Alias the guarded parser to a const so the injected closures below keep
      // the non-undefined narrowing (the module `parser` let is reassigned elsewhere).
      const activeParser = parser;
      const task = await activeParser.getTask(taskId);
      if (!task) return;
      const confirm = await vscode.window.showWarningMessage(
        `Cancel dispatch for ${taskId}? This releases the claim, resets it to To Do, and removes its worktree.`,
        { modal: true },
        'Cancel dispatch'
      );
      if (confirm !== 'Cancel dispatch') return;

      const branch = dispatchBranchName(task);
      const statuses = await activeParser.getStatuses();
      const toDo = statuses[0] ?? 'To Do';
      const repoRoot = path.dirname(activeParser.getBacklogPath());
      const exec: GitExecFn = (cwd, args) =>
        execFileAsync('git', args, { cwd, timeout: 15_000 }).then((r) => ({
          stdout: r.stdout,
          stderr: r.stderr,
        }));

      await cancelDispatch(
        {
          releaseClaim: (id) => releaseTaskClaim(id, activeParser),
          setStatus: (id, status) => writer.updateTask(id, { status }, activeParser),
          removeWorktree: (rel) => removeWorktree(exec, repoRoot, rel),
          disposeTerminal: (name) =>
            vscode.window.terminals.find((t) => t.name === name)?.dispose(),
        },
        { taskId, branch, toDoStatus: toDo, terminalName: `Taskwright ${taskId}` }
      );

      refreshAllViews();
      TaskDetailProvider.refreshCurrent(taskDetailProvider);
      vscode.window.showInformationMessage(
        `Cancelled dispatch for ${taskId}: released claim, reset to ${toDo}, removed worktree.`
      );
    })
  );

  // Register set/clear active-task commands. The active task is Taskwright's
  // pull-based handoff: it is written to <root>/.taskwright/active-task.json so
  // the Taskwright MCP server's get_active_task can read it back in a session.
  const activeRootDir = (): string | undefined => {
    const backlogPath = manager.getActiveRoot()?.backlogPath;
    return backlogPath ? path.dirname(backlogPath) : undefined;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.setActiveTask', async (arg?: unknown) => {
      const root = activeRootDir();
      if (!root) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }
      const taskId = resolveClaimTarget(arg);
      if (!taskId) {
        vscode.window.showInformationMessage('Open a task to set it active.');
        return;
      }
      try {
        writeActiveTask(root, taskId);
        refreshAllViews();
        TaskDetailProvider.refreshCurrent(taskDetailProvider);
        vscode.window.showInformationMessage(`${taskId} is now the active task for agents.`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to set active task: ${error}`);
      }
    }),
    vscode.commands.registerCommand('taskwright.clearActiveTask', () => {
      const root = activeRootDir();
      if (!root) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }
      try {
        clearActiveTask(root);
        refreshAllViews();
        TaskDetailProvider.refreshCurrent(taskDetailProvider);
        vscode.window.showInformationMessage('Cleared the active task.');
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to clear active task: ${error}`);
      }
    })
  );

  // Subscription-safe dispatch: render a paste-ready prompt for a task (and
  // optionally an isolated worktree + active-task handoff), copy it to the
  // clipboard. Never spawns `claude -p` — the user pastes it into a fresh session.
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.dispatchTask', async (arg?: unknown) => {
      if (!parser) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }
      const taskId = resolveClaimTarget(arg);
      if (!taskId) {
        vscode.window.showInformationMessage('Open a task to dispatch it.');
        return;
      }
      try {
        const result = await dispatchTask(taskId, parser);
        if (!result) return;
        refreshAllViews();
        TaskDetailProvider.refreshCurrent(taskDetailProvider);
        const detail = result.worktreePath
          ? `Prompt copied to clipboard. Worktree: ${result.worktreePath}`
          : 'Prompt copied to clipboard. Paste it into a fresh Claude Code session.';
        const choice = await vscode.window.showInformationMessage(
          `Dispatched ${taskId}. ${detail}`,
          'Open handoff'
        );
        if (choice === 'Open handoff') {
          const doc = await vscode.workspace.openTextDocument(result.handoffFile);
          await vscode.window.showTextDocument(doc);
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to dispatch task: ${error}`);
      }
    })
  );

  // Merge-queue review: approve a queued task (grants the manual-review gate)
  // or send it back (dequeues + resets the board status to In Progress).
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.approveMerge', async (arg?: unknown) => {
      const taskId = resolveClaimTarget(arg);
      if (!taskId || !workspaceRootPath) {
        vscode.window.showInformationMessage('Open a task awaiting review to approve it.');
        return;
      }
      const commonDir = await resolveCommonDir(workspaceRootPath);
      if (!commonDir) {
        vscode.window.showErrorMessage('Not a git repository — no merge queue to approve.');
        return;
      }
      try {
        approveMergeInQueue(commonDir, taskId);
        refreshAllViews();
        TaskDetailProvider.refreshCurrent(taskDetailProvider);
        vscode.window.showInformationMessage(`Approved ${taskId} — the agent will merge it.`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to approve merge: ${error}`);
      }
    }),
    vscode.commands.registerCommand('taskwright.sendBackMerge', async (arg?: unknown) => {
      const taskId = resolveClaimTarget(arg);
      if (!taskId || !workspaceRootPath || !parser) {
        vscode.window.showInformationMessage('Open a task awaiting review to send it back.');
        return;
      }
      const commonDir = await resolveCommonDir(workspaceRootPath);
      if (!commonDir) {
        vscode.window.showErrorMessage('Not a git repository — no merge queue to update.');
        return;
      }
      try {
        await sendBackMerge(commonDir, taskId, parser, writer);
        refreshAllViews();
        TaskDetailProvider.refreshCurrent(taskDetailProvider);
        vscode.window.showInformationMessage(`Sent ${taskId} back to In Progress.`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to send back: ${error}`);
      }
    })
  );

  // Superpowers bridge: attach / detach a task's implementation plan so the
  // board tracks plan progress.
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.attachPlan', async (arg?: unknown) => {
      if (!parser) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }
      const taskId = resolveClaimTarget(arg);
      if (!taskId) {
        vscode.window.showInformationMessage('Open a task to attach a plan.');
        return;
      }
      try {
        const stored = await attachPlanForTask(taskId, parser);
        if (!stored) return;
        refreshAllViews();
        TaskDetailProvider.refreshCurrent(taskDetailProvider);
        vscode.window.showInformationMessage(`Attached plan ${stored} to ${taskId}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to attach plan: ${error}`);
      }
    }),
    vscode.commands.registerCommand('taskwright.detachPlan', async (arg?: unknown) => {
      if (!parser) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }
      const taskId = resolveClaimTarget(arg);
      if (!taskId) {
        vscode.window.showInformationMessage('Open a task to detach its plan.');
        return;
      }
      try {
        await detachPlanForTask(taskId, parser);
        refreshAllViews();
        TaskDetailProvider.refreshCurrent(taskDetailProvider);
        vscode.window.showInformationMessage(`Detached the plan from ${taskId}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to detach plan: ${error}`);
      }
    })
  );

  // Intake: turn the raw bug/improvement notes in the active editor into a
  // paste-ready "categorize these into Backlog.md tasks" prompt on the clipboard.
  // Subscription-safe — never spawns `claude -p`.
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.categorizeWithClaude', async () => {
      if (!parser) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }
      try {
        const result = await categorizeWithClaude(parser);
        if (!result) return;
        const choice = await vscode.window.showInformationMessage(
          'Categorization prompt copied to clipboard. Paste it into a Claude Code session to create the tasks.',
          'Open handoff'
        );
        if (choice === 'Open handoff') {
          const doc = await vscode.workspace.openTextDocument(result.handoffFile);
          await vscode.window.showTextDocument(doc);
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to build categorization prompt: ${error}`);
      }
    })
  );

  // Claude Code integration: register the bundled Taskwright MCP server with
  // Claude Code (user scope, via its CLI) and offer to add the agent convention
  // to CLAUDE.md so sessions actually call get_active_task / claim_task.
  const CLAUDE_SETUP_DISMISSED_KEY = 'taskwright.claudeSetupDismissed';
  // Set once the user opts into MCP integration; drives the deactivate cleanup
  // and the on-activate refresh below.
  const CLAUDE_MCP_REGISTERED_KEY = 'taskwright.mcpRegistered';
  const mcpServerPath = path.join(context.extensionPath, 'dist', 'mcp', 'server.js');
  const setUpClaudeIntegration = async (): Promise<void> => {
    const root = activeRootDir();
    if (!root) {
      vscode.window.showErrorMessage('No backlog folder found in workspace');
      return;
    }
    if (!fs.existsSync(mcpServerPath)) {
      vscode.window.showErrorMessage(
        'The Taskwright MCP server bundle (dist/mcp/server.js) is missing. Reinstall or rebuild the extension.'
      );
      return;
    }

    // 1) Register the MCP server with Claude Code at user scope.
    if (await isClaudeCliAvailable()) {
      try {
        await registerTaskwrightMcp(mcpServerPath);
        // Stop the activation prompt from re-checking the CLI on every launch.
        await context.globalState.update(CLAUDE_SETUP_DISMISSED_KEY, true);
        await context.globalState.update(CLAUDE_MCP_REGISTERED_KEY, true);
        claudeMcpRegistered = true;
        vscode.window.showInformationMessage(
          'Registered the Taskwright MCP server with Claude Code (user scope). Restart Claude Code to load it.'
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to register the Taskwright MCP server: ${error}`);
      }
    } else {
      vscode.window.showWarningMessage(
        'Claude Code CLI not found on PATH — skipped MCP registration. Install Claude Code, then run "Taskwright: Set Up Claude Code Integration (MCP + CLAUDE.md)" again.'
      );
    }

    // 2) Offer to add the agent convention to CLAUDE.md (idempotent, preserves
    // existing content — only a marked block is written).
    const claudeMdPath = path.join(root, 'CLAUDE.md');
    const existed = fs.existsSync(claudeMdPath);
    const existing = existed ? fs.readFileSync(claudeMdPath, 'utf-8') : '';
    const updated = injectConvention(existing);
    if (updated === existing) {
      if (existed) {
        vscode.window.showInformationMessage('CLAUDE.md already has the Taskwright instructions.');
      }
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      existed
        ? 'Add Taskwright agent instructions to your CLAUDE.md? Only a marked block is added — your existing content is preserved.'
        : 'Create a CLAUDE.md with Taskwright agent instructions so Claude Code uses the MCP server?',
      { modal: true },
      'Add'
    );
    if (choice === 'Add') {
      try {
        fs.writeFileSync(claudeMdPath, updated, 'utf-8');
        vscode.window.showInformationMessage(
          `${existed ? 'Updated' : 'Created'} CLAUDE.md with Taskwright agent instructions.`
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update CLAUDE.md: ${error}`);
      }
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.setupClaudeIntegration', setUpClaudeIntegration)
  );

  // Once the user has opted into MCP integration, refresh the registration on
  // every activation. This (a) re-points it at the current build after an
  // extension update moves the install directory, and (b) restores it after a
  // window reload — deactivate best-effort-removes the entry, and this re-adds
  // it. Fire-and-forget so it never blocks activation.
  if (context.globalState.get<boolean>(CLAUDE_MCP_REGISTERED_KEY)) {
    claudeMcpRegistered = true;
    void (async () => {
      if (!fs.existsSync(mcpServerPath)) return;
      if (!(await isClaudeCliAvailable())) return;
      try {
        await registerTaskwrightMcp(mcpServerPath);
      } catch {
        // Best-effort refresh; a failure just leaves the prior registration in place.
      }
    })();
  }

  // One-time prompt: in a backlog repo where Claude Code is installed but the
  // MCP server isn't registered yet, offer to set it up. Fire-and-forget so it
  // never blocks activation.
  void (async () => {
    if (context.globalState.get<boolean>(CLAUDE_SETUP_DISMISSED_KEY)) return;
    if (!activeRootDir()) return;
    if (!(await isClaudeCliAvailable())) return;
    if (await isTaskwrightMcpRegistered()) return;
    const choice = await vscode.window.showInformationMessage(
      'Set up Taskwright for Claude Code? Registers the MCP server (so agents can pull their active task) and adds a usage note to CLAUDE.md.',
      'Set up',
      'Not now',
      "Don't ask again"
    );
    if (choice === 'Set up') {
      await setUpClaudeIntegration();
    } else if (choice === "Don't ask again") {
      await context.globalState.update(CLAUDE_SETUP_DISMISSED_KEY, true);
    }
  })();

  // Listen for file changes (only if we have a file watcher)
  if (fileWatcher) {
    const debouncedRefresh = createDebouncedHandler((uri: vscode.Uri) => {
      console.log('[Taskwright] Debounced refresh triggered');
      tasksHosts.forEach((host) => host.refresh());
      taskPreviewProvider.refresh();
      TaskDetailProvider.onFileChanged(uri, taskDetailProvider);
    }, 300);
    fileWatcher.onDidChange((uri) => {
      console.log('[Taskwright] File change detected, scheduling refresh');
      debouncedRefresh(uri);
    });
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsTaskwrightConfig(event, 'taskIdDisplay')) {
        tasksHosts.forEach((host) => host.refresh());
      }
      if (affectsTaskwrightConfig(event, 'enforceWorktreeIsolation') && workspaceRootPath) {
        syncWorktreeGuard(workspaceRootPath, context.extensionUri);
      }
      if (
        workspaceRootPath &&
        (affectsTaskwrightConfig(event, 'mergeMode') ||
          affectsTaskwrightConfig(event, 'mergeVerifyCommands') ||
          affectsTaskwrightConfig(event, 'mergeQueueStaleMinutes'))
      ) {
        void syncMergeConfig(workspaceRootPath);
      }
      if (
        workspaceRootPath &&
        (affectsTaskwrightConfig(event, 'sync.mode') ||
          affectsTaskwrightConfig(event, 'sync.ref') ||
          affectsTaskwrightConfig(event, 'sync.remote') ||
          affectsTaskwrightConfig(event, 'sync.pollIntervalSeconds'))
      ) {
        void publishSyncConfig(workspaceRootPath).then(() => boardSync?.start());
      }
      if (affectsTaskwrightConfig(event, 'mergeMode')) {
        const backlogForStatus = manager.getActiveRoot()?.backlogPath;
        if (backlogForStatus) {
          void syncMergeStatus(backlogForStatus, parser, writer, () =>
            tasksHosts.forEach((host) => host.refresh())
          );
        }
      }
    })
  );

  // Check for cross-branch feature configuration and CLI availability
  if (parser) {
    checkCrossBranchConfig(parser, context, tasksHosts);
    tasksHosts.forEach((host) => host.checkAndSendIntegrationState());
  }

  console.log('[Taskwright] Extension activation complete!');
}

export function deactivate(): Thenable<void> | undefined {
  if (fileWatcher) {
    fileWatcher.dispose();
  }
  if (crossBranchStatusBarItem) {
    crossBranchStatusBarItem.dispose();
  }
  if (workspaceStatusBarItem) {
    workspaceStatusBarItem.dispose();
  }
  // Best-effort cleanup: remove the user-scope MCP registration so a disabled or
  // reloaded extension doesn't leave a `taskwright` entry pointing at a
  // `dist/mcp/server.js` that may later be deleted. `unregisterTaskwrightMcp`
  // never throws. On a window reload this entry is re-added on the next
  // activation (see CLAUDE_MCP_REGISTERED_KEY). Limitation: VS Code does NOT run
  // deactivate on *uninstall*, so an uninstall can leave a stale entry behind —
  // remove it manually with `claude mcp remove taskwright -s user`.
  if (claudeMcpRegistered) {
    return unregisterTaskwrightMcp().then(() => undefined);
  }
  return undefined;
}

/**
 * Check if cross-branch features are configured.
 * Now uses native git support instead of external CLI.
 * Shows appropriate status bar indicators.
 */
async function checkCrossBranchConfig(
  parser: BacklogParser,
  context: vscode.ExtensionContext,
  tasksHosts: TasksBoardSurface[]
): Promise<void> {
  try {
    const config = await parser.getConfig();
    const crossBranchEnabled = config.check_active_branches === true;

    if (!crossBranchEnabled) {
      // Local-only mode is configured (or default) - hide status bar
      console.log('[Taskwright] Cross-branch features not enabled in config');
      return;
    }

    // Cross-branch features are enabled - native support is now available
    console.log('[Taskwright] Cross-branch features enabled, using native git support');

    // Create status bar item
    crossBranchStatusBarItem = BacklogCli.createStatusBarItem();
    context.subscriptions.push(crossBranchStatusBarItem);

    // Update to show cross-branch mode
    BacklogCli.updateStatusBarItem(crossBranchStatusBarItem, 'cross-branch');

    // Notify the tasks boards about the data source mode
    tasksHosts.forEach((host) => host.setDataSourceMode('cross-branch'));
  } catch (error) {
    console.error('[Taskwright] Error checking cross-branch config:', error);
  }
}
