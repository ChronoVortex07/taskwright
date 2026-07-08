import type { Task } from './types';
import type { TreeBoard } from './treeDerived';
import { laneOf, BACKBURNER_BAND } from './treeLayout';
import { priorityRank } from './priorityOrder';
import { isClaimStale } from './claims';

/**
 * Default claim-staleness window (hours) when the caller supplies none. Mirrors the
 * `taskwright.claimStalenessHours` setting default (12) in package.json. The MCP server
 * is vscode-free and cannot read VS Code settings, so the handler falls back to this.
 */
export const DEFAULT_CLAIM_STALENESS_HOURS = 12;

export interface SelectReadyOptions {
  /** Terminal/Done status name — resolveDoneStatus(config.statuses). */
  doneStatus: string;
  /** Highest-first priority vocabulary — resolvePriorities(config); drives the primary sort. */
  priorities: string[];
  /** Claim-staleness window in ms; a claim older than this is NOT live (reclaimable).
   *  `<= 0` disables expiry — every claim is then treated as live (matches resolveClaimAction). */
  stalenessMs: number;
  /** Task IDs currently in the shared merge queue (mid-integration) — excluded. */
  inMergeQueue?: Iterable<string>;
  /** Lane filter (case-insensitive), matched via laneOf so 'Bugs'/'Misc' work. */
  category?: string;
  /** Band filter (case-insensitive); 'Backburner' matches an unset/unknown milestone. */
  milestone?: string;
  /** Max rows to return (clamped to >= 1, floored); omitted ⇒ all ready tasks. */
  limit?: number;
  /** Injectable clock (ms) for claim-staleness; defaults to Date.now(). */
  now?: number;
}

/**
 * A task is held by a LIVE claim when someone holds it and the claim is not stale.
 * `stalenessMs <= 0` disables expiry, so every claim is live — this matches
 * resolveClaimAction, which returns 'conflict' (not 'stale') when staleness is off.
 */
function hasLiveClaim(task: Task, stalenessMs: number, now: number): boolean {
  if (!task.claimedBy || !task.claimedBy.trim()) return false;
  if (stalenessMs <= 0) return true;
  return !isClaimStale(task.claimedAt, stalenessMs, now);
}

/**
 * A task's canonical band: its trimmed milestone matched case-insensitively to a known
 * band, else Backburner (mirrors get_board's makeBandResolver so filtering agrees).
 */
function bandOf(task: Task, bandOrder: string[]): string {
  const m = task.milestone?.trim();
  if (!m) return BACKBURNER_BAND;
  const match = bandOrder.find((b) => b.toLowerCase() === m.toLowerCase());
  return match ?? BACKBURNER_BAND;
}

/**
 * Ready-task sort: priority (high>medium>low via the configured vocabulary; unknown last),
 * then ordinal ascending (tasks with no ordinal last), then id for a stable final tiebreak.
 */
function compareReady(a: Task, b: Task, priorities: string[]): number {
  const pr = priorityRank(a.priority, priorities) - priorityRank(b.priority, priorities);
  if (pr !== 0) return pr;
  const ao = a.ordinal;
  const bo = b.ordinal;
  if (ao !== undefined && bo === undefined) return -1;
  if (ao === undefined && bo !== undefined) return 1;
  if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
  return a.id.localeCompare(b.id);
}

/**
 * The pure selector behind `next_ready_tasks`: the subset of `tasks` ready to execute now,
 * sorted by priority then ordinal. A task is READY when:
 *   1. its status is not the Done status (and it is not in completed/archive);
 *   2. every dependency is Done — i.e. it is NOT locked/blocked (board.states);
 *   3. it is not held by a LIVE (non-stale) claim;
 *   4. it is not currently in the shared merge queue.
 * Optional category/milestone filters use the same lane/band semantics as get_board.
 *
 * Mirrors the P4 read-tool core (searchTasks): returns the selected `Task[]`; the handler
 * shapes them into get_board rows via toBoardSummary. Callers pass the ACTIVE task universe
 * (parser.getTasks()) — drafts are never ready (they must be promoted first).
 */
export function selectReadyTasks(
  tasks: Task[],
  board: TreeBoard,
  opts: SelectReadyOptions
): Task[] {
  const now = opts.now ?? Date.now();
  const inQueue = new Set<string>();
  for (const id of opts.inMergeQueue ?? []) inQueue.add(id.trim().toUpperCase());
  const catF = opts.category?.trim().toLowerCase();
  const mileF = opts.milestone?.trim().toLowerCase();

  const ready = tasks.filter((t) => {
    if (t.status === opts.doneStatus) return false;
    if (t.folder === 'completed' || t.folder === 'archive') return false;
    const derived = board.states.get(t.id.trim().toUpperCase());
    if (derived?.locked) return false;
    if (hasLiveClaim(t, opts.stalenessMs, now)) return false;
    if (inQueue.has(t.id.trim().toUpperCase())) return false;
    if (catF && laneOf(t).toLowerCase() !== catF) return false;
    if (mileF && bandOf(t, board.bandOrder).toLowerCase() !== mileF) return false;
    return true;
  });

  ready.sort((a, b) => compareReady(a, b, opts.priorities));
  if (opts.limit === undefined) return ready;
  return ready.slice(0, Math.max(1, Math.floor(opts.limit)));
}
