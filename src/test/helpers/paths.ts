/**
 * Cross-platform path helpers for tests.
 *
 * Production code builds paths with `path.join`/`path.resolve`, which emit
 * backslashes (and, for `path.resolve`, a `C:` drive prefix) on Windows. Tests
 * that hardcode POSIX expectations like `/repo/backlog` would otherwise fail on
 * Windows even though the production code is cross-platform-correct. These
 * helpers let assertions keep their readable POSIX form while passing on both
 * Windows and POSIX (where they are no-ops, since POSIX paths contain neither
 * backslashes nor a drive letter).
 */

/** Normalize OS-native separators to forward slashes. No-op on POSIX paths. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Asymmetric matcher comparing a received path to `expected` after normalizing
 * separators and stripping any leading drive letter. Drop it anywhere an
 * asymmetric matcher is accepted — `toEqual`, `toHaveBeenCalledWith`, or nested
 * inside `expect.objectContaining`.
 */
export function posixPath(expected: string): {
  asymmetricMatch(received: unknown): boolean;
  toString(): string;
  getExpectedType(): string;
  toAsymmetricMatcher(): string;
} {
  const normalize = (value: string): string => toPosix(value).replace(/^[A-Za-z]:/, '');
  const want = normalize(expected);
  return {
    asymmetricMatch: (received: unknown): boolean =>
      typeof received === 'string' && normalize(received) === want,
    toString: () => 'PosixPath',
    getExpectedType: () => 'string',
    toAsymmetricMatcher: () => `PosixPath<${expected}>`,
  };
}
