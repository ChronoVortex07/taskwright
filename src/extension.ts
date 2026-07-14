import * as vscode from 'vscode';
import { TasksViewProvider } from './providers/TasksViewProvider';
import { TasksPanelProvider } from './providers/TasksPanelProvider';
import { TaskDetailProvider } from './providers/TaskDetailProvider';
import { ContentDetailProvider } from './providers/ContentDetailProvider';
import { TaskPreviewViewProvider } from './providers/TaskPreviewViewProvider';
import { TreeNavigatorProvider } from './providers/TreeNavigatorProvider';
import { BacklogParser } from './core/BacklogParser';
import { BacklogWriter } from './core/BacklogWriter';
import { TreeFieldService } from './core/TreeFieldService';
import { runDraftIdMigrationLocked, formatMigrationMessage } from './core/draftIdMigration';
import { FileWatcher } from './core/FileWatcher';
import { BacklogCli } from './core/BacklogCli';
import { createDebouncedHandler } from './core/debounce';
import type { TaskSource, DataSourceMode, ExtensionMessage } from './core/types';
import { createBacklogDocumentSelector } from './language/documentSelector';
import { BacklogCompletionProvider } from './language/BacklogCompletionProvider';
import { BacklogDocumentLinkProvider } from './language/BacklogDocumentLinkProvider';
import { BacklogHoverProvider } from './language/BacklogHoverProvider';
import { initializeBacklog, type InitBacklogOptions } from './core/initBacklog';
import { BacklogWorkspaceManager, type BacklogRoot } from './core/BacklogWorkspaceManager';
import {
  detectPackageManager,
  detectCodexInstalled,
  detectCodexIntegration,
} from './core/AgentIntegrationDetector';
import { claimTaskForCurrentUser, releaseTaskClaim } from './providers/claimActions';
import { dispatchTask } from './providers/dispatchActions';
import { runBoardDoctorFlow } from './providers/doctorActions';
import { cancelDispatch } from './core/cancelDispatch';
import { writeCancellationMarker } from './core/cancellationMarker';
import { removeWorktree } from './core/finishTask';
import { dispatchBranchName } from './core/dispatchPrompt';
import { worktreePathFor, type GitExecFn } from './core/WorktreeService';
import {
  approveMergeInQueue,
  sendBackInQueue,
  sendBackMerge,
  pendingBranchMerges,
  type PendingBranchMerge,
} from './providers/mergeActions';
import { categorizeWithClaude } from './providers/intakeActions';
import { attachPlanForTask, detachPlanForTask } from './providers/planActions';
import { writeActiveTask, clearActiveTask } from './core/activeTask';
import * as path from 'path';
import * as fs from 'fs';
import {
  isClaudeCliAvailable,
  isTaskwrightMcpRegistered,
  ensureTaskwrightMcpRegistered,
} from './core/claudeMcp';
import { installGlobalMcpLauncher } from './core/globalMcpLauncher';
import { injectConvention, injectAgentsConvention } from './core/agentConvention';
import { installTaskwrightSkills, type SkillInstallResult } from './core/skillInstaller';
import { extractTaskwrightServer, upsertTaskwrightMcpServer } from './core/mcpProjectConfig';
import { codexServerForPackagedExtension, upsertCodexMcpServer } from './core/codexConfig';
import { installAgentSkills } from './core/agentSkills';
import { homedir } from 'os';
import { affectsTaskwrightConfig, getTaskwrightConfig } from './config';
import {
  installGuard,
  uninstallGuard,
  installBoardSyncHooks,
  uninstallBoardSyncHooks,
  installPostCheckoutWarn,
  uninstallPostCheckoutWarn,
  type HookFsDeps,
} from './core/hookInstaller';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  explicitSettingValue,
  publishMergeConfig,
  readMergeConfig,
  mergeConfigPath,
} from './core/mergeConfig';
import { runVerifyDoctor, verifyDoctorNotification } from './core/verifyDoctor';
import { nodeQueueFs, MergeQueueStore, mergeQueuePath, type MergeQueue } from './core/mergeQueue';
import {
  resolveSyncConfigFromSettings,
  readSyncConfig,
  writeSyncConfig,
  syncConfigPath,
  DEFAULT_SYNC_CONFIG,
  type SyncMode,
} from './core/syncConfig';
import { createDeferredRunner } from './core/deferredBootstrap';
import { applyBoardIgnore, boardTrackedPaths } from './core/boardMigration';
import { resolvePrimaryWorktreeRoot, boardWorktreePathFor } from './core/boardRoot';
import { snapshotBoardToRef, refTip, materializeRefToWorktree } from './core/boardRef';
import { pushBoard, pullBoard } from './core/boardPushPull';
import { ensureBoardWorktree } from './core/boardWorktree';
import {
  gatherMigrationFacts,
  planMigrationSteps,
  moveBoardIntoWorktree,
  cleanMaterializedMarker,
  foldPrimaryStrays,
  type MoveFailure,
} from './core/boardHomeMigration';
import { autoCommitBoard, runBoardAutoSync, BoardSyncScheduler } from './core/autoSync';
import type { MergeConflict } from './core/boardMerge';
import {
  formatBoardSyncStatusBar,
  buildBoardSyncQuickPickItems,
  formatConflictMessage,
  type BoardSyncStatusBarState,
} from './core/boardSyncUx';
import { planStatusSync, parseStatusesLine, rewriteStatusesLine } from './core/mergeStatusConfig';
import type { MergeMode } from './core/mergeQueue';

const execFileAsync = promisify(execFile);

let fileWatcher: FileWatcher | undefined;
let workspaceStatusBarItem: vscode.StatusBarItem | undefined;
let boardSyncStatusBarItem: vscode.StatusBarItem | undefined;

const GUARD_REL = '.taskwright/hooks/worktree-guard.js';
const WARN_REL = '.taskwright/hooks/worktree-warn.js';

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
 * Install or remove the advisory post-checkout warn hook for `repoRoot`,
 * per the `taskwright.enforceWorktreeIsolation` setting. Same setting as the
 * pre-commit guard — the post-checkout hook warns (never blocks) when a
 * dispatched task branch is checked out in the primary tree.
 */
function syncPostCheckoutWarn(repoRoot: string, extensionUri: vscode.Uri): void {
  try {
    if (!getTaskwrightConfig<boolean>('enforceWorktreeIsolation', true)) {
      uninstallPostCheckoutWarn(repoRoot, guardFs);
      return;
    }
    const bundled = path.join(extensionUri.fsPath, 'dist', 'hooks', 'worktree-warn.js');
    if (!fs.existsSync(bundled)) return; // dev build without the bundle yet
    const dest = path.join(repoRoot, WARN_REL);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(bundled, dest);
    const manager = installPostCheckoutWarn(repoRoot, WARN_REL, guardFs);
    if (manager === 'plain') {
      try {
        fs.chmodSync(path.join(repoRoot, '.git', 'hooks', 'post-checkout'), 0o755);
      } catch {
        /* chmod is a no-op / unsupported on Windows */
      }
    }
  } catch (e) {
    console.warn('[Taskwright] Post-checkout warn sync failed:', e);
  }
}

/**
 * Install or remove the opt-in Board Sync v2 `pre-push`/`post-merge` hooks for
 * `repoRoot`, per `taskwright.sync.installHooks` (off by default — never
 * auto-installed). Both hooks shell out to the committed
 * `scripts/board-sync-hook.cjs`, which calls the same `pushBoard`/`pullBoard`
 * core as the Push/Pull Board commands and never blocks the user's git
 * operation on failure.
 */
function syncBoardHooks(repoRoot: string): void {
  try {
    if (!getTaskwrightConfig<boolean>('sync.installHooks', false)) {
      uninstallBoardSyncHooks(repoRoot, guardFs);
      return;
    }
    const { prePush, postMerge } = installBoardSyncHooks(repoRoot, guardFs);
    for (const [manager, hookName] of [
      [prePush, 'pre-push'],
      [postMerge, 'post-merge'],
    ] as const) {
      if (manager === 'plain') {
        try {
          fs.chmodSync(path.join(repoRoot, '.git', 'hooks', hookName), 0o755);
        } catch {
          /* chmod is a no-op / unsupported on Windows */
        }
      }
    }
  } catch (e) {
    console.warn('[Taskwright] Board sync hooks sync failed:', e);
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
  // Republish ONLY keys the user explicitly set (workspace or global) — merged
  // over the existing file, never overwriting it wholesale. merge-config.json
  // is the durable store for agent/CLI-made adjustments (e.g. corrected
  // verifyCommands in a non-bun repo), which must survive extension restarts.
  const explicit = <T>(key: string): T | undefined => explicitSettingValue(cfg.inspect<T>(key));
  // Timeout settings are minutes in VS Code; the shared config stores milliseconds.
  // Non-positive/invalid values are treated as not-set (verifyTimeoutMs -> file value
  // or 10-min default, verifyTimeoutMaxMs -> file value or unset = no cap).
  const minutesToMs = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 60_000) : undefined;
  publishMergeConfig(
    mergeConfigPath(commonDir),
    {
      mode: explicit('mergeMode'),
      verifyCommands: explicit('mergeVerifyCommands'),
      staleMinutes: explicit('mergeQueueStaleMinutes'),
      verifyTimeoutMs: minutesToMs(explicit('mergeVerifyTimeoutMinutes')),
      verifyTimeoutMaxMs: minutesToMs(explicit('mergeVerifyTimeoutMaxMinutes')),
    },
    nodeQueueFs
  );
}

