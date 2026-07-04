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

// --- Generalized labeled-fence installer, for hooks other than pre-commit's
// fixed worktree guard above (kept as-is for backward compatibility). Used by
// the Board Sync v2 Task H opt-in pre-push/post-merge hooks below. ---

function labelFenceStart(label: string): string {
  return `# >>> ${label} >>>`;
}
function labelFenceEnd(label: string): string {
  return `# <<< ${label} <<<`;
}
function labelFenceRe(label: string): RegExp {
  return new RegExp(
    `${escapeRe(labelFenceStart(label))}[\\s\\S]*?${escapeRe(labelFenceEnd(label))}`
  );
}
function labelFenceReTrailingNl(label: string): RegExp {
  return new RegExp(
    `${escapeRe(labelFenceStart(label))}[\\s\\S]*?${escapeRe(labelFenceEnd(label))}\\n?`
  );
}

/** A fenced block running `command`, under an arbitrary `label` (distinct fence per label). */
export function labeledBlock(label: string, command: string): string {
  return [labelFenceStart(label), command, labelFenceEnd(label)].join('\n');
}

/** Insert a labeled fenced block, or replace it in place when one for this label already exists. */
export function upsertLabeledFence(existing: string, label: string, block: string): string {
  const re = labelFenceRe(label);
  if (re.test(existing)) return existing.replace(re, block);
  const base = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${base}${block}\n`;
}

/** Remove a labeled fenced block (and a single trailing newline) when present. */
export function removeLabeledFence(existing: string, label: string): string {
  return existing.replace(labelFenceReTrailingNl(label), '');
}

/** Where an arbitrary named hook lives, husky-aware (generalizes {@link resolveHookTarget}). */
export function resolveHookTargetFor(
  repoRoot: string,
  hookName: string,
  deps: HookFsDeps
): { manager: 'husky' | 'plain'; hookPath: string } {
  const husky = path.join(repoRoot, '.husky', hookName);
  if (deps.exists(husky)) return { manager: 'husky', hookPath: husky };
  return { manager: 'plain', hookPath: path.join(repoRoot, '.git', 'hooks', hookName) };
}

/** Idempotently install a labeled fence running `command` into `hookName` (husky-aware). */
export function installLabeledHook(
  repoRoot: string,
  hookName: string,
  label: string,
  command: string,
  deps: HookFsDeps
): 'husky' | 'plain' {
  const { manager, hookPath } = resolveHookTargetFor(repoRoot, hookName, deps);
  const current = deps.exists(hookPath)
    ? deps.read(hookPath)
    : manager === 'plain'
      ? PLAIN_SHEBANG
      : '';
  deps.write(hookPath, upsertLabeledFence(current, label, labeledBlock(label, command)));
  return manager;
}

/** Remove a labeled fence from `hookName`; leaves the rest of the hook file intact. */
export function uninstallLabeledHook(
  repoRoot: string,
  hookName: string,
  label: string,
  deps: HookFsDeps
): void {
  const { hookPath } = resolveHookTargetFor(repoRoot, hookName, deps);
  if (!deps.exists(hookPath)) return;
  deps.write(hookPath, removeLabeledFence(deps.read(hookPath), label));
}

// --- Board Sync v2 Task H: opt-in pre-push (push) / post-merge (pull) hooks ---

/** Committed, dependency-free launcher these fences invoke (pattern of `scripts/taskwright-mcp.cjs`). */
export const BOARD_SYNC_HOOK_SCRIPT_REL = 'scripts/board-sync-hook.cjs';

const BOARD_PUSH_HOOK_LABEL = 'taskwright board sync (push)';
const BOARD_PULL_HOOK_LABEL = 'taskwright board sync (pull)';

/** `|| true`: a board-sync hiccup must never block or corrupt the user's real git operation. */
function boardSyncCommand(mode: 'push' | 'pull'): string {
  return `if [ -f "${BOARD_SYNC_HOOK_SCRIPT_REL}" ]; then node "${BOARD_SYNC_HOOK_SCRIPT_REL}" ${mode} || true; fi`;
}

export interface BoardSyncHookInstallResult {
  prePush: 'husky' | 'plain';
  postMerge: 'husky' | 'plain';
}

/**
 * Idempotently install the opt-in board-sync hooks: `pre-push` runs a push,
 * `post-merge` runs a pull. Never installed automatically — callers gate this
 * on `taskwright.sync.installHooks` / the `taskwright.installBoardHooks` command.
 */
export function installBoardSyncHooks(
  repoRoot: string,
  deps: HookFsDeps
): BoardSyncHookInstallResult {
  const prePush = installLabeledHook(
    repoRoot,
    'pre-push',
    BOARD_PUSH_HOOK_LABEL,
    boardSyncCommand('push'),
    deps
  );
  const postMerge = installLabeledHook(
    repoRoot,
    'post-merge',
    BOARD_PULL_HOOK_LABEL,
    boardSyncCommand('pull'),
    deps
  );
  return { prePush, postMerge };
}

/** Remove both board-sync hook fences; leaves the rest of each hook file intact. */
export function uninstallBoardSyncHooks(repoRoot: string, deps: HookFsDeps): void {
  uninstallLabeledHook(repoRoot, 'pre-push', BOARD_PUSH_HOOK_LABEL, deps);
  uninstallLabeledHook(repoRoot, 'post-merge', BOARD_PULL_HOOK_LABEL, deps);
}
