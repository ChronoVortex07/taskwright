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

/** `claude mcp get taskwright` */
export function buildGetArgs(): string[] {
  return ['mcp', 'get', TASKWRIGHT_MCP_NAME];
}

/**
 * Whether `claude mcp get` output already records this exact server path. Pure.
 * Compared separator- and case-insensitively: the path round-trips through the
 * CLI's own formatting, and on Windows `C:\x` and `c:/x` are the same file.
 */
export function registrationMatches(getOutput: string, serverPath: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
  return normalize(getOutput).includes(normalize(serverPath));
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

/**
 * Register only when the recorded path is not already `serverPath`.
 *
 * `~/.claude.json` is a single global file that every *running* Claude Code
 * session also writes to, and `claude mcp add/remove` is a read-modify-write of
 * it — so an unconditional re-register on every activation is both a window in
 * which the entry is absent (remove, then add) and a chance to lose a concurrent
 * session's write. Since the registered path is now version-stable, the common
 * case is "already correct", and the correct action is to touch nothing.
 *
 * NOTE: there is deliberately no unregister-on-deactivate counterpart. deactivate
 * runs per *window* while the registration is global, so removing it there
 * deleted the server for every other open window — the root cause of Taskwright
 * randomly vanishing from new sessions until a reload re-added it.
 */
export async function ensureTaskwrightMcpRegistered(
  serverPath: string,
  exec: ExecFn = defaultExec
): Promise<'unchanged' | 'registered'> {
  try {
    const { stdout } = await exec('claude', buildGetArgs());
    if (registrationMatches(stdout, serverPath)) return 'unchanged';
  } catch {
    // Not registered yet (`mcp get` exits non-zero) — fall through and add it.
  }
  await registerTaskwrightMcp(serverPath, exec);
  return 'registered';
}
