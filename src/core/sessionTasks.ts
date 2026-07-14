import * as fs from 'fs';
import * as path from 'path';

/**
 * The session-task ledger: the tasks THIS session has in flight — the ones it
 * started (`start_task`) or claimed (`claim_task`).
 *
 * Why it exists (TASK-129). The "active task" (see activeTask.ts) is an ephemeral
 * pointer the BOARD or a DISPATCH writes into the directory a session runs in. But
 * a session that bootstraps its own worktree with `start_task` gets no such pointer:
 * `start_task` seeds the marker inside the NEW worktree (where a relaunched session
 * would look), while the calling session's MCP server stays rooted in the primary
 * tree — the server binds its root once at launch and an in-session `cd` does not
 * move it. So the session that just bootstrapped a worktree was precisely the one
 * that could not see its own active task, and it fell back to hunting the board on
 * disk. This ledger closes that gap: `get_active_task` reads it when no marker is set.
 *
 * State lives at `<root>/.taskwright/session-tasks.json` — local, ephemeral, and
 * git-ignored, exactly like the active-task marker. `root` is the MCP server's root.
 *
 * It is a LIST, not a single value, and that is load-bearing: one orchestrator
 * session shares one MCP server (and one root) across all its in-session subagents,
 * so a fan-out records every bootstrapped task here. MCP calls carry no working
 * directory, so the server genuinely cannot tell which subagent is asking — with
 * several tasks in flight the only correct answer is "ambiguous", never a guess.
 * Callers resolve that policy (see `getActiveTask`); this module just keeps the list.
 */

/** How a task entered this session's ledger. */
export type SessionTaskVia = 'start_task' | 'claim_task';

export interface SessionTaskEntry {
  /** ID of the task this session started/claimed (e.g. `TASK-7`). */
  taskId: string;
  /** Repo-root-relative worktree the task runs in, when known. */
  worktree?: string;
  /** ISO-8601 timestamp of when this session took the task on. */
  at: string;
  /** Which call recorded it. */
  via: SessionTaskVia;
}

/** What a caller supplies; `at` is stamped for them. */
export interface SessionTaskInput {
  taskId: string;
  worktree?: string;
  via: SessionTaskVia;
}

const STATE_DIR = '.taskwright';
const STATE_FILE = 'session-tasks.json';
/** Cap the ledger so a long-lived session cannot grow it without bound. */
const MAX_ENTRIES = 50;

/** Absolute path of the session-task ledger under `root`. */
export function sessionTasksPath(root: string): string {
  return path.join(root, STATE_DIR, STATE_FILE);
}

function isEntry(value: unknown): value is SessionTaskEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<SessionTaskEntry>;
  return typeof e.taskId === 'string' && e.taskId.trim().length > 0;
}

function sameTask(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * Read this session's in-flight tasks, oldest first. Never throws — a missing or
 * corrupt ledger means "this session has taken on no tasks", which degrades to
 * today's behavior (`get_active_task` reports none) rather than breaking a session.
 */
export function readSessionTasks(root: string): SessionTaskEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionTasksPath(root), 'utf-8');
  } catch {
    return [];
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(isEntry).map((e) => ({
      taskId: e.taskId,
      ...(e.worktree ? { worktree: e.worktree } : {}),
      at: typeof e.at === 'string' ? e.at : '',
      via: e.via === 'start_task' || e.via === 'claim_task' ? e.via : 'claim_task',
    }));
  } catch {
    return [];
  }
}

/** Write the ledger atomically (temp + rename), the board-mutation convention. */
function writeSessionTasks(root: string, entries: SessionTaskEntry[]): void {
  const target = sessionTasksPath(root);
  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, target);
}

/**
 * Record a task this session started/claimed. Upsert by task ID (case-insensitive):
 * a `start_task` followed by a `claim_task` for the same task is ONE entry, refreshed.
 * Best-effort — a failure to persist must never fail the start/claim it accompanies.
 */
export function recordSessionTask(
  root: string,
  input: SessionTaskInput,
  now: Date = new Date()
): SessionTaskEntry[] {
  const entry: SessionTaskEntry = {
    taskId: input.taskId,
    ...(input.worktree ? { worktree: input.worktree } : {}),
    at: now.toISOString(),
    via: input.via,
  };
  const entries = [
    ...readSessionTasks(root).filter((e) => !sameTask(e.taskId, input.taskId)),
    entry,
  ].slice(-MAX_ENTRIES);
  try {
    writeSessionTasks(root, entries);
  } catch {
    // best-effort: the ledger is an optimization, never a gate
  }
  return entries;
}

/**
 * Drop a task from the ledger — it is no longer in flight for this session
 * (`release_task`, or a terminal `request_merge`). Idempotent; never throws.
 */
export function forgetSessionTask(root: string, taskId: string): void {
  const entries = readSessionTasks(root);
  const kept = entries.filter((e) => !sameTask(e.taskId, taskId));
  if (kept.length === entries.length) return; // nothing to do (also: no ledger at all)
  try {
    writeSessionTasks(root, kept);
  } catch {
    // best-effort
  }
}
