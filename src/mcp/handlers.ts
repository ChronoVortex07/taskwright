import { execFile, exec as childExec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { BacklogParser, computeSubtasks } from '../core/BacklogParser';
import {
  BacklogWriter,
  detectCRLF,
  normalizeToLF,
  restoreLineEndings,
} from '../core/BacklogWriter';
import { addCategoryLine, isReservedCategory } from '../core/categoriesConfig';
import { ClaimService } from '../core/ClaimService';
import { PlanService } from '../core/PlanService';
import { TreeFieldService } from '../core/TreeFieldService';
import { resolvePriorities } from '../core/priorityOrder';
import { wouldCreateCycle, resolveDoneStatus } from '../core/treeGate';
import { createTaskWithTreeFields, normalizeType } from '../core/createTaskCore';
import { searchTasks } from '../core/searchTasks';
import { promoteDrafts, type PromoteDraftsResult } from '../core/promoteDrafts';
import { readActiveTask } from '../core/activeTask';
import { bootstrapTaskWorktree, type StartTaskResult } from '../core/startTask';
import { loadPlanProgress } from '../core/loadPlanProgress';
import { ChecklistItem, Milestone, Task } from '../core/types';
import {
  ChecklistInput,
  assertValidPriority,
  assertValidStatus,
  renderChecklist,
} from './taskWriteHelpers';
import { isPrimaryTree } from '../core/worktreeGuard';
import {
  loadTreeStateFromParser,
  loadTreeBoardFromParser,
  type TreeDerivedState,
} from '../core/treeDerived';
import { laneOf, MISC_LANE, BUGS_LANE, BACKBURNER_BAND, type TreeLayout } from '../core/treeLayout';
import {
  MergeQueueStore,
  mergeQueuePath,
  nodeQueueFs,
  positionOf,
  type QueueFsDeps,
} from '../core/mergeQueue';
import { mergeConfigPath, readMergeConfig } from '../core/mergeConfig';
import { readSyncConfig, syncConfigPath } from '../core/syncConfig';
import {
  pushBoard,
  pullBoard,
  type PushBoardResult,
  type PullBoardResult,
} from '../core/boardPushPull';
import type { BoardGitExec } from '../core/boardRef';
import {
  requestMerge,
  type BoardOps,
  type GitExecFn,
  type RunFn,
  type RequestMergeResult,
} from '../core/finishTask';
import { selectReadyTasks, DEFAULT_CLAIM_STALENESS_HOURS } from '../core/readyTasks';
import { stalenessMsFromHours } from '../core/claimResolution';

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
  /** Injectable git runner for board-ref plumbing that needs isolated-index env
   *  forwarding (defaults to boardRef's defaultBoardExec) — `gitExec` above has
   *  no env param and would silently drop `GIT_INDEX_FILE`. Tests override. */
  boardExec?: BoardGitExec;
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
  /** Definition of Done checklist items (echoed so clients can verify writes). */
  definitionOfDone?: ChecklistItem[];
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
  /** IDs of subtask children (drives the skill's independent-subtasks execution branch). */
  subtasks?: string[];
  /** Parent task ID when this is a subtask. */
  parentTaskId?: string;
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
  /** True when the task cannot be claimed because its dependencies are unmet. */
  locked?: boolean;
  /** The blocking dependency IDs when `locked` is true. */
  blockedBy?: string[];
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

  const board = deps.board ?? makePrimaryBoard(facts.primaryRoot, exec);

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

/**
 * `start_task`: from any primary-rooted session, create (or reuse) the task's isolated
 * `.worktrees/<branch>` and seed its active task — the same bootstrap the board Dispatch
 * action performs, exposed over MCP. It does NOT re-root this server (the root is fixed at
 * launch, server.ts:82), so the result's `relaunchHint` tells the caller to relaunch a
 * session with cwd = worktreeAbs to run `/execute-task` there.
 */
export async function startTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<StartTaskResult> {
  return bootstrapTaskWorktree(
    {
      // The primary checkout owns `.worktrees/`. Under Board Sync v2 `backlogPath` is the
      // ONE physical board (the primary worktree's backlog), so its parent is the primary
      // root even when this session runs from a worktree.
      repoRoot: path.dirname(deps.backlogPath),
      getTask: (id) => deps.parser.getTask(id),
    },
    args.taskId
  );
}

/** Board sync is off — the standard "not enabled" response shape for push/pull. */
function syncOffMessage(): string {
  return 'Board sync is off (taskwright.sync.mode). Run "Taskwright: Enable Board Sync" first.';
}

/**
 * `push_board` (Board Sync v2 Task F): snapshot the live board, union-merge
 * with the remote `taskwright-board` ref, and push. A no-op (with a
 * `message` explaining why) when `taskwright.sync.mode` is `off`.
 */
export async function pushBoardHandler(deps: McpHandlerDeps): Promise<PushBoardResult> {
  const exec = deps.gitExec ?? defaultGitExec;
  const facts = await gitFacts(exec, deps.root);
  const fsDeps = deps.fsDeps ?? nodeQueueFs;
  const syncCfg = readSyncConfig(syncConfigPath(facts.commonDir), fsDeps);
  if (syncCfg.mode === 'off') {
    return {
      pushed: false,
      ref: syncCfg.ref,
      remote: syncCfg.remote,
      commit: '',
      conflicts: [],
      message: syncOffMessage(),
    };
  }
  return pushBoard({
    cwd: deps.root,
    ref: syncCfg.ref,
    remote: syncCfg.remote,
    message: 'chore(taskwright): push board',
    exec: deps.boardExec,
  });
}

/**
 * `pull_board` (Board Sync v2 Task F): fetch the remote `taskwright-board`
 * ref, union-merge with the local board (uncommitted local edits are
 * preserved), and materialize the result. A no-op when `taskwright.sync.mode`
 * is `off`.
 */
export async function pullBoardHandler(deps: McpHandlerDeps): Promise<PullBoardResult> {
  const exec = deps.gitExec ?? defaultGitExec;
  const facts = await gitFacts(exec, deps.root);
  const fsDeps = deps.fsDeps ?? nodeQueueFs;
  const syncCfg = readSyncConfig(syncConfigPath(facts.commonDir), fsDeps);
  if (syncCfg.mode === 'off') {
    return {
      pulled: false,
      ref: syncCfg.ref,
      remote: syncCfg.remote,
      files: [],
      conflicts: [],
      message: syncOffMessage(),
    };
  }
  return pullBoard({
    cwd: deps.root,
    ref: syncCfg.ref,
    remote: syncCfg.remote,
    message: 'chore(taskwright): pull board',
    exec: deps.boardExec,
  });
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
    definitionOfDone: task.definitionOfDone,
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
    subtasks: task.subtasks,
    parentTaskId: task.parentTaskId,
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
  // Derive subtasks from the full task set (mirror the provider pattern). getTask
  // populates task.subtasks ONLY from the parent's frontmatter subtasks[], but
  // create_subtask writes only the CHILD's parent_task_id — and computeSubtasks (the
  // provider-side derivation) never runs on the MCP path. Without this a dispatched
  // parent returns subtasks: undefined, so /execute-task's independent-subtasks (SDD)
  // branch can never fire. Intentional fail-open: a derive/IO error must not brick
  // get_active_task (matches the queue/plan-progress catches here).
  try {
    const all = await deps.parser.getTasks();
    computeSubtasks(all);
    const derived = all.find((t) => t.id === task.id);
    if (derived) task.subtasks = derived.subtasks;
  } catch {
    // fail-open — leave task.subtasks as loaded from frontmatter
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
  // Intentional fail-open: a transient derive/IO error must not brick claims — do not "fix" to fail-closed.
  const states = await loadTreeStateFromParser(deps.parser).catch(() => undefined);
  return {
    active: true,
    task: toSummary(task, deps.root, states?.get(task.id.trim().toUpperCase())),
    queuePosition,
  };
}

/** Place an advisory claim on a task so other sessions can see it is in progress. */
export async function claimTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string; claimedBy?: string; worktree?: string }
): Promise<ClaimResult> {
  const claimedBy = args.claimedBy?.trim() || '@agent';

  // Dependency gate: a locked task cannot be claimed by an agent.
  // Intentional fail-open: a transient derive/IO error must not brick claims — do not "fix" to fail-closed.
  const states = await loadTreeStateFromParser(deps.parser).catch(() => undefined);
  const derived = states?.get(args.taskId.trim().toUpperCase());
  if (derived?.locked) {
    return { claimed: false, taskId: args.taskId, locked: true, blockedBy: derived.blockedBy };
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

/** Resolve the board config file (config.yml preferred, then config.yaml). */
function resolveConfigPath(backlogPath: string): string | undefined {
  const yml = path.join(backlogPath, 'config.yml');
  if (fs.existsSync(yml)) return yml;
  const yaml = path.join(backlogPath, 'config.yaml');
  if (fs.existsSync(yaml)) return yaml;
  return undefined;
}

export interface CreateCategoryResult {
  created: boolean;
  category: string;
}

/** Add a tech-tree lane (category) to config.yml. Idempotent on a case-insensitive dupe
 *  (against config ∪ discovered ∪ reserved). Rejects blank and reserved names. */
export async function createCategoryHandler(
  deps: McpHandlerDeps,
  args: { category: string }
): Promise<CreateCategoryResult> {
  const category = args.category?.trim();
  if (!category) throw new Error('A category name is required.');
  if (isReservedCategory(category)) {
    throw new Error(
      `"${category}" is a reserved lane (Bugs/Misc/Backburner) and cannot be created as a category.`
    );
  }
  // getCategories() = config ∪ discovered (reserved excluded, sorted). Dupe → idempotent.
  const existing = await deps.parser.getCategories();
  const match = existing.find((c) => c.toLowerCase() === category.toLowerCase());
  if (match) return { created: false, category: match };

  const configPath = resolveConfigPath(deps.backlogPath);
  if (!configPath) throw new Error('No backlog config.yml was found to add the category to.');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const hasCRLF = detectCRLF(raw);
  const updated = addCategoryLine(normalizeToLF(raw), category);
  fs.writeFileSync(configPath, restoreLineEndings(updated, hasCRLF), 'utf-8');
  deps.parser.invalidateConfigCache();
  return { created: true, category };
}

export interface CreateMilestoneResult {
  created: boolean;
  id: string;
  milestone: string;
}

/** Add a milestone band (age) to the board by wrapping BacklogWriter.createMilestone (files
 *  under backlog/milestones/). Idempotent on a case-insensitive NAME match against the existing
 *  milestones -> { created:false, id, milestone }. Rejects blank and the reserved 'Backburner'
 *  band (the virtual rightmost band for no-milestone tasks). Band order is CREATION order
 *  (monotonic m-N ids), so there is no `order` param. */
export async function createMilestoneHandler(
  deps: McpHandlerDeps,
  args: { name: string; description?: string }
): Promise<CreateMilestoneResult> {
  const name = args.name?.trim();
  if (!name) throw new Error('A milestone name is required.');
  if (name.toLowerCase() === BACKBURNER_BAND.toLowerCase()) {
    throw new Error(
      `"${name}" is the reserved virtual band (Backburner, for no-milestone tasks) and cannot be created as a milestone.`
    );
  }
  // Idempotent on a case-insensitive name match (mirror create_category's dupe contract).
  const existing = await deps.parser.getMilestones();
  const match = existing.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (match) return { created: false, id: match.id, milestone: match.name };

  const milestone = await deps.writer.createMilestone(
    deps.backlogPath,
    name,
    args.description,
    deps.parser // dedup backstop
  );
  deps.parser.invalidateMilestoneCache();
  return { created: true, id: milestone.id, milestone: milestone.name };
}

export interface CategorySummary {
  category: string;
  count: number;
  reserved: boolean;
}

/** The tech-tree lane vocabulary (canvas parity: config order + discovered + Misc + Bugs)
 *  with a task count per lane over the tasks+drafts universe. */
export async function listCategoriesHandler(deps: McpHandlerDeps): Promise<CategorySummary[]> {
  const [board, tasks, drafts] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
  ]);
  // Key by lowercased lane so a task whose stored category casing differs from the
  // canonical laneOrder entry is still counted (mirrors the milestone bandByLower defense).
  const counts = new Map<string, number>();
  for (const t of [...tasks, ...drafts]) {
    const lane = laneOf(t).toLowerCase();
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  const reserved = new Set([MISC_LANE, BUGS_LANE]);
  return board.laneOrder.map((category) => ({
    category,
    count: counts.get(category.toLowerCase()) ?? 0,
    reserved: reserved.has(category),
  }));
}

export interface MilestoneSummary {
  id?: string;
  name: string;
  order: number;
  taskCount: number;
  doneCount: number;
}

/** The milestone band order (canvas parity: declared -> discovered -> Backburner) with
 *  task/done counts per band over the tasks+drafts universe. Backburner absorbs
 *  tasks with no/unknown milestone (band semantics). */
export async function listMilestonesHandler(deps: McpHandlerDeps): Promise<MilestoneSummary[]> {
  const [board, tasks, drafts, milestones, config] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
    deps.parser.getMilestones(),
    deps.parser.getConfig(),
  ]);
  const doneStatus = resolveDoneStatus(config.statuses);
  const idByName = new Map(milestones.map((m: Milestone) => [m.name.toLowerCase(), m.id]));
  const resolveBand = makeBandResolver(board);
  const totals = new Map<string, { taskCount: number; doneCount: number }>();
  for (const t of [...tasks, ...drafts]) {
    const band = resolveBand(t);
    const agg = totals.get(band) ?? { taskCount: 0, doneCount: 0 };
    agg.taskCount++;
    if (t.status === doneStatus) agg.doneCount++;
    totals.set(band, agg);
  }
  return board.bandOrder.map((name, order) => {
    const agg = totals.get(name) ?? { taskCount: 0, doneCount: 0 };
    const id = name === BACKBURNER_BAND ? undefined : idByName.get(name.toLowerCase());
    return {
      ...(id ? { id } : {}),
      name,
      order,
      taskCount: agg.taskCount,
      doneCount: agg.doneCount,
    };
  });
}

