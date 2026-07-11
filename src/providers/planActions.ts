import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BacklogParser } from '../core/BacklogParser';
import { PlanService } from '../core/PlanService';

/**
 * Provider-layer glue for the superpowers plan bridge: pick a plan/spec file and
 * store its repo-root-relative path on the task via {@link PlanService}. Kept out
 * of `src/core` because it reaches into VS Code dialogs.
 */
const planService = new PlanService();

/** The repo root that owns the backlog (parent of the `backlog/` directory). */
function repoRootFor(parser: BacklogParser): string {
  return parser.getPrimaryRoot();
}

/**
 * Prompt for a plan file and attach it to a task. Returns the stored
 * (repo-relative) path, or undefined if the user cancelled or picked a file
 * outside the repository.
 */
export async function attachPlanForTask(
  taskId: string,
  parser: BacklogParser
): Promise<string | undefined> {
  const repoRoot = repoRootFor(parser);
  const plansDir = path.join(repoRoot, 'docs', 'superpowers', 'plans');
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Attach plan',
    filters: { Markdown: ['md', 'markdown'] },
    defaultUri: vscode.Uri.file(fs.existsSync(plansDir) ? plansDir : repoRoot),
  });
  if (!picked || picked.length === 0) return undefined;

  const rel = path.relative(repoRoot, picked[0].fsPath).replace(/\\/g, '/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    vscode.window.showWarningMessage('Plan file must live inside the repository.');
    return undefined;
  }
  return planService.attachPlan(taskId, rel, parser);
}

/** Remove the plan link from a task. */
export async function detachPlanForTask(taskId: string, parser: BacklogParser): Promise<void> {
  await planService.detachPlan(taskId, parser);
}

/** Open a task's attached plan file in an editor. */
export async function openPlanForTask(planRelPath: string, parser: BacklogParser): Promise<void> {
  const abs = path.join(repoRootFor(parser), planRelPath);
  const doc = await vscode.workspace.openTextDocument(abs);
  await vscode.window.showTextDocument(doc);
}
