/**
 * Taskwright MCP server (stdio).
 *
 * Exposes the agent-facing semantics Backlog.md lacks: a pull-based
 * `get_active_task` (what should this session work on?) plus advisory
 * `claim_task` / `release_task`. Backlog.md's own MCP still handles task CRUD —
 * this server is deliberately thin and additive.
 *
 * It runs as a separate process (not in the VS Code extension host), so it only
 * imports vscode-free `src/core` modules. State root is the process cwd (or
 * `TASKWRIGHT_ROOT`), which for a dispatched session is its git worktree.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'path';
import { BacklogParser } from '../core/BacklogParser';
import { ClaimService } from '../core/ClaimService';
import { resolveBacklogDirectory } from '../core/resolveBacklogDirectory';
import {
  getActiveTask,
  claimTaskHandler,
  releaseTaskHandler,
  type McpHandlerDeps,
} from './handlers';

function jsonContent(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function main(): Promise<void> {
  // stdout is the JSON-RPC channel for stdio MCP — it must carry nothing else.
  // Core modules (e.g. BacklogParser) log via console.log at call time; route
  // all such incidental logging to stderr so it can't corrupt the protocol
  // stream. The SDK transport writes to process.stdout directly, so it is
  // unaffected by this reassignment.
  console.log = (...args: unknown[]): void => console.error(...args);

  const root = process.env.TASKWRIGHT_ROOT?.trim() || process.cwd();
  const backlogPath = resolveBacklogDirectory(root).backlogPath || path.join(root, 'backlog');

  const deps: McpHandlerDeps = {
    root,
    parser: new BacklogParser(backlogPath),
    claimService: new ClaimService(),
  };

  const server = new McpServer({ name: 'taskwright', version: '0.0.1' });

  server.registerTool(
    'get_active_task',
    {
      title: 'Get active task',
      description:
        'Return the task this session should work on, as recorded on the Taskwright board / by a dispatch. Call this first to learn your task ID and context.',
    },
    async () => jsonContent(await getActiveTask(deps))
  );

  server.registerTool(
    'claim_task',
    {
      title: 'Claim task',
      description:
        'Place an advisory claim on a task so other sessions see it is in progress. Claiming is advisory (git syncs asynchronously across worktrees) — it reduces, not prevents, duplicate work.',
      inputSchema: {
        taskId: z.string().describe('Task ID to claim, e.g. TASK-7.'),
        claimedBy: z
          .string()
          .optional()
          .describe('Identity holding the claim (defaults to @agent).'),
        worktree: z.string().optional().describe('Branch or worktree being worked in.'),
      },
    },
    async (args) => jsonContent(await claimTaskHandler(deps, args))
  );

  server.registerTool(
    'release_task',
    {
      title: 'Release task',
      description: 'Remove the advisory claim from a task (e.g. when finishing or handing off).',
      inputSchema: {
        taskId: z.string().describe('Task ID to release, e.g. TASK-7.'),
      },
    },
    async (args) => jsonContent(await releaseTaskHandler(deps, args))
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for diagnostics; stdout is the JSON-RPC channel.
  console.error(`[taskwright-mcp] ready (root: ${root})`);
}

main().catch((error) => {
  console.error('[taskwright-mcp] fatal:', error);
  process.exit(1);
});
