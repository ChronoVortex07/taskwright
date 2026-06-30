import * as path from 'path';
import * as vscode from 'vscode';
import { BacklogParser } from '../core/BacklogParser';
import { GitBranchService } from '../core/GitBranchService';
import { createWorktree } from '../core/WorktreeService';
import { writeActiveTask } from '../core/activeTask';
import { writeHandoff } from '../core/handoff';
import {
  DEFAULT_DISPATCH_TEMPLATE,
  dispatchBranchName,
  dispatchContextFromTask,
  renderDispatchPrompt,
} from '../core/dispatchPrompt';
import { getTaskwrightConfig } from '../config';

/**
 * Provider-layer glue for subscription-safe dispatch. Composes the pure cores
 * (prompt rendering, worktree creation, handoff/active-task writes) with VS Code
 * config, clipboard, and terminal. It never spawns `claude -p` — the output is a
 * paste-ready prompt the user drops into a fresh Claude Code session.
 */
export interface DispatchResult {
  taskId: string;
  prompt: string;
  handoffFile: string;
  /** The session root (worktree dir when one was created, else the repo root). */
  sessionRoot: string;
  branch: string;
  worktreePath?: string;
}

/** The repo root that owns the backlog (parent of the `backlog/` directory). */
function repoRootFor(parser: BacklogParser): string {
  return path.dirname(parser.getBacklogPath());
}

interface DispatchSettings {
  template: string;
  createWorktree: boolean;
  openTerminal: boolean;
}

function readSettings(): DispatchSettings {
  const template = getTaskwrightConfig<string>('dispatchTemplate', '').trim();
  return {
    template: template || DEFAULT_DISPATCH_TEMPLATE,
    createWorktree: getTaskwrightConfig<boolean>('dispatchCreateWorktree', false),
    openTerminal: getTaskwrightConfig<boolean>('dispatchOpenTerminal', false),
  };
}

/**
 * Dispatch a task: optionally carve out a git worktree, mark the task active for
 * that session root, render the prompt, write a handoff file, and copy the prompt
 * to the clipboard. Returns undefined (after showing a message) when the task is
 * unknown.
 */
export async function dispatchTask(
  taskId: string,
  parser: BacklogParser
): Promise<DispatchResult | undefined> {
  const task = await parser.getTask(taskId);
  if (!task) {
    vscode.window.showErrorMessage(`Task ${taskId} was not found.`);
    return undefined;
  }

  const repoRoot = repoRootFor(parser);
  const settings = readSettings();
  const branch = dispatchBranchName(task);

  // Optionally create an isolated worktree. On any failure (not a git repo, dirty
  // branch, etc.) fall back to the repo root so dispatch still produces a prompt.
  let sessionRoot = repoRoot;
  let worktreePath: string | undefined;
  if (settings.createWorktree) {
    try {
      const git = new GitBranchService(repoRoot);
      if (await git.isGitRepository()) {
        const wt = await createWorktree(repoRoot, branch);
        sessionRoot = wt.path;
        worktreePath = wt.path;
      } else {
        vscode.window.showWarningMessage(
          'Not a git repository — dispatching into the workspace root instead of a worktree.'
        );
      }
    } catch (error) {
      vscode.window.showWarningMessage(
        `Could not create a worktree (${error}); dispatching into the workspace root instead.`
      );
    }
  }

  // Mark the task active for the session root so the MCP get_active_task resolves
  // it, then render + persist the paste-ready prompt.
  writeActiveTask(sessionRoot, taskId);
  const prompt = renderDispatchPrompt(
    settings.template,
    dispatchContextFromTask(task, { worktree: branch })
  );
  const handoffFile = writeHandoff(sessionRoot, taskId, prompt);
  await vscode.env.clipboard.writeText(prompt);

  if (settings.openTerminal && worktreePath) {
    const terminal = vscode.window.createTerminal({
      name: `Taskwright ${taskId}`,
      cwd: worktreePath,
    });
    terminal.show();
  }

  return { taskId, prompt, handoffFile, sessionRoot, branch, worktreePath };
}
