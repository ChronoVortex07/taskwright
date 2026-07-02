import type { Task } from './types';
import type { BacklogParser } from './BacklogParser';
import { computeBlockedBy, resolveDoneStatus } from './treeGate';
import { deriveTreeLayout, laneOf, BACKBURNER_BAND, type TreeLayout } from './treeLayout';
import { resolvePriorities } from './priorityOrder';

/** Per-task derived tech-tree state (never persisted). */
export interface TreeDerivedState {
  locked: boolean;
  blockedBy: string[];
  bugs: string[];
  activeBugIds: string[];
  layout: TreeLayout;
}

export interface DeriveTreeStateOptions {
  doneStatus: string;
  milestoneOrder: string[];
  priorities: string[];
  categories: string[];
}

/**
 * Pure composition of the gate (locked/blockedBy), the bug backlink
 * (bugs/activeBugIds), and layout for every task in `tasks`. Pass the full
 * universe (active + completed + archived) so a dependency on a done/completed
 * task counts as satisfied and bug backlinks resolve.
 * Map is keyed by normalized (uppercased) task id.
 */
export function deriveTreeState(
  tasks: Task[],
  opts: DeriveTreeStateOptions
): Map<string, TreeDerivedState> {
  const byId = new Map<string, Task>(tasks.map((t) => [t.id.trim().toUpperCase(), t]));
  const { layout } = deriveTreeLayout(tasks, {
    categories: opts.categories,
    milestoneOrder: opts.milestoneOrder,
    doneStatus: opts.doneStatus,
    priorities: opts.priorities,
  });

  const bugsByCause = new Map<string, string[]>();
  const activeByCause = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.type !== 'bug') continue;
    const cause = t.causedBy?.trim().toUpperCase();
    if (!cause) continue;
    (bugsByCause.get(cause) ?? bugsByCause.set(cause, []).get(cause)!).push(t.id);
    const active =
      t.status !== opts.doneStatus && t.folder !== 'completed' && t.folder !== 'archive';
    if (active) (activeByCause.get(cause) ?? activeByCause.set(cause, []).get(cause)!).push(t.id);
  }

  const states = new Map<string, TreeDerivedState>();
  for (const t of tasks) {
    const key = t.id.trim().toUpperCase();
    const blockedBy = computeBlockedBy(t, byId, opts.doneStatus);
    states.set(key, {
      locked: blockedBy.length > 0,
      blockedBy,
      bugs: bugsByCause.get(key) ?? [],
      activeBugIds: activeByCause.get(key) ?? [],
      layout: layout.get(t.id) ?? { lane: laneOf(t), band: BACKBURNER_BAND, depth: 0, subRow: 0 },
    });
  }
  return states;
}

/**
 * The single disk-reading convenience: gather the full task universe and config,
 * then run one `deriveTreeState` pass. Vscode-free (BacklogParser only) so both
 * the MCP handlers and the extension providers can share it.
 */
export async function loadTreeStateFromParser(
  parser: BacklogParser
): Promise<Map<string, TreeDerivedState>> {
  const [tasks, completed, archived, config, milestones, categories] = await Promise.all([
    parser.getTasks(),
    parser.getCompletedTasks(),
    parser.getArchivedTasks(),
    parser.getConfig(),
    parser.getMilestones(),
    parser.getCategories(),
  ]);
  return deriveTreeState([...tasks, ...completed, ...archived], {
    doneStatus: resolveDoneStatus(config.statuses),
    milestoneOrder: milestones.map((m) => m.name),
    priorities: resolvePriorities(config),
    categories,
  });
}