export interface BoardTaskSummary {
  id: string;
  title: string;
  status: string;
  priority?: string;
  category?: string;
  milestone?: string;
  type?: string;
  causedBy?: string;
  dependencies: string[];
  blockedBy: string[];
  locked: boolean;
  draft: boolean;
}

/** Build a milestone→band resolver for one board: a task's trimmed milestone mapped to
 *  its canonical band (case-insensitive), or Backburner when unset/unknown. One definition
 *  shared by list_milestones and get_board (mirrors the shared toBoardSummary). */
function makeBandResolver(
  board: Awaited<ReturnType<typeof loadTreeBoardFromParser>>
): (task: Task) => string {
  const bandByLower = new Map(board.bandOrder.map((b) => [b.toLowerCase(), b]));
  return (task: Task): string => {
    const m = task.milestone?.trim();
    if (!m) return BACKBURNER_BAND;
    return bandByLower.get(m.toLowerCase()) ?? BACKBURNER_BAND;
  };
}

/** Shape one task into the compact board summary. Unset category/milestone are OMITTED
 *  (callers read reserved lane/band names from list_categories/list_milestones — the
 *  fields themselves are never synthesized to Misc/Backburner). */
function toBoardSummary(
  task: Task,
  board: Awaited<ReturnType<typeof loadTreeBoardFromParser>>
): BoardTaskSummary {
  const st = board.states.get(task.id.trim().toUpperCase());
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    category: task.category?.trim() || undefined,
    milestone: task.milestone?.trim() || undefined,
    type: task.type,
    causedBy: task.causedBy,
    dependencies: task.dependencies,
    blockedBy: st?.blockedBy ?? [],
    locked: st?.locked ?? false,
    draft: task.folder === 'drafts',
  };
}

