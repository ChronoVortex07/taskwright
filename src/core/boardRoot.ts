import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveBacklogDirectory,
  type BacklogDirectoryResolution,
} from './resolveBacklogDirectory';
import { readSyncConfig, syncConfigPath, type SyncMode } from './syncConfig';
import { nodeQueueFs } from './mergeQueue';

/**
 * Board Sync v2 (spec §2.1, §3) — resolves the *one* physical board: the
 * primary worktree's `backlog/` directory. Every worktree (primary, a linked
 * `.worktrees/<branch>`, or a plain non-worktree repo) targets this same path,
 * which is what makes worktree-to-primary visibility automatic and removes the
 * v1 per-worktree materialized copy entirely.
 */

const execFileAsync = promisify(execFile);

export type GitExecFn = (
  cwd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: GitExecFn = (cwd, args) => execFileAsync('git', args, { cwd, timeout: 15000 });

/**
 * Ordered worktree paths from `git worktree list --porcelain` output — the
 * primary worktree is always the first `worktree ` entry, regardless of which
 * worktree ran the command. Ignores every other porcelain line (`HEAD`,
 * `branch`, `detached`, `bare`, `prunable ...`, blank separators).
 */
export function parseWorktreeListPorcelain(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice('worktree '.length).trim());
    }
  }
  return paths;
}

/**
 * The primary worktree's raw root path (not yet joined to `backlog/`), given
 * raw `git worktree list --porcelain` output. Pure — no I/O — exported so
 * callers that need the raw root (e.g. to resolve `backlog.config.yml` /
 * custom directory naming via {@link resolveBacklogDirectory}) don't have to
 * re-run or re-parse git output themselves.
 */
export function primaryWorktreeRootFromPorcelain(porcelain: string): string {
  const [primary] = parseWorktreeListPorcelain(porcelain);
  if (!primary) {
    throw new Error(
      'resolveBoardRoot: `git worktree list --porcelain` returned no worktree entries'
    );
  }
  return primary;
}

/**
 * The primary worktree's `backlog/` directory, given raw `git worktree list
 * --porcelain` output. Pure — no I/O — so it is unit-tested against captured
 * porcelain text without a live git call.
 */
export function boardRootFromPorcelain(porcelain: string): string {
  return path.join(primaryWorktreeRootFromPorcelain(porcelain), 'backlog');
}

export interface ResolveBoardRootDeps {
  exec?: GitExecFn;
  /**
   * Injectable sync-mode reader (tests / callers that already know the mode).
   * Default resolves the git common dir and reads the shared sync-config.json.
   */
  readMode?: () => SyncMode;
}

/**
 * The board's physical home under a given sync mode (TASK-91). In `git-auto`
 * the ONE physical board lives in a hidden linked worktree of the
 * `taskwright-board` branch at `<primaryRoot>/.taskwright/board/`, while
 * `config.yml` + `docs/` + `decisions/` stay in the repo's `backlog/` (they
 * version with the code, and the board branch's tree must only ever contain
 * the five state dirs — old clients' materialize guard refuses anything else).
 */
export interface BoardHome {
  primaryRoot: string;
  mode: SyncMode;
  /** Where tasks/drafts/completed/archive/milestones live. */
  backlogPath: string;
  /** Where config.yml + docs/ + decisions/ live — always the repo backlog. */
  configRoot: string;
}

/** `<primaryRoot>/.taskwright/board` — the hidden board worktree's location. */
export function boardWorktreePathFor(primaryRoot: string): string {
  return path.join(primaryRoot, '.taskwright', 'board');
}

/** Pure mode → board-home mapping; `off`/`git` keep the exact v2 shape. */
export function boardHomeFor(primaryRoot: string, mode: SyncMode): BoardHome {
  const configRoot = path.join(primaryRoot, 'backlog');
  return {
    primaryRoot,
    mode,
    backlogPath:
      mode === 'git-auto' ? path.join(boardWorktreePathFor(primaryRoot), 'backlog') : configRoot,
    configRoot,
  };
}

/**
 * Resolve the board home from any worktree: primary root via
 * `git worktree list --porcelain`, sync mode via the shared
 * `<commonDir>/taskwright/sync-config.json` (or an injected `readMode`).
 * Any failure reading the mode degrades to `off` (the v2 primary-local shape).
 */
