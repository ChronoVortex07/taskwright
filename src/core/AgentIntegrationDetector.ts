import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { TASKWRIGHT_MCP_NAME } from './claudeMcp';
import { TASKWRIGHT_MARKERS } from './markerBlock';

const execAsync = promisify(exec);

/** Legacy MCP server name inherited from Backlog.md, kept for back-compat detection. */
const LEGACY_MCP_NAME = 'backlog';

/** MCP server names that count as "integrated" — current first, legacy for back-compat. */
const MCP_SERVER_NAMES = [TASKWRIGHT_MCP_NAME, LEGACY_MCP_NAME];

/**
 * Per-agent integration status
 */
export interface AgentStatus {
  mcpConfigured: boolean;
  guidelinesInjected: boolean;
}

/**
 * Overall integration detection result
 */
export interface IntegrationStatus {
  hasAnyIntegration: boolean;
  claudeCode: AgentStatus;
  codex: AgentStatus;
  generalGuidelines: boolean;
}

/**
 * Markers used in instruction files (CLAUDE.md / AGENTS.md) to indicate agent
 * integration. Taskwright's marker comes first; the legacy Backlog.md markers
 * are kept so projects set up under the old naming still register as integrated.
 */
const GUIDELINES_MARKERS = [
  TASKWRIGHT_MARKERS.begin,
  '<!-- BACKLOG.MD MCP GUIDELINES START -->',
  '<!-- BACKLOG.MD GUIDELINES START -->',
];

/**
 * Safely read a file, returning null if it doesn't exist or can't be read.
 */
async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Check whether a file contains an agent-integration guidelines marker
 * (Taskwright's, or a legacy Backlog.md marker for back-compat).
 */
function hasGuidelinesMarker(content: string): boolean {
  return GUIDELINES_MARKERS.some((marker) => content.includes(marker));
}

/**
 * Detect Claude Code integration in the workspace.
 *
 * Checks:
 * - `.mcp.json` for a `taskwright` key in `mcpServers` (legacy `backlog` too)
 * - `CLAUDE.md` or `AGENTS.md` for the guidelines marker
 */
export async function detectClaudeCodeIntegration(workspaceRoot: string): Promise<AgentStatus> {
  const result: AgentStatus = { mcpConfigured: false, guidelinesInjected: false };

  // Check .mcp.json
  const mcpContent = await safeReadFile(join(workspaceRoot, '.mcp.json'));
  if (mcpContent) {
    try {
      const parsed = JSON.parse(mcpContent);
      if (MCP_SERVER_NAMES.some((name) => parsed?.mcpServers?.[name])) {
        result.mcpConfigured = true;
      }
    } catch {
      // Invalid JSON — check as raw string fallback
      if (MCP_SERVER_NAMES.some((name) => mcpContent.includes(`"${name}"`))) {
        result.mcpConfigured = true;
      }
    }
  }

  // Check CLAUDE.md and AGENTS.md for guidelines marker
  for (const filename of ['CLAUDE.md', 'AGENTS.md']) {
    const content = await safeReadFile(join(workspaceRoot, filename));
    if (content && hasGuidelinesMarker(content)) {
      result.guidelinesInjected = true;
      break;
    }
  }

  return result;
}

/**
 * Detect Codex integration in the workspace.
 *
 * Checks:
 * - `.codex/config.toml` (workspace) and `<homeDir>/.codex/config.toml` (the
 *   config Codex actually reads) for `[mcp_servers.taskwright]` (legacy
 *   `mcp_servers.backlog` too)
 * - `AGENTS.md` for the guidelines marker
 */
export async function detectCodexIntegration(
  workspaceRoot: string,
  homeDir: string = homedir()
): Promise<AgentStatus> {
  const result: AgentStatus = { mcpConfigured: false, guidelinesInjected: false };

  // Check the workspace-local and home-dir Codex configs (simple string
  // search, no TOML parser).
  const configPaths = [
    join(workspaceRoot, '.codex', 'config.toml'),
    join(homeDir, '.codex', 'config.toml'),
  ];
  for (const configPath of configPaths) {
    const codexConfig = await safeReadFile(configPath);
    if (
      codexConfig &&
      MCP_SERVER_NAMES.some((name) => codexConfig.includes(`mcp_servers.${name}`))
    ) {
      result.mcpConfigured = true;
      break;
    }
  }

  // Check AGENTS.md for guidelines marker
  const agentsMd = await safeReadFile(join(workspaceRoot, 'AGENTS.md'));
  if (agentsMd && hasGuidelinesMarker(agentsMd)) {
    result.guidelinesInjected = true;
  }

  return result;
}

/**
 * Whether Codex appears to be installed for this user: `<homeDir>/.codex`
 * contains its `config.toml` or `auth.json`. (File reads only — keeps the
 * detector's fs surface to `readFile`, mirroring the rest of this module.)
 */
export async function detectCodexInstalled(homeDir: string = homedir()): Promise<boolean> {
  for (const file of ['config.toml', 'auth.json']) {
    if ((await safeReadFile(join(homeDir, '.codex', file))) !== null) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the repo is an AGENTS.md-only repo — it carries agent instructions in
 * AGENTS.md but has no CLAUDE.md. Such repos are likely driven by an
 * AGENTS.md-native agent (Codex, etc.), so Codex integration is worth offering.
 */
export async function isAgentsMdOnlyRepo(workspaceRoot: string): Promise<boolean> {
  const agentsMd = await safeReadFile(join(workspaceRoot, 'AGENTS.md'));
  if (agentsMd === null) {
    return false;
  }
  const claudeMd = await safeReadFile(join(workspaceRoot, 'CLAUDE.md'));
  return claudeMd === null;
}

/**
 * Check if AGENTS.md has a general guidelines marker (not agent-specific).
 */
export async function detectGuidelinesMarker(workspaceRoot: string): Promise<boolean> {
  const content = await safeReadFile(join(workspaceRoot, 'AGENTS.md'));
  if (content && hasGuidelinesMarker(content)) {
    return true;
  }
  return false;
}

/**
 * Detect all agent integrations for a workspace.
 */
export async function detectIntegration(workspaceRoot: string): Promise<IntegrationStatus> {
  const [claudeCode, codex, generalGuidelines] = await Promise.all([
    detectClaudeCodeIntegration(workspaceRoot),
    detectCodexIntegration(workspaceRoot),
    detectGuidelinesMarker(workspaceRoot),
  ]);

  const hasAnyIntegration =
    claudeCode.mcpConfigured ||
    claudeCode.guidelinesInjected ||
    codex.mcpConfigured ||
    codex.guidelinesInjected ||
    generalGuidelines;

  return {
    hasAnyIntegration,
    claudeCode,
    codex,
    generalGuidelines,
  };
}

/**
 * Detect which package manager is available on PATH.
 * Prefers bun if both are available. Returns null if neither is found.
 */
export async function detectPackageManager(): Promise<'bun' | 'npm' | null> {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';

  try {
    await execAsync(`${whichCmd} bun`);
    return 'bun';
  } catch {
    // bun not found
  }

  try {
    await execAsync(`${whichCmd} npm`);
    return 'npm';
  } catch {
    // npm not found
  }

  return null;
}
