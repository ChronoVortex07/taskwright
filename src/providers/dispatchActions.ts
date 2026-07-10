import * as path from 'path';
import * as vscode from 'vscode';
import { BacklogParser } from '../core/BacklogParser';
import { GitBranchService } from '../core/GitBranchService';
import { createWorktree } from '../core/WorktreeService';
import { writeActiveTask } from '../core/activeTask';
import { clearCancellationMarker } from '../core/cancellationMarker';
import { writeHandoff, handoffPath } from '../core/handoff';
import {
  dispatchBranchName,
  dispatchContextFromTask,
  renderDispatchPrompt,
  resolveTerminalLaunch,
} from '../core/dispatchPrompt';
import { resolveDispatchProfile } from '../core/dispatchProfiles';
import { getTaskwrightConfig } from '../config';
import { loadTreeStateFromParser } from '../core/treeDerived';
import { blockedByMessage } from '../core/treeGate';

/**
 * Provider-layer glue for subscription-safe dispatch. Composes the pure cores
 * (prompt rendering, worktree creation, handoff/active-task writes) with VS Code
 * config, clipboard, and terminal. It never spawns an agent headlessly
 * (`claude -p`, `codex exec`, …) — the output is a paste-ready prompt the user
 * drops into a fresh interactive session of the configured agent
 * (`taskwright.dispatchAgent`, phrasing per `dispatchProfiles.ts`).
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
  terminalCommand: string;
}

function readSettings(): DispatchSettings {
  // A custom taskwright.dispatchTemplate always wins untouched; otherwise the
  // selected agent's profile (taskwright.dispatchAgent) supplies the template.
  const template = getTaskwrightConfig<string>('dispatchTemplate', '').trim();
  const profile = resolveDispatchProfile(getTaskwrightConfig<string>('dispatchAgent', 'claude'));
  return {
    template: template || profile.template,
    createWorktree: getTaskwrightConfig<boolean>('dispatchCreateWorktree', true),
    openTerminal: getTaskwrightConfig<boolean>('dispatchOpenTerminal', false),
    terminalCommand: getTaskwrightConfig<string>('dispatchTerminalCommand', ''),
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

  // Dependency gate: never dispatch a locked task.
  try {
    const states = await loadTreeStateFromParser(parser);
    const derived = states.get(task.id.trim().toUpperCase());
    if (derived?.locked) {
      vscode.window.showErrorMessage(blockedByMessage(task.id, derived.blockedBy));
      return undefined;
    }
  } catch {
    // Intentional fail-open: a transient derive/IO error must not brick dispatch — do not "fix" to fail-closed.
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
  // it, then render + persist the paste-ready prompt. Clear any stale cancellation
  // marker left by a prior (leaked) cancel of the SAME task (deterministic branch =>
  // reused worktree dir) so this fresh /execute-task does not insta-abort (GAP-3).
  writeActiveTask(sessionRoot, taskId);
  clearCancellationMarker(sessionRoot);
  // Invariant: handoffPath must match what writeHandoff writes — both derive from src/core/handoff.ts.
  const handoffFile = handoffPath(sessionRoot, taskId);
  const context = dispatchContextFromTask(task, { worktree: branch, handoffFile });
  let prompt = renderDispatchPrompt(settings.template, context);

  // No isolated worktree (opt-out via taskwright.dispatchCreateWorktree=false, or a
  // creation failure fell back to the repo root). Every built-in profile template tells
  // the session to launch inside `.worktrees/<branch>` and run `/execute-task` — but
  // /execute-task STOPs in the primary tree (no worktree). Prepend a NOTE so the pasted
  // prompt is coherent (work in place, manual TDD, no /execute-task) and warn the human.
  // We touch only the rendered prompt here, never the profile templates (they are also
  // the handoff source and the user-customizable `dispatchTemplate` setting wins as-is).
  if (!worktreePath) {
    const note =
      '> NOTE: No isolated worktree was created for this dispatch ' +
      '(taskwright.dispatchCreateWorktree is off, or worktree creation failed). ' +
      'Work this task IN PLACE in the current checkout using the manual TDD / superpowers ' +
      'workflow, and commit here. Do NOT run the `/execute-task` skill — it requires a ' +
      'dedicated `.worktrees/<branch>` worktree and will stop when run in the primary tree. ' +
      'Ignore the worktree-launch instructions below.\n\n';
    prompt = note + prompt;
    vscode.window.showWarningMessage(
      'Taskwright dispatched without an isolated worktree — the pasted prompt works the task ' +
        'in place with the manual TDD workflow (not /execute-task, which requires a worktree). ' +
        'Enable taskwright.dispatchCreateWorktree for the full auto-close flow.'
    );
  }
  writeHandoff(sessionRoot, taskId, prompt);
  await vscode.env.clipboard.writeText(prompt);

  if (settings.openTerminal && worktreePath) {
    const terminal = vscode.window.createTerminal({
      name: `Taskwright ${taskId}`,
      cwd: worktreePath,
    });
    terminal.show();
    const launch = resolveTerminalLaunch(settings.terminalCommand, context);
    if (launch.warning) {
      vscode.window.showWarningMessage(launch.warning);
    }
    if (launch.run && launch.command) {
      terminal.sendText(launch.command, true);
    }
  }

  return { taskId, prompt, handoffFile, sessionRoot, branch, worktreePath };
}
