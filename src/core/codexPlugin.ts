import { TASKWRIGHT_MCP_NAME } from './claudeMcp';
import type { McpServerDef } from './mcpProjectConfig';
import { TASKWRIGHT_SKILL_NAMES } from './skillInstaller';

/**
 * Pure renderers for a **Codex plugin** — the distribution primitive that ships
 * Taskwright's native skills and the Taskwright MCP server together as one
 * installable bundle. Codex reads a manifest at `.codex-plugin/plugin.json`
 * whose `skills` field points at a directory it scans for `SKILL.md` packages
 * and whose `mcpServers` field points at a bare `.mcp.json` server map. A version
 * bump is Codex's reinstall cache key, so `plugin.json` drives the update flow.
 *
 * String-in / string-out (no fs, no vscode) so the build script and tests can
 * assemble/verify the bundle without a Codex install. The build copies the four
 * skill packages into `<bundle>/skills/`; these renderers own the manifest,
 * the plugin `.mcp.json`, and an optional repo-scoped marketplace entry.
 */

/** The Codex plugin package name (kebab-case, stable — Codex's reinstall cache key). */
export const TASKWRIGHT_PLUGIN_NAME = 'taskwright';

/** Path (relative to the plugin root) where Codex discovers the bundled skills. */
export const PLUGIN_SKILLS_DIR = './skills/';
/** Path (relative to the plugin root) to the plugin's MCP server map. */
export const PLUGIN_MCP_FILE = './.mcp.json';
/** The manifest's fixed location inside the plugin bundle. */
export const PLUGIN_MANIFEST_PATH = '.codex-plugin/plugin.json';

const DEFAULT_DESCRIPTION =
  'Taskwright — an agentic task board on a git-native Backlog.md backbone. Bundles the ' +
  'Taskwright workflow skills (create-task, execute-task, index-codebase, orchestrate-board) ' +
  'and the Taskwright MCP server so Codex can triage, dispatch, and merge board tasks natively.';
const DEFAULT_REPOSITORY = 'https://github.com/ChronoVortex07/taskwright';

/** Options for rendering the plugin bundle artifacts. */
export interface CodexPluginOptions {
  /** Semantic version — normally package.json's `version` (the reinstall cache key). */
  version: string;
  /** The Taskwright MCP server definition to bundle (command/args/env). */
  server: McpServerDef;
  /** Optional description override. */
  description?: string;
  /** Optional repository/homepage/license overrides. */
  repository?: string;
  homepage?: string;
  license?: string;
}

/** The shape of the `.codex-plugin/plugin.json` manifest object. */
export interface CodexPluginManifest {
  name: string;
  version: string;
  description: string;
  repository: string;
  homepage: string;
  license: string;
  keywords: string[];
  skills: string;
  mcpServers: string;
}

/** Build the plugin manifest object (declares BOTH skills and the MCP server). */
export function buildCodexPluginManifest(options: CodexPluginOptions): CodexPluginManifest {
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  return {
    name: TASKWRIGHT_PLUGIN_NAME,
    version: options.version,
    description: options.description ?? DEFAULT_DESCRIPTION,
    repository,
    homepage: options.homepage ?? repository,
    license: options.license ?? 'MIT',
    keywords: ['taskwright', 'backlog', 'agents', 'codex', 'task-board', 'mcp'],
    skills: PLUGIN_SKILLS_DIR,
    mcpServers: PLUGIN_MCP_FILE,
  };
}

/** Render `.codex-plugin/plugin.json` (pretty JSON + trailing newline). */
export function renderCodexPluginManifest(options: CodexPluginOptions): string {
  return `${JSON.stringify(buildCodexPluginManifest(options), null, 2)}\n`;
}

/**
 * Render the plugin's `.mcp.json`. Codex's plugin form is a BARE map of
 * server-name → definition (not wrapped in `mcpServers`, unlike Claude Code's
 * `.mcp.json`). Only the Codex schema keys (`command`/`args`/`env`) are emitted;
 * the Claude-only `type` and any `url` are dropped, and `env` is included only
 * when non-empty.
 */
export function renderPluginMcpJson(server: McpServerDef): string {
  const def: McpServerDef = {};
  if (server.command) def.command = server.command;
  if (server.args && server.args.length > 0) def.args = [...server.args];
  if (server.env && Object.keys(server.env).length > 0) def.env = { ...server.env };
  const map: Record<string, McpServerDef> = { [TASKWRIGHT_MCP_NAME]: def };
  return `${JSON.stringify(map, null, 2)}\n`;
}

/**
 * Render a repo-scoped `.agents/plugins/marketplace.json` entry so a Taskwright
 * checkout can offer the plugin in Codex's `/plugins` browser without publishing.
 */
export function renderCodexMarketplaceJson(options: {
  version: string;
  description?: string;
  source?: string;
}): string {
  const marketplace = {
    plugins: [
      {
        name: TASKWRIGHT_PLUGIN_NAME,
        source: options.source ?? './',
        version: options.version,
        description: options.description ?? DEFAULT_DESCRIPTION,
      },
    ],
  };
  return `${JSON.stringify(marketplace, null, 2)}\n`;
}

/**
 * The non-skill files of the plugin bundle, keyed by their path relative to the
 * plugin root. The build writes these alongside the `skills/` directory (the
 * four native SKILL.md packages copied from `dist/skills/`).
 */
export function codexPluginBundleFiles(options: CodexPluginOptions): Record<string, string> {
  return {
    [PLUGIN_MANIFEST_PATH]: renderCodexPluginManifest(options),
    '.mcp.json': renderPluginMcpJson(options.server),
  };
}

/** The skill package names the bundle's `skills/` directory must contain. */
export const CODEX_PLUGIN_SKILL_NAMES: readonly string[] = TASKWRIGHT_SKILL_NAMES;
