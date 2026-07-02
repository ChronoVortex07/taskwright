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
import { BacklogWriter } from '../core/BacklogWriter';
import { ClaimService } from '../core/ClaimService';
import { PlanService } from '../core/PlanService';
import { TreeFieldService } from '../core/TreeFieldService';
import { resolveBacklogDirectory } from '../core/resolveBacklogDirectory';
import {
  getActiveTask,
  claimTaskHandler,
  releaseTaskHandler,
  attachPlanHandler,
  createTaskHandler,
  editTaskHandler,
  completeTaskHandler,
  archiveTaskHandler,
  restoreTaskHandler,
  promoteDraftHandler,
  demoteTaskHandler,
  createSubtaskHandler,
  requestMergeHandler,
  type McpHandlerDeps,
} from './handlers';

function jsonContent(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Run a handler and convert success/throw into a uniform MCP tool result. */
async function runTool(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn(), null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: { message } }) }],
      isError: true,
    };
  }
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
    backlogPath,
    parser: new BacklogParser(backlogPath),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
    treeFieldService: new TreeFieldService(),
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

  server.registerTool(
    'attach_plan',
    {
      title: 'Attach plan',
      description:
        'Link a task to its implementation plan/spec (e.g. docs/superpowers/plans/<date>-<feature>.md) so the board tracks plan progress. Call this after writing the plan. Path is relative to the repository root.',
      inputSchema: {
        taskId: z.string().describe('Task ID to attach the plan to, e.g. TASK-7.'),
        plan: z
          .string()
          .describe('Repo-root-relative path to the plan file, e.g. docs/superpowers/plans/x.md.'),
      },
    },
    async (args) => jsonContent(await attachPlanHandler(deps, args))
  );

  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description:
        'Create a new Backlog.md task (or draft) on the board. Returns the created task summary.',
      inputSchema: {
        title: z.string().describe('Task title, imperative mood.'),
        description: z.string().optional(),
        status: z.string().optional().describe('Defaults to the board default status.'),
        priority: z.string().optional().describe("One of the board's configured priorities."),
        labels: z.array(z.string()).optional(),
        assignee: z.array(z.string()).optional(),
        milestone: z.string().optional(),
        category: z.string().optional().describe('Tech-tree lane. Absent/empty ⇒ Misc.'),
        type: z.string().optional().describe('Set to "bug" to file a bug node.'),
        causedBy: z
          .string()
          .optional()
          .describe('For bugs: the task ID that introduced the bug.'),
        dependencies: z
          .array(z.string())
          .optional()
          .describe('Task IDs this task depends on (must exist; no cycles).'),
        draft: z.boolean().optional().describe('Create as a draft (DRAFT-N in drafts/).'),
      },
    },
    async (args) => runTool(() => createTaskHandler(deps, args))
  );

  server.registerTool(
    'edit_task',
    {
      title: 'Edit task',
      description:
        'Apply partial edits to a task (status, priority, fields, description, acceptance criteria, notes). Returns the updated summary.',
      inputSchema: {
        taskId: z.string().describe('Task ID to edit, e.g. TASK-7.'),
        title: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional().describe("One of the board's configured priorities."),
        labels: z.array(z.string()).optional(),
        assignee: z.array(z.string()).optional(),
        milestone: z.string().optional(),
        description: z.string().optional(),
        acceptanceCriteria: z
          .array(z.object({ text: z.string(), checked: z.boolean().optional() }))
          .optional(),
        definitionOfDone: z
          .array(z.object({ text: z.string(), checked: z.boolean().optional() }))
          .optional(),
        implementationPlan: z.string().optional(),
        implementationNotes: z.string().optional(),
        finalSummary: z.string().optional(),
        dependencies: z.array(z.string()).optional(),
        references: z.array(z.string()).optional(),
        category: z.string().optional().describe('Tech-tree lane; empty string clears it.'),
        type: z.string().optional().describe('Set to "bug" or empty to clear.'),
        causedBy: z.string().optional().describe('Bug cause task ID; empty string clears it.'),
      },
    },
    async (args) => runTool(() => editTaskHandler(deps, args))
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete task',
      description: 'Move a task into completed/. Returns { taskId, outcome, path }.',
      inputSchema: { taskId: z.string().describe('Task ID to complete.') },
    },
    async (args) => runTool(() => completeTaskHandler(deps, args))
  );

  server.registerTool(
    'archive_task',
    {
      title: 'Archive task',
      description: 'Soft-delete a task into archive/tasks/. Returns { taskId, outcome, path }.',
      inputSchema: { taskId: z.string().describe('Task ID to archive.') },
    },
    async (args) => runTool(() => archiveTaskHandler(deps, args))
  );

  server.registerTool(
    'restore_task',
    {
      title: 'Restore task',
      description: 'Restore an archived task back to tasks/. Returns { taskId, outcome, path }.',
      inputSchema: { taskId: z.string().describe('Task ID to restore.') },
    },
    async (args) => runTool(() => restoreTaskHandler(deps, args))
  );

  server.registerTool(
    'promote_draft',
    {
      title: 'Promote draft',
      description: 'Promote a draft (DRAFT-N) into a task with a new TASK-N id.',
      inputSchema: { taskId: z.string().describe('Draft ID to promote, e.g. DRAFT-3.') },
    },
    async (args) => runTool(() => promoteDraftHandler(deps, args))
  );

  server.registerTool(
    'demote_task',
    {
      title: 'Demote task',
      description: 'Demote a task into a draft (new DRAFT-N id, status Draft).',
      inputSchema: { taskId: z.string().describe('Task ID to demote, e.g. TASK-7.') },
    },
    async (args) => runTool(() => demoteTaskHandler(deps, args))
  );

  server.registerTool(
    'create_subtask',
    {
      title: 'Create subtask',
      description: 'Create a subtask (dot-notation id, e.g. TASK-7.1) under a parent task.',
      inputSchema: {
        parentTaskId: z.string().describe('Parent task ID, e.g. TASK-7.'),
        title: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async (args) => runTool(() => createSubtaskHandler(deps, args))
  );

  server.registerTool(
    'request_merge',
    {
      title: 'Request merge',
      description:
        'Submit your finished task for integration and wait. From inside your .worktrees/<branch>, this rebases onto the base branch, runs the verify commands, then enqueues you in the shared merge queue. It blocks until you reach the head and (in manual-review mode) a human approves, then fast-forward-merges to the base branch (or opens a PR), completes the task, and removes your worktree. Call this once when the task is committed and clean; do not merge or commit to the repo root yourself.',
      inputSchema: { taskId: z.string().describe('Task ID to integrate, e.g. TASK-7.') },
    },
    async (args) => runTool(() => requestMergeHandler(deps, args))
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
