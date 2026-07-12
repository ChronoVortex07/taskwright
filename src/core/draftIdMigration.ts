/**
 * Converge a legacy `DRAFT-N` board onto stable task ids (TASK-118). vscode-free.
 *
 * A board written before stable ids (TASK-115) has drafts named `DRAFT-3`, whose id changes the
 * moment they are promoted — the exact instability the feature removes. Rather than leaving such
 * boards on a compat path forever (where the confusion persists until each draft happens to be
 * promoted, dangling every reference written against it), we converge them automatically and
 * idempotently.
 *
 * A migrated draft STAYS A DRAFT. This is a re-id in place, not a promotion — the human, not the
 * migration, decides what gets promoted. `folder === 'drafts'` is, and remains, the sole draftness
 * marker; the id says nothing about draftness.
 *
 * Legacy detection is "the id does not carry the board's configured `task_prefix`", via the ONE
 * shared `idHasPrefix` predicate (TASK-116) that `promoteDraft` also uses. It is never a literal
 * `DRAFT-` match — a board with `task_prefix: STORY` must classify `STORY-4` as its own, not as
 * legacy, and must not churn it.
 *
 * Designed to be run from BOTH extension activation (deferred) and MCP server startup (TASK-119),
 * so an agent-only session converges the same way a UI session does. It is idempotent: a board with
 * no legacy drafts performs ZERO writes.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Task, BacklogConfig } from './types';
import type { IdRemapDeps } from './idRemap';
import { remapIds } from './idRemap';
import { idHasPrefix, isArchivedDraftPath } from './BacklogWriter';

export interface DraftIdMigrationPlan {
  /** Legacy drafts to re-id in place: `drafts/draft-3 - X.md` → `drafts/task-111 - X.md`. */
  renames: Array<{ oldId: string; newId: string; fromPath: string; toPath: string }>;
  /** Legacy archived drafts to relocate from `archive/tasks/` to `archive/drafts/`. */
  relocations: Array<{ id: string; fromPath: string; toPath: string }>;
}

/** Upstream's filename title sanitization (mirrors BacklogWriter's create/promote paths). */
function sanitize(title: string): string {
  return (title || 'Untitled')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50);
}

/**
 * Order legacy drafts so an in-set dependency precedes its dependent, and prerequisites therefore
 * take lower ids. Purely cosmetic (correctness does not depend on it — `remapIds` runs after every
 * file has moved), but it keeps a migrated board's ids reading in the order the work happens.
 *
 * `visited` is marked BEFORE recursing, so a dependency cycle between two legacy drafts terminates
 * instead of overflowing the stack.
 */
function topoOrder(drafts: Task[]): Task[] {
  const byUpper = new Map(drafts.map((d) => [d.id.trim().toUpperCase(), d]));
  const ordered: Task[] = [];
  const visited = new Set<string>();

  const visit = (upper: string): void => {
    if (visited.has(upper)) return;
    visited.add(upper);
    const draft = byUpper.get(upper);
    if (!draft) return;
    for (const dep of draft.dependencies ?? []) {
      const depUpper = dep.trim().toUpperCase();
      if (byUpper.has(depUpper)) visit(depUpper);
    }
    ordered.push(draft);
  };

  for (const draft of drafts) visit(draft.id.trim().toUpperCase());
  return ordered;
}

/**
 * Plan the migration. PURE — no filesystem reads, no writes.
 *
 * `nextId` is the first free task number (from `BacklogWriter.peekNextTaskId`, which scans every
 * folder an id can occupy). Legacy drafts are assigned sequentially from it, dependency-first.
 */
