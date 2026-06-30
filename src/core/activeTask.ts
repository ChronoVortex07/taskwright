import * as fs from 'fs';
import * as path from 'path';

/**
 * The "active task" is Taskwright's pull-based handoff to an agent session:
 * the board (or a dispatch) records which task a session should work on, and
 * the Taskwright MCP server's `get_active_task` reads it back. There is no API
 * to push context into a running agent session, so this file is the rendezvous.
 *
 * State lives at `<root>/.taskwright/active-task.json`. `root` is the directory
 * a session runs in — the repo root, or a per-task git worktree — so concurrent
 * sessions in different worktrees each see their own active task. The file is
 * local/ephemeral (git-ignored), never shared.
 */

export interface ActiveTask {
  /** ID of the task the session should work on (e.g. `TASK-7`). */
  taskId: string;
  /** ISO-8601 timestamp of when it was marked active. */
  setAt: string;
}

const STATE_DIR = '.taskwright';
const STATE_FILE = 'active-task.json';

/** Absolute path of the active-task state file under `root`. */
export function activeTaskPath(root: string): string {
  return path.join(root, STATE_DIR, STATE_FILE);
}

/**
 * Read the active task for `root`, or undefined when none is set or the file is
 * missing/malformed. Never throws — a broken state file means "no active task".
 */
export function readActiveTask(root: string): ActiveTask | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(activeTaskPath(root), 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const data = JSON.parse(raw) as Partial<ActiveTask>;
    if (typeof data?.taskId === 'string' && data.taskId.trim()) {
      return { taskId: data.taskId, setAt: typeof data.setAt === 'string' ? data.setAt : '' };
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** Mark `taskId` active for `root`, creating the state dir if needed. */
export function writeActiveTask(root: string, taskId: string, now: Date = new Date()): ActiveTask {
  const active: ActiveTask = { taskId, setAt: now.toISOString() };
  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  fs.writeFileSync(activeTaskPath(root), `${JSON.stringify(active, null, 2)}\n`, 'utf-8');
  return active;
}

/** Clear the active task for `root`. Idempotent — a missing file is fine. */
export function clearActiveTask(root: string): void {
  try {
    fs.unlinkSync(activeTaskPath(root));
  } catch {
    // already absent — nothing to clear
  }
}