/**
 * Verify-command doctor (TASK-86): validate the effective merge-verify commands
 * against the repo's actual shape (package.json scripts, Python/uv markers, …)
 * and, when a command provably cannot run (e.g. the bun-flavored defaults in a
 * Python repo), surface a warning with a one-click "Apply suggested commands"
 * that persists durably (workspace setting + republished merge-config.json).
 * Suggestions are always human-confirmed — nothing is rewritten silently.
 */
async function runVerifyDoctorCheck(
  repoRoot: string,
  options: { quietWhenOk: boolean }
): Promise<void> {
  const commonDir = await resolveCommonDir(repoRoot);
  if (!commonDir) return;
  const config = readMergeConfig(mergeConfigPath(commonDir), nodeQueueFs);
  const report = runVerifyDoctor({
    root: repoRoot,
    commands: config.verifyCommands,
    fs: nodeQueueFs,
  });
  if (report.ok) {
    if (!options.quietWhenOk) {
      vscode.window.showInformationMessage(
        `Taskwright merge verify: all ${report.findings.length} configured verify command(s) look runnable in this repo.`
      );
    }
    return;
  }
  const note = verifyDoctorNotification(report);
  if (!note) return;
  const applyAction = 'Apply suggested commands';
  const settingsAction = 'Open Settings';
  const actions = note.suggestions.length > 0 ? [applyAction, settingsAction] : [settingsAction];
  const pick = await vscode.window.showWarningMessage(note.message, ...actions);
  if (pick === applyAction) {
    await vscode.workspace
      .getConfiguration('taskwright')
      .update('mergeVerifyCommands', note.suggestions, vscode.ConfigurationTarget.Workspace);
    // Republish immediately so the shared merge-config.json (which the
    // out-of-process MCP merge gate reads) reflects the fix now, not on the
    // next activation. The config-change listener also fires; publishing is
    // idempotent and clobber-safe (TASK-85).
    await syncMergeConfig(repoRoot);
    vscode.window.showInformationMessage(
      `Updated taskwright.mergeVerifyCommands to: ${note.suggestions.join(' && ')}`
    );
  } else if (pick === settingsAction) {
    void vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'taskwright.mergeVerifyCommands'
    );
  }
}

/**
 * Publish taskwright.sync.* to the shared config the out-of-process MCP server
 * reads.
 */
async function publishSyncConfig(repoRoot: string): Promise<void> {
  const commonDir = await resolveCommonDir(repoRoot);
  if (!commonDir) return;
  const cfg = vscode.workspace.getConfiguration('taskwright');
  const merged = resolveSyncConfigFromSettings({
    mode: cfg.get('sync.mode'),
    ref: cfg.get('sync.ref'),
    remote: cfg.get('sync.remote'),
    installHooks: cfg.get('sync.installHooks'),
  });
  writeSyncConfig(syncConfigPath(commonDir), merged, nodeQueueFs);
}

/**
 * The one-time, one-consent "move board off code branches" migration + enable.
 * Adds the gitignore block, untracks the board dirs in a single commit, sets
 * `sync.mode` to `git`, publishes the shared config, and seeds the
 * `taskwright-board` ref from the current board (Board Sync v2 §8) — pushing it
 * to a remote is a separate, explicit Push Board action (not part of enabling).
 * Returns the chosen mode, or undefined when the user cancels.
 */
async function runEnableSync(repoRoot: string): Promise<SyncMode | undefined> {
  const commonDir = await resolveCommonDir(repoRoot);
  const currentMode = commonDir
    ? readSyncConfig(syncConfigPath(commonDir), nodeQueueFs).mode
    : DEFAULT_SYNC_CONFIG.mode;

  const modePick = await vscode.window.showQuickPick(
    [
      {
        label: '$(sync) git-auto — hidden worktree + automatic sync (recommended)',
        description: 'Board moves to .taskwright/board; commits & syncs itself on events',
        mode: 'git-auto' as SyncMode,
      },
      {
        label: '$(git-branch) git — versioned ref with explicit Push/Pull Board',
        description: 'Board stays in backlog/ (git-ignored); you push/pull the ref by hand',
        mode: 'git' as SyncMode,
      },
      {
        label: '$(circle-slash) off — local board, no versioning',
        description:
          currentMode === 'git-auto'
            ? 'Moves the board back into backlog/ first'
            : 'Plain git-ignored working files',
        mode: 'off' as SyncMode,
      },
    ],
    {
      placeHolder: `Board sync mode (currently: ${currentMode})`,
      title: 'Taskwright: Board Sync',
    }
  );
  if (!modePick) return undefined;

  if (modePick.mode === 'git-auto') {
    if (currentMode === 'git-auto') {
      // Idempotent re-run: repair/ensure only.
      return (await migrateToGitAuto(repoRoot)) ? 'git-auto' : undefined;
    }
    const confirm = await vscode.window.showWarningMessage(
      'Switch the board to git-auto? Its files move from backlog/ into a hidden worktree at .taskwright/board (branch "taskwright-board") with automatic event-driven commit/sync. A safety snapshot is taken first, files are verified before anything is removed, and a window reload is needed at the end. End other agent sessions on this repo before migrating.',
      { modal: true },
      'Migrate to git-auto'
    );
    if (confirm !== 'Migrate to git-auto') return undefined;
    return (await migrateToGitAuto(repoRoot)) ? 'git-auto' : undefined;
  }

  if (currentMode === 'git-auto') {
    // Leaving git-auto: reverse migration (restore backlog/, remove the worktree).
    const confirm = await vscode.window.showWarningMessage(
      `Switch back to "${modePick.mode}"? The board moves from the hidden worktree back into backlog/ (pending edits are committed first; the "taskwright-board" branch is kept). A window reload is needed at the end.`,
      { modal: true },
      'Move board back'
    );
    if (confirm !== 'Move board back') return undefined;
    return (await migrateFromGitAuto(repoRoot, modePick.mode)) ? modePick.mode : undefined;
  }

  if (modePick.mode === 'off') {
    await vscode.workspace
      .getConfiguration('taskwright')
      .update('sync.mode', 'off', vscode.ConfigurationTarget.Workspace);
    await publishSyncConfig(repoRoot);
    return 'off';
  }

  return enableGitMode(repoRoot);
}

/** The v2 `git`-mode enable flow — kept byte-for-byte from Board Sync v2. */
async function enableGitMode(repoRoot: string): Promise<SyncMode | undefined> {
  const pick = await vscode.window.showWarningMessage(
    'Enable Taskwright board sync? This makes ONE commit that moves board task files off your code branches (they will live on the "taskwright-board" ref instead). This removes the read-only cross-branch "ghost" cards, and lets you version + share the board via explicit Push/Pull Board actions.',
    { modal: true },
    'Enable'
  );
  if (!pick) return undefined;
  const mode: SyncMode = 'git';

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

  // 4. Seed the board ref from the current board (local only — no push/remote
  // here; sharing happens via the separate Push Board action). Idempotent:
  // chains onto the ref's current tip when it already exists instead of
  // creating a duplicate orphan root each time the command is re-run.
  const cfg = vscode.workspace.getConfiguration('taskwright');
  const ref = cfg.get<string>('sync.ref') ?? 'taskwright-board';
  try {
    const primaryRoot = await resolvePrimaryWorktreeRoot(repoRoot);
    const parent = await refTip(primaryRoot, ref);
    await snapshotBoardToRef({
      repoRoot: primaryRoot,
      ref,
      indexFile: path.join(primaryRoot, '.taskwright', 'board.index'),
      message: 'chore(taskwright): seed board ref (enableSync)',
      parent: parent ?? undefined,
      backlogDir: 'backlog',
    });
  } catch (err) {
    console.error('[Taskwright] enableSync ref seed failed:', err);
    void vscode.window.showWarningMessage(
      'Board sync enabled, but seeding the "taskwright-board" ref failed. You can retry with the Push Board command once available.'
    );
  }
  return mode;
}

