import { BacklogParser } from '../core/BacklogParser';
import { ClaimService } from '../core/ClaimService';
import { PlanService } from '../core/PlanService';
import { readActiveTask } from '../core/activeTask';
import { loadPlanProgress } from '../core/loadPlanProgress';
import { ChecklistItem, Task } from '../core/types';

/**
 * Pure-ish implementations of the Taskwright MCP tools, decoupled from the MCP
 * transport so they can be unit-tested. `server.ts` wires these to stdio.
 */
export interface McpHandlerDeps {
  /** Directory holding `.taskwright/active-task.json` (session cwd / worktree). */
  root: string;
  parser: BacklogParser;
  claimService: ClaimService;
  planService: PlanService;
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
  filePath: string;
}

export interface ActiveTaskResult {
  active: boolean;
  task?: TaskSummary;
  message?: string;
}

export interface ClaimResult {
  claimed: true;
  taskId: string;
  claimedBy: string;
  worktree?: string;
  claimedAt: string;
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

function toSummary(task: Task, root: string): TaskSummary {
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
  return { active: true, task: toSummary(task, deps.root) };
}

/** Place an advisory claim on a task so other sessions can see it is in progress. */
export async function claimTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string; claimedBy?: string; worktree?: string }
): Promise<ClaimResult> {
  const claimedBy = args.claimedBy?.trim() || '@agent';
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
