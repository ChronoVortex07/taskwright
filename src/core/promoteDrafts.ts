/**
 * Bulk draft promotion with reference remap (P4, GAP-3). vscode-free.
 *
 * `writer.promoteDraft` re-ids DRAFT-N → TASK-N but rewrites only the moved file's
 * frontmatter — inbound references to the old DRAFT id are left dangling. This core
 * promotes a set in dependency order (deps first, so prerequisites get lower ids), then
 * delegates to the shared `remapIds` core, which rewrites EVERY inbound reference kind
 * across the live board (tasks + remaining drafts, incl. the just-promoted tasks' own
 * edges): dependencies, bug `caused_by`, `parent_task_id`, `subtasks`, and `references[]`.
 *
 * Consumers (parity): MCP `promote_drafts` (bulk), MCP `promote_draft` (single id →
 * gains remap for free), and the canvas "Promote all proposed" webview message.
 */
import type { BacklogParser } from './BacklogParser';
import type { BacklogWriter } from './BacklogWriter';
import type { TreeFieldService } from './TreeFieldService';
import { remapIds } from './idRemap';

export interface PromoteDraftsDeps {
  parser: BacklogParser;
  writer: BacklogWriter;
  treeFieldService: TreeFieldService;
}

interface PromoteMapping {
  from: string;
  to: string;
}

export interface PromoteDraftsResult {
  /** Old→new id pairs, in promotion (dep-first) order. */
  promoted: PromoteMapping[];
  /** Ids of tasks/drafts whose inbound references were rewired (see idRemap). */
  remapped: string[];
}

/** Thrown when a draft fails to promote mid-set; carries the drafts already moved. */
export class PromoteDraftsError extends Error {
  constructor(
    message: string,
    readonly promoted: PromoteMapping[]
  ) {
    super(message);
    this.name = 'PromoteDraftsError';
  }
}

/** Order the requested drafts so a draft's in-set dependencies precede it (deps → dependents). */
function topoOrder(ids: string[], draftByUpper: Map<string, { dependencies: string[] }>): string[] {
  const inSet = new Set(ids.map((i) => i.trim().toUpperCase()));
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (upper: string) => {
    if (visited.has(upper)) return;
    visited.add(upper);
    for (const dep of draftByUpper.get(upper)?.dependencies ?? []) {
      const d = dep.trim().toUpperCase();
      if (inSet.has(d)) visit(d);
    }
    ordered.push(upper);
  };
  for (const i of ids) visit(i.trim().toUpperCase());
  return ordered; // uppercased, deps-first
}

export async function promoteDrafts(
  deps: PromoteDraftsDeps,
  taskIds: string[]
): Promise<PromoteDraftsResult> {
  if (taskIds.length === 0) return { promoted: [], remapped: [] };

  const drafts = await deps.parser.getDrafts();
  const draftByUpper = new Map(drafts.map((d) => [d.id.trim().toUpperCase(), d]));

  // Validate up front: every requested id must be an existing draft (no partial writes yet).
  for (const id of taskIds) {
    if (!draftByUpper.has(id.trim().toUpperCase())) {
      throw new Error(`Cannot promote ${id}: it is not a draft in backlog/drafts/.`);
    }
  }

  const orderUpper = topoOrder(taskIds, draftByUpper as Map<string, { dependencies: string[] }>);
  const promoted: PromoteMapping[] = [];
  for (const upper of orderUpper) {
    const from = draftByUpper.get(upper)!.id;
    try {
      const to = await deps.writer.promoteDraft(from, deps.parser);
      promoted.push({ from, to });
    } catch (err) {
      const done = promoted.map((p) => `${p.from}→${p.to}`).join(', ') || '(none)';
      throw new PromoteDraftsError(
        `Promoted ${promoted.length} of ${orderUpper.length} drafts (${done}) before failing on ${from}: ${err instanceof Error ? err.message : String(err)}. Dependency references were NOT remapped; rerun promote_drafts on the remaining drafts.`,
        promoted
      );
    }
  }

  // Remap inbound references across the live board. The reload happens inside remapIds, AFTER
  // promotion, so promoted files (now in tasks/) and any remaining drafts are seen with current
  // content.
  //
  // Only drafts whose id actually CHANGED need rewriting. A draft that promotes in place
  // (from === to) has no stale inbound references, so its entry is dropped from the map.
  const oldToNew = new Map(
    promoted
      .filter((p) => p.from.trim().toUpperCase() !== p.to.trim().toUpperCase())
      .map((p) => [p.from.trim().toUpperCase(), p.to])
  );
  const remapped = await remapIds(deps, oldToNew);

  return { promoted, remapped };
}
