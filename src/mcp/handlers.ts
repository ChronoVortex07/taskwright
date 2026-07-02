import { execFile, exec as childExec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { BacklogParser } from '../core/BacklogParser';
import { BacklogWriter } from '../core/BacklogWriter';
import { ClaimService } from '../core/ClaimService';
import { PlanService } from '../core/PlanService';
import { TreeFieldService } from '../core/TreeFieldService';
import { resolvePriorities } from '../core/priorityOrder';
import { wouldCreateCycle } from '../core/treeGate';
import { readActiveTask } from '../core/activeTask';
import { loadPlanProgress } from '../core/loadPlanProgress';
import { ChecklistItem, Task } from '../core/types';
import {
  ChecklistInput,
  assertValidPriority,
  assertValidStatus,
  renderChecklist,
} from './taskWriteHelpers';
import { isPrimaryTree } from '../core/worktreeGuard';
import { loadTreeStateFromParser, type TreeDerivedState } from '../core/treeDerived';
import type { TreeLayout } from '../core/treeLayout';
import {
  MergeQueueStore,
  mergeQueuePath,
  nodeQueueFs,
  positionOf,
  type QueueFsDeps,
} from '../core/mergeQueue';
import { mergeConfigPath, readMergeConfig } from '../core/mergeConfig';
import {
  readSyncConfig,
  syncConfigPath,
  DEFAULT_SYNC_CONFIG,
  type SyncConfig,
} from '../core/syncConfig';
import {
  claimTaskSynced,
  releaseTaskSynced,
  setStatusSynced,
  type SyncTarget,
  type SyncEngineDeps,
  type ClaimOutcome,
} from '../core/boardSyncEngine';
import {
  requestMerge,
  type BoardOps,
  type GitExecFn,
  type RunFn,
  type RequestMergeResult,
} from '../core/finishTask';

/**
 * Pure-ish implementations of the Taskwright MCP tools, decoupled from the MCP
 * transport so they can be unit-tested. `server.ts` wires these to stdio.
 */
export interface McpHandlerDeps {
  /** Directory holding `.taskwright/active-task.json` (session cwd / worktree). */
  root: string;
  /** Path to the `backlog/` directory (parent of `tasks/`); used by create tools. */
  backlogPath: string;
  parser: BacklogParser;
  writer: BacklogWriter;
  claimService: ClaimService;
  planService: PlanService;
  treeFieldService: TreeFieldService;
  /** Injectable git runner (defaults to execFile('git')). Tests override. */
  gitExec?: GitExecFn;
  /** Injectable shell runner for verify/gh (defaults to child_process.exec). */
  shellRun?: RunFn;
  /** Injectable clock/sleep for the wait loop (defaults to wall clock). */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable board (defaults to makePrimaryBoard(primaryRoot)). Tests override. */
  board?: BoardOps;
  /** Injectable fs adapter for queue/config I/O (defaults to nodeQueueFs). Tests override. */
  fsDeps?: QueueFsDeps;
  /** Injectable synced-board claim (defaults to the real engine). Tests override. */
  claimSynced?: (
    target: SyncTarget,
    taskId: string,
    claimedBy: string,
    opts?: { worktree?: string; stalenessMs?: number }
  ) => Promise<ClaimOutcome>;
  /** Injectable synced-board release (defaults to the real engine). Tests override. */
  releaseSynced?: (
    target: SyncTarget,
    taskId: string
  ) => Promise<{ status: 'released' } | { status: 'failed'; reason: string }>;
  /** Injectable sync-config resolver (defaults to reading sync-config.json). Tests override. */
  syncConfigForRoot?: (root: string) => Promise<SyncConfig>;
}

export interface PlanProgressSummary {
  total: number;
  done: number;
  percent: number;
  exists: boolean;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  priority?: string;
  description?: string;
  acceptanceCriteria: ChecklistItem[];
  implementationPlan?: string;
  labels: string[];
  assignee: string[];
  claimedBy?: string;
  worktree?: string;
  claimedAt?: string;
  /** Repo-root-relative path to the linked superpowers plan, if attached. */
  plan?: string;
  /** Checkbox completion of the linked plan, when one is attached. */
  planProgress?: PlanProgressSummary;
  // Tech-tree P1 fields.
  category?: string;
  type?: string;
  causedBy?: string;
  milestone?: string;
  dependencies: string[];
  locked?: boolean;
  blockedBy?: string[];
  bugs?: string[];
  activeBugIds?: string[];
  layout?: TreeLayout;
  filePath: string;
}

export interface ActiveTaskResult {
  active: boolean;
  task?: TaskSummary;
  message?: string;
  queuePosition?: number;
}

export interface ClaimResult {
  claimed: boolean;
  taskId: string;
  claimedBy?: string;
  worktree?: string;
  claimedAt?: string;
  /** True when the synced board shows the task is already held by someone else. */
  surrendered?: boolean;
  /** Who holds the task when `surrendered` is true. */
  heldBy?: string;
}

export interface ReleaseResult {
  released: true;
  taskId: string;
}

export interface AttachPlanResult {
  attached: true;
  taskId: string;
  plan: string;
}

const execFileAsync = promisify(execFile);
const childExecAsync = promisify(childExec);

const defaultGitExec: GitExecFn = (cwd, args) =>
  execFileAsync('git', args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });

