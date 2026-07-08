import { TASKWRIGHT_MCP_NAME } from './claudeMcp';

/**
 * Pure helpers for writing a project-local `.mcp.json` that registers the
 * Taskwright MCP server for any MCP client (Claude Code, etc.) opened in the
 * repo — the per-project counterpart to the user-scope CLI registration
 * (src/core/claudeMcp.ts). The server is launched via the committed,
 * dependency-free `scripts/taskwright-mcp.cjs` (copied into the repo alongside
 * this file), exactly as Taskwright's own repo-root `.mcp.json` does.
 *
 * String-in / string-out so the extension owns all fs I/O and these stay
 * unit-testable without a workspace. No vscode, no fs.
 */

/** The shape of a single MCP server definition in an `.mcp.json` file. */
export interface McpServerDef {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

interface McpJson {
  mcpServers?: Record<string, McpServerDef>;
  [key: string]: unknown;
}

/**
 * Extract the `taskwright` server definition from an `.mcp.json` template (the
 * extension's own shipped `.mcp.json`). Throws when the template is malformed or
 * has no `taskwright` entry — the caller surfaces the error.
 */
export function extractTaskwrightServer(templateJson: string): McpServerDef {
  let parsed: McpJson;
  try {
    parsed = JSON.parse(templateJson) as McpJson;
  } catch (error) {
    throw new Error(`.mcp.json template is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const server = parsed.mcpServers?.[TASKWRIGHT_MCP_NAME];
  if (!server) {
    throw new Error(`.mcp.json template has no "${TASKWRIGHT_MCP_NAME}" server entry`);
  }
  return server;
}

/**
 * Insert or update the `taskwright` server in a project's `.mcp.json` body,
 * preserving any other configured servers and top-level keys. Empty/blank input
 * starts from `{}`. Returns pretty-printed JSON with a trailing newline.
 * Idempotent — re-running with the same server yields byte-identical output.
 */
export function upsertTaskwrightMcpServer(
  existingProjectJson: string,
  taskwrightServer: McpServerDef
): string {
  const obj: McpJson = existingProjectJson.trim()
    ? (JSON.parse(existingProjectJson) as McpJson)
    : {};
  if (!obj.mcpServers || typeof obj.mcpServers !== 'object') {
    obj.mcpServers = {};
  }
  obj.mcpServers[TASKWRIGHT_MCP_NAME] = taskwrightServer;
  return `${JSON.stringify(obj, null, 2)}\n`;
}
