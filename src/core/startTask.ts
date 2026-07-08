import { createWorktree } from './WorktreeService';
import { writeActiveTask } from './activeTask';
import { clearCancellationMarker } from './cancellationMarker';
import { dispatchBranchName } from './dispatchPrompt';
import { GitBranchService } from './GitBranchService';
import type { Task } from './types';

/**
 * Bootstrap a task's isolated worktree from any primary-rooted session.
 *
 * Today only the board Dispatch action (src/providers/dispatchActions.ts) creates a
 * `.worktrees/<branch>` and seeds its active task. `start_task` exposes that same
 * bootstrap over MCP: create (or reuse) the worktree, seed the active task INSIDE it,
 * and clear any stale cancellation marker — the identical sequence dispatchTask runs
 * (createWorktree -> writeActiveTask -> clearCancellationMarker).
 *
 * It deliberately does NOT try to re-root the running MCP server: the server binds its
 * root once at process launch (`TASKWRIGHT_ROOT || cwd`, src/mcp/server.ts) and an
 * in-session `cd` does not move it. So the returned `relaunchHint` instructs the caller
 * to launch a fresh session with cwd = the new worktree to run `/execute-task` there.
 *
 * Idempotent: createWorktree reuses an existing dir (created:false, no git run), and both
 * writeActiveTask and clearCancellationMarker are idempotent, so re-running is safe.
 */

export interface StartTaskDeps {
  /** The primary checkout root that owns `.worktrees/` (parent of the board's `backlog/`). */
  repoRoot: string;
  /** Resolve a task's id + title (for the deterministic branch slug); undefined for an unknown id. */
  getTask: (taskId: string) => Promise<Pick<Task, 'id' | 'title'> | undefined>;
}

export interface StartTaskResult {
  /** True when a new worktree was created; false when an existing one was reused (idempotent). */
  created: boolean;
  taskId: string;
  branch: string;
  /** Repo-root-relative worktree path, e.g. ".worktrees/task-7-add-login". */
  worktree: string;
  /** Absolute worktree path. */
  worktreeAbs: string;
  /** Why the caller must relaunch a session in the worktree to run /execute-task. */
  relaunchHint: string;
}

export async function bootstrapTaskWorktree(
  deps: StartTaskDeps,
  taskId: string
): Promise<StartTaskResult> {
  const task = await deps.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was not found.`);
  }

  const git = new GitBranchService(deps.repoRoot);
  if (!(await git.isGitRepository())) {
    throw new Error(
      `start_task needs a git repository at ${deps.repoRoot} to create an isolated worktree.`
    );
  }

  const branch = dispatchBranchName(task);
  const wt = await createWorktree(deps.repoRoot, branch);

  // Seed the active task INTO the worktree (its own .taskwright/), mirroring dispatchTask,
  // and clear any stale cancellation marker so a fresh /execute-task does not insta-abort.
  writeActiveTask(wt.path, task.id);
  clearCancellationMarker(wt.path);

  return {
    created: wt.created,
    taskId: task.id,
    branch,
    worktree: `.worktrees/${branch}`,
    worktreeAbs: wt.path,
    relaunchHint:
      `This MCP server is rooted at the directory this session launched in and cannot re-root ` +
      `mid-session, so it cannot run /execute-task in the new worktree. Open a NEW Claude Code ` +
      `session with its working directory set to ${wt.path} (open that folder, or launch the ` +
      `session from there), then run /execute-task in it.`,
  };
}
