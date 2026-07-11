import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  codexServerForPackagedExtension,
  renderCodexServerToml,
  upsertCodexMcpServer,
} from '../../core/codexConfig';
import { extractTaskwrightServer } from '../../core/mcpProjectConfig';

// The same server shape the extension ships in its .mcp.json template. The Codex
// adapter swaps the relative launcher arg for an absolute path (Codex's
// config.toml is user-global, so a relative path would not resolve).
const SERVER = {
  type: 'stdio',
  command: 'node',
  args: ['scripts/taskwright-mcp.cjs'],
  env: {},
};

const ABS_SERVER = {
  type: 'stdio',
  command: 'node',
  args: ['C:\\ext\\scripts\\taskwright-mcp.cjs'],
  env: {},
};

describe('renderCodexServerToml', () => {
  it('renders a [mcp_servers.taskwright] table with command and args', () => {
    const out = renderCodexServerToml(SERVER);
    expect(out).toContain('[mcp_servers.taskwright]');
    expect(out).toContain('command = "node"');
    expect(out).toContain('args = ["scripts/taskwright-mcp.cjs"]');
  });

  it('escapes backslashes in Windows paths', () => {
    const out = renderCodexServerToml(ABS_SERVER);
    expect(out).toContain('args = ["C:\\\\ext\\\\scripts\\\\taskwright-mcp.cjs"]');
  });

  it('omits env when empty and renders it inline when present', () => {
    expect(renderCodexServerToml(SERVER)).not.toContain('env');
    const out = renderCodexServerToml({
      command: 'node',
      args: ['x.cjs'],
      env: { TASKWRIGHT_ROOT: '/repo' },
    });
    expect(out).toContain('env = { TASKWRIGHT_ROOT = "/repo" }');
  });

  it('omits the Claude-specific "type" key (not part of Codex TOML schema)', () => {
    expect(renderCodexServerToml(SERVER)).not.toContain('type =');
  });
});

describe('codexServerForPackagedExtension', () => {
  it('targets the packaged MCP bundle directly so it starts in consumer repositories', () => {
    const server = codexServerForPackagedExtension(
      SERVER,
      'C:\\extensions\\taskwright\\dist\\mcp\\server.js'
    );

    expect(server).toEqual({
      ...SERVER,
      args: ['C:\\extensions\\taskwright\\dist\\mcp\\server.js'],
    });
    expect(server.args?.[0]).not.toContain('taskwright-mcp.cjs');
  });
});

describe('upsertCodexMcpServer', () => {
  it('creates a fresh config from empty input, with a trailing newline', () => {
    const out = upsertCodexMcpServer('', SERVER);
    expect(out).toContain('[mcp_servers.taskwright]');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('preserves existing top-level keys and other tables', () => {
    const existing = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n';
    const out = upsertCodexMcpServer(existing, SERVER);
    expect(out).toContain('model = "o3"');
    expect(out).toContain('[mcp_servers.other]');
    expect(out).toContain('command = "other"');
    expect(out).toContain('[mcp_servers.taskwright]');
  });

  it('updates a stale taskwright table in place without duplicating it', () => {
    const stale =
      'model = "o3"\n\n[mcp_servers.taskwright]\ncommand = "OLD"\nargs = ["old.js"]\n\n[projects]\nfoo = "bar"\n';
    const out = upsertCodexMcpServer(stale, SERVER);
    expect(out.match(/\[mcp_servers\.taskwright\]/g)).toHaveLength(1);
    expect(out).not.toContain('OLD');
    expect(out).toContain('command = "node"');
    // Content after the replaced table is preserved.
    expect(out).toContain('[projects]');
    expect(out).toContain('foo = "bar"');
    // Content before it too.
    expect(out).toContain('model = "o3"');
  });

  it('replaces a stale table that sits at the end of the file', () => {
    const stale = '[mcp_servers.taskwright]\ncommand = "OLD"';
    const out = upsertCodexMcpServer(stale, SERVER);
    expect(out.match(/\[mcp_servers\.taskwright\]/g)).toHaveLength(1);
    expect(out).not.toContain('OLD');
  });

  it('does not mistake a sub-table for the taskwright table', () => {
    // [mcp_servers.taskwright.env] style sub-tables or other servers sharing the
    // prefix must not be clobbered.
    const existing = '[mcp_servers.taskwright2]\ncommand = "keep"\n';
    const out = upsertCodexMcpServer(existing, SERVER);
    expect(out).toContain('[mcp_servers.taskwright2]');
    expect(out).toContain('command = "keep"');
    expect(out).toContain('[mcp_servers.taskwright]');
  });

  it('is idempotent: re-running yields byte-identical output', () => {
    const once = upsertCodexMcpServer('model = "o3"\n', SERVER);
    const twice = upsertCodexMcpServer(once, SERVER);
    expect(twice).toBe(once);
  });

  it('round-trips the server extracted from the shipped .mcp.json template', () => {
    const template = JSON.stringify({
      mcpServers: { taskwright: SERVER, svelte: { type: 'http', url: 'https://x' } },
    });
    const server = extractTaskwrightServer(template);
    const out = upsertCodexMcpServer('', server);
    expect(out).toContain('[mcp_servers.taskwright]');
    expect(out).toContain('args = ["scripts/taskwright-mcp.cjs"]');
  });

  it('dogfoods the Taskwright MCP in the committed project-scoped Codex config', () => {
    const config = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '.codex', 'config.toml'),
      'utf8'
    );
    expect(config).toContain('[mcp_servers.taskwright]');
    expect(config).not.toContain('[mcp_servers.backlog]');
  });
});
