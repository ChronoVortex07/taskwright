/**
 * Resolve the identity that a human-driven claim is attributed to.
 *
 * Priority:
 *  1. An explicitly configured identity (`backlog.claimIdentity`), used verbatim
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