export interface GetBoardArgs {
  category?: string;
  milestone?: string;
  status?: string;
}

/** Compact, filterable board view over the tasks+drafts universe (completed/archived
 *  gate only, never appear). Filters use laneOf/band semantics so 'Bugs'/'Misc'/
 *  'Backburner' work. */
export async function getBoardHandler(
  deps: McpHandlerDeps,
  args: GetBoardArgs = {}
): Promise<BoardTaskSummary[]> {
  const [board, tasks, drafts] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
  ]);
  const resolveBand = makeBandResolver(board);
  const catF = args.category?.trim().toLowerCase();
  const mileF = args.milestone?.trim().toLowerCase();
  const statF = args.status?.trim().toLowerCase();
  const out: BoardTaskSummary[] = [];
  for (const t of [...tasks, ...drafts]) {
    if (catF && laneOf(t).toLowerCase() !== catF) continue;
    if (mileF && resolveBand(t).toLowerCase() !== mileF) continue;
    if (statF && t.status.toLowerCase() !== statF) continue;
    out.push(toBoardSummary(t, board));
  }
  return out;
}

/** Ranked keyword search over the tasks+drafts universe; returns the same compact
 *  summaries as get_board. Empty query throws (use get_board for the whole board). */
export async function searchTasksHandler(
  deps: McpHandlerDeps,
  args: { query: string; limit?: number }
): Promise<BoardTaskSummary[]> {
  const [board, tasks, drafts] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
  ]);
  const ranked = searchTasks([...tasks, ...drafts], args.query, { limit: args.limit });
  return ranked.map((t) => toBoardSummary(t, board));
}

