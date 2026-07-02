/**
 * Cancel a dispatched task (P2 spec §7, v1 scope). Reverses a dispatch: release
 * the claim, return the task to the first configured status, remove the isolated
 * worktree, and dispose the terminal the extension launched. Pure orchestrator —
 * every side effect is injected so this is unit-testable and reuses the same cores
 * the MCP/commands use (parity). Best-effort: one failing step never blocks the rest.
 */
export interface CancelDispatchDeps {
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
  await attempt(() => deps.releaseClaim(input.taskId));
  await attempt(() => deps.setStatus(input.taskId, input.toDoStatus));
  await attempt(() => deps.removeWorktree(`.worktrees/${input.branch}`));
  await attempt(() => deps.disposeTerminal(input.terminalName));

  // TODO(P5): write a task/worktree-scoped cancellation marker that the dispatched
  // agent detects at its next checkpoint (the P5 cancellation-signal protocol — see
  // the P5 spec §6). P2 only tears down local state; it does not signal a live agent.
  //
  // Q2 (adjudicated, v1): "dispatched/agent" is inferred from the `worktree` claim
  // field — a human claiming from a worktree, or a dispatched-but-unclaimed task, are
  // accepted edge cases for v1. A firmer marker (`dispatched_at` frontmatter) lands
  // with this P5 cancellation protocol, not now.
}
