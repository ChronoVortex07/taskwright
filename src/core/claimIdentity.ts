/**
 * Resolve the identity that a human-driven claim is attributed to.
 *
 * Priority:
 *  1. An explicitly configured identity (`taskwright.claimIdentity`), used verbatim
 *     (trimmed) — lets a user pick a handle independent of their OS account.
 *  2. The OS username, `@`-prefixed to match Backlog.md assignee conventions.
 *  3. `@unknown` as a last resort.
 *
 * Agent claims (via the Taskwright MCP) carry their own identity and do not go
 * through this helper.
 */
export function resolveClaimIdentity(configured: string | undefined, osUsername: string): string {
  const trimmedConfig = configured?.trim();
  if (trimmedConfig) {
    return trimmedConfig;
  }
  const trimmedUser = osUsername.trim();
  if (!trimmedUser) {
    return '@unknown';
  }
  return trimmedUser.startsWith('@') ? trimmedUser : `@${trimmedUser}`;
}

/**
 * The legacy, identity-less agent claimant. Historically every MCP claim was
 * attributed to this generic value, which made "my claim" indistinguishable
 * from "someone else's" after a session restart (TASK-89).
 */
export const GENERIC_AGENT_IDENTITY = '@agent';

/**
 * Derive a stable, per-session agent claimant identity from the worktree/branch
 * the session works in: `@agent/<branch>` (e.g. `@agent/task-61-fix-login`),
 * falling back to the bare generic `@agent` when no branch is known.
 *
 * Identity comes from the worktree, not the tool — any agent brand (Claude,
 * Codex, …) relaunched into the same worktree derives the same identity, which
 * is what makes re-claiming your own task idempotent across restarts.
 */
export function agentClaimIdentity(branch?: string): string {
  const trimmed = branch?.trim();
  return trimmed ? `${GENERIC_AGENT_IDENTITY}/${trimmed}` : GENERIC_AGENT_IDENTITY;
}

/**
 * Extract the dispatch branch from a path inside a Taskwright-managed worktree.
 * Worktrees live at `.worktrees/<branch>` (WorktreeService), so the segment
 * after the last `.worktrees` IS the branch name. Returns undefined for a
 * primary-checkout path. Separator-agnostic (POSIX and Windows).
 */
export function worktreeBranchFromPath(rootPath: string): string | undefined {
  const segments = rootPath.split(/[\\/]+/).filter(Boolean);
  const idx = segments.lastIndexOf('.worktrees');
  if (idx === -1 || idx + 1 >= segments.length) return undefined;
  return segments[idx + 1];
}

/**
 * Compact a claimant identity for badge display. Worktree-derived identities
 * collapse to their task-id core (`@agent/task-89-long-branch-slug` →
 * `@agent/task-89`); anything else is kept verbatim unless it exceeds
 * `maxLength`, in which case it is truncated with an ellipsis. Tooltips should
 * keep showing the full identity.
 */
export function shortClaimIdentity(identity: string, maxLength = 24): string {
  const id = identity.trim();
  const match = id.match(/^(@[^/\s]+)\/([A-Za-z]+-\d+(?:\.\d+)*)(?:[-.].*)?$/);
  if (match) return `${match[1]}/${match[2]}`;
  if (id.length <= maxLength) return id;
  return `${id.slice(0, maxLength - 1)}…`;
}