export interface NextReadyArgs {
  limit?: number;
  category?: string;
  milestone?: string;
}

/**
 * `next_ready_tasks`: the subset of the ACTIVE board (tasks/, never drafts) that is ready
 * to execute right now — status not Done, every dependency Done (not locked), no live
 * (non-stale) foreign claim, and not currently in the shared merge queue — sorted by
 * priority then ordinal, returned as the same compact rows as get_board. The heavy lifting
 * (the READY predicate + sort) is the pure core selectReadyTasks; this handler does the
 * disk/git I/O and shapes the rows via toBoardSummary. Filter by category / milestone; cap
 * with limit. Drafts are excluded — a draft must be promoted before it can be dispatched.
 */
export async function nextReadyTasksHandler(
  deps: McpHandlerDeps,
  args: NextReadyArgs = {}
): Promise<BoardTaskSummary[]> {
  const [board, tasks, config] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getConfig(),
  ]);

  // Exclude tasks that are mid-integration in the shared merge queue. Fail-open:
  // not a git repo / no queue ⇒ exclude nothing (mirrors getActiveTask's queue lookup).
  let inMergeQueue: string[] = [];
  try {
    const exec = deps.gitExec ?? defaultGitExec;
    const fsDeps = deps.fsDeps ?? nodeQueueFs;
    const commonDir = path.resolve(
      (await exec(deps.root, ['rev-parse', '--git-common-dir'])).stdout.trim()
    );
    inMergeQueue = queueStoreFor(commonDir, fsDeps)
      .read()
      .entries.map((e) => e.taskId);
  } catch {
    // not a git repo / no queue — nothing to exclude
  }

  const ready = selectReadyTasks(tasks, board, {
    doneStatus: resolveDoneStatus(config.statuses),
    priorities: resolvePriorities(config),
    stalenessMs: stalenessMsFromHours(DEFAULT_CLAIM_STALENESS_HOURS),
    inMergeQueue,
    category: args.category,
    milestone: args.milestone,
    limit: args.limit,
  });
  return ready.map((t) => toBoardSummary(t, board));
}