const defaultShellRun: RunFn = async (cwd, commandLine) => {
  try {
    const { stdout, stderr } = await childExecAsync(commandLine, {
      cwd,
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
    };
  }
};

/** Git facts needed to run `request_merge` from a worktree. */
interface GitFacts {
  gitDir: string;
  commonDir: string;
  primaryRoot: string;
  branch: string | null;
}

async function gitFacts(exec: GitExecFn, cwd: string): Promise<GitFacts> {
  const gitDir = path.resolve((await exec(cwd, ['rev-parse', '--git-dir'])).stdout.trim());
  const commonDir = path.resolve(
    (await exec(cwd, ['rev-parse', '--git-common-dir'])).stdout.trim()
  );
  let branch: string | null;
  try {
    branch = (await exec(cwd, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  } catch {
    branch = null;
  }
  return { gitDir, commonDir, primaryRoot: path.dirname(commonDir), branch };
}

/** A BoardOps bound to the PRIMARY tree's board (what the human watches). */
export function makePrimaryBoard(primaryRoot: string, exec: GitExecFn): BoardOps {
  const backlogPath = path.join(primaryRoot, 'backlog');
  const parser = new BacklogParser(backlogPath);
  const writer = new BacklogWriter();
  const claims = new ClaimService();
  return {
    async setStatus(taskId, status) {
      await writer.updateTask(taskId, { status } as Partial<Task>, parser);
    },
    async release(taskId) {
      await claims.releaseTask(taskId, parser);
    },
    async resetTaskFile(taskId) {
      const task = await parser.getTask(taskId);
      if (!task) return;
      const rel = path.relative(primaryRoot, task.filePath);
      try {
        await exec(primaryRoot, ['checkout', '--', rel]);
      } catch {
        // best-effort: if it fails, the ff-merge will abort cleanly on the dirty file
      }
    },
  };
}

/**
 * A BoardOps for the synced board (sync mode `local`/`github`). Routes each
 * mutation through the CAS engine so it lands on the shared `taskwright-board`
 * ref (and origin) instead of being a working-tree-only edit that the next
 * materialize would discard. `resetTaskFile` is a no-op: board files are
 * git-ignored on code branches, so the intermediate-status write never enters
 * the primary tree's index and cannot collide with the ff-merge.
 */
export function makeSyncedBoard(
  target: SyncTarget,
  engineDeps?: Partial<SyncEngineDeps>
): BoardOps {
  return {
    async setStatus(taskId, status) {
      const r = await setStatusSynced(target, taskId, status, { deps: engineDeps });
      if (r.status !== 'ok') {
        throw new Error(
          `request_merge could not set ${taskId} status to "${status}" on the board: ${r.reason}`
        );
      }
    },
    async release(taskId) {
      const r = await releaseTaskSynced(target, taskId, { deps: engineDeps });
      if (r.status !== 'released') {
        throw new Error(`request_merge could not release ${taskId} on the board: ${r.reason}`);
      }
    },
    async resetTaskFile() {
      // no-op — see doc comment
    },
  };
}

function queueStoreFor(commonDir: string, fsDeps: QueueFsDeps = nodeQueueFs): MergeQueueStore {
  return new MergeQueueStore(mergeQueuePath(commonDir), fsDeps);
}

/**
 * `request_merge`: submit the active task for integration and block until it is
 * merged / a PR is opened / it is sent back — the single closing call an agent
 * makes from inside its worktree.
 */
export async function requestMergeHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<RequestMergeResult> {
  const exec = deps.gitExec ?? defaultGitExec;
  const run = deps.shellRun ?? defaultShellRun;
  const facts = await gitFacts(exec, deps.root);

  if (isPrimaryTree(facts.gitDir)) {
    return {
      status: 'aborted',
      reason:
        'request_merge must be called from inside your .worktrees/<branch>, not the primary tree. cd into the worktree and try again.',
    };
  }
  if (!facts.branch) {
    return {
      status: 'aborted',
      reason: 'Your worktree has a detached HEAD; check out your task branch first.',
    };
  }

  const fsDeps = deps.fsDeps ?? nodeQueueFs;
  const config = readMergeConfig(mergeConfigPath(facts.commonDir), fsDeps);

  // On a synced board the source of truth is the shared ref, and the primary
  // tree's `backlog/` is materialized from it — so route board writes through the
  // sync engine (fetch → mutate → snapshot → push) rather than editing the
  // materialized files directly, which the next poll would clobber.
  const syncCfg = await resolveSyncConfig(deps);
  const board =
    deps.board ??
    (syncCfg.mode !== 'off'
      ? makeSyncedBoard(syncTargetFor(deps.root, syncCfg))
      : makePrimaryBoard(facts.primaryRoot, exec));

  return requestMerge(
    {
      root: deps.root,
      primaryRoot: facts.primaryRoot,
      branch: facts.branch,
      worktreeRel: `.worktrees/${facts.branch}`,
      config,
      queue: queueStoreFor(facts.commonDir, fsDeps),
      board,
      exec,
      run,
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    },
    args.taskId
  );
}

export function toSummary(task: Task, root: string, derived?: TreeDerivedState): TaskSummary {
  let planProgress: PlanProgressSummary | undefined;
  if (task.plan) {
    const loaded = loadPlanProgress(root, task.plan);
    planProgress = {
      total: loaded.progress.total,
      done: loaded.progress.done,
      percent: loaded.progress.percent,
      exists: loaded.exists,
    };
  }
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    implementationPlan: task.implementationPlan,
    labels: task.labels,
    assignee: task.assignee,
    claimedBy: task.claimedBy,
    worktree: task.worktree,
    claimedAt: task.claimedAt,
    plan: task.plan,
    planProgress,
    category: task.category,
    type: task.type,
    causedBy: task.causedBy,
    milestone: task.milestone,
    dependencies: task.dependencies,
    locked: derived?.locked,
    blockedBy: derived?.blockedBy,
    bugs: derived?.bugs,
    activeBugIds: derived?.activeBugIds,
    layout: derived?.layout,
    filePath: task.filePath,
  };
}

/**
 * Resolve the task a session should work on. Pull-based: returns whatever the
 * board/dispatch recorded as active in `root`, hydrated from the task file.
 */
export async function getActiveTask(deps: McpHandlerDeps): Promise<ActiveTaskResult> {
  const active = readActiveTask(deps.root);
  if (!active) {
    return {
      active: false,
      message:
        'No active task is set. Pick a task on the Taskwright board (or dispatch one) before starting.',
    };
  }
  const task = await deps.parser.getTask(active.taskId);
  if (!task) {
    return {
      active: false,
      message: `Active task ${active.taskId} was set but no matching task file was found.`,
    };
  }
  let queuePosition: number | undefined;
  try {
    const exec = deps.gitExec ?? defaultGitExec;
    const fsDeps = deps.fsDeps ?? nodeQueueFs;
    const commonDir = path.resolve(
      (await exec(deps.root, ['rev-parse', '--git-common-dir'])).stdout.trim()
    );
    const pos = positionOf(queueStoreFor(commonDir, fsDeps).read(), active.taskId);
    if (pos > 0) queuePosition = pos;
  } catch {
    // not a git repo / no queue — omit the field
  }
  const states = await loadTreeStateFromParser(deps.parser).catch(() => undefined);
  return {
    active: true,
    task: toSummary(task, deps.root, states?.get(task.id)),
    queuePosition,
  };
}

/**
 * Resolve the synced-board config for this session (from sync-config.json under
 * the common dir). Degrades to `off` (legacy claim path) when the directory is
 * not a git repo or the config can't be read — sync is strictly opt-in.
 */
async function resolveSyncConfig(deps: McpHandlerDeps): Promise<SyncConfig> {
  if (deps.syncConfigForRoot) return deps.syncConfigForRoot(deps.root);
  try {
    const exec = deps.gitExec ?? defaultGitExec;
    const fsDeps = deps.fsDeps ?? nodeQueueFs;
    const commonDir = path.resolve(
      (await exec(deps.root, ['rev-parse', '--git-common-dir'])).stdout.trim()
    );
    return readSyncConfig(syncConfigPath(commonDir), fsDeps);
  } catch {
    return DEFAULT_SYNC_CONFIG;
  }
}

function syncTargetFor(root: string, cfg: SyncConfig): SyncTarget {
  return {
    repoRoot: root,
    ref: cfg.ref,
    remote: cfg.mode === 'github' ? cfg.remote : undefined,
    indexFile: path.join(root, '.taskwright', 'board.index'),
    backlogDir: 'backlog',
  };
}

/** Place an advisory claim on a task so other sessions can see it is in progress. */
export async function claimTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string; claimedBy?: string; worktree?: string }
): Promise<ClaimResult> {
  const claimedBy = args.claimedBy?.trim() || '@agent';
  const cfg = await resolveSyncConfig(deps);

  if (cfg.mode !== 'off') {
    const claim = deps.claimSynced ?? claimTaskSynced;
    const outcome = await claim(syncTargetFor(deps.root, cfg), args.taskId, claimedBy, {
      worktree: args.worktree,
    });
    if (outcome.status === 'claimed') {
      return {
        claimed: true,
        taskId: args.taskId,
        claimedBy: outcome.claim.claimedBy,
        worktree: outcome.claim.worktree,
        claimedAt: outcome.claim.claimedAt,
      };
    }
    if (outcome.status === 'surrendered') {
      return { claimed: false, taskId: args.taskId, surrendered: true, heldBy: outcome.by };
    }
    return { claimed: false, taskId: args.taskId };
  }

  const claim = await deps.claimService.claimTask(args.taskId, claimedBy, deps.parser, {
    worktree: args.worktree,
  });
  return {
    claimed: true,
    taskId: args.taskId,
    claimedBy: claim.claimedBy,
    worktree: claim.worktree,
    claimedAt: claim.claimedAt,
  };
}

