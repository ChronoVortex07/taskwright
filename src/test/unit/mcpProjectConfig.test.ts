import { describe, it, expect } from 'vitest';
import { extractTaskwrightServer, upsertTaskwrightMcpServer } from '../../core/mcpProjectConfig';

// The exact shape the extension ships as its .mcp.json template (repo-root .mcp.json).
const TEMPLATE = JSON.stringify(
  {
    mcpServers: {
      taskwright: {
        type: 'stdio',
        command: 'node',
        args: ['scripts/taskwright-mcp.cjs'],
        env: {},
      },
      svelte: { type: 'http', url: 'https://mcp.svelte.dev/mcp' },
    },
  },
  null,
  2
);

const TASKWRIGHT_SERVER = {
  type: 'stdio',
  command: 'node',
  args: ['scripts/taskwright-mcp.cjs'],
  env: {},
};

describe('extractTaskwrightServer', () => {
  it('returns the taskwright server definition from a template', () => {
    expect(extractTaskwrightServer(TEMPLATE)).toEqual(TASKWRIGHT_SERVER);
  });

  it('throws when the template has no taskwright entry', () => {
    const noTaskwright = JSON.stringify({ mcpServers: { svelte: { type: 'http' } } });
    expect(() => extractTaskwrightServer(noTaskwright)).toThrow(/no "taskwright" server/);
  });

  it('throws on malformed JSON', () => {
    expect(() => extractTaskwrightServer('{ not json')).toThrow(/not valid JSON/);
  });
});

describe('upsertTaskwrightMcpServer', () => {
  it('creates a fresh .mcp.json from empty input, with a trailing newline', () => {
    const out = upsertTaskwrightMcpServer('', TASKWRIGHT_SERVER);
    expect(JSON.parse(out)).toEqual({ mcpServers: { taskwright: TASKWRIGHT_SERVER } });
    expect(out.endsWith('\n')).toBe(true);
  });

  it('preserves other servers and top-level keys', () => {
    const existing = JSON.stringify({
      $schema: 'https://example.com/mcp.json',
      mcpServers: { other: { type: 'stdio', command: 'x' } },
    });
    const out = JSON.parse(upsertTaskwrightMcpServer(existing, TASKWRIGHT_SERVER));
    expect(out.mcpServers.other).toEqual({ type: 'stdio', command: 'x' });
    expect(out.mcpServers.taskwright).toEqual(TASKWRIGHT_SERVER);
    expect(out.$schema).toBe('https://example.com/mcp.json');
  });

  it('updates a stale taskwright entry in place', () => {
    const stale = JSON.stringify({
      mcpServers: { taskwright: { type: 'stdio', command: 'OLD', args: [] } },
    });
    const out = JSON.parse(upsertTaskwrightMcpServer(stale, TASKWRIGHT_SERVER));
    expect(out.mcpServers.taskwright).toEqual(TASKWRIGHT_SERVER);
  });

  it('creates mcpServers when the existing file omits it', () => {
    const existing = JSON.stringify({ $schema: 'x' });
    const out = JSON.parse(upsertTaskwrightMcpServer(existing, TASKWRIGHT_SERVER));
    expect(out.mcpServers.taskwright).toEqual(TASKWRIGHT_SERVER);
  });

  it('is idempotent: re-running yields byte-identical output', () => {
    const once = upsertTaskwrightMcpServer('', TASKWRIGHT_SERVER);
    const twice = upsertTaskwrightMcpServer(once, TASKWRIGHT_SERVER);
    expect(twice).toBe(once);
  });

  it('round-trips the extracted server from the template', () => {
    const server = extractTaskwrightServer(TEMPLATE);
    const out = JSON.parse(upsertTaskwrightMcpServer('', server));
    expect(out.mcpServers.taskwright).toEqual(TASKWRIGHT_SERVER);
  });
});
