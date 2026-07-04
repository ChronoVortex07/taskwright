#!/usr/bin/env node
/**
 * Opt-in board-sync git hook launcher (committed, dependency-free CommonJS).
 *
 * Installed into `pre-push` (mode "push") / `post-merge` (mode "pull") only
 * when the user opts in (`taskwright.sync.installHooks`, or the
 * `taskwright.installBoardHooks` command — see `src/core/hookInstaller.ts`).
 * Mirrors `taskwright-mcp.cjs`: resolves the primary checkout's git common
 * dir (shared across every linked `.worktrees/<branch>`) and runs its
 * already-built `dist/hooks/board-sync-hook.js`, which calls the same
 * `pushBoard`/`pullBoard` core as the `push_board`/`pull_board` MCP tools and
 * VS Code commands (Task F).
 *
 * Deliberately plain `.cjs`, imports nothing outside Node core, so it can run
 * from a hook before any build has happened. Never blocks or corrupts the
 * user's git operation: every failure path here (repo not found, bundle not
 * built) just logs and returns — this script always exits 0. Failures
 * *inside* the bundle (push/pull errors, sync off) are handled the same way
 * by `runBoardSyncHook` itself.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Given the output of `git rev-parse --path-format=absolute --git-common-dir`
 * and the cwd it ran from, return the primary checkout's board-sync-hook
 * bundle path plus the resolved absolute common dir (the caller needs both —
 * the bundle path to check it's built, the common dir to locate
 * sync-config.json). Pure string logic — no I/O.
 *
 * @param {string} commonDirOutput raw `git rev-parse` output (may be relative
 *   or have trailing whitespace).
 * @param {string} cwd base for resolving a relative common dir.
 */
function resolveBundlePath(commonDirOutput, cwd) {
  const raw = String(commonDirOutput).trim();
  const commonDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  const primaryRoot = path.dirname(commonDir);
  return { bundlePath: path.join(primaryRoot, 'dist', 'hooks', 'board-sync-hook.js'), commonDir };
}

function main() {
  const mode = process.argv[2];
  if (mode !== 'push' && mode !== 'pull') {
    console.error(
      `[board-sync-hook] unknown mode ${JSON.stringify(mode)} — expected "push" or "pull".`
    );
    return;
  }

  let commonDirRaw;
  try {
    commonDirRaw = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
  } catch (error) {
    console.error(`[board-sync-hook] cannot locate the git repository (${error && error.message}).`);
    return;
  }

  const { bundlePath, commonDir } = resolveBundlePath(commonDirRaw, process.cwd());
  if (!fs.existsSync(bundlePath)) {
    console.error(
      `[board-sync-hook] not built at ${bundlePath} — run 'bun run build' in the primary Taskwright checkout.`
    );
    return;
  }

  // Run the payload as a SEPARATE child process (`node bundlePath <mode>
  // <commonDir>`, hitting its own `if (require.main === module)` CLI entry)
  // rather than `require()`-ing the bundle in-process and firing its async
  // work without awaiting it. The latter was tried first and is UNSAFE: a
  // git-invoked hook's own process sometimes tears down before a same-process
  // fire-and-forget promise chain (however many `.then`/`.catch` deep) gets to
  // finish its pending child `git` spawns — reproduced empirically as an
  // intermittent silent no-op (exit 0, zero output, board never pushed/pulled)
  // when firing real hooks against a real remote. `execFileSync` here blocks
  // on a genuinely separate process with its own independent event loop, so
  // there is nothing left to race — this call does not return until the push
  // or pull has actually finished.
  try {
    execFileSync(process.execPath, [bundlePath, mode, commonDir], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
  } catch (error) {
    // The bundle's own CLI entry never throws/exits non-zero on a push/pull
    // failure (see `runBoardSyncHook`) — a non-zero exit here means the child
    // node process itself crashed unexpectedly. Log, never block the git op.
    console.error(`[board-sync-hook] ${mode} failed: ${error && error.message}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { resolveBundlePath };
