import { TASKWRIGHT_MCP_NAME } from './claudeMcp';
import type { McpServerDef } from './mcpProjectConfig';

/**
 * Pure helpers for registering the Taskwright MCP server in Codex's
 * `config.toml` (`[mcp_servers.taskwright]`) — the Codex counterpart to
 * `src/core/mcpProjectConfig.ts` (`.mcp.json` for Claude Code). Codex reads a
 * user-global `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`), so the
 * adapter passes an ABSOLUTE launcher path; the launcher
 * (`scripts/taskwright-mcp.cjs`) resolves the primary checkout's built server
 * from the session's cwd, so worktrees resolve the primary build exactly as
 * with Claude Code.
 *
 * String-in / string-out so the extension owns all fs I/O and these stay
 * unit-testable without a Codex install. No vscode, no fs. Only the
 * `[mcp_servers.taskwright]` table is owned by Taskwright — everything else in
 * the user's config.toml is preserved byte-for-byte.
 */

/** The `[mcp_servers.<name>]` header Taskwright owns in config.toml. */
const TABLE_HEADER = `[mcp_servers.${TASKWRIGHT_MCP_NAME}]`;

/** Render a TOML basic string (double-quoted, backslashes and quotes escaped). */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Render the `[mcp_servers.taskwright]` table for a server definition. The
 * Claude-specific `type` key is omitted (Codex's schema is command/args/env);
 * `env` is emitted as an inline table only when non-empty. Ends with a newline.
 */
export function renderCodexServerToml(server: McpServerDef): string {
  const lines: string[] = [TABLE_HEADER];
  if (server.command) {
    lines.push(`command = ${tomlString(server.command)}`);
  }
  if (server.args && server.args.length > 0) {
    lines.push(`args = [${server.args.map(tomlString).join(', ')}]`);
  }
  if (server.env && Object.keys(server.env).length > 0) {
    const entries = Object.entries(server.env)
      .map(([key, value]) => `${key} = ${tomlString(value)}`)
      .join(', ');
    lines.push(`env = { ${entries} }`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Insert or update the `[mcp_servers.taskwright]` table in a Codex config.toml
 * body, preserving every other line (top-level keys, other servers, other
 * tables). Empty/blank input starts a fresh file. The owned table runs from its
 * header to the next top-level `[` table header (sub-tables of the owned server
 * are swallowed too). Idempotent — re-running with the same server yields
 * byte-identical output.
 */
export function upsertCodexMcpServer(existingToml: string, server: McpServerDef): string {
  const table = renderCodexServerToml(server);
  const lines = existingToml.split('\n');

  // Find the owned table header (exact match, ignoring surrounding whitespace).
  const headerIdx = lines.findIndex((line) => line.trim() === TABLE_HEADER);

  if (headerIdx === -1) {
    // Append: keep existing content, one blank line, then the table.
    const prefix = existingToml.trim() ? `${existingToml.replace(/\s+$/, '')}\n\n` : '';
    return `${prefix}${table}`;
  }

  // Section runs from the header to the next table header that is NOT a
  // sub-table of the owned server (e.g. [mcp_servers.taskwright.env]).
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[') && !trimmed.startsWith(`[mcp_servers.${TASKWRIGHT_MCP_NAME}.`)) {
      endIdx = i;
      break;
    }
  }

  const before = lines.slice(0, headerIdx).join('\n');
  const after = lines.slice(endIdx).join('\n');

  const beforePart = before.trim() ? `${before.replace(/\s+$/, '')}\n\n` : '';
  const afterPart = after.trim() ? `\n${after.replace(/^\s+/, '')}` : '';
  const result = `${beforePart}${table}${afterPart}`;
  return result.endsWith('\n') ? result : `${result}\n`;
}
