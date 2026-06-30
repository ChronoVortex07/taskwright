import * as path from 'path';

/** Git facts gathered at commit time, enough to decide whether to block. */
export interface GuardContext {
  /** `git rev-parse --git-dir`, resolved to an absolute path. */
  gitDir: string;
  /** Current branch (`git symbolic-ref --short HEAD`), or null when detached. */
  branch: string | null;
  /** Branch names that have a dispatched worktree under `.worktrees/`. */
  dispatchedBranches: string[];
}

export interface GuardDecision {
  block: boolean;
  /** Populated only when `block` is true. */
  message?: string;
}

/**
 * True when `gitDir` is the primary repository `.git` directory rather than a
 * linked worktree's git dir (`<primary>/.git/worktrees/<id>`).
 */
export function isPrimaryTree(gitDir: string): boolean {
  return !gitDir.replace(/\\/g, '/').includes('/.git/worktrees/');
}

/**
 * Block only the precise TASK-15 failure mode: committing a *dispatched task
 * branch* while standing in the *primary* working tree (an agent escaped its
 * worktree). Commits on the integration branch, on undispatched branches, or
 * inside a worktree all pass.
 */
export function shouldBlockCommit(ctx: GuardContext): GuardDecision {
  if (ctx.branch === null) return { block: false };
  if (!isPrimaryTree(ctx.gitDir)) return { block: false };
  if (!ctx.dispatchedBranches.includes(ctx.branch)) return { block: false };
  return {
    block: true,
    message:
      `Taskwright: branch "${ctx.branch}" is dispatched to .worktrees/${ctx.branch} — ` +
      `commit inside that worktree, not the primary tree. ` +
      `(To bypass this one commit: git commit --no-verify)`,
  };
}

/** Injectable directory listing for `collectDispatchedBranches`. */
export interface WorktreeListDeps {
  /** Immediate subdirectory names of `dir`, or [] when `dir` is absent. */
  listDirs: (dir: string) => string[];
}

/**
 * Dispatched task branches are exactly the immediate subdirectory names of
 * `<primaryRoot>/.worktrees/` (see WorktreeService.worktreePathFor).
 */
export function collectDispatchedBranches(primaryRoot: string, deps: WorktreeListDeps): string[] {
  return deps.listDirs(path.join(primaryRoot, '.worktrees'));
}
