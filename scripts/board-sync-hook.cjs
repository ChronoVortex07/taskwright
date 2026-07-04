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
 * Resolve an absolute common-dir from a raw `git rev-parse --git-common-dir`
 * output line. Pure string logic — no I/O. Exported for unit tests.
 *
 * @param {string} raw  git output (may be relative, absolute, or have
 *   leading/trailing whitespace).
 * @param {string} cwd  base for resolving a relative path.
 * @returns {{ bundlePath: string, commonDir: string }}
 */
function resolveBundlePath(raw, cwd) {
  const trimmed = String(raw).trim();
  const commonDir = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  const primaryRoot = path.dirname(commonDir);
  return { bundlePath: path.join(primaryRoot, 'dist', 'hooks', 'board-sync-hook.js'), commonDir };
}

/**
 * Resolve `--git-common-dir`, falling back from `--path-format=absolute`
 * (requires git ≥ 2.31) to manual relative-path resolution for older git.
 */
function resolveCommonDir(cwd) {
  // Try the modern flag first.
  try {
    const raw = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8' }
    );
    return resolveBundlePath(raw, cwd);
  } catch (_e) {
    // Fall back: git < 2.31 doesn't support --path-format=absolute.
  }
  try {
    const raw = execFileSync(
      'git',
      ['rev-parse', '--git-common-dir'],
      { cwd, encoding: 'utf8' }
    );
    return resolveBundlePath(raw, cwd);
  } catch (error) {
    console.error(
      `[board-sync-hook] cannot locate the git repository (${error && error.message}).`
    );
    return null;
  }
}

function main() {
  const mode = process.argv[2];
  if (mode !== 'push' && mode !== 'pull') {
    console.error(
      `[board-sync-hook] unknown mode ${JSON.stringify(mode)} — expected "push" or "pull".`
    );
    return;
  }

  const resolved = resolveCommonDir(process.cwd());
  if (!resolved) return;

  const { bundlePath, commonDir } = resolved;

  if (!fs.existsSync(bundlePath)) {
    console.error(
      `[board-sync-hook] payload not built at ${bundlePath} — ` +
        `run 'bun run build' in the primary Taskwright checkout (${path.dirname(commonDir)}).`
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
      // On Windows, git hook processes occasionally inherit a detached console
      // that causes EIO on stdio; setting a generous timeout + detached false
      // ensures a clean child lifecycle regardless of platform.
      timeout: 5 * 60 * 1000,
    });
  } catch (error) {
    // The bundle's own CLI entry never throws/exits non-zero on a push/pull
    // failure (see `runBoardSyncHook`) — a non-zero exit here means the child
    // node process itself crashed unexpectedly. Log, never block the git op.
    const detail = error && error.code
      ? `${error.message} (code: ${error.code})`
      : error && error.message;
    console.error(`[board-sync-hook] ${mode} child process failed: ${detail}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { resolveBundlePath, resolveCommonDir };