/** Re-read a just-written task and shape it for return; throws if it vanished. */
async function requireSummary(deps: McpHandlerDeps, taskId: string): Promise<TaskSummary> {
  const task = await deps.parser.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was written but could not be read back.`);
  }
  // Intentional fail-open: a transient derive/IO error must not brick claims — do not "fix" to fail-closed.
  const states = await loadTreeStateFromParser(deps.parser).catch(() => undefined);
  return toSummary(task, deps.root, states?.get(task.id.trim().toUpperCase()));
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
        throw new Error(`Adding dependency ${dep} to ${targetId} would create a dependency cycle.`);
      }
    }
  }
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
  const config = await deps.parser.getConfig();
  if (args.status !== undefined) assertValidStatus(args.status, config.statuses ?? []);
  if (args.priority !== undefined) assertValidPriority(args.priority, resolvePriorities(config));
  await assertDependenciesValid(deps, args.dependencies ?? []); // no targetId: new task cannot form a cycle

  const created = await createTaskWithTreeFields(deps, args);
  return requireSummary(deps, created.id);
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

/** Move a task into completed/. Bugs must be traced to their cause first. */
export async function completeTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<MoveResult> {
  const task = await deps.parser.getTask(args.taskId);
  if (task?.type === 'bug') {
    const cause = task.causedBy?.trim();
    if (!cause) {
      throw new Error(
        'A bug must be traced to the task that caused it (set caused_by) before it can be completed.'
      );
    }
    const causeTask = await deps.parser.getTask(cause);
    if (!causeTask) {
      throw new Error(`caused_by references ${cause} which does not exist.`);
    }
  }
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

/** Promote a draft (DRAFT-N) to a task (new TASK-N id). Routes through the bulk core so
 *  inbound dependency/caused_by references are remapped (contract unchanged: returns the
 *  promoted task summary). */
export async function promoteDraftHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<TaskSummary> {
  const { promoted } = await promoteDrafts(deps, [args.taskId]);
  const to = promoted[0]?.to;
  if (!to) throw new Error(`Draft ${args.taskId} could not be promoted.`);
  return requireSummary(deps, to);
}

/** Promote a set of drafts at once, remapping inbound dependency/caused_by edges so a
 *  linked proposal set keeps its structure. Returns { promoted:[{from,to}], remapped:[] }. */
export async function promoteDraftsHandler(
  deps: McpHandlerDeps,
  args: { taskIds: string[] }
): Promise<PromoteDraftsResult> {
  const ids = args.taskIds ?? [];
  return promoteDrafts(deps, ids);
}

/** Demote a task to a draft (new DRAFT-N id; status preserved, P6/D2e). */
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
  const created = await deps.writer.createSubtask(
    args.parentTaskId,
    deps.backlogPath,
    deps.parser,
    {
      title: args.title,
      description: args.description,
    }
  );
  return requireSummary(deps, created.id);
}