export function planDraftIdMigration(
  drafts: Task[],
  archived: Task[],
  config: BacklogConfig,
  nextId: number,
  backlogPath: string
): DraftIdMigrationPlan {
  const taskPrefix = config.task_prefix || 'TASK';
  const zeroPadding = config.zero_padded_ids || 0;
  const lowerPrefix = taskPrefix.toLowerCase();
  const pad = (n: number) => (zeroPadding > 0 ? String(n).padStart(zeroPadding, '0') : String(n));

  const legacyDrafts = drafts.filter((d) => !idHasPrefix(d.id, taskPrefix));

  let next = nextId;
  const renames = topoOrder(legacyDrafts).map((draft) => {
    const padded = pad(next++);
    return {
      oldId: draft.id,
      newId: `${taskPrefix}-${padded}`.toUpperCase(),
      fromPath: draft.filePath,
      toPath: path.join(
        backlogPath,
        'drafts',
        `${lowerPrefix}-${padded} - ${sanitize(draft.title)}.md`
      ),
    };
  });

  // A legacy archived draft sits in archive/tasks/ — where the old id-prefix-routed archiveTask put
  // it (TASK-117 moved that routing to the folder). The parser flattens both archive subfolders to
  // `folder: 'archive'`, so the PATH is the only record of which side it came from: move it to
  // archive/drafts/ so the folder-routed restore returns it to drafts/, not tasks/.
  //
  // It is NOT re-id'd here: it is not on the board, and if it is ever restored it lands in drafts/
  // as a legacy draft, which the next migration pass converges. Convergence, not a special case.
  const relocations = archived
    .filter((t) => !isArchivedDraftPath(t.filePath))
    .filter((t) => !idHasPrefix(t.id, taskPrefix))
    .map((t) => ({
      id: t.id,
      fromPath: t.filePath,
      toPath: path.join(backlogPath, 'archive', 'drafts', path.basename(t.filePath)),
    }));

  return { renames, relocations };
}

/** Does this plan have anything to do? A false here means the executor must perform ZERO writes. */
export function isLegacyDraftBoard(plan: DraftIdMigrationPlan): boolean {
  return plan.renames.length > 0 || plan.relocations.length > 0;
}

/**
 * Execute the migration. Idempotent: a board with no legacy drafts performs ZERO writes — the plan
 * comes back empty and we return before touching the filesystem.
 *
 * ORDER IS LOAD-BEARING. Every file must be in its final place before `remapIds` runs, because
 * `remapIds` re-reads the board from disk: remapping first would rewrite references to point at ids
 * that do not exist yet, and (worse) would not see the renamed drafts' own inbound edges.
 */
export async function runDraftIdMigration(
  deps: IdRemapDeps,
  backlogPath: string
): Promise<{ migrated: number; mapping: Array<{ from: string; to: string }> }> {
  const [drafts, archived, config] = await Promise.all([
    deps.parser.getDrafts(),
    deps.parser.getArchivedTasks(),
    deps.parser.getConfig(),
  ]);

  const nextId = deps.writer.peekNextTaskId(backlogPath, config.task_prefix || 'TASK');
  const plan = planDraftIdMigration(drafts, archived, config, nextId, backlogPath);
  if (!isLegacyDraftBoard(plan)) {
    return { migrated: 0, mapping: [] };
  }

  // 1. Relocate legacy archived drafts into archive/drafts/.
  for (const relocation of plan.relocations) {
    fs.mkdirSync(path.dirname(relocation.toPath), { recursive: true });
    fs.renameSync(relocation.fromPath, relocation.toPath);
    deps.parser.invalidateTaskCache(relocation.fromPath);
    deps.parser.invalidateTaskCache(relocation.toPath);
  }

  // 2. Re-id each legacy draft in place (drafts/ → drafts/). A RE-ID, NOT a promotion.
  for (const rename of plan.renames) {
    await deps.writer.reidTaskFile(rename.fromPath, rename.toPath, rename.newId, deps.parser);
  }

  // 3. Only now that every file is in its final place: rewrite every inbound reference, through the
  //    shared core — so dependencies, bug caused_by, parent_task_id, subtasks and references[] all
  //    move together, in the migration exactly as in promoteDrafts.
  const oldToNew = new Map(plan.renames.map((r) => [r.oldId.trim().toUpperCase(), r.newId]));
  await remapIds(deps, oldToNew);

  return {
    migrated: plan.renames.length,
    mapping: plan.renames.map((r) => ({ from: r.oldId, to: r.newId })),
  };
}
