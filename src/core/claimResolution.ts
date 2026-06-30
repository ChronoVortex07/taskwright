import { isClaimStale } from './claims';

/**
 * Decide what claiming a task means given any existing claim — the basis for
 * surfacing conflicts and expiring stale claims across parallel sessions.
 *
 * - `free`     — no existing claim; claim freely.
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
  if (!existing.claimedBy) return 'free';
  if (existing.claimedBy === newClaimant) return 'self';
  if (stalenessMs > 0 && isClaimStale(existing.claimedAt, stalenessMs, now)) return 'stale';
  return 'conflict';
}
