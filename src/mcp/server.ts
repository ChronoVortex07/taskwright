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
import { resolveWorkspaceBacklogRoot } from '../core/boardRoot';
import { runDraftIdMigrationLocked } from '../core/draftIdMigration';
import type { MergeProgress } from '../core/finishTask';
import {
  getActiveTask,
  claimTaskHandler,
  releaseTaskHandler,
  attachPlanHandler,
  listCategoriesHandler,
  listMilestonesHandler,
  getBoardHandler,
  searchTasksHandler,
  nextReadyTasksHandler,
  boardDoctorHandler,
  createTaskHandler,
  createCategoryHandler,
  createMilestoneHandler,
  editTaskHandler,
  completeTaskHandler,
  archiveTaskHandler,
  restoreTaskHandler,
  promoteDraftHandler,
  promoteDraftsHandler,
  demoteTaskHandler,
  createSubtaskHandler,
  requestMergeHandler,
  startTaskHandler,
  pushBoardHandler,
  pullBoardHandler,
  type McpHandlerDeps,
} from './handlers';
import { TASKWRIGHT_MCP_INSTRUCTIONS } from './instructions';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './serverMeta';

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

  // `root` stays worktree-local (session identity: `.taskwright/active-task.json`,
  // merge-queue lookups). `backlogPath` is the ONE physical board — the primary
  // worktree's `backlog/` (Board Sync v2 §2.1), or in git-auto mode the hidden
  // board worktree's `backlog/` (TASK-91) — so an agent working from a
  // `.worktrees/<branch>` checkout (which has no local `backlog/` at all; it's
  // git-ignored and `git worktree add` never populates it) still reads/writes
  // the real board instead of a nonexistent local one. Resolved ONCE at launch:
  // a sync-mode flip requires an MCP restart (the migration prompts a reload).
  // In git-auto with the worktree not yet bootstrapped (fresh clone before the
  // extension's first activation), this falls back to the primary shape.
  const root = process.env.TASKWRIGHT_ROOT?.trim() || process.cwd();
  const resolution = await resolveWorkspaceBacklogRoot(root);
  const backlogPath = resolution.backlogPath || path.join(root, 'backlog');
  // Pass the folder config through so the git-auto split root still reads
  // config.yml from the repo backlog/; a root-level backlog.config.yml keeps
  // the parser's own discovery (behavior identical to v2).
  const resolvedConfigPath =
    resolution.configSource === 'folder' ? (resolution.configPath ?? undefined) : undefined;

  const deps: McpHandlerDeps = {
    root,
    primaryRoot: resolution.primaryRoot,
    backlogPath,
    parser: new BacklogParser(backlogPath, resolvedConfigPath, undefined, resolution.primaryRoot),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
    treeFieldService: new TreeFieldService(),
  };

  // Converge a legacy DRAFT-N board onto stable task ids (TASK-119), so an agent-only or
  // headless session converges exactly the way a UI session does — an MCP server may well be
  // the only Taskwright process this board ever sees.
  //
  // Idempotent (a converged board performs ZERO writes) and cross-process safe: this and an
  // extension host routinely start at the same instant against the SAME physical board, and
  // `peekNextTaskId` is lock-free, so the shared `.locks/` mutex is what prevents both from
  // planning the same id and double-renaming the same draft file.
  //
  // Never fatal: a failure here must not stop the server from serving tools — the board doctor's
  // `legacy-draft-ids` finding is the visible safety net. Logs go to STDERR: stdout is the
  // JSON-RPC channel (console.log is already rerouted above, but be explicit).
  try {
    const migration = await runDraftIdMigrationLocked(deps, backlogPath);
    if (migration.migrated > 0) {
      deps.parser.invalidateTaskCache();
      const pairs = migration.mapping.map((m) => `${m.from} → ${m.to}`).join(', ');
      console.error(
        `[taskwright] Migrated ${migration.migrated} draft(s) to stable task ids: ${pairs}`
      );
    }
  } catch (error) {
    console.error('[taskwright] draft-id migration failed:', error);
  }

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: TASKWRIGHT_MCP_INSTRUCTIONS }
  );

  server.registerTool(
    'get_active_task',
    {
      title: 'Get active task',
      description:
        'Return the task this session should work on, as recorded on the Taskwright board / by a dispatch. Call this first to learn your task ID and context.',
    },
    async () => runTool(() => getActiveTask(deps))
  );

  server.registerTool(
    'claim_task',
    {
      title: 'Claim task',
      description:
        'Place an advisory claim on a task so other sessions see it is in progress. The claimant identity is derived from your session worktree/branch (e.g. @agent/task-7-fix-login), so re-claiming YOUR OWN task is an idempotent no-op ({ claimed: true, alreadyClaimed: true }) — safe after a restart. A live claim held by a DIFFERENT identity returns { claimed: false, surrendered: true, heldBy } — pick another task instead of double-executing. Stale claims (past the staleness window) and legacy generic @agent claims are reclaimed in place.',
      inputSchema: {
        taskId: z.string().describe('Task ID to claim, e.g. TASK-7.'),
        claimedBy: z
          .string()
          .optional()
          .describe(
            'Identity holding the claim. Defaults to a per-session identity derived from the worktree/branch (@agent/<branch>; bare @agent when none is derivable).'
          ),
        worktree: z
          .string()
          .optional()
          .describe(
            'Branch or worktree being worked in (also seeds the derived identity). Defaults to the session root’s .worktrees/<branch> segment or git branch.'
          ),
      },
    },
    async (args) => runTool(() => claimTaskHandler(deps, args))
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
    async (args) => runTool(() => releaseTaskHandler(deps, args))
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
    async (args) => runTool(() => attachPlanHandler(deps, args))
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description:
        'List the tech-tree lane vocabulary (categories) with a task count each, including the reserved Misc and Bugs lanes. Read this before deciding a new task’s lane: reuse an existing category by sideways traversal; only create a new one (create_category) for a genuinely new area.',
    },
    async () => jsonContent(await listCategoriesHandler(deps))
  );

  server.registerTool(
    'list_milestones',
    {
      title: 'List milestones',
      description:
        'List milestone bands in board order (declared → discovered → Backburner) with task/done counts each. Read this to slot a task into the milestone where the work lands in the flow; default to Backburner when unknown.',
    },
    async () => jsonContent(await listMilestonesHandler(deps))
  );

  server.registerTool(
    'get_board',
    {
      title: 'Get board',
      description:
        'Get a compact, filterable view of the board (active tasks + draft proposals) for tree traversal: each row is { id, title, status, priority?, category?, milestone?, type?, causedBy?, dependencies, blockedBy, locked, draft }. Filter by category / milestone / status to keep output bounded on large boards. Unset category means the Misc lane; unset milestone means Backburner.',
      inputSchema: {
        category: z.string().optional().describe('Lane filter (incl. reserved "Bugs"/"Misc").'),
        milestone: z.string().optional().describe('Band filter ("Backburner" matches unset).'),
        status: z.string().optional().describe('Status filter.'),
      },
    },
    async (args) => jsonContent(await getBoardHandler(deps, args))
  );

  server.registerTool(
    'search_tasks',
    {
      title: 'Search tasks',
      description:
        'Keyword-search the board (active tasks + drafts) by title / description / labels / category, ranked, returning the same compact summaries as get_board. Use this to find related or overlapping work so you LINK to or extend an existing task instead of creating a near-duplicate. All query tokens must match; a blank query is an error (use get_board to list everything).',
      inputSchema: {
        query: z.string().describe('Space-separated keywords; all must match somewhere.'),
        limit: z.number().optional().describe('Max results (default 20).'),
      },
    },
    async (args) => jsonContent(await searchTasksHandler(deps, args))
  );

  server.registerTool(
    'next_ready_tasks',
    {
      title: 'Next ready tasks',
      description:
        'List the tasks that are READY to execute right now — status not Done, every dependency Done (unblocked), no live claim by another session, and not already in the merge queue — sorted by priority then ordinal. Returns the same compact rows as get_board ({ id, title, status, priority?, category?, milestone?, type?, causedBy?, dependencies, blockedBy, locked, draft }). Use this to pull the next unit(s) of work to dispatch. Drafts are excluded (promote first). Filter by category / milestone; cap with limit. Pass parallelSafe:true to get a CONFLICT-SAFE parallel batch — only tasks whose attached-plan file footprints are pairwise disjoint (unknown-footprint tasks returned solo) so they can be dispatched concurrently without merge collisions; limit caps the fan-out.',
      inputSchema: {
        limit: z
          .number()
          .optional()
          .describe('Max ready tasks to return (default: all; with parallelSafe, caps the batch).'),
        category: z.string().optional().describe('Lane filter (incl. reserved "Bugs"/"Misc").'),
        milestone: z
          .string()
          .optional()
          .describe('Band filter ("Backburner" matches an unset milestone).'),
        parallelSafe: z
          .boolean()
          .optional()
          .describe(
            'When true, return a conflict-safe batch of tasks whose attached-plan file footprints are pairwise disjoint (unknown-footprint tasks returned solo), safe to dispatch in parallel. Use limit as the fan-out cap.'
          ),
      },
    },
    async (args) => jsonContent(await nextReadyTasksHandler(deps, args))
  );

  server.registerTool(
    'board_doctor',
    {
      title: 'Board doctor',
      description:
        'Read-only health check over the board and its .taskwright/.worktrees state. Returns { healthy, findings } where each finding is typed (dangling-active-task, stale-handoff, orphaned-worktree, in-flight-no-claim, claim-worktree-vanished, malformed-category, dangling-continuation, board-worktree-missing, board-strays-in-primary, board-mode-mismatch) with a suggested repair kind. Never mutates anything — repairs run through the extension (taskwright.doctor) with human confirmation. Use this to pre-flight the board before orchestrating work.',
    },
    async () => runTool(() => boardDoctorHandler(deps))
  );

  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description:
        'Create a new Backlog.md task (or draft) on the board. Fill in as many fields as you can up front — acceptance criteria, definition of done, implementation plan, references, priority, milestone, category, dependencies — so the task is unambiguous without a follow-up edit_task. Returns the created task summary.',
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
        causedBy: z.string().optional().describe('For bugs: the task ID that introduced the bug.'),
        dependencies: z
          .array(z.string())
          .optional()
          .describe('Task IDs this task depends on (must exist; no cycles).'),
        acceptanceCriteria: z
          .array(z.object({ text: z.string(), checked: z.boolean().optional() }))
          .optional()
          .describe('Acceptance criteria checklist items (rendered as `- [ ] #N text`).'),
        definitionOfDone: z
          .array(z.object({ text: z.string(), checked: z.boolean().optional() }))
          .optional()
          .describe('Definition-of-done checklist items.'),
        implementationPlan: z
          .string()
          .optional()
          .describe(
            'Implementation plan body (markdown). For a linked plan file, use attach_plan.'
          ),
        implementationNotes: z
          .string()
          .optional()
          .describe('Implementation notes body (markdown).'),
        finalSummary: z.string().optional().describe('Final summary body (markdown).'),
        references: z.array(z.string()).optional().describe('Reference URLs or paths.'),
        draft: z.boolean().optional().describe('Create as a draft (DRAFT-N in drafts/).'),
      },
    },
    async (args) => runTool(() => createTaskHandler(deps, args))
  );

  server.registerTool(
    'create_category',
    {
      title: 'Create category',
      description:
        'Add a new tech-tree lane (category) to the board config. Idempotent: an existing category (case-insensitive, including discovered ones) returns { created:false, category } rather than erroring. Reserved lane names (Bugs/Misc/Backburner) are refused. Create a category ONLY for a genuinely new area of work, surfaced for the user’s approval — prefer reusing an existing lane (see list_categories).',
      inputSchema: {
        category: z.string().describe('The new lane name, e.g. "Platform".'),
      },
    },
    async (args) => runTool(() => createCategoryHandler(deps, args))
  );

  server.registerTool(
    'create_milestone',
    {
      title: 'Create milestone',
      description:
        'Add a new milestone band (age) to the board. Milestones are ordered by CREATION order (oldest → newest, left → right on the tech-tree), so create them in chronological order. Idempotent: an existing milestone (case-insensitive name) returns { created:false, id, milestone } rather than erroring. The reserved virtual band "Backburner" (the rightmost band for tasks with no milestone) is refused. See list_milestones for the current bands.',
      inputSchema: {
        name: z.string().describe('The milestone/age name, e.g. "v1.0" or "Foundation".'),
        description: z.string().optional().describe('Optional milestone description.'),
      },
    },
    async (args) => runTool(() => createMilestoneHandler(deps, args))
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
      description:
        'Soft-delete a task into the archive — archive/tasks/ for a task, archive/drafts/ for a draft. Returns { taskId, outcome, path }.',
      inputSchema: { taskId: z.string().describe('Task ID to archive.') },
    },
    async (args) => runTool(() => archiveTaskHandler(deps, args))
  );

  server.registerTool(
    'restore_task',
    {
      title: 'Restore task',
      description:
        'Restore an archived task to the folder it was archived from — a draft returns to drafts/, a task to tasks/. Returns { taskId, outcome, path }.',
      inputSchema: { taskId: z.string().describe('Task ID to restore.') },
    },
    async (args) => runTool(() => restoreTaskHandler(deps, args))
  );

  server.registerTool(
    'promote_draft',
    {
      title: 'Promote draft',
      description:
        "Promote a draft into a real task. The id does NOT change — a draft carries its task id from birth (TASK-112 in drafts/ becomes TASK-112 in tasks/), so a reference written against a draft stays valid. Promotion is a pure file move; the status is preserved. (A legacy DRAFT-N draft is still re-id'd to a fresh TASK-M.) Returns the promoted task summary.",
      inputSchema: { taskId: z.string().describe('Draft ID to promote, e.g. TASK-112.') },
    },
    async (args) => runTool(() => promoteDraftHandler(deps, args))
  );

  server.registerTool(
    'promote_drafts',
    {
      title: 'Promote drafts (bulk)',
      description:
        "Promote a SET of reviewed draft proposals into real tasks at once. Ids are stable, so a promoted draft keeps its id and the set keeps its structure for free; any LEGACY DRAFT-N draft that must be re-id'd has every inbound dependency, caused_by, parent_task_id, subtask and reference rewritten to follow it. Use after the human has reviewed the drafts on the board. Returns { promoted: [{from,to}], remapped: [...] }.",
      inputSchema: {
        taskIds: z
          .array(z.string())
          .describe('Draft IDs to promote together, e.g. ["TASK-112","TASK-113"].'),
      },
    },
    async (args) => runTool(() => promoteDraftsHandler(deps, args))
  );

  server.registerTool(
    'demote_task',
    {
      title: 'Demote task',
      description:
        'Demote a task back into a draft. A pure file move: the id does NOT change (so nothing that referenced the task dangles) and the status is preserved — a Done task becomes a Done draft (P6/D2e). The drafts/ folder is the provisional marker, not the id. Returns the demoted task summary.',
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
        "Submit a finished task for integration and wait. Normally called from INSIDE your .worktrees/<branch>: it rebases onto the base branch, runs the verify commands, then enqueues you in the shared merge queue. It blocks until you reach the head and (in manual-review mode) a human approves, then fast-forward-merges to the base branch (or opens a PR), completes the task, and removes your worktree. It emits MCP progress notifications during verify and the queue wait, so clients that reset timeouts on progress stay alive. Pass `waitMinutes` to bound the wait: on expiry it returns { status: 'pending', queuePosition, ticket } with the queue entry KEPT — call request_merge again later with the same taskId (+ the ticket) to resume idempotently (no re-enqueue; verify is skipped when the base has not moved). Optionally, a primary-rooted session may pass `worktree` (a branch name or a repo-root-relative .worktrees/<branch> path) to drive the close against THAT worktree instead of the caller's cwd; the target must be a clean, non-detached linked worktree of this repo under .worktrees/. Call this once when the task is committed and clean; do not merge or commit to the repo root yourself.",
      inputSchema: {
        taskId: z.string().describe('Task ID to integrate, e.g. TASK-7.'),
        worktree: z
          .string()
          .optional()
          .describe(
            'Optional explicit target: a branch name or repo-root-relative .worktrees/<branch> path. When set, a primary-rooted session closes THIS worktree (must be a clean, non-detached linked worktree under .worktrees/). Omit to use the calling worktree.'
          ),
        verifyTimeoutMinutes: z
          .number()
          .optional()
          .describe(
            'Optional per-call verify timeout in minutes (e.g. after measuring a long suite). Overrides the repo default (taskwright.mergeVerifyTimeoutMinutes, 10 min if unset); clamped to the repo-level max when one is configured. Non-positive values are ignored.'
          ),
        waitMinutes: z
          .number()
          .optional()
          .describe(
            'Optional cap on the queue/approval wait, in minutes (0 = check once). When exceeded, returns { status: "pending", queuePosition, ticket } instead of blocking; the queue entry and board status are kept, and a later request_merge call for the same task resumes it idempotently. Omit for the fully-blocking default.'
          ),
        ticket: z
          .string()
          .optional()
          .describe(
            'The ticket a previous { status: "pending" } return handed back. Presenting it lets a resume detect a reviewer’s Send back that happened while you were parked (returned as status "sent_back" instead of silently re-submitting).'
          ),
      },
    },
    async (args, extra) => {
      // Forward core progress as MCP progress notifications — but only when the
      // client asked for them (sent a progressToken). `progress` is a monotonic
      // counter (there is no meaningful total for a queue wait).
      const progressToken = extra._meta?.progressToken;
      let sequence = 0;
      const onProgress =
        progressToken === undefined
          ? undefined
          : (p: MergeProgress): void => {
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: { progressToken, progress: ++sequence, message: p.message },
                })
                .catch(() => {
                  // liveness only — a dropped notification must never break the merge
                });
            };
      return runTool(() => requestMergeHandler(deps, args, onProgress));
    }
  );

  server.registerTool(
    'start_task',
    {
      title: 'Start task',
      description:
        "Create (or reuse) the task's isolated .worktrees/<branch> worktree and seed its active task, from any primary-rooted session — the same bootstrap the board Dispatch action performs. This server cannot re-root itself mid-session, so it returns a relaunchHint: open a NEW session with its working directory set to the returned worktreeAbs, then run /execute-task there. Idempotent — an existing worktree is reused (created:false). Returns { created, taskId, branch, worktree, worktreeAbs, relaunchHint }.",
      inputSchema: { taskId: z.string().describe('Task ID to start, e.g. TASK-7.') },
    },
    async (args) => runTool(() => startTaskHandler(deps, args))
  );

  server.registerTool(
    'push_board',
    {
      title: 'Push board',
      description:
        'Snapshot the current board, union-merge it with the remote "taskwright-board" ref (a same-task edit on both sides resolves by newer updated_date, always surfaced as a conflict), and push. Requires taskwright.sync.mode = "git" (run the "Taskwright: Enable Board Sync" command first). Returns { pushed, commit, conflicts, rejected? }. On a rejection (the remote moved again), just call push_board again — nothing is lost.',
    },
    async () => runTool(() => pushBoardHandler(deps))
  );

  server.registerTool(
    'pull_board',
    {
      title: 'Pull board',
      description:
        'Fetch the remote "taskwright-board" ref, union-merge it with the current local board (your own uncommitted edits are preserved; a same-task edit on both sides resolves by newer updated_date, always surfaced as a conflict), and materialize the result into the board. Requires taskwright.sync.mode = "git". Returns { pulled, files, conflicts }.',
    },
    async () => runTool(() => pullBoardHandler(deps))
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