/**
 * Surface a blocked migration with the REASON per file, not just the count and
 * one name (TASK-123). The old message named a task and stopped there, which
 * left the user with nothing to act on — and "re-run to retry" was false comfort
 * when the failure is deterministic. Every blocker is listed, with what to do.
 */
async function showMigrationBlockers(blocking: MoveFailure[]): Promise<void> {
  const explain: Record<MoveFailure['reason'], string> = {
    absent: 'missing from the board worktree',
    'content-drift': 'differs from the board copy and could not be merged',
    'eol-only': 'line endings only', // never blocking; listed for completeness
  };
  const lines = blocking.map((f) => `${f.path} — ${explain[f.reason]}`);
  const detail = [
    'Taskwright git-auto migration aborted BEFORE anything was removed. The board is intact in backlog/.',
    '',
    `${blocking.length} board file(s) could not be verified in the board worktree (.taskwright/board):`,
    ...lines.map((l) => `  • ${l}`),
    '',
    'A "content-drift" file was edited while the migration ran (end other agent sessions and re-run).',
    'An "absent" file never reached the board worktree — check that .taskwright/board is a healthy',
    'worktree of the taskwright-board branch (Taskwright: Board Doctor can repair it).',
  ].join('\n');

  const pick = await vscode.window.showErrorMessage(
    `Taskwright git-auto migration aborted: ${blocking.length} board file(s) failed verification (e.g. ${blocking[0]?.path} — ${blocking[0] ? explain[blocking[0].reason] : ''}). Nothing was removed.`,
    'Show details'
  );
  if (pick === 'Show details') {
    const channel = vscode.window.createOutputChannel('Taskwright');
    channel.appendLine(detail);
    channel.show(true);
  }
}

/**
 * Migrate to the git-auto board home (TASK-91, spec §5.2). Ordering is the
 * safety argument: hygiene → safety snapshot → worktree → verify → per-file
 * move → marker cleanup → remote fold → mode flip (the commit point) → reload.
 * Any abort before the flip leaves the mode unchanged and the primary board
 * intact and authoritative. Idempotent — re-running resumes/no-ops.
 */
