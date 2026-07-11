import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BacklogParser } from '../core/BacklogParser';
import {
  BacklogWriter,
  detectCRLF,
  normalizeToLF,
  restoreLineEndings,
} from '../core/BacklogWriter';
import { TreeFieldService } from '../core/TreeFieldService';
import { atomicWriteFileSync } from '../core/atomicWrite';
import { clearActiveTask } from '../core/activeTask';
import { handoffPath } from '../core/handoff';
import { removeWorktree } from '../core/finishTask';
import { writeCancellationMarker } from '../core/cancellationMarker';
import { worktreePathFor, type GitExecFn } from '../core/WorktreeService';
import {
  runBoardDoctor,
  stripDanglingContinuations,
  type DoctorFinding,
} from '../core/boardDoctor';
import { releaseTaskClaim } from './claimActions';
import { ensureBoardWorktree } from '../core/boardWorktree';
import { foldPrimaryStrays } from '../core/boardHomeMigration';
import { materializeRefToWorktree } from '../core/boardRef';
import { formatConflictMessage } from '../core/boardSyncUx';
import { resolveSyncConfigFromSettings } from '../core/syncConfig';

/**
 * Board-doctor UX glue (TASK-90): run the pure `runBoardDoctor` core, surface
 * findings as a notification/quick-pick, and apply the repairs the user picks —
 * each routed through the EXISTING writers (activeTask.ts, claimActions,
 * finishTask.removeWorktree + cancellation marker, TreeFieldService, and a
 * CRLF-safe surgical rewrite for the continuation corruption). Nothing is
 * deleted without the user explicitly selecting it; worktree teardown gets an
 * extra modal confirmation because it can hold uncommitted work.
 */

const execFileAsync = promisify(execFile);
const defaultExec: GitExecFn = (cwd, args) =>
  execFileAsync('git', args, { cwd, timeout: 15_000 }).then((r) => ({
    stdout: r.stdout,
    stderr: r.stderr,
  }));

export interface DoctorFlowDeps {
  parser: BacklogParser;
  writer: BacklogWriter;
  refresh: () => void;
  /** Injectable for tests; defaults to a real `git` runner. */
  exec?: GitExecFn;
}

/** Human-readable label for the one-click repair a finding carries. */
export function repairLabel(finding: DoctorFinding): string {
  switch (finding.repair) {
    case 'clear-active-task':
      return 'Clear the active-task pointer';
    case 'delete-handoff':
      return 'Delete the handoff file';
    case 'teardown-worktree':
      return 'Remove the worktree (confirms first)';
    case 'reset-status':
      return 'Reset the task to the first status';
    case 'release-claim':
      return 'Release the claim';
    case 'fix-category':
      return finding.suggestion ? `Set category to "${finding.suggestion}"` : 'Clear the category';
    case 'strip-continuations':
      return 'Strip the dangling lines';
    case 'repair-board-worktree':
      return 'Repair the board worktree';
    case 'fold-primary-strays':
      return 'Fold the stray files into the board';
    case 'restore-board-to-primary':
      return 'Restore the board into backlog/';
  }
}

