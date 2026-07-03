/**
 * Cancel a dispatched task (P2 spec §7, v1 scope). Reverses a dispatch: release
 * the claim, return the task to the first configured status, remove the isolated
 * worktree, and dispose the terminal the extension launched. Pure orchestrator —
 * every side effect is injected so this is unit-testable and reuses the same cores
 * the MCP/commands use (parity). Best-effort: one failing step never blocks the rest.
 */
export interface CancelDispatchDeps {
  /** Write the task/worktree-scoped cancellation marker into the worktree's `.taskwright/`.
   *  Invoked FIRST, before any teardown — the ordering is load-bearing (see cancelDispatch). */
  writeCancellationMarker: (taskId: string) => void;
  releaseClaim: (taskId: string) => Promise<void>;
  setStatus: (taskId: string, status: string) => Promise<void>;
  removeWorktree: (worktreeRelPath: string) => Promise<void>;
  disposeTerminal: (terminalName: string) => void;
}

export interface CancelDispatchInput {
  taskId: string;
  /** Dispatch branch name (`dispatchBranchName(task)`); the worktree is `.worktrees/<branch>`. */
  branch: string;
  /** The status to reset to — the first configured status (usually "To Do"). */
  toDoStatus: string;
  /** The terminal name the dispatch used (`Taskwright <taskId>`). */
  terminalName: string;
}

async function attempt(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort cleanup — a failed step must not block the others
  }
}

export async function cancelDispatch(
  deps: CancelDispatchDeps,
  input: CancelDispatchInput
): Promise<void> {
  // Marker FIRST — the order is load-bearing (see the block comment below).
  await attempt(() => deps.writeCancellationMarker(input.taskId));
  await attempt(() => deps.releaseClaim(input.taskId));
  await attempt(() => deps.setStatus(input.taskId, input.toDoStatus));
  await attempt(() => deps.removeWorktree(`.worktrees/${input.branch}`));
  await attempt(() => deps.disposeTerminal(input.terminalName));

  // Ordering rationale (P5, GAP-1): the marker is written before removeWorktree, never
  // after. removeWorktree runs `git worktree remove --force` (finishTask.ts:209-224),
  // which sweeps the whole dir including the git-ignored `.taskwright/`. Writing the
  // marker AFTER a successful removal would resurrect `.worktrees/<branch>/.taskwright/`
  // via mkdirSync — and the next dispatch's createWorktree sees the dir exists, SKIPS
  // `git worktree add` (WorktreeService.ts:74-79), and runs the agent in a plain dir git
  // resolves up to the PRIMARY tree (isolation silently defeated).
  //
  // Detection (P5, GAP-2) is presence-only (src/core/cancellationMarker.ts) and co-equal
  // with the worktree-vanished backstop: on POSIX `git worktree remove --force` unlinks
  // the busy dir and DELETES the marker, so the vanished worktree is the only signal
  // there; on Windows a busy removal may leave the marker AND LEAK the worktree — a
  // single cancelDispatch call does not `prune`-reclaim it (`git worktree prune` only
  // deregisters worktrees whose directory is already missing). The self-heal is the next
  // dispatch of the same task, which reuses the dir after clearing the stale marker
  // (dispatchActions clearCancellationMarker, GAP-3).
  //
  // We deliberately do NOT add a `dispatched_at` frontmatter field (GAP-8): teardown
  // derives the worktree path from the task id (extension wiring: worktreePathFor +
  // dispatchBranchName), so it would buy zero cancellation-correctness and only add
  // Backlog.md byte-compat surface. The Cancel-dispatch affordance is gated on
  // worktree-dir existence (TasksController `dispatchedWorktree`), not the claim field.
}
