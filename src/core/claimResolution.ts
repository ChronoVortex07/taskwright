import { isClaimStale } from './claims';
import { GENERIC_AGENT_IDENTITY } from './claimIdentity';

/**
 * Decide what claiming a task means given any existing claim — the basis for
 * surfacing conflicts and expiring stale claims across parallel sessions.
 *
 * - `free`     — no existing claim (or a legacy generic `@agent` claim being
 *                upgraded in place by an agent-derived identity); claim freely.
 * - `self`     — the same identity already holds it; re-claim is a no-op refresh.
 * - `stale`    — a different identity holds it but past the staleness window;
 *                treat as abandoned and reclaimable without friction.
 * - `conflict` — a different identity holds a live claim; the caller should
 *                confirm before overriding (claims are advisory, not locks).
 */
export type ClaimAction = 'free' | 'self' | 'stale' | 'conflict';

export interface ExistingClaim {
  claimedBy?: string;
  claimedAt?: string;
}

/** Convert a configured staleness window in hours to ms; ≤0 means disabled. */
export function stalenessMsFromHours(hours: number): number {
  return hours > 0 ? hours * 3600_000 : 0;
}

export function resolveClaimAction(
  existing: ExistingClaim,
  newClaimant: string,
  stalenessMs: number,
  now: number = Date.now()
): ClaimAction {
  const holder = existing.claimedBy?.trim();
  if (!holder) return 'free';
  const claimant = newClaimant.trim();
  if (holder === claimant) return 'self';
  // Legacy upgrade (TASK-89): a generic identity-less '@agent' claim cannot be
  // told apart between agent sessions, so an agent-derived claimant
  // ('@agent/<branch>') rewrites it in place instead of surrendering. Humans
  // (and non-@agent identities) still get 'conflict' and must confirm.
  if (holder === GENERIC_AGENT_IDENTITY && claimant.startsWith(`${GENERIC_AGENT_IDENTITY}/`)) {
    return 'free';
  }
  if (stalenessMs > 0 && isClaimStale(existing.claimedAt, stalenessMs, now)) return 'stale';
  return 'conflict';
}