export async function resolveBoardHome(
  cwd: string,
  deps: ResolveBoardRootDeps = {}
): Promise<BoardHome> {
  const exec = deps.exec ?? defaultExec;
  const primaryRoot = await resolvePrimaryWorktreeRoot(cwd, { exec });
  let mode: SyncMode = 'off';
  try {
    if (deps.readMode) {
      mode = deps.readMode();
    } else {
      const { stdout } = await exec(primaryRoot, ['rev-parse', '--git-common-dir']);
      const commonDir = path.resolve(primaryRoot, stdout.trim());
      mode = readSyncConfig(syncConfigPath(commonDir), nodeQueueFs).mode;
    }
  } catch {
    mode = 'off';
  }
  return boardHomeFor(primaryRoot, mode);
}

/**
 * Resolve the primary worktree's raw root path from any worktree by running
 * `git worktree list --porcelain` in `cwd` and taking the primary (first)
 * entry. Same result whether `cwd` is the primary, a linked
 * `.worktrees/<branch>` worktree, or a plain non-worktree repo.
 */
export async function resolvePrimaryWorktreeRoot(
  cwd: string,
  deps: ResolveBoardRootDeps = {}
): Promise<string> {
  const exec = deps.exec ?? defaultExec;
  const { stdout } = await exec(cwd, ['worktree', 'list', '--porcelain']);
  return primaryWorktreeRootFromPorcelain(stdout);
}

/**
 * Resolve the one physical board's directory from any worktree. Same result
 * whether `cwd` is the primary, a linked `.worktrees/<branch>` worktree, or a
 * plain non-worktree repo.
 */
export async function resolveBoardRoot(
  cwd: string,
  deps: ResolveBoardRootDeps = {}
): Promise<string> {
  return path.join(await resolvePrimaryWorktreeRoot(cwd, deps), 'backlog');
}

/**
 * Resolve the backlog directory for a workspace folder / session cwd,
 * preferring the *primary* worktree's board (Board Sync v2 §2.1) over a local
 * one. A linked `.worktrees/<branch>` worktree has no local `backlog/` at all
 * (it's git-ignored, so `git worktree add` never populates it) — resolving
 * locally first would report "no backlog" even though the primary has one.
 *
 * Falls back to local resolution (`resolveBacklogDirectory(workspaceFolderPath)`)
 * when: `cwd` isn't a git repo (or git is unavailable), or the primary itself
 * has no backlog directory (e.g. a plain, non-Taskwright folder was opened as
 * one workspace folder while another folder in the same window is the real
 * project — a legitimate `resolveBacklogDirectory` local-discovery case this
 * must not break).
 */
export async function resolveWorkspaceBacklogRoot(
  workspaceFolderPath: string,
  deps: ResolveBoardRootDeps = {}
): Promise<BacklogDirectoryResolution> {
  try {
    const primaryRoot = await resolvePrimaryWorktreeRoot(workspaceFolderPath, deps);

    // git-auto (TASK-91): the ONE physical board is the hidden worktree's
    // backlog/. Only honored once the worktree actually exists — before the
    // bootstrap (fresh clone) we fall through to the v2 primary resolution so
    // activation still finds a board to show while it repairs.
    const home = await resolveBoardHome(primaryRoot, deps);
    if (home.mode === 'git-auto' && fs.existsSync(home.backlogPath)) {
      const configPath = path.join(home.configRoot, 'config.yml');
      return {
        projectRoot: primaryRoot,
        backlogDir: 'backlog',
        backlogPath: home.backlogPath,
        source: 'backlog',
        configPath: fs.existsSync(configPath) ? configPath : null,
        configSource: fs.existsSync(configPath) ? 'folder' : null,
        rootConfigPath: path.join(primaryRoot, 'backlog.config.yml'),
        rootConfigExists: fs.existsSync(path.join(primaryRoot, 'backlog.config.yml')),
        primaryRoot,
      };
    }

    const resolution = resolveBacklogDirectory(primaryRoot);
    if (resolution.backlogPath) {
      return { ...resolution, primaryRoot };
    }
  } catch {
    // Not a git repo (or git unavailable) — fall through to local resolution.
  }
  return resolveBacklogDirectory(workspaceFolderPath);
}
