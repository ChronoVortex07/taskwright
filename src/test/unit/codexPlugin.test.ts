import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  TASKWRIGHT_PLUGIN_NAME,
  PLUGIN_SKILLS_DIR,
  PLUGIN_MCP_FILE,
  PLUGIN_MANIFEST_PATH,
  CODEX_PLUGIN_SKILL_NAMES,
  buildCodexPluginManifest,
  renderCodexPluginManifest,
  renderPluginMcpJson,
  renderCodexMarketplaceJson,
  codexPluginBundleFiles,
} from '../../core/codexPlugin';
import { extractTaskwrightServer } from '../../core/mcpProjectConfig';
import { TASKWRIGHT_SKILL_NAMES } from '../../core/skillInstaller';
import type { McpServerDef } from '../../core/mcpProjectConfig';

const SERVER: McpServerDef = {
  type: 'stdio',
  command: 'node',
  args: ['scripts/taskwright-mcp.cjs'],
  env: {},
};

describe('codexPlugin — valid manifest distributing skills + MCP', () => {
  describe('renderCodexPluginManifest', () => {
    it('produces valid JSON with a trailing newline', () => {
      const out = renderCodexPluginManifest({ version: '1.4.0', server: SERVER });
      expect(out.endsWith('}\n')).toBe(true);
      expect(() => JSON.parse(out)).not.toThrow();
    });

    it('declares a kebab-case name, semver version, and BOTH skills and mcpServers', () => {
      const m = buildCodexPluginManifest({ version: '2.3.1', server: SERVER });
      expect(m.name).toBe(TASKWRIGHT_PLUGIN_NAME);
      expect(m.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(m.version).toBe('2.3.1');
      // The manifest bundles skills AND the MCP server together (AC#3).
      expect(m.skills).toBe(PLUGIN_SKILLS_DIR);
      expect(m.mcpServers).toBe(PLUGIN_MCP_FILE);
    });

    it('carries distribution metadata (description, repository, license, keywords)', () => {
      const m = buildCodexPluginManifest({ version: '1.4.0', server: SERVER });
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.repository).toMatch(/^https?:\/\//);
      expect(m.homepage).toMatch(/^https?:\/\//);
      expect(m.license).toBe('MIT');
      expect(m.keywords).toContain('taskwright');
    });

    it('wires the version through so a bump forces a Codex reinstall (update flow)', () => {
      const v1 = renderCodexPluginManifest({ version: '1.4.0', server: SERVER });
      const v2 = renderCodexPluginManifest({ version: '1.5.0', server: SERVER });
      expect(v1).not.toBe(v2);
      expect(JSON.parse(v1).version).toBe('1.4.0');
      expect(JSON.parse(v2).version).toBe('1.5.0');
    });

    it('is deterministic: same options render byte-identical output', () => {
      const a = renderCodexPluginManifest({ version: '1.4.0', server: SERVER });
      const b = renderCodexPluginManifest({ version: '1.4.0', server: SERVER });
      expect(a).toBe(b);
    });

    it('honours description/repository/license overrides', () => {
      const m = buildCodexPluginManifest({
        version: '1.0.0',
        server: SERVER,
        description: 'custom',
        repository: 'https://example.com/x',
        license: 'Apache-2.0',
      });
      expect(m.description).toBe('custom');
      expect(m.repository).toBe('https://example.com/x');
      expect(m.homepage).toBe('https://example.com/x');
      expect(m.license).toBe('Apache-2.0');
    });
  });

  describe('renderPluginMcpJson', () => {
    it('is a bare server-name map (not wrapped in mcpServers) with command/args', () => {
      const parsed = JSON.parse(renderPluginMcpJson(SERVER));
      expect(parsed.mcpServers).toBeUndefined();
      expect(parsed[TASKWRIGHT_PLUGIN_NAME]).toBeDefined();
      expect(parsed[TASKWRIGHT_PLUGIN_NAME].command).toBe('node');
      expect(parsed[TASKWRIGHT_PLUGIN_NAME].args).toEqual(['scripts/taskwright-mcp.cjs']);
    });

    it('drops the Claude-only "type" and any "url"; omits empty env', () => {
      const parsed = JSON.parse(renderPluginMcpJson(SERVER));
      const def = parsed[TASKWRIGHT_PLUGIN_NAME];
      expect(def.type).toBeUndefined();
      expect(def.url).toBeUndefined();
      expect(def.env).toBeUndefined();
    });

    it('emits env only when non-empty', () => {
      const parsed = JSON.parse(
        renderPluginMcpJson({ command: 'node', args: ['s.js'], env: { A: '1' } })
      );
      expect(parsed[TASKWRIGHT_PLUGIN_NAME].env).toEqual({ A: '1' });
    });

    it('round-trips the taskwright server extracted from the shipped .mcp.json', () => {
      const repoRoot = path.resolve(__dirname, '..', '..', '..');
      const template = fs.readFileSync(path.join(repoRoot, '.mcp.json'), 'utf-8');
      const server = extractTaskwrightServer(template);
      const parsed = JSON.parse(renderPluginMcpJson(server));
      expect(parsed[TASKWRIGHT_PLUGIN_NAME].command).toBe(server.command);
      expect(parsed[TASKWRIGHT_PLUGIN_NAME].args).toEqual(server.args);
    });
  });

  describe('renderCodexMarketplaceJson', () => {
    it('renders a valid repo-scoped marketplace entry for the plugin', () => {
      const parsed = JSON.parse(renderCodexMarketplaceJson({ version: '1.4.0' }));
      expect(Array.isArray(parsed.plugins)).toBe(true);
      expect(parsed.plugins[0].name).toBe(TASKWRIGHT_PLUGIN_NAME);
      expect(parsed.plugins[0].version).toBe('1.4.0');
    });
  });

  describe('codexPluginBundleFiles', () => {
    it('includes the manifest and the plugin .mcp.json, both valid JSON', () => {
      const files = codexPluginBundleFiles({ version: '1.4.0', server: SERVER });
      expect(Object.keys(files).sort()).toEqual(['.codex-plugin/plugin.json', '.mcp.json']);
      expect(() => JSON.parse(files[PLUGIN_MANIFEST_PATH])).not.toThrow();
      expect(() => JSON.parse(files['.mcp.json'])).not.toThrow();
    });

    it('the manifest points at the skills dir and the mcp file the bundle provides', () => {
      const files = codexPluginBundleFiles({ version: '1.4.0', server: SERVER });
      const manifest = JSON.parse(files[PLUGIN_MANIFEST_PATH]);
      expect(manifest.skills).toBe(PLUGIN_SKILLS_DIR);
      expect(manifest.mcpServers).toBe(PLUGIN_MCP_FILE);
    });
  });

  describe('bundled skill set', () => {
    it('advertises exactly the four shipped Taskwright skills', () => {
      expect([...CODEX_PLUGIN_SKILL_NAMES].sort()).toEqual([...TASKWRIGHT_SKILL_NAMES].sort());
    });
  });
});