/** Apply one selected repair. Returns false when the user declined a confirm. */
async function applyRepair(deps: DoctorFlowDeps, finding: DoctorFinding): Promise<boolean> {
  const { parser, writer } = deps;
  const repoRoot = parser.getPrimaryRoot();
  switch (finding.repair) {
    case 'clear-active-task': {
      clearActiveTask(repoRoot);
      return true;
    }
    case 'delete-handoff': {
      if (!finding.taskId) return false;
      fs.rmSync(handoffPath(repoRoot, finding.taskId), { force: true });
      return true;
    }
    case 'release-claim': {
      if (!finding.taskId) return false;
      await releaseTaskClaim(finding.taskId, parser);
      return true;
    }
    case 'reset-status': {
      if (!finding.taskId) return false;
      const statuses = await parser.getStatuses();
      await writer.updateTask(finding.taskId, { status: statuses[0] ?? 'To Do' }, parser);
      return true;
    }
    case 'fix-category': {
      if (!finding.taskId) return false;
      const treeFieldService = new TreeFieldService();
      if (finding.suggestion) {
        await treeFieldService.setCategory(finding.taskId, finding.suggestion, parser);
      } else {
        await treeFieldService.clearCategory(finding.taskId, parser);
      }
      return true;
    }
    case 'teardown-worktree': {
      const dir = finding.detail;
      if (!dir) return false;
      const confirm = await vscode.window.showWarningMessage(
        `Remove .worktrees/${dir}? Any uncommitted work inside it will be lost.`,
        { modal: true },
        'Remove worktree'
      );
      if (confirm !== 'Remove worktree') return false;
      // Marker FIRST (same load-bearing order as cancelDispatch): if a stray
      // session is still running in the dir, it sees the cancellation.
      try {
        writeCancellationMarker(worktreePathFor(repoRoot, dir), finding.taskId ?? dir);
      } catch {
        // best-effort — the removal below is the actual repair
      }
      await removeWorktree(deps.exec ?? defaultExec, repoRoot, `.worktrees/${dir}`);
      return true;
    }
    case 'strip-continuations': {
      if (!finding.taskId) return false;
      const task = await parser.getTask(finding.taskId);
      if (!task) return false;
      const raw = fs.readFileSync(task.filePath, 'utf-8');
      const hasCRLF = detectCRLF(raw);
      const updated = stripDanglingContinuations(normalizeToLF(raw));
      atomicWriteFileSync(task.filePath, restoreLineEndings(updated, hasCRLF));
      parser.invalidateTaskCache(task.filePath);
      return true;
    }
    case 'repair-board-worktree': {
      const cfg = vscode.workspace.getConfiguration('taskwright');
      await ensureBoardWorktree({
        primaryRoot: repoRoot,
        ref: cfg.get<string>('sync.ref')?.trim() || 'taskwright-board',
        remote: cfg.get<string>('sync.remote')?.trim() || 'origin',
      });
      parser.invalidateTaskCache();
      return true;
    }
    case 'fold-primary-strays': {
      const folded = await foldPrimaryStrays(repoRoot);
      if (folded && folded.conflicts.length > 0) {
        void vscode.window.showWarningMessage(formatConflictMessage('pulled', folded.conflicts));
      }
      parser.invalidateTaskCache();
      return true;
    }
    case 'restore-board-to-primary': {
      const cfg = vscode.workspace.getConfiguration('taskwright');
      await materializeRefToWorktree({
        repoRoot,
        ref: cfg.get<string>('sync.ref')?.trim() || 'taskwright-board',
        indexFile: path.join(repoRoot, '.taskwright', 'board.index'),
        backlogDir: 'backlog',
      });
      parser.invalidateTaskCache();
      return true;
    }
  }
}

interface DoctorPickItem extends vscode.QuickPickItem {
  finding: DoctorFinding;
}

/**
 * Run the doctor and surface the findings. `interactive` (the
 * `taskwright.doctor` command) reports a healthy board and goes straight to
 * the repair picker; the activation-time run is silent when clean and asks
 * via a notification before showing the picker.
 */
export async function runBoardDoctorFlow(
  deps: DoctorFlowDeps,
  opts: { interactive: boolean }
): Promise<void> {
  const repoRoot = deps.parser.getPrimaryRoot();
  // The board-home checks (worktree missing / strays / mode mismatch) need the
  // sync mode; the settings mirror is the same source publishSyncConfig reads.
  const taskwrightCfg = vscode.workspace.getConfiguration('taskwright');
  const syncCfg = resolveSyncConfigFromSettings({
    mode: taskwrightCfg.get('sync.mode'),
    ref: taskwrightCfg.get('sync.ref'),
  });
  const findings = await runBoardDoctor(deps.parser, repoRoot, {
    syncMode: syncCfg.mode,
    ref: syncCfg.ref,
  });

  if (findings.length === 0) {
    if (opts.interactive) {
      vscode.window.showInformationMessage('Taskwright board is healthy — no issues found.');
    }
    return;
  }

  if (!opts.interactive) {
    const action = await vscode.window.showWarningMessage(
      `Taskwright board doctor found ${findings.length} issue${findings.length === 1 ? '' : 's'}.`,
      'Review',
      'Dismiss'
    );
    if (action !== 'Review') return;
  }

  const items: DoctorPickItem[] = findings.map((finding) => ({
    label: finding.message,
    description: repairLabel(finding),
    picked: true,
    finding,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Board doctor — ${findings.length} issue${findings.length === 1 ? '' : 's'} found`,
    placeHolder: 'Select the repairs to apply (nothing is changed until you confirm)',
  });
  if (!selected || selected.length === 0) return;

  let repaired = 0;
  const failures: string[] = [];
  for (const item of selected) {
    try {
      if (await applyRepair(deps, item.finding)) repaired++;
    } catch (error) {
      failures.push(`${item.finding.taskId ?? item.finding.detail ?? item.finding.type}: ${error}`);
    }
  }
  deps.refresh();
  if (failures.length > 0) {
    vscode.window.showErrorMessage(
      `Board doctor repaired ${repaired} issue(s); ${failures.length} failed: ${failures.join('; ')}`
    );
  } else if (repaired > 0) {
    vscode.window.showInformationMessage(`Board doctor repaired ${repaired} issue(s).`);
  }
}
