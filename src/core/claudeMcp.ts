import { execFile } from 'child_process';
import { promisify } from 'util';

/**
 * Helpers for registering the Taskwright MCP server with Claude Code at **user
 * scope** via its CLI (`claude mcp ...`). User scope means one registration
 * makes the server available in every project the user opens — Claude Code
 * launches it with the project as its working directory, which the server
 * resolves as its task root.
 *
 * The exec function is injectable so the logic is unit-testable without a real
 * `claude` binary.
 */
const execFileAsync = promisify(execFile);

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (cmd, args) => execFileAsync(cmd, args);

export const TASKWRIGHT_MCP_NAME = 'taskwright';

/** `claude mcp add taskwright -s user -- node <serverPath>` */
export function buildAddArgs(serverPath: string): string[] {
  return ['mcp', 'add', TASKWRIGHT_MCP_NAME, '-s', 'user', '--', 'node', serverPath];
}

/** `claude mcp remove taskwright -s user` */
export function buildRemoveArgs(): string[] {
  return ['mcp', 'remove', TASKWRIGHT_MCP_NAME, '-s', 'user'];
}

/** Whether the `claude` CLI is on PATH. */
export async function isClaudeCliAvailable(exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    await exec('claude', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** Whether the Taskwright MCP server is already registered with Claude Code. */
export async function isTaskwrightMcpRegistered(exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    const { stdout } = await exec('claude', ['mcp', 'get', TASKWRIGHT_MCP_NAME]);
    return new RegExp(TASKWRIGHT_MCP_NAME, 'i').test(stdout);
  } catch {
    // `claude mcp get` exits non-zero when the server is not configured.
    return false;
  }
}

/**
 * Register (or re-register) the server at user scope. Any existing registration
 * is removed first so the bundled server path is always current — e.g. after an
 * extension update moves the install directory. The pre-emptive remove is
 * best-effort and its failure (nothing to remove) is ignored.
 */
export async function registerTaskwrightMcp(
  serverPath: string,
  exec: ExecFn = defaultExec
): Promise<void> {
  try {
    await exec('claude', buildRemoveArgs());
  } catch {
    // no existing registration — fine
  }
  await exec('claude', buildAddArgs(serverPath));
}
