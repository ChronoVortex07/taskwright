import * as fs from 'fs';
import * as path from 'path';
import {
  pushBoard,
  pullBoard,
  type PushBoardResult,
  type PullBoardResult,
} from '../../src/core/boardPushPull';
import { readSyncConfig, syncConfigPath } from '../../src/core/syncConfig';
import type { BoardGitExec } from '../../src/core/boardRef';

/**
 * Board Sync v2 Task H — the opt-in `pre-push`/`post-merge` git hook payload.
 * Bundled to `dist/hooks/board-sync-hook.js` (see `scripts/build.ts`) and run
 * by the committed launcher `scripts/board-sync-hook.cjs`, which resolves the
 * primary checkout's git common dir and passes it in here (this module never
 * re-derives it). Calls the SAME `pushBoard`/`pullBoard` core as the
 * `push_board`/`pull_board` MCP tools and VS Code commands (Task F) — no
 * duplicate sync logic.
 *
 * A board-ref push already runs with `--no-verify` (`boardRef.ts`'s
 * `pushRef`), so it can never recursively re-trigger this same `pre-push`
 * hook; `pullBoard`'s fetch + materialize never runs `git merge`, so it can't
 * recursively re-trigger `post-merge` either.
 */

export type BoardSyncHookMode = 'push' | 'pull';

export interface RunBoardSyncHookDeps {
  fsDeps?: { exists: (p: string) => boolean; read: (p: string) => string };
  boardExec?: BoardGitExec;
  log?: (message: string) => void;
}

export type BoardSyncHookResult =
  | PushBoardResult
  | PullBoardResult
  | { skipped: true; reason: string };

const defaultFsDeps = {
  exists: fs.existsSync,
  read: (p: string) => fs.readFileSync(p, 'utf8'),
};

/**
 * Run one push or pull against the board ref named by `commonDir`'s
 * `sync-config.json`. A no-op (`{ skipped: true }`) when `taskwright.sync.mode`
 * is `off`. Never throws — failures from the push/pull core itself are
 * logged, not thrown, because a hook must never abort the user's real git
 * operation.
 */
export async function runBoardSyncHook(
  mode: BoardSyncHookMode,
  commonDir: string,
  deps: RunBoardSyncHookDeps = {}
): Promise<BoardSyncHookResult> {
  const log = deps.log ?? ((message: string) => console.error(`[board-sync-hook] ${message}`));
  const fsDeps = deps.fsDeps ?? defaultFsDeps;
  const syncCfg = readSyncConfig(syncConfigPath(commonDir), fsDeps);
  if (syncCfg.mode === 'off') {
    const reason = 'Board sync is off (taskwright.sync.mode) — skipping.';
    log(reason);
    return { skipped: true, reason };
  }

  const primaryRoot = path.dirname(commonDir);
  const opts = {
    cwd: primaryRoot,
    ref: syncCfg.ref,
    remote: syncCfg.remote,
    exec: deps.boardExec,
  };

  if (mode === 'push') {
    const result = await pushBoard({ ...opts, message: 'chore(taskwright): push board (hook)' });
    if (!result.pushed) {
      log(`push ${result.rejected ? 'rejected' : 'failed'}: ${result.message ?? 'unknown error'}`);
    }
    if (result.conflicts.length > 0) {
      log(
        `push resolved ${result.conflicts.length} conflict(s): ${result.conflicts.map((c) => c.id).join(', ')}`
      );
    }
    return result;
  }

  const result = await pullBoard({ ...opts, message: 'chore(taskwright): pull board (hook)' });
  if (!result.pulled) {
    log(`pull skipped: ${result.message ?? 'unknown reason'}`);
  }
  if (result.conflicts.length > 0) {
    log(
      `pull resolved ${result.conflicts.length} conflict(s): ${result.conflicts.map((c) => c.id).join(', ')}`
    );
  }
  return result;
}

/** CLI entry point: `node board-sync-hook.js <push|pull> <git-common-dir>`. Never throws. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [mode, commonDir] = argv;
  if (mode !== 'push' && mode !== 'pull') {
    console.error(
      `[board-sync-hook] usage: board-sync-hook.js <push|pull> <git-common-dir>, got mode=${JSON.stringify(mode)}`
    );
    return;
  }
  if (!commonDir) {
    console.error('[board-sync-hook] missing <git-common-dir> argument');
    return;
  }
  try {
    await runBoardSyncHook(mode, commonDir);
  } catch (error) {
    console.error(
      `[board-sync-hook] ${mode} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

if (require.main === module) {
  void main();
}
