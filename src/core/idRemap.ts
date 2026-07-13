/**
 * Rewrite every inbound reference to a set of renamed task ids. vscode-free.
 *
 * Extracted from promoteDrafts' remap pass, which only ever rewrote `dependencies` and
 * bug `caused_by` — leaving `parent_task_id`, `subtasks`, and `references[]` to dangle
 * silently. Both promoteDrafts (legacy re-id) and the draft-id migration use this one
 * core, so those gaps close in both places at once.
 *
 * Ids are compared as WHOLE, uppercased ids — never as substrings. A substring rewrite
 * would corrupt TASK-11 while remapping TASK-1.
 */
import type { BacklogParser } from './BacklogParser';
import type { BacklogWriter } from './BacklogWriter';
import type { TreeFieldService } from './TreeFieldService';
import type { Task } from './types';

export interface IdRemapDeps {
  parser: BacklogParser;
  writer: BacklogWriter;
  treeFieldService: TreeFieldService;
}

/** Map a single id through the rename map, or return undefined when it is not renamed. */
function mapped(id: string, oldToNew: Map<string, string>): string | undefined {
  return oldToNew.get(id.trim().toUpperCase());
}

/** Rewrite a list of ids; returns undefined when no entry changed (so we skip the write). */
function mapList(ids: string[], oldToNew: Map<string, string>): string[] | undefined {
  let changed = false;
  const next = ids.map((id) => {
    const to = mapped(id, oldToNew);
    if (to === undefined) return id;
    changed = true;
    return to;
  });
  return changed ? next : undefined;
}

/**
 * Rewrite dependencies / caused_by / parent_task_id / subtasks / references across EVERY folder
 * a task id can occupy — tasks, drafts, completed, and both archive subfolders. Returns the ids
 * of every task actually rewritten.
 *
 * WHY THE SCAN IS THIS WIDE (TASK-121). It used to cover only `tasks/` + `drafts/` — the live
 * board — so an inbound reference held by a COMPLETED or ARCHIVED task was silently left
 * pointing at an id that no longer existed. Both are real, restorable records, not tombstones:
 * archiving is a documented SOFT delete (`restoreArchivedTask` puts the task back on the live
 * board), and a completed task's `dependencies` are the record of what it was actually blocked
 * on. A reference the remap cannot see is a reference that dangles forever — precisely the
 * silent breakage this milestone exists to end, so a rename must reach every holder of it.
 *
 * Iterating all five folders is safe by construction: since TASK-114 the id allocator scans
 * every one of them, so an id identifies exactly one file board-wide and `parser.getTask` (which
 * `updateTask`/`setCausedBy` resolve through) cannot land on the wrong one.
 *
 * `oldToNew` keys must be uppercased ids. The board is re-read here, so callers must have
 * finished their file moves first.
 */
export async function remapIds(
  deps: IdRemapDeps,
  oldToNew: Map<string, string>
): Promise<string[]> {
  if (oldToNew.size === 0) return [];

  const [tasks, drafts, completed, archived] = await Promise.all([
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
    deps.parser.getCompletedTasks(),
    deps.parser.getArchivedTasks(),
  ]);
  const remapped: string[] = [];

  for (const t of [...tasks, ...drafts, ...completed, ...archived]) {
    const updates: Partial<Task> = {};

    const nextDeps = mapList(t.dependencies ?? [], oldToNew);
    if (nextDeps) updates.dependencies = nextDeps;

    if (t.parentTaskId) {
      const to = mapped(t.parentTaskId, oldToNew);
      if (to) updates.parentTaskId = to;
    }

    if (t.subtasks?.length) {
      const nextSubs = mapList(t.subtasks, oldToNew);
      if (nextSubs) updates.subtasks = nextSubs;
    }

    // references[] legitimately holds non-id values (paths, URLs); mapList leaves them alone.
    if (t.references?.length) {
      const nextRefs = mapList(t.references, oldToNew);
      if (nextRefs) updates.references = nextRefs;
    }

    let changed = false;
    if (Object.keys(updates).length > 0) {
      await deps.writer.updateTask(t.id, updates, deps.parser);
      changed = true;
    }

    // causedBy is a Taskwright tree field, written surgically — not via updateTask.
    if (t.type === 'bug' && t.causedBy) {
      const to = mapped(t.causedBy, oldToNew);
      if (to) {
        await deps.treeFieldService.setCausedBy(t.id, to, deps.parser);
        changed = true;
      }
    }

    if (changed) remapped.push(t.id);
  }

  return remapped;
}
