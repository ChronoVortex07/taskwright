import { describe, it, expect } from 'vitest';
import { resolveClaimIdentity } from '../../core/claimIdentity';

describe('resolveClaimIdentity', () => {
  it('uses the configured identity verbatim when set', () => {
    expect(resolveClaimIdentity('@team-lead', 'alice')).toBe('@team-lead');
  });

  it('trims surrounding whitespace from the configured identity', () => {
    expect(resolveClaimIdentity('  @bob  ', 'alice')).toBe('@bob');
  });

  it('falls back to the @-prefixed OS username when unconfigured', () => {
    expect(resolveClaimIdentity(undefined, 'alice')).toBe('@alice');
    expect(resolveClaimIdentity('', 'alice')).toBe('@alice');
    expect(resolveClaimIdentity('   ', 'alice')).toBe('@alice');
  });

  it('does not double-prefix an OS username that already starts with @', () => {
    expect(resolveClaimIdentity(undefined, '@alice')).toBe('@alice');
  });

  it('returns @unknown when neither a config nor a username is available', () => {
    expect(resolveClaimIdentity(undefined, '')).toBe('@unknown');
    expect(resolveClaimIdentity('', '   ')).toBe('@unknown');
  });
});
