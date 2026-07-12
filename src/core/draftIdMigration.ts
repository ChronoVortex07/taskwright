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
import { acquireSyncLock } from './autoSync';

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

/** The migration's lock namespace inside the board's existing `.locks/` dir. */
export const DRAFT_ID_MIGRATION_LOCK = 'draft-id-migration.lock';

/**
 * The user-facing text for a completed migration. It NAMES the ids (`DRAFT-3 → TASK-111`) rather
 * than reporting a bare count: a draft's id just changed under the user, and any reference they
 * wrote by hand — in a spec, a commit message, a chat — needs the new one. Truncated past `max` so
 * a large migration still yields a readable notification. Empty mapping ⇒ empty string: the caller
 * says NOTHING when nothing migrated.
 */
export function formatMigrationMessage(
  mapping: Array<{ from: string; to: string }>,
  max = 6
): string {
  if (mapping.length === 0) return '';
  const shown = mapping.slice(0, max).map((m) => `${m.from} → ${m.to}`);
  const rest = mapping.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ');
  return `Taskwright migrated ${mapping.length} draft${mapping.length === 1 ? '' : 's'} to stable task IDs — a draft's ID no longer changes when it is promoted: ${list}`;
}

export interface DraftIdMigrationResult {
  migrated: number;
  mapping: Array<{ from: string; to: string }>;
  /** Set when a peer process held the lock for the whole wait window. */
  skipped?: 'locked';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take the board's migration lock, waiting up to `waitMs` for a peer to finish. Returns the release
 * fn, or null if the window expired while another process still held it.
 */
async function acquireMigrationLock(
  locksDir: string,
  opts: { waitMs: number; pollMs: number; staleMs: number }
): Promise<(() => void) | null> {
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    fs.mkdirSync(locksDir, { recursive: true });
    const release = acquireSyncLock(locksDir, opts.staleMs, DRAFT_ID_MIGRATION_LOCK);
    if (release) return release;
    if (Date.now() >= deadline) return null;
    await sleep(opts.pollMs);
  }
}

/**
 * Run the migration under a cross-process lock. **This is the entry point every automatic
 * caller must use** — extension activation, MCP server startup, and the board-doctor repair
 * (TASK-119). `runDraftIdMigration` itself is deliberately lock-free so it stays a pure,
 * directly-testable core; calling it unguarded from a real process is the bug this prevents.
 *
 * WHY THE LOCK IS LOAD-BEARING: `peekNextTaskId` is lock-free by design (TASK-118), and an
 * extension host and an MCP server routinely start SIMULTANEOUSLY against one board. Unguarded,
 * both scan the same `nextId`, both plan `DRAFT-3 → TASK-111`, and the second re-ids a file the
 * first already moved — a lost draft, a colliding id, or a dangling reference. The critical
 * section therefore spans plan AND execute: a lock around the writes alone would still let two
 * processes plan against the same stale `nextId`.
 *
 * The lock lives in the board's own `backlog/.locks/` (already the id-allocator's transient lock
 * home — excluded from `BOARD_SUBDIRS`, never committed). Keying it on `backlogPath` is what makes
 * it work across processes: every process resolves the ONE physical board to the same path, so two
 * of them always contend for the same lock, from any worktree.
 *
 * Contention is a bounded WAIT, not an instant skip: the loser waits for the winner, then runs an
 * idempotent second pass that finds a converged board and reports `migrated: 0` honestly. Only if
 * the window expires does it return `skipped: 'locked'` — the board still converges, on the next
 * activation or from the doctor's `legacy-draft-ids` finding. It never blocks a board write.
 *
 * Throws only what the migration throws; the lock is always released (`finally`), so a crashed
 * migration cannot wedge the board — a stale lock is additionally stolen after `staleMs`.
 */
export async function runDraftIdMigrationLocked(
  deps: IdRemapDeps,
  backlogPath: string,
  opts: { waitMs?: number; staleMs?: number; pollMs?: number } = {}
): Promise<DraftIdMigrationResult> {
  const locksDir = path.join(backlogPath, '.locks');
  const release = await acquireMigrationLock(locksDir, {
    waitMs: opts.waitMs ?? 15_000,
    pollMs: opts.pollMs ?? 25,
    staleMs: opts.staleMs ?? 60_000,
  });
  if (!release) return { migrated: 0, mapping: [], skipped: 'locked' };

  try {
    // A peer may have migrated while we waited; our caches predate that. Re-read from disk so the
    // second pass plans against the CONVERGED board (and correctly finds nothing to do) rather
    // than replaying a stale plan.
    deps.parser.invalidateTaskCache();
    return await runDraftIdMigration(deps, backlogPath);
  } finally {
    release();
  }
}
