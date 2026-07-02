import type { Task } from './types';

/**
 * The shared "done" status convention: the last configured status, falling back
 * to 'Done'. Every dependency-gate consumer resolves done-ness through this one
 * helper so the gate can never drift from the board's terminal column.
 */
export function resolveDoneStatus(statuses: string[] | undefined): string {
  return statuses && statuses.length > 0 ? statuses[statuses.length - 1] : 'Done';
}

/**
 * A dependency is satisfied when it exists and is either at the done status or
 * lives in the completed/archive folder. A missing dependency (undefined) is
 * never satisfied — it counts as blocking.
 */
export function dependencySatisfied(
  dep: Pick<Task, 'status' | 'folder'> | undefined,
  doneStatus: string
): boolean {
  if (!dep) return false;
  if (dep.folder === 'completed' || dep.folder === 'archive') return true;
  return dep.status === doneStatus;
}

/** Uppercase-normalized IDs of the dependencies currently blocking `task` (missing deps included). */
export function computeBlockedBy(
  task: Pick<Task, 'dependencies'>,
  tasksById: Map<string, Task>,
  doneStatus: string
): string[] {
  const blocked: string[] = [];
  for (const rawId of task.dependencies) {
    const id = rawId.trim().toUpperCase();
    if (!id) continue;
    const dep = tasksById.get(id);
    if (!dependencySatisfied(dep, doneStatus)) blocked.push(id);
  }
  return blocked;
}

/** A task is locked iff at least one dependency is blocking. */
export function isLocked(
  task: Pick<Task, 'dependencies'>,
  tasksById: Map<string, Task>,
  doneStatus: string
): boolean {
  return computeBlockedBy(task, tasksById, doneStatus).length > 0;
}

/**
 * Would adding `toId` to `fromId`'s dependencies create a cycle? True for a self
 * edge, or when `toId` can already reach `fromId` by following dependency edges.
 * IDs are compared case-insensitively (the parser uppercases task IDs).
 */
export function wouldCreateCycle(
  tasks: Pick<Task, 'id' | 'dependencies'>[],
  fromId: string,
  toId: string
): boolean {
  const from = fromId.trim().toUpperCase();
  const to = toId.trim().toUpperCase();
  if (from === to) return true;

  const deps = new Map<string, string[]>();
  for (const t of tasks) {
    deps.set(
      t.id.trim().toUpperCase(),
      t.dependencies.map((d) => d.trim().toUpperCase())
    );
  }

  // Does `to` reach `from` via dependency edges? If so, from -> to closes a cycle.
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === from) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of deps.get(node) ?? []) stack.push(next);
  }
  return false;
}

/** Human-readable refusal string for a locked task. */
export function blockedByMessage(taskId: string, blockedBy: string[]): string {
  return `${taskId} is blocked by ${blockedBy.join(', ')} — finish or unblock those first.`;
}
