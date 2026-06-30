import { describe, it, expect } from 'vitest';
import { resolveClaimAction, stalenessMsFromHours } from '../../core/claimResolution';
import { claimTimestamp } from '../../core/claims';

const HOUR = 3600_000;

describe('stalenessMsFromHours', () => {
  it('converts positive hours to milliseconds', () => {
    expect(stalenessMsFromHours(12)).toBe(12 * HOUR);
  });

  it('treats zero or negative as disabled (0)', () => {
    expect(stalenessMsFromHours(0)).toBe(0);
    expect(stalenessMsFromHours(-5)).toBe(0);
  });
});

describe('resolveClaimAction', () => {
  const now = Date.now();

  it('is "free" when there is no existing claim', () => {
    expect(resolveClaimAction({}, '@alice', 12 * HOUR, now)).toBe('free');
  });

  it('is "self" when the same identity already holds it', () => {
    expect(
      resolveClaimAction(
        { claimedBy: '@alice', claimedAt: claimTimestamp() },
        '@alice',
        12 * HOUR,
        now
      )
    ).toBe('self');
  });

  it('is "conflict" when a different, fresh identity holds it', () => {
    expect(
      resolveClaimAction(
        { claimedBy: '@bob', claimedAt: claimTimestamp() },
        '@alice',
        12 * HOUR,
        now
      )
    ).toBe('conflict');
  });

  it('is "stale" when a different identity holds it past the threshold', () => {
    const old = claimTimestamp(new Date(now - 13 * HOUR));
    expect(
      resolveClaimAction({ claimedBy: '@bob', claimedAt: old }, '@alice', 12 * HOUR, now)
    ).toBe('stale');
  });

  it('never reports stale when staleness is disabled (0)', () => {
    const old = claimTimestamp(new Date(now - 1000 * HOUR));
    expect(resolveClaimAction({ claimedBy: '@bob', claimedAt: old }, '@alice', 0, now)).toBe(
      'conflict'
    );
  });
});
