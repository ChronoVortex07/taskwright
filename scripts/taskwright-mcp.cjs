#!/usr/bin/env node
/**
 * Taskwright MCP launcher (committed, dependency-free CommonJS).
 *
 * `.mcp.json` runs this instead of `dist/mcp/server.js` directly. In a dispatched
 * `.worktrees/<branch>` checkout the git-ignored `dist/` does not exist, so the
 * relative path would fail and the whole MCP server would be unavailable to the
 * agent. This launcher instead locates the **primary** checkout's already-built,
 * self-contained server bundle (esbuild inlines every dep except `vscode`, which
 * the server never touches) and runs it in-process, with the *current* worktree
 * as the project root.
 *
 * Deliberately plain `.cjs`: it must run when neither `dist/` nor `node_modules`
 * exists, so it is never built/bundled and imports nothing outside Node core.
 * The entrypoint is guarded by `require.main === module` so tests can import the
 * pure `resolveMainServerPath` without spawning a server.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Given the output of `git rev-parse --path-format=absolute --git-common-dir`
 * (the shared `.git`, which is the primary checkout's even from a linked
 * worktree) and the current working directory, return the path to the primary
 * checkout's built MCP server bundle. Pure string logic — no I/O.
 *
 * @param {string} commonDirOutput raw `git rev-parse` output (may be relative or
 *   have trailing whitespace).
 * @param {string} cwd base for resolving a relative common dir.
 * @returns {string} absolute path to `<primaryRoot>/dist/mcp/server.js`.
 */
function resolveMainServerPath(commonDirOutput, cwd) {
  const raw = String(commonDirOutput).trim();
  const commonDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  const primaryRoot = path.dirname(commonDir);
  return path.join(primaryRoot, 'dist', 'mcp', 'server.js');
}

function main() {
  let commonDir;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
  } catch (error) {
    console.error(
      `[taskwright-mcp] cannot locate the git repository (${error && error.message}). ` +
        `Run the MCP server from inside the Taskwright checkout.`
    );
    process.exit(1);
  }

  const serverPath = resolveMainServerPath(commonDir, process.cwd());
  if (!fs.existsSync(serverPath)) {
    console.error(
      `[taskwright-mcp] MCP server not built at ${serverPath} — ` +
        `run 'bun run build' (or 'bun run compile') in the primary Taskwright checkout, then restart the session.`
    );
    process.exit(1);
  }

  // Pin the project root to the worktree that launched us. The server reads
  // TASKWRIGHT_ROOT || process.cwd(); requiring the bundle keeps process.cwd()
  // as this worktree, so it operates on this worktree's backlog while the shared
  // merge queue lives in the common .git.
  if (!process.env.TASKWRIGHT_ROOT) {
    process.env.TASKWRIGHT_ROOT = process.cwd();
  }
  require(serverPath);
}

if (require.main === module) {
  main();
}

module.exports = { resolveMainServerPath };