/** Remove the advisory claim from a task. */
export async function releaseTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<ReleaseResult> {
  const cfg = await resolveSyncConfig(deps);
  if (cfg.mode !== 'off') {
    const release = deps.releaseSynced ?? releaseTaskSynced;
    await release(syncTargetFor(deps.root, cfg), args.taskId);
    return { released: true, taskId: args.taskId };
  }
  await deps.claimService.releaseTask(args.taskId, deps.parser);
  return { released: true, taskId: args.taskId };
}

/** Link a task to its implementation plan/spec so the board can track progress. */
export async function attachPlanHandler(
  deps: McpHandlerDeps,
  args: { taskId: string; plan: string }
): Promise<AttachPlanResult> {
  const plan = await deps.planService.attachPlan(args.taskId, args.plan, deps.parser);
  return { attached: true, taskId: args.taskId, plan };
}

/** Re-read a just-written task and shape it for return; throws if it vanished. */
async function requireSummary(deps: McpHandlerDeps, taskId: string): Promise<TaskSummary> {
  const task = await deps.parser.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was written but could not be read back.`);
  }
  const states = await loadTreeStateFromParser(deps.parser).catch(() => undefined);
  return toSummary(task, deps.root, states?.get(task.id));
}

/**
 * Validate a proposed dependency set: every ID must resolve to a known task
 * (tasks/drafts/completed/archive), and — when editing an existing task —
 * adding any of them must not create a cycle.
 */
async function assertDependenciesValid(
  deps: McpHandlerDeps,
  dependencies: string[],
  targetId?: string
): Promise<void> {
  if (dependencies.length === 0) return;
  const [tasks, drafts, completed, archived] = await Promise.all([
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
    deps.parser.getCompletedTasks(),
    deps.parser.getArchivedTasks(),
  ]);
  const all = [...tasks, ...drafts, ...completed, ...archived];
  const known = new Set(all.map((t) => t.id.trim().toUpperCase()));
  for (const dep of dependencies) {
    if (!known.has(dep.trim().toUpperCase())) {
      throw new Error(`Dependency ${dep} does not exist.`);
    }
  }
  if (targetId) {
    for (const dep of dependencies) {
      if (wouldCreateCycle(all, targetId, dep)) {
        throw new Error(
          `Adding dependency ${dep} to ${targetId} would create a dependency cycle.`
        );
      }
    }
  }
}

/** Validate the type value: only 'bug' or absent is allowed. Returns the trimmed value or undefined. */
function normalizeType(type: string | undefined): string | undefined {
  if (type === undefined) return undefined;
  const t = type.trim();
  if (t === '') return undefined;
  if (t !== 'bug') {
    throw new Error(`Invalid type "${type}". Only "bug" (or none) is allowed.`);
  }
  return 'bug';
}

export interface CreateTaskArgs {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  assignee?: string[];
  milestone?: string;
  category?: string;
  type?: string;
  causedBy?: string;
  dependencies?: string[];
  draft?: boolean;
}

/** Create a task (or draft) and return its summary. */
export async function createTaskHandler(
  deps: McpHandlerDeps,
  args: CreateTaskArgs
): Promise<TaskSummary> {
  const title = args.title?.trim();
  if (!title) throw new Error('A task title is required.');
  const config = await deps.parser.getConfig();
  if (args.status !== undefined) assertValidStatus(args.status, config.statuses ?? []);
  if (args.priority !== undefined) assertValidPriority(args.priority, resolvePriorities(config));
  const type = normalizeType(args.type);
  const causedBy = args.causedBy?.trim();
  if (causedBy && type !== 'bug') {
    throw new Error('caused_by can only be set on a bug (type: bug).');
  }
  const dependencies = args.dependencies ?? [];
  await assertDependenciesValid(deps, dependencies); // no targetId: new task cannot form a cycle

  let id: string;
  if (args.draft) {
    ({ id } = await deps.writer.createDraft(deps.backlogPath, deps.parser, {
      title,
      description: args.description,
    }));
  } else {
    ({ id } = await deps.writer.createTask(
      deps.backlogPath,
      {
        title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        labels: args.labels,
        assignee: args.assignee,
        milestone: args.milestone,
      },
      deps.parser
    ));
  }

  // type / dependencies go through BacklogWriter (both are serialized there).
  if (type !== undefined || dependencies.length > 0) {
    const canonical: Partial<Task> = {};
    if (type !== undefined) canonical.type = type;
    if (dependencies.length > 0) canonical.dependencies = dependencies;
    await deps.writer.updateTask(id, canonical, deps.parser);
  }
  // category / caused_by are Taskwright-only: write surgically after create.
  if (args.category !== undefined && args.category.trim() !== '') {
    await deps.treeFieldService.setCategory(id, args.category, deps.parser);
  }
  if (causedBy) {
    await deps.treeFieldService.setCausedBy(id, causedBy, deps.parser);
  }

  return requireSummary(deps, id);
}

export interface EditTaskArgs {
  taskId: string;
  title?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  assignee?: string[];
  milestone?: string;
  description?: string;
  acceptanceCriteria?: ChecklistInput[];
  definitionOfDone?: ChecklistInput[];
  implementationPlan?: string;
  implementationNotes?: string;
  finalSummary?: string;
  dependencies?: string[];
  references?: string[];
  category?: string;
  type?: string;
  causedBy?: string;
}

export interface MoveResult {
  taskId: string;
  outcome: 'completed' | 'archived' | 'restored';
  path: string;
}

/** Move a task into completed/. */
export async function completeTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<MoveResult> {
  const dest = await deps.writer.completeTask(args.taskId, deps.parser);
  return { taskId: args.taskId, outcome: 'completed', path: dest };
}

/** Move a task into archive/tasks/. */
export async function archiveTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<MoveResult> {
  const dest = await deps.writer.archiveTask(args.taskId, deps.parser);
  return { taskId: args.taskId, outcome: 'archived', path: dest };
}

/** Move an archived task back into tasks/ (or drafts/ for DRAFT- ids). */
export async function restoreTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<MoveResult> {
  const dest = await deps.writer.restoreArchivedTask(args.taskId, deps.parser);
  return { taskId: args.taskId, outcome: 'restored', path: dest };
}

/** Promote a draft (DRAFT-N) to a task (new TASK-N id). */
export async function promoteDraftHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<TaskSummary> {
  const newId = await deps.writer.promoteDraft(args.taskId, deps.parser);
  return requireSummary(deps, newId);
}

/** Demote a task to a draft (new DRAFT-N id, status Draft). */
export async function demoteTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<TaskSummary> {
  const newId = await deps.writer.demoteTask(args.taskId, deps.parser);
  return requireSummary(deps, newId);
}

/** Apply partial edits to a task and return the updated summary. */
export async function editTaskHandler(
  deps: McpHandlerDeps,
  args: EditTaskArgs
): Promise<TaskSummary> {
  const config = await deps.parser.getConfig();
  if (args.status !== undefined) assertValidStatus(args.status, config.statuses ?? []);
  if (args.priority !== undefined) assertValidPriority(args.priority, resolvePriorities(config));

  const existing = await deps.parser.getTask(args.taskId);
  if (!existing) throw new Error(`Task ${args.taskId} not found`);

  const nextType = args.type !== undefined ? normalizeType(args.type) : existing.type;
  const causedBy = args.causedBy?.trim();
  if (args.causedBy !== undefined && causedBy && nextType !== 'bug') {
    throw new Error('caused_by can only be set on a bug (type: bug).');
  }
  if (args.dependencies !== undefined) {
    await assertDependenciesValid(deps, args.dependencies, args.taskId);
  }

  const updates: Record<string, unknown> = {};
  if (args.title !== undefined) updates.title = args.title;
  if (args.status !== undefined) updates.status = args.status;
  if (args.priority !== undefined) updates.priority = args.priority;
  if (args.labels !== undefined) updates.labels = args.labels;
  if (args.assignee !== undefined) updates.assignee = args.assignee;
  if (args.milestone !== undefined) updates.milestone = args.milestone;
  if (args.description !== undefined) updates.description = args.description;
  if (args.acceptanceCriteria !== undefined)
    updates.acceptanceCriteria = renderChecklist(args.acceptanceCriteria);
  if (args.definitionOfDone !== undefined)
    updates.definitionOfDone = renderChecklist(args.definitionOfDone);
  if (args.implementationPlan !== undefined) updates.implementationPlan = args.implementationPlan;
  if (args.implementationNotes !== undefined)
    updates.implementationNotes = args.implementationNotes;
  if (args.finalSummary !== undefined) updates.finalSummary = args.finalSummary;
  if (args.dependencies !== undefined) updates.dependencies = args.dependencies;
  if (args.references !== undefined) updates.references = args.references;
  // Only a non-empty `type` (i.e. 'bug') routes through BacklogWriter; clearing is surgical (below).
  if (args.type !== undefined && nextType !== undefined) updates.type = nextType;

  if (Object.keys(updates).length > 0) {
    await deps.writer.updateTask(args.taskId, updates as Partial<Task>, deps.parser);
  }

  // Clearing `type` is surgical: BacklogWriter has no omit-if-empty path for `type`,
  // so removing the field (rather than writing an empty value) keeps the file clean.
  if (args.type !== undefined && nextType === undefined) {
    await deps.treeFieldService.clearType(args.taskId, deps.parser);
  }
  // category / caused_by are Taskwright-only surgical fields.
  if (args.category !== undefined) {
    if (args.category.trim() === '')
      await deps.treeFieldService.clearCategory(args.taskId, deps.parser);
    else await deps.treeFieldService.setCategory(args.taskId, args.category, deps.parser);
  }
  if (args.causedBy !== undefined) {
    if (causedBy) await deps.treeFieldService.setCausedBy(args.taskId, causedBy, deps.parser);
    else await deps.treeFieldService.clearCausedBy(args.taskId, deps.parser);
  }

  return requireSummary(deps, args.taskId);
}

/** Create a subtask under a parent and return its summary. */
export async function createSubtaskHandler(
  deps: McpHandlerDeps,
  args: { parentTaskId: string; title?: string; description?: string }
): Promise<TaskSummary> {
  const { id } = await deps.writer.createSubtask(args.parentTaskId, deps.backlogPath, deps.parser, {
    title: args.title,
    description: args.description,
  });
  return requireSummary(deps, id);
}