async function migrateToGitAuto(repoRoot: string): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('taskwright');
  const ref = cfg.get<string>('sync.ref')?.trim() || DEFAULT_SYNC_CONFIG.ref;
  const remote = cfg.get<string>('sync.remote')?.trim() || DEFAULT_SYNC_CONFIG.remote;

  try {
    const primaryRoot = await resolvePrimaryWorktreeRoot(repoRoot);
    const git = (args: string[]) =>
      execFileAsync('git', args, { cwd: primaryRoot, timeout: 30_000 });
    const facts = await gatherMigrationFacts(primaryRoot, ref);
    const steps = planMigrationSteps(facts);

    // Hygiene shared with v2: fenced gitignore block (upgrades stale 4-dir
    // blocks to include milestones/) + untrack + one commit. Working-tree
    // content is the source of truth — untracking never touches the files.
    if (facts.hasStateDirs || steps.includes('untrack')) {
      const gitignorePath = path.join(primaryRoot, '.gitignore');
      const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
      fs.writeFileSync(gitignorePath, applyBoardIgnore(existing), 'utf-8');
      try {
        await git(['rm', '-r', '--cached', '--ignore-unmatch', ...boardTrackedPaths()]);
        await git(['add', '.gitignore']);
        await git(['commit', '-m', 'chore(taskwright): move board off code branches (git-auto)']);
      } catch (err) {
        // "nothing to commit" is the already-clean case; anything else is logged.
        console.warn('[Taskwright] git-auto untrack commit skipped/failed:', err);
      }
    }

    // Pre-move safety snapshot: the live board onto the ref, parented on any
    // existing tip (S3's history continues; the remote push stays ff-able).
    if (steps.includes('seed-fresh') || steps.includes('seed-fold-ref')) {
      const parent = await refTip(primaryRoot, ref);
      await snapshotBoardToRef({
        repoRoot: primaryRoot,
        ref,
        indexFile: path.join(primaryRoot, '.taskwright', 'board.index'),
        message: 'chore(taskwright): pre-git-auto board snapshot',
        parent: parent ?? undefined,
        backlogDir: 'backlog',
      });
    }

    // Quiesce the watcher for the move; the reload below re-wires everything.
    fileWatcher?.dispose();
    fileWatcher = undefined;

    const ensured = await ensureBoardWorktree({ primaryRoot, ref, remote });

    if (facts.hasStateDirs) {
      // Verify before delete — but heal drift rather than wedging on it, and
      // never abort without saying WHY (TASK-123).
      const move = await moveBoardIntoWorktree({ primaryRoot, boardWorktree: ensured.path });
      if (!move.ok) {
        void showMigrationBlockers(move.blocking);
        return false;
      }
      if (move.conflicts.length > 0) {
        void vscode.window.showWarningMessage(formatConflictMessage('pulled', move.conflicts));
      }
      if (move.lockedLeftBehind.length > 0) {
        void vscode.window.showWarningMessage(
          `Taskwright: ${move.lockedLeftBehind.length} board file(s) were locked and left in backlog/ (e.g. ${move.lockedLeftBehind[0]}). They will be folded into the board automatically at the next activation.`
        );
      }
    }

    cleanMaterializedMarker(primaryRoot);

    // Fold the remote board in immediately when reachable (S3's remote side);
    // offline just accumulates — the first post-reload sync retries.
    const sync = await runBoardAutoSync({ primaryRoot, ref, remote });
    if (!('skipped' in sync) && sync.conflicts.length > 0) {
      void vscode.window.showWarningMessage(formatConflictMessage('pulled', sync.conflicts));
    }

    // The commit point: only now does the mode flip.
    await cfg.update('sync.mode', 'git-auto', vscode.ConfigurationTarget.Workspace);
    await publishSyncConfig(repoRoot);

    const reload = await vscode.window.showInformationMessage(
      'Board migrated to its hidden worktree (.taskwright/board). Reload the window so the board services (and the MCP server root) pick up the new home.',
      'Reload Window'
    );
    if (reload === 'Reload Window') {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    return true;
  } catch (err) {
    console.error('[Taskwright] git-auto migration failed:', err);
    void vscode.window.showErrorMessage(
      `Taskwright git-auto migration failed before the mode flip — the board is still in backlog/ and nothing was lost. ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/**
 * Reverse migration (spec §5.4): commit pending worktree edits, materialize
 * the branch back into the primary backlog/, remove the worktree (the branch
 * — the durable store — is kept), then flip the mode and prompt a reload.
 */
async function migrateFromGitAuto(repoRoot: string, targetMode: SyncMode): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('taskwright');
  const ref = cfg.get<string>('sync.ref')?.trim() || DEFAULT_SYNC_CONFIG.ref;

  try {
    const primaryRoot = await resolvePrimaryWorktreeRoot(repoRoot);
    const git = (args: string[]) =>
      execFileAsync('git', args, { cwd: primaryRoot, timeout: 30_000 });
    const worktree = boardWorktreePathFor(primaryRoot);

    if (fs.existsSync(worktree)) {
      await autoCommitBoard(worktree);
    }
    await materializeRefToWorktree({
      repoRoot: primaryRoot,
      ref,
      indexFile: path.join(primaryRoot, '.taskwright', 'board.index'),
      backlogDir: 'backlog',
    });
    if (fs.existsSync(worktree)) {
      try {
        await git(['worktree', 'remove', '--force', worktree]);
      } catch (err) {
        console.warn('[Taskwright] board worktree remove failed (will prune):', err);
      }
      await git(['worktree', 'prune']);
    }

    await cfg.update('sync.mode', targetMode, vscode.ConfigurationTarget.Workspace);
    await publishSyncConfig(repoRoot);

    const reload = await vscode.window.showInformationMessage(
      `Board moved back into backlog/ (mode: ${targetMode}). Reload the window so the board services pick up the new home.`,
      'Reload Window'
    );
    if (reload === 'Reload Window') {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    return true;
  } catch (err) {
    console.error('[Taskwright] leaving git-auto failed:', err);
    void vscode.window.showErrorMessage(
      `Taskwright could not move the board back into backlog/: ${err instanceof Error ? err.message : String(err)}. The mode was left on git-auto; nothing was lost.`
    );
    return false;
  }
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
  relayNavigator(message: ExtensionMessage): void;
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Taskwright] Extension activating...');
  console.log('[Taskwright] Extension URI:', context.extensionUri.toString());
  console.log(
    '[Taskwright] Workspace folders:',
    vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath)
  );

  // Initialize workspace manager. `initialize()` prefers each folder's
  // *primary* worktree board (Board Sync v2 §2.1) over a local one, so a
  // linked `.worktrees/<branch>` workspace folder (which has no local
  // `backlog/` at all) still resolves to the real board.
  const manager = new BacklogWorkspaceManager(context.workspaceState);
  context.subscriptions.push(manager);
  const activeRoot = await manager.initialize();
  manager.startWatching();

  const backlogFolder = activeRoot?.backlogPath;

  if (!backlogFolder) {
    console.log('[Taskwright] No backlog folder found in workspace');
  } else {
    console.log('[Taskwright] Found backlog folder:', backlogFolder);
  }

  // Gates command-palette visibility of workspace-dependent commands (Task G:
  // push/pull board only makes sense once a backlog workspace is open).
  void vscode.commands.executeCommand(
    'setContext',
    'taskwright.hasBacklog',
    Boolean(backlogFolder)
  );

  // Initialize parser (may be undefined if no backlog folder)
  let parser = activeRoot
    ? new BacklogParser(
        activeRoot.backlogPath,
        activeRoot.configPath,
        activeRoot.workspaceFolder.uri.fsPath,
        activeRoot.primaryRoot
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

  // Repo/git housekeeping (TASK-109). None of this is needed to render the board,
  // but all of it spawns git subprocesses — so it runs off the window-open critical
  // path via the deferred runner below, not inline in activate().
  async function runRepoHousekeeping(root: string): Promise<void> {
    syncWorktreeGuard(root, context.extensionUri);
    syncPostCheckoutWarn(root, context.extensionUri);
    syncBoardHooks(root);
    // Publish the merge config, then run the verify-command doctor over the
    // published result — flags verify commands that provably cannot run in this
    // repo (misconfigured merge gate) before a merge rather than mid-merge.
    await syncMergeConfig(root);
    await runVerifyDoctorCheck(root, { quietWhenOk: true });
    await publishSyncConfig(root);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.enableSync', async () => {
      if (!workspaceRootPath) {
        void vscode.window.showWarningMessage('Open a Taskwright workspace folder first.');
        return;
      }
      const mode = await runEnableSync(workspaceRootPath);
      if (!mode) return;
      tasksHosts.forEach((host) => host.refresh());
      void refreshBoardSyncStatusBar();
      if (mode === 'git') {
        // git-auto / off surfaced their own migration summary + reload prompt.
        void vscode.window.showInformationMessage(
          'Taskwright board sync enabled. Cross-branch ghost cards are gone, and the board is versioned on the "taskwright-board" ref — push/pull it explicitly to share with others.'
        );
      }
    })
  );

  // Board Sync v2 push/pull UX (Task G): a status-bar item summarizing mode +
  // last push/pull + conflict count, with a quick-pick for push/pull/enable —
  // and a shared "never silent" conflict notification with an Open action.
  // Reads the same `boardSyncState` the push/pull commands below update.
  let boardSyncState: BoardSyncStatusBarState = { mode: DEFAULT_SYNC_CONFIG.mode };

  async function refreshBoardSyncStatusBar(): Promise<void> {
    if (!workspaceRootPath) {
      boardSyncStatusBarItem?.hide();
      return;
    }
    const commonDir = await resolveCommonDir(workspaceRootPath);
    const syncCfg = commonDir
      ? readSyncConfig(syncConfigPath(commonDir), nodeQueueFs)
      : DEFAULT_SYNC_CONFIG;
    boardSyncState = { ...boardSyncState, mode: syncCfg.mode };

    if (!boardSyncStatusBarItem) {
      boardSyncStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        98
      );
      boardSyncStatusBarItem.command = 'taskwright.boardSyncQuickPick';
      context.subscriptions.push(boardSyncStatusBarItem);
    }
    const { text, tooltip } = formatBoardSyncStatusBar(boardSyncState);
    boardSyncStatusBarItem.text = text;
    boardSyncStatusBarItem.tooltip = tooltip;
    boardSyncStatusBarItem.show();
  }
  // Called by the deferred startup bootstrap (TASK-109) — it resolves the git
  // common dir, so it is not run inline during activation.

  // ── git-auto engine (TASK-91) ─────────────────────────────────────────────
  // Event-driven only: activation, write-debounce (FileWatcher), the manual
  // commands, and MCP request_merge boundaries. Never an interval.
  let boardSyncScheduler: BoardSyncScheduler | undefined;

  async function runAutoSyncNow(): Promise<void> {
    if (!workspaceRootPath) return;
    try {
      const commonDir = await resolveCommonDir(workspaceRootPath);
      const syncCfg = commonDir
        ? readSyncConfig(syncConfigPath(commonDir), nodeQueueFs)
        : DEFAULT_SYNC_CONFIG;
      if (syncCfg.mode !== 'git-auto') return;
      const primaryRoot = await resolvePrimaryWorktreeRoot(workspaceRootPath);
      const outcome = await runBoardAutoSync({
        primaryRoot,
        ref: syncCfg.ref,
        remote: syncCfg.remote,
      });
      if ('skipped' in outcome) return; // another process is syncing — fine
      boardSyncState = {
        ...boardSyncState,
        lastSync: {
          type: 'sync',
          atIso: new Date().toISOString(),
          ok: outcome.error === undefined,
          conflictIds: outcome.conflicts.map((c) => c.id),
          failureReason: outcome.error,
        },
      };
      void refreshBoardSyncStatusBar();
      if (outcome.conflicts.length > 0) {
        void showConflictNotification('pulled', outcome.conflicts);
      }
      if (outcome.merged) {
        tasksHosts.forEach((host) => host.refresh());
      }
    } catch (err) {
      console.warn('[Taskwright] board auto-sync failed:', err);
    }
  }

  async function bootstrapGitAuto(): Promise<void> {
    if (!workspaceRootPath) return;
    const commonDir = await resolveCommonDir(workspaceRootPath);
    const syncCfg = commonDir
      ? readSyncConfig(syncConfigPath(commonDir), nodeQueueFs)
      : DEFAULT_SYNC_CONFIG;
    if (syncCfg.mode !== 'git-auto') return;
    try {
      const primaryRoot = await resolvePrimaryWorktreeRoot(workspaceRootPath);
      // S5 bootstrap: a fresh clone carries mode git-auto in committed settings
      // but has no .taskwright/ (git-ignored ⇒ never cloned) and no worktree.
      const ensured = await ensureBoardWorktree({
        primaryRoot,
        ref: syncCfg.ref,
        remote: syncCfg.remote,
      });
      if (ensured.created) {
        // The board home appeared after root resolution ran — reload to load from it.
        const pick = await vscode.window.showInformationMessage(
          'Taskwright bootstrapped the hidden board worktree (.taskwright/board). Reload the window so the board loads from it.',
          'Reload Window'
        );
        if (pick === 'Reload Window') {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
        return;
      }
      // Split-brain heal (spec §5.3): fold strays a stale writer left in backlog/.
      const folded = await foldPrimaryStrays(primaryRoot);
      if (folded) {
        void vscode.window.showInformationMessage(
          `Taskwright folded ${folded.folded} stray board file(s) from backlog/ into the board.`
        );
        if (folded.conflicts.length > 0) {
          void showConflictNotification('pulled', folded.conflicts);
        }
        tasksHosts.forEach((host) => host.refresh());
      }
      boardSyncScheduler = new BoardSyncScheduler({ run: runAutoSyncNow });
      context.subscriptions.push({ dispose: () => boardSyncScheduler?.dispose() });
      fileWatcher?.onDidChange(() => boardSyncScheduler?.noteWrite());
      boardSyncScheduler.requestSync(); // the activation event
    } catch (err) {
      console.warn('[Taskwright] git-auto activation bootstrap failed:', err);
    }
  }

  /**
   * Converge a legacy DRAFT-N board onto stable task ids (TASK-119).
   *
   * Idempotent — a board whose drafts already carry task ids performs ZERO writes, so this is
   * safe to run on every activation. Cross-process safe: an extension host and an MCP server
   * routinely start at the same moment against one board, and `peekNextTaskId` is lock-free, so
   * the shared `.locks/` mutex inside `runDraftIdMigrationLocked` is what stops the two from
   * planning the same id and double-renaming the same file.
   *
   * NON-FATAL BY CONSTRUCTION: it runs inside the deferred bootstrap (never inline — TASK-109
   * moved every fs/git burst off the activation path) and swallows its own failures. The
   * deferred runner never rejects into `activate()`, and a failure here must not break the
   * window: it logs, and the board doctor's `legacy-draft-ids` finding remains as the visible,
   * repairable safety net.
   */
  async function migrateDraftIds(): Promise<void> {
    if (!parser) return;
    try {
      const result = await runDraftIdMigrationLocked(
        { parser, writer: new BacklogWriter(), treeFieldService: new TreeFieldService() },
        parser.getBacklogPath()
      );
      if (result.migrated === 0) return; // silent when there was nothing to do
      parser.invalidateTaskCache();
      tasksHosts.forEach((host) => host.refresh());
      void vscode.window.showInformationMessage(formatMigrationMessage(result.mapping));
    } catch (err) {
      console.warn('[Taskwright] draft-id migration failed:', err);
    }
  }

  /**
   * Everything git-flavoured that activation used to fire inline (TASK-109).
   *
   * It runs once, ~2s after activation — off the window-open critical path — or
   * sooner if something that genuinely depends on it pulls it forward (opening the
   * board, or a sync command). Ordering inside is preserved: repo housekeeping and
   * the status bar first, then the git-auto bootstrap (ensure-worktree → fold-strays
   * → first sync), which is what the git-auto engine expects — the draft-id migration
   * is APPENDED last, so it runs against the board home git-auto just resolved.
   */
  const startupBootstrap = createDeferredRunner(async () => {
    if (workspaceRootPath) {
      await runRepoHousekeeping(workspaceRootPath);
    }
    await refreshBoardSyncStatusBar();
    await bootstrapGitAuto();
    await migrateDraftIds();
  });
  context.subscriptions.push({ dispose: () => startupBootstrap.dispose() });
  startupBootstrap.schedule();

  /** Never-silent conflict surfacing, shared by push and pull: lists ids, offers to open one. */
  async function showConflictNotification(
    verb: 'pushed' | 'pulled',
    conflicts: MergeConflict[]
  ): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      formatConflictMessage(verb, conflicts),
      'Open'
    );
    if (choice !== 'Open') return;
    const targetId =
      conflicts.length === 1
        ? conflicts[0].id
        : (
            await vscode.window.showQuickPick(
              conflicts.map((c) => ({ label: c.id, description: c.path })),
              { placeHolder: 'Open which conflicted task?' }
            )
          )?.label;
    if (targetId) {
      void vscode.commands.executeCommand('taskwright.openTaskDetail', targetId);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.boardSyncQuickPick', async () => {
      const picked = await vscode.window.showQuickPick(
        buildBoardSyncQuickPickItems(boardSyncState),
        { placeHolder: 'Board Sync' }
      );
      if (!picked) return;
      if (picked.action === 'enableSync') {
        await vscode.commands.executeCommand('taskwright.enableSync');
      } else if (picked.action === 'sync') {
        await runAutoSyncNow();
      } else if (picked.action === 'push') {
        await vscode.commands.executeCommand('taskwright.pushBoard');
      } else {
        await vscode.commands.executeCommand('taskwright.pullBoard');
      }
    })
  );

  // Board Sync v2 push/pull backbone (Task F): explicit, synchronous commands over
  // the same pushBoard/pullBoard core the taskwright MCP tools call — no live loop.
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.pushBoard', async () => {
      if (!workspaceRootPath) {
        void vscode.window.showWarningMessage('Open a Taskwright workspace folder first.');
        return;
      }
      const commonDir = await resolveCommonDir(workspaceRootPath);
      const syncCfg = commonDir
        ? readSyncConfig(syncConfigPath(commonDir), nodeQueueFs)
        : DEFAULT_SYNC_CONFIG;
      if (syncCfg.mode === 'off') {
        void vscode.window.showWarningMessage(
          'Board sync is off. Run "Taskwright: Enable Board Sync" first.'
        );
        return;
      }
      if (syncCfg.mode === 'git-auto') {
        // Manual escape hatch: the same event-driven sync pass.
        await runAutoSyncNow();
        return;
      }
      try {
        const result = await pushBoard({
          cwd: workspaceRootPath,
          ref: syncCfg.ref,
          remote: syncCfg.remote,
          message: 'chore(taskwright): push board',
        });
        tasksHosts.forEach((host) => host.refresh());
        boardSyncState = {
          ...boardSyncState,
          lastSync: {
            type: 'push',
            atIso: new Date().toISOString(),
            ok: result.pushed,
            conflictIds: result.conflicts.map((c) => c.id),
            failureReason: result.pushed
              ? undefined
              : `${result.rejected ? 'remote moved — ' : ''}${result.message ?? 'unknown error'}`,
          },
        };
        void refreshBoardSyncStatusBar();
        if (!result.pushed) {
          void vscode.window.showWarningMessage(
            `Push Board failed${result.rejected ? ' (remote moved — try again)' : ''}: ${result.message ?? 'unknown error'}`
          );
        } else if (result.conflicts.length > 0) {
          void showConflictNotification('pushed', result.conflicts);
        } else {
          void vscode.window.showInformationMessage('Board pushed.');
        }
      } catch (err) {
        boardSyncState = {
          ...boardSyncState,
          lastSync: {
            type: 'push',
            atIso: new Date().toISOString(),
            ok: false,
            conflictIds: [],
            failureReason: err instanceof Error ? err.message : String(err),
          },
        };
        void refreshBoardSyncStatusBar();
        void vscode.window.showErrorMessage(
          `Push Board failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.pullBoard', async () => {
      if (!workspaceRootPath) {
        void vscode.window.showWarningMessage('Open a Taskwright workspace folder first.');
        return;
      }
      const commonDir = await resolveCommonDir(workspaceRootPath);
      const syncCfg = commonDir
        ? readSyncConfig(syncConfigPath(commonDir), nodeQueueFs)
        : DEFAULT_SYNC_CONFIG;
      if (syncCfg.mode === 'off') {
        void vscode.window.showWarningMessage(
          'Board sync is off. Run "Taskwright: Enable Board Sync" first.'
        );
        return;
      }
      if (syncCfg.mode === 'git-auto') {
        // Manual escape hatch: the same event-driven sync pass.
        await runAutoSyncNow();
        return;
      }
      try {
        const result = await pullBoard({
          cwd: workspaceRootPath,
          ref: syncCfg.ref,
          remote: syncCfg.remote,
          message: 'chore(taskwright): pull board',
        });
        tasksHosts.forEach((host) => host.refresh());
        boardSyncState = {
          ...boardSyncState,
          lastSync: {
            type: 'pull',
            atIso: new Date().toISOString(),
            ok: result.pulled,
            conflictIds: result.conflicts.map((c) => c.id),
            failureReason: result.pulled ? undefined : (result.message ?? 'unknown error'),
          },
        };
        void refreshBoardSyncStatusBar();
        if (!result.pulled) {
          void vscode.window.showWarningMessage(
            `Pull Board: ${result.message ?? 'nothing to pull'}`
          );
        } else if (result.conflicts.length > 0) {
          void showConflictNotification('pulled', result.conflicts);
        } else {
          void vscode.window.showInformationMessage('Board pulled.');
        }
      } catch (err) {
        boardSyncState = {
          ...boardSyncState,
          lastSync: {
            type: 'pull',
            atIso: new Date().toISOString(),
            ok: false,
            conflictIds: [],
            failureReason: err instanceof Error ? err.message : String(err),
          },
        };
        void refreshBoardSyncStatusBar();
        void vscode.window.showErrorMessage(
          `Pull Board failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  // Board Sync v2 Task H: opt-in pre-push/post-merge hooks over the same
  // pushBoard/pullBoard core — an explicit command alternative to flipping
  // `taskwright.sync.installHooks` directly in settings.
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.installBoardHooks', async () => {
      if (!workspaceRootPath) {
        void vscode.window.showWarningMessage('Open a Taskwright workspace folder first.');
        return;
      }
      await vscode.workspace
        .getConfiguration('taskwright')
        .update('sync.installHooks', true, vscode.ConfigurationTarget.Workspace);
      syncBoardHooks(workspaceRootPath);
      void vscode.window.showInformationMessage(
        'Board sync hooks installed: `git push` also pushes the board ref, and `git pull`/merge materializes board updates. Failures are logged, never block the git operation. Uninstall via "Taskwright: Uninstall Board Sync Hooks".'
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.uninstallBoardHooks', async () => {
      if (!workspaceRootPath) {
        void vscode.window.showWarningMessage('Open a Taskwright workspace folder first.');
        return;
      }
      await vscode.workspace
        .getConfiguration('taskwright')
        .update('sync.installHooks', false, vscode.ConfigurationTarget.Workspace);
      syncBoardHooks(workspaceRootPath);
      void vscode.window.showInformationMessage('Board sync hooks removed.');
    })
  );

  // Merge-queue board enrichment: resolve the shared queue location, inject a
  // reader into both board hosts, and watch the queue file so out-of-process
  // mutations (request_merge merging/dequeuing, approve/send-back) refresh the
  // board without a manual reload.
  //
  // Also caches the common dir on the detail provider so it doesn't spawn
  // `git rev-parse` per panel open.
  //
  // Extracted so it can be re-called on a backlog-root switch (the file watcher
  // needs to re-point to the new common dir's queue file).
  let mergeQueueWatcherDispose: vscode.Disposable | undefined;

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
      mergeQueueWatcherDispose = new vscode.Disposable(() => fs.unwatchFile(queueFile));
      context.subscriptions.push(mergeQueueWatcherDispose);
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

  const treeNavigatorProvider = new TreeNavigatorProvider(context.extensionUri, parser, (message) =>
    tasksHosts.forEach((host) => host.relayNavigator(message))
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('taskwright.treeNavigator', treeNavigatorProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  console.log('[Taskwright] Tree navigator view provider registered');

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'taskwright.navigatorMinimap',
      (x: number, y: number, w: number, h: number) => {
        treeNavigatorProvider.postMessage({ type: 'minimapViewport', x, y, w, h });
      }
    )
  );

  // Create Task Detail provider for opening task details in editor
  const taskDetailProvider = new TaskDetailProvider(context.extensionUri, parser);
  if (backlogFolder) {
    taskDetailProvider.setBacklogPath(backlogFolder);
  }
  // Cache the git common dir on the detail provider so resolveMergeState
  // reuses it instead of spawning `git rev-parse` per panel open.
  if (workspaceRootPath) {
    resolveCommonDir(workspaceRootPath).then((cd) => {
      if (cd) taskDetailProvider.setCommonDir(cd);
    });
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
    parser = new BacklogParser(
      root.backlogPath,
      root.configPath,
      root.workspaceFolder.uri.fsPath,
      root.primaryRoot
    );
    fileWatcher = new FileWatcher(root.backlogPath);
    context.subscriptions.push(fileWatcher);

    // Wire debounced refresh
    const debouncedRefresh = createDebouncedHandler((uri: vscode.Uri) => {
      console.log('[Taskwright] Debounced refresh triggered');
      tasksHosts.forEach((host) => host.refresh());
      taskPreviewProvider.refresh();
      treeNavigatorProvider.refresh();
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
    // Re-resolve the common dir for the new root so the detail panel doesn't
    // spawn git rev-parse on every open after a workspace switch.
    void resolveCommonDir(root.workspaceFolder.uri.fsPath).then((cd) => {
      if (cd) taskDetailProvider.setCommonDir(cd);
    });
    contentDetailProvider.setParser(parser);
    treeNavigatorProvider.setParser(parser);
    treeNavigatorProvider.refresh();

    // Re-register language providers (selector may differ per backlog dir)
    registerLanguageProviders(parser, root.backlogDir);

    // Refresh views
    tasksHosts.forEach((host) => host.refresh());

    // Check cross-branch config for the new root
    checkCrossBranchConfig(parser);

    // Check agent integration status for the new root
    tasksHosts.forEach((host) => host.checkAndSendIntegrationState());

    // Update workspace status bar
    updateWorkspaceStatusBar(manager);

    // Re-point the merge-queue reader + file watcher to the new root's common
    // dir. The old watcher's path (derived from the prior workspace root) is
    // stale — dispose it first, then set up the new one.
    if (root.workspaceFolder) {
      void (async () => {
        // Dispose the old watcher so it doesn't poll a dead path.
        if (mergeQueueWatcherDispose) {
          mergeQueueWatcherDispose.dispose();
          mergeQueueWatcherDispose = undefined;
        }
        const newCommon = await resolveCommonDir(root.workspaceFolder.uri.fsPath);
        if (!newCommon) return;
        const store = new MergeQueueStore(mergeQueuePath(newCommon), nodeQueueFs);
        const reader = (): MergeQueue => store.read();
        tasksHosts.forEach((host) => host.setMergeQueueReader(reader));
        taskDetailProvider.setCommonDir(newCommon);
        tasksHosts.forEach((host) => host.refresh());

        const queueFile = mergeQueuePath(newCommon);
        const onQueueChange = () => tasksHosts.forEach((host) => host.refresh());
        fs.watchFile(queueFile, { interval: 1000 }, (curr, prev) => {
          if (curr.mtimeMs !== prev.mtimeMs) onQueueChange();
        });
        mergeQueueWatcherDispose = new vscode.Disposable(() => fs.unwatchFile(queueFile));
        context.subscriptions.push(mergeQueueWatcherDispose);
      })();
    }
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
          primaryRoot: path.dirname(newBacklogPath),
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
  // Create task: reveal the board and open the unified create form in it.
  // (relayNavigator is the generic "post this ExtensionMessage to the board" relay.)
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.createTask', () => {
      tasksPanelProvider.reveal();
      tasksHosts.forEach((host) => host.relayNavigator({ type: 'openCreateForm', mode: 'full' }));
    })
  );

  // Quick capture: same form in quick (title-only) mode.
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.quickCapture', () => {
      tasksPanelProvider.reveal();
      tasksHosts.forEach((host) => host.relayNavigator({ type: 'openCreateForm', mode: 'quick' }));
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
    treeNavigatorProvider.refresh();
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
      const repoRoot = activeParser.getPrimaryRoot();
      const exec: GitExecFn = (cwd, args) =>
        execFileAsync('git', args, { cwd, timeout: 15_000 }).then((r) => ({
          stdout: r.stdout,
          stderr: r.stderr,
        }));

      await cancelDispatch(
        {
          // Absolute worktree root so the marker lands in .worktrees/<branch>/.taskwright/.
          writeCancellationMarker: (id) =>
            writeCancellationMarker(worktreePathFor(repoRoot, branch), id),
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

  // Board doctor (TASK-90): on-demand health check with one-click repairs, plus
  // a silent-when-clean activation-time run. Read-only until the user picks
  // repairs; every repair routes through the existing writers.
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.doctor', async () => {
      if (!parser) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }
      try {
        await runBoardDoctorFlow(
          { parser, writer, refresh: refreshAllViews },
          { interactive: true }
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Board doctor failed: ${error}`);
      }
    })
  );
  if (parser) {
    const activationParser = parser;
    // Silent-when-clean health check. It parses the board and stats .taskwright/
    // and .worktrees/, so like the rest of the startup work it is deferred off the
    // window-open critical path (TASK-109) rather than run inline.
    const doctorCheck = createDeferredRunner(() =>
      runBoardDoctorFlow(
        { parser: activationParser, writer, refresh: refreshAllViews },
        { interactive: false }
      )
    );
    context.subscriptions.push({ dispose: () => doctorCheck.dispose() });
    doctorCheck.schedule();
  }

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
    }),
    // TASK-127: task-LESS merges (a dev worktree with no board task) queue under a
    // `branch:<name>` key, so they have no board card to approve from. Without this
    // command the manual-review gate would be ungrantable and the dev session would
    // wait forever — the very dead end that pushed such sessions back to a manual
    // merge in the repo root.
    vscode.commands.registerCommand('taskwright.reviewBranchMerge', async () => {
      if (!workspaceRootPath) return;
      const commonDir = await resolveCommonDir(workspaceRootPath);
      if (!commonDir) {
        vscode.window.showErrorMessage('Not a git repository — no merge queue to review.');
        return;
      }
      const pending = pendingBranchMerges(commonDir);
      if (pending.length === 0) {
        vscode.window.showInformationMessage(
          'No task-less branch merges are waiting in the merge queue.'
        );
        return;
      }
      const items: (vscode.QuickPickItem & { entry: PendingBranchMerge })[] = pending.map(
        (entry) => ({
          label: entry.branch,
          description: `queue position ${entry.position}${entry.approved ? ' · approved' : ''}`,
          detail: entry.worktree,
          entry,
        })
      );
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Branch merges awaiting review',
        placeHolder: 'Pick a branch merge',
      });
      if (!picked) return;
      const action = await vscode.window.showQuickPick(
        [
          { label: 'Approve', detail: 'Let the waiting session merge this branch.' },
          { label: 'Send back', detail: 'Drop it from the queue; the session keeps the branch.' },
        ],
        { title: `${picked.entry.branch} — merge queue`, placeHolder: 'Choose an action' }
      );
      if (!action) return;
      try {
        if (action.label === 'Approve') {
          approveMergeInQueue(commonDir, picked.entry.key);
          vscode.window.showInformationMessage(
            `Approved ${picked.entry.branch} — the waiting session will merge it.`
          );
        } else {
          // No board write: a task-less entry has no task to reset to In Progress.
          sendBackInQueue(commonDir, picked.entry.key);
          vscode.window.showInformationMessage(
            `Sent ${picked.entry.branch} back — its session's request_branch_merge returns sent_back.`
          );
        }
        refreshAllViews();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update the merge queue: ${error}`);
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
  // Set once the user opts into MCP integration; drives the on-activate refresh
  // below.
  const CLAUDE_MCP_REGISTERED_KEY = 'taskwright.mcpRegistered';
  const mcpServerPath = path.join(context.extensionPath, 'dist', 'mcp', 'server.js');

  // The command registered with Claude Code is a launcher in globalStorage —
  // a path keyed by extension *id*, not version — that resolves the current
  // build at run time. Registering `extensionPath/dist/mcp/server.js` directly
  // would pin the single global `~/.claude.json` entry to a versioned install
  // directory that the next extension update deletes.
  const installMcpLauncher = (): string =>
    installGlobalMcpLauncher(context.globalStorageUri.fsPath, mcpServerPath);

  // Shared adapter step: offer the Taskwright convention block for AGENTS.md —
  // the agent-neutral instruction surface (Claude Code reads it via CLAUDE.md's
  // @AGENTS.md include, Codex reads it natively). Idempotent — only a marked
  // block is written; existing content is preserved. Creation is consent-gated
  // with a modal.
  const offerAgentsConvention = async (root: string): Promise<void> => {
    const agentsMdPath = path.join(root, 'AGENTS.md');
    const agentsExisted = fs.existsSync(agentsMdPath);
    const agentsExisting = agentsExisted ? fs.readFileSync(agentsMdPath, 'utf-8') : '';
    const agentsUpdated = injectAgentsConvention(agentsExisting);
    if (agentsUpdated === agentsExisting) {
      if (agentsExisted) {
        vscode.window.showInformationMessage('AGENTS.md already has the Taskwright instructions.');
      }
      // fall through — the caller's remaining setup steps still need to run
      return;
    }
    const agentsChoice = await vscode.window.showInformationMessage(
      agentsExisted
        ? 'Add Taskwright agent instructions to your AGENTS.md? Only a marked block is added — your existing content is preserved.'
        : 'Create an AGENTS.md with Taskwright agent instructions so any agent uses the MCP server?',
      { modal: true },
      'Add'
    );
    if (agentsChoice === 'Add') {
      try {
        fs.writeFileSync(agentsMdPath, agentsUpdated, 'utf-8');
        vscode.window.showInformationMessage(
          `${agentsExisted ? 'Updated' : 'Created'} AGENTS.md with Taskwright agent instructions.`
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update AGENTS.md: ${error}`);
      }
    }
  };

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
        await ensureTaskwrightMcpRegistered(installMcpLauncher());
        // Stop the activation prompt from re-checking the CLI on every launch.
        await context.globalState.update(CLAUDE_SETUP_DISMISSED_KEY, true);
        await context.globalState.update(CLAUDE_MCP_REGISTERED_KEY, true);
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
      // fall through — skills install still needs to run below
    } else {
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
    }

    // 2b) Offer the same convention for AGENTS.md so non-Claude agents (Codex,
    // etc.) also reach for the Taskwright MCP (shared adapter step).
    await offerAgentsConvention(root);

    // 3) Install the four user-facing Taskwright skills (create-task,
    // execute-task, index-codebase, orchestrate-board) into the project's
    // .claude/skills/ — idempotent: already-installed skills are skipped, so
    // re-running setup is safe. (visual-proof/agent-browser stay internal.) The source is the
    // BUNDLED copy under dist/skills/ (scripts/build.ts bundles them there) so a
    // published .vsix ships them — .claude/** is excluded from the package.
    const extSkillsDir = path.join(context.extensionPath, 'dist', 'skills');
    const projectSkillsDir = path.join(root, '.claude', 'skills');
    try {
      const skillResults = installTaskwrightSkills(extSkillsDir, projectSkillsDir, false);
      const created = skillResults.filter((r: SkillInstallResult) => r.action === 'created');
      const skipped = skillResults.filter((r: SkillInstallResult) => r.action === 'skipped');
      if (created.length > 0 || skipped.length > 0) {
        const parts: string[] = [];
        if (created.length > 0) {
          parts.push(
            `installed ${created.map((r: SkillInstallResult) => `/${r.name}`).join(', ')}`
          );
        }
        if (skipped.length > 0) {
          parts.push(
            `${skipped.map((r: SkillInstallResult) => `/${r.name}`).join(', ')} already present`
          );
        }
        vscode.window.showInformationMessage(`Taskwright skills: ${parts.join('; ')}.`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to install Taskwright skills: ${error}`);
    }

    // 4) Optionally wire a project-local .mcp.json so a session opened in this
    // repo gets the Taskwright MCP without the user-scope CLI registration.
    // Opt-in (taskwright.setupWritesProjectMcpJson, default false): upsert the
    // taskwright server into .mcp.json (preserving other servers) and copy the
    // committed, dependency-free launcher it references.
    if (getTaskwrightConfig<boolean>('setupWritesProjectMcpJson', false)) {
      try {
        const templatePath = path.join(context.extensionPath, '.mcp.json');
        const taskwrightServer = extractTaskwrightServer(fs.readFileSync(templatePath, 'utf-8'));

        const projectMcpPath = path.join(root, '.mcp.json');
        const existingMcp = fs.existsSync(projectMcpPath)
          ? fs.readFileSync(projectMcpPath, 'utf-8')
          : '';
        fs.writeFileSync(
          projectMcpPath,
          upsertTaskwrightMcpServer(existingMcp, taskwrightServer),
          'utf-8'
        );

        // Copy the launcher the .mcp.json references into <root>/scripts/.
        const launcherSrc = path.join(context.extensionPath, 'scripts', 'taskwright-mcp.cjs');
        const launcherDestDir = path.join(root, 'scripts');
        fs.mkdirSync(launcherDestDir, { recursive: true });
        fs.copyFileSync(launcherSrc, path.join(launcherDestDir, 'taskwright-mcp.cjs'));

        vscode.window.showInformationMessage(
          'Wrote project-local .mcp.json and scripts/taskwright-mcp.cjs for the Taskwright MCP server.'
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to write project-local .mcp.json: ${error}`);
      }
    }

    // 5) Verify-command doctor: detect the repo type and flag configured merge
    // verify commands that provably cannot run here (e.g. the bun-flavored
    // defaults in a Python repo), offering a one-click confirmed fix. Setup is
    // an explicit human action, so a healthy gate is confirmed out loud too.
    await syncMergeConfig(root);
    await runVerifyDoctorCheck(root, { quietWhenOk: false });
  };
  // Codex integration adapter: register the Taskwright MCP server in Codex's
  // user-global config.toml and install the four user-facing skills as native
  // `.agents/skills/` SKILL.md packages — the Codex counterpart of
  // setUpClaudeIntegration. This targets $CODEX_HOME (~/.codex by default) with
  // an ABSOLUTE path to the extension's packaged MCP bundle, so it works from
  // consumer repositories.
  const codexHome = (): string => {
    const fromEnv = process.env.CODEX_HOME?.trim();
    return fromEnv ? fromEnv : path.join(homedir(), '.codex');
  };
  const setUpCodexIntegration = async (): Promise<void> => {
    const root = activeRootDir();
    if (!root) {
      vscode.window.showErrorMessage('No backlog folder found in workspace');
      return;
    }
    const codexDir = codexHome();
    if (!fs.existsSync(codexDir)) {
      vscode.window.showWarningMessage(
        `Codex does not appear to be installed (no ${codexDir}). Install Codex, then run "Taskwright: Set Up Codex Integration (MCP + skills)" again.`
      );
      return;
    }

    // 1) Upsert [mcp_servers.taskwright] into Codex's config.toml (idempotent,
    // preserves every other line of the user's config).
    if (!fs.existsSync(mcpServerPath)) {
      vscode.window.showErrorMessage(
        'The packaged Taskwright MCP server (dist/mcp/server.js) is missing. Reinstall or rebuild the extension.'
      );
      return;
    }
    try {
      const templatePath = path.join(context.extensionPath, '.mcp.json');
      const server = extractTaskwrightServer(fs.readFileSync(templatePath, 'utf-8'));
      // Codex's user-global config needs an absolute, cwd-independent target.
      const codexServer = codexServerForPackagedExtension(server, mcpServerPath);
      const configPath = path.join(codexDir, 'config.toml');
      const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
      fs.writeFileSync(configPath, upsertCodexMcpServer(existing, codexServer), 'utf-8');
      vscode.window.showInformationMessage(
        'Registered the Taskwright MCP server in Codex (config.toml). Restart Codex to load it.'
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to register the Taskwright MCP server with Codex: ${error}`
      );
    }

    // 2) Install the four user-facing skills as NATIVE SKILL.md packages under
    // the project's `.agents/skills/` — Codex's canonical skill discovery
    // surface ($REPO_ROOT/.agents/skills). These are the SAME full skill
    // packages the Claude installer copies into `.claude/skills/` (one source of
    // truth, no capability reduction) — Codex reads name+description up front and
    // loads the full body on demand (progressive disclosure). This replaces the
    // earlier `~/.codex/prompts/<name>.md` custom-prompt approximation.
    // Idempotent: existing skills are skipped.
    try {
      const extSkillsDir = path.join(context.extensionPath, 'dist', 'skills');
      const skillResults = installAgentSkills(extSkillsDir, root, false);
      const created = skillResults.filter((r: SkillInstallResult) => r.action === 'created');
      const skipped = skillResults.filter((r: SkillInstallResult) => r.action === 'skipped');
      if (created.length > 0 || skipped.length > 0) {
        const parts: string[] = [];
        if (created.length > 0) {
          parts.push(`installed ${created.map((r: SkillInstallResult) => r.name).join(', ')}`);
        }
        if (skipped.length > 0) {
          parts.push(
            `${skipped.map((r: SkillInstallResult) => r.name).join(', ')} already present`
          );
        }
        vscode.window.showInformationMessage(
          `Taskwright native skills (.agents/skills): ${parts.join('; ')}.`
        );
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to install Taskwright native skills: ${error}`);
    }

    // 3) AGENTS.md is Codex's native instruction surface — offer the shared
    // Taskwright convention block (same marked block the Claude flow offers).
    await offerAgentsConvention(root);
  };

  // Generalized entry point: run the setup adapter for each requested agent.
  // Per-agent adapters keep their own consent gates and error surfaces.
  const agentIntegrationAdapters = {
    claude: setUpClaudeIntegration,
    codex: setUpCodexIntegration,
  } as const;
  type AgentIntegrationTarget = keyof typeof agentIntegrationAdapters;
  const setUpAgentIntegration = async (...targets: AgentIntegrationTarget[]): Promise<void> => {
    for (const target of targets) {
      await agentIntegrationAdapters[target]();
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.setupClaudeIntegration', () =>
      setUpAgentIntegration('claude')
    ),
    vscode.commands.registerCommand('taskwright.setupCodexIntegration', () =>
      setUpAgentIntegration('codex')
    )
  );

  // Edit Board Config — opens the config editor modal in the tasks webview
  context.subscriptions.push(
    vscode.commands.registerCommand('taskwright.editBoardConfig', () => {
      tasksHosts.forEach((host) => host.relayNavigator({ type: 'openConfigEditor' }));
    })
  );

  // Once the user has opted into MCP integration, re-point the launcher at this
  // build on every activation — that is what makes an extension update safe, and
  // it is a plain file write, never a mutation of the shared `~/.claude.json`.
  // The registration itself is only rewritten if it is missing or stale, so the
  // steady state touches nothing a concurrent Claude Code session could race.
  // Fire-and-forget so it never blocks activation.
  if (context.globalState.get<boolean>(CLAUDE_MCP_REGISTERED_KEY)) {
    void (async () => {
      if (!fs.existsSync(mcpServerPath)) return;
      try {
        const launcherPath = installMcpLauncher();
        if (!(await isClaudeCliAvailable())) return;
        await ensureTaskwrightMcpRegistered(launcherPath);
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
      await setUpAgentIntegration('claude');
    } else if (choice === "Don't ask again") {
      await context.globalState.update(CLAUDE_SETUP_DISMISSED_KEY, true);
    }
  })();

  // One-time prompt (Codex): in a backlog repo where Codex is installed
  // (~/.codex exists) but the Taskwright MCP server isn't in its config yet,
  // offer to set it up. Fire-and-forget so it never blocks activation.
  const CODEX_SETUP_DISMISSED_KEY = 'taskwright.codexSetupDismissed';
  void (async () => {
    if (context.globalState.get<boolean>(CODEX_SETUP_DISMISSED_KEY)) return;
    const root = activeRootDir();
    if (!root) return;
    if (!(await detectCodexInstalled())) return;
    if ((await detectCodexIntegration(root)).mcpConfigured) return;
    const choice = await vscode.window.showInformationMessage(
      'Set up Taskwright for Codex? Registers the MCP server in ~/.codex/config.toml and installs the Taskwright skills as native .agents/skills packages.',
      'Set up',
      'Not now',
      "Don't ask again"
    );
    if (choice === 'Set up') {
      await setUpAgentIntegration('codex');
      await context.globalState.update(CODEX_SETUP_DISMISSED_KEY, true);
    } else if (choice === "Don't ask again") {
      await context.globalState.update(CODEX_SETUP_DISMISSED_KEY, true);
    }
  })();

  // Listen for file changes (only if we have a file watcher)
  if (fileWatcher) {
    const debouncedRefresh = createDebouncedHandler((uri: vscode.Uri) => {
      console.log('[Taskwright] Debounced refresh triggered');
      tasksHosts.forEach((host) => host.refresh());
      taskPreviewProvider.refresh();
      treeNavigatorProvider.refresh();
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
        syncPostCheckoutWarn(workspaceRootPath, context.extensionUri);
      }
      if (
        workspaceRootPath &&
        (affectsTaskwrightConfig(event, 'mergeMode') ||
          affectsTaskwrightConfig(event, 'mergeVerifyCommands') ||
          affectsTaskwrightConfig(event, 'mergeQueueStaleMinutes') ||
          affectsTaskwrightConfig(event, 'mergeVerifyTimeoutMinutes') ||
          affectsTaskwrightConfig(event, 'mergeVerifyTimeoutMaxMinutes'))
      ) {
        void syncMergeConfig(workspaceRootPath);
      }
      if (
        workspaceRootPath &&
        (affectsTaskwrightConfig(event, 'sync.mode') ||
          affectsTaskwrightConfig(event, 'sync.ref') ||
          affectsTaskwrightConfig(event, 'sync.remote') ||
          affectsTaskwrightConfig(event, 'sync.installHooks'))
      ) {
        void publishSyncConfig(workspaceRootPath);
      }
      if (workspaceRootPath && affectsTaskwrightConfig(event, 'sync.installHooks')) {
        syncBoardHooks(workspaceRootPath);
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

  // Check for cross-branch feature configuration
  if (parser) {
    checkCrossBranchConfig(parser);
    tasksHosts.forEach((host) => host.checkAndSendIntegrationState());
  }

  console.log('[Taskwright] Extension activation complete!');
}

export function deactivate(): Thenable<void> | undefined {
  if (fileWatcher) {
    fileWatcher.dispose();
  }
  if (workspaceStatusBarItem) {
    workspaceStatusBarItem.dispose();
  }
  // The user-scope MCP registration is deliberately LEFT IN PLACE. It is a single
  // global entry in `~/.claude.json` shared by every window and every running
  // Claude Code session, whereas deactivate runs per window — so removing it here
  // deleted Taskwright's tools for every *other* open window too, and any session
  // created before some window's next activation re-added it silently had no
  // Taskwright MCP (a reload "fixed" it, which is what made this look random).
  // The entry can no longer go stale: it points at the globalStorage launcher,
  // whose path is version-independent (see installGlobalMcpLauncher). To remove
  // it after uninstalling, run `claude mcp remove taskwright -s user`.
  return undefined;
}

/**
 * Board Sync v2 (Task C): the board is always the single primary `backlog/`
 * root, so `check_active_branches` is treated as effectively off — there is
 * nothing to cross-scan. This only surfaces a heads-up log when the (now
 * inert) setting is still on; it no longer flips the tasks boards into
 * cross-branch mode, which used to blank the Tree tab (TASK-35).
 */
async function checkCrossBranchConfig(parser: BacklogParser): Promise<void> {
  try {
    const config = await parser.getConfig();
    if (config.check_active_branches) {
      console.log(
        '[Taskwright] check_active_branches is set but has no effect: the board is a single local root and is always shown in full.'
      );
    }
  } catch (error) {
    console.error('[Taskwright] Error checking cross-branch config:', error);
  }
}
