import * as path from 'path';

export const FENCE_START = '# >>> taskwright worktree guard >>>';
export const FENCE_END = '# <<< taskwright worktree guard <<<';
const PLAIN_SHEBANG = '#!/bin/sh\n';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FENCE_RE = new RegExp(`${escapeRe(FENCE_START)}[\\s\\S]*?${escapeRe(FENCE_END)}`);
const FENCE_RE_TRAILING_NL = new RegExp(
  `${escapeRe(FENCE_START)}[\\s\\S]*?${escapeRe(FENCE_END)}\\n?`
);

/**
 * The fenced block invoking the bundled guard. Existence-guarded so a linked
 * worktree (whose cwd has no `.taskwright/hooks/` script) skips silently — the
 * guard only ever needs to act in the primary tree.
 */
export function guardBlock(guardScriptRelPath: string): string {
  const rel = guardScriptRelPath.replace(/\\/g, '/');
  return [FENCE_START, `if [ -f "${rel}" ]; then node "${rel}" || exit 1; fi`, FENCE_END].join(
    '\n'
  );
}

/** Insert the fenced block, or replace it in place when a fence already exists. */
export function upsertFence(existing: string, block: string): string {
  if (FENCE_RE.test(existing)) return existing.replace(FENCE_RE, block);
  const base = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${base}${block}\n`;
}

/** Remove the fenced block (and a single trailing newline) when present. */
export function removeFence(existing: string): string {
  return existing.replace(FENCE_RE_TRAILING_NL, '');
}

export interface HookFsDeps {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  write: (p: string, content: string) => void;
}

/** Where the guard hook lives, husky-aware. */
export function resolveHookTarget(
  repoRoot: string,
  deps: HookFsDeps
): { manager: 'husky' | 'plain'; hookPath: string } {
  const husky = path.join(repoRoot, '.husky', 'pre-commit');
  if (deps.exists(husky)) return { manager: 'husky', hookPath: husky };
  return { manager: 'plain', hookPath: path.join(repoRoot, '.git', 'hooks', 'pre-commit') };
}

/** Idempotently install the guard fence into the appropriate pre-commit hook. */
export function installGuard(
  repoRoot: string,
  guardScriptRelPath: string,
  deps: HookFsDeps
): 'husky' | 'plain' {
  const { manager, hookPath } = resolveHookTarget(repoRoot, deps);
  const current = deps.exists(hookPath)
    ? deps.read(hookPath)
    : manager === 'plain'
      ? PLAIN_SHEBANG
      : '';
  deps.write(hookPath, upsertFence(current, guardBlock(guardScriptRelPath)));
  return manager;
}

/** Remove the guard fence; leaves the rest of the hook intact. */
export function uninstallGuard(repoRoot: string, deps: HookFsDeps): void {
  const { hookPath } = resolveHookTarget(repoRoot, deps);
  if (!deps.exists(hookPath)) return;
  deps.write(hookPath, removeFence(deps.read(hookPath)));
}
