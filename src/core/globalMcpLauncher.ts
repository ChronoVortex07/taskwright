import * as fs from 'fs';
import * as path from 'path';

/**
 * The version-stable launcher for the user-scope Taskwright MCP registration.
 *
 * Claude Code's user-scope registration lives in `~/.claude.json` — ONE global
 * entry shared by every project and every running session. Registering the
 * extension's bundle directly (`…/chronovortex07.taskwright-<version>/dist/mcp/
 * server.js`) pins that global entry to a *versioned* install directory, which
 * VS Code deletes on the next extension update: the entry rots, and every
 * session that starts before an activation happens to refresh it loses the
 * server ("Cannot find module …taskwright-0.0.1\dist\mcp\server.js").
 *
 * The previous mitigation — removing the registration on deactivate and re-adding
 * it on activate — made it worse: deactivate is per-window but the entry is
 * global, so reloading/closing ANY window deleted the server for every other
 * window too, and sessions created in the gap silently had no Taskwright tools.
 *
 * Instead we register a launcher at a path that never changes (the extension's
 * globalStorage directory, keyed by extension id, not version). The launcher
 * reads a sibling pointer file — refreshed on every activation — and requires
 * whichever build is current. The registered command is therefore write-once and
 * cannot rot, so nothing ever needs to remove it.
 */

export const LAUNCHER_FILENAME = 'taskwright-mcp.cjs';
export const POINTER_FILENAME = 'mcp-server-path.json';

/**
 * The launcher source. Deliberately plain, dependency-free CommonJS: it runs
 * from globalStorage where there is no `node_modules`, and it must never import
 * anything outside Node core.
 */
export const LAUNCHER_SCRIPT = `#!/usr/bin/env node
/**
 * Taskwright MCP launcher (generated — do not edit).
 *
 * Registered with Claude Code at user scope. Resolves the CURRENT extension
 * build from the sibling pointer file, so this command survives extension
 * updates that move the versioned install directory.
 */
const fs = require('fs');
const path = require('path');

const pointer = path.join(__dirname, '${POINTER_FILENAME}');

let serverPath;
try {
  serverPath = JSON.parse(fs.readFileSync(pointer, 'utf8')).serverPath;
} catch (error) {
  serverPath = undefined;
}

if (!serverPath || !fs.existsSync(serverPath)) {
  console.error(
    '[taskwright-mcp] no current Taskwright build recorded at ' +
      pointer +
      ' — open a window with the Taskwright extension active (it refreshes this on activation), then restart the session.'
  );
  process.exit(1);
}

require(serverPath);
`;

export interface LauncherFsDeps {
  mkdirSync(dir: string, options: { recursive: true }): void;
  existsSync(file: string): boolean;
  readFileSync(file: string, encoding: 'utf-8'): string;
  writeFileSync(file: string, data: string, encoding: 'utf-8'): void;
}

export const nodeLauncherFs: LauncherFsDeps = {
  mkdirSync: (dir, options) => void fs.mkdirSync(dir, options),
  existsSync: (file) => fs.existsSync(file),
  readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
  writeFileSync: (file, data, encoding) => fs.writeFileSync(file, data, encoding),
};

/** The stable command Claude Code is registered against. */
export function launcherPathFor(storageDir: string): string {
  return path.join(storageDir, LAUNCHER_FILENAME);
}

/** The sibling file recording which build the launcher should run. */
export function pointerPathFor(storageDir: string): string {
  return path.join(storageDir, POINTER_FILENAME);
}

export function renderPointer(serverPath: string): string {
  return `${JSON.stringify({ serverPath }, null, 2)}\n`;
}

/** Pure parse — a missing/corrupt pointer yields null rather than throwing. */
export function readPointerServerPath(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = (parsed as { serverPath?: unknown }).serverPath;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Materialize the launcher + pointer into `storageDir` and return the launcher
 * path (the command to register). Idempotent: content that is already current is
 * not rewritten, so an activation in a repo with many windows open costs nothing.
 */
export function installGlobalMcpLauncher(
  storageDir: string,
  serverPath: string,
  deps: LauncherFsDeps = nodeLauncherFs
): string {
  deps.mkdirSync(storageDir, { recursive: true });

  const write = (file: string, content: string): void => {
    const current = deps.existsSync(file) ? deps.readFileSync(file, 'utf-8') : undefined;
    if (current !== content) {
      deps.writeFileSync(file, content, 'utf-8');
    }
  };

  write(launcherPathFor(storageDir), LAUNCHER_SCRIPT);
  write(pointerPathFor(storageDir), renderPointer(serverPath));

  return launcherPathFor(storageDir);
}
