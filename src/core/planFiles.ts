/**
 * Conflict-avoidance helpers for parallel orchestration.
 *
 * When `/orchestrate-board` runs a batch of ready tasks in parallel, two tasks that edit the
 * SAME files produce a merge conflict when their branches integrate. `next_ready_tasks` already
 * guarantees the batch is DEPENDENCY-independent, but that says nothing about file overlap — two
 * unrelated tasks can still touch `src/mcp/handlers.ts`. These pure helpers let the orchestrator
 * AVOID co-scheduling file-overlapping tasks; any conflict that still slips through (e.g. a task
 * whose plan under-declares its footprint) remains the dispatched agent's to resolve during
 * `request_merge`'s rebase.
 */

/**
 * Extract the file footprint a plan declares in its "## File Structure" section.
 *
 * The house plan format lists Create/Modify/Test paths as backtick-wrapped bullets under a
 * `## File Structure` heading, e.g. `` - Modify: `src/mcp/handlers.ts:123-145` — … ``. We collect
 * every backtick token under that heading that looks like a repo path, stripping a trailing
 * line-range suffix (`:123` / `:123-145`) and normalizing separators to `/`.
 *
 * Returns a de-duplicated path list. An empty list means the plan declares no files (still a
 * KNOWN footprint); a task with no plan at all is UNKNOWN — that distinction is the caller's to
 * make (an absent map entry in {@link selectDisjointBatch}).
 */
export function extractPlanFiles(planMarkdown: string): string[] {
  const files = new Set<string>();
  let inSection = false;
  for (const raw of planMarkdown.split(/\r?\n/)) {
    const heading = raw.match(/^\s{0,3}#{1,6}\s+(.*\S)\s*$/);
    if (heading) {
      inSection = /^file structure\b/i.test(heading[1].trim());
      continue;
    }
    if (!inSection) continue;
    const spans = raw.match(/`([^`]+)`/g);
    if (!spans) continue;
    for (const span of spans) {
      let p = span.slice(1, -1).trim();
      p = p.replace(/:\d+(?:-\d+)?$/, ''); // strip a trailing :123 or :123-145 line range
      p = p.replace(/\\/g, '/').replace(/\/+$/, ''); // normalize separators, drop trailing slash
      // Heuristic: a repo path has a slash or a file extension; skip bare prose tokens like `foo()`.
      if (/\//.test(p) || /\.[A-Za-z0-9]+$/.test(p)) files.add(p);
    }
  }
  return [...files];
}

/**
 * Greedily select a batch of ready tasks that is SAFE to run in parallel: every member has a
 * KNOWN file footprint and the footprints are pairwise disjoint, so their branches won't collide
 * at merge time.
 *
 * `orderedIds` is the priority-ordered ready set. `filesById` maps a task id to its declared
 * footprint; an ABSENT entry means an UNKNOWN footprint (no plan / unreadable plan). Because an
 * unknown footprint can't be proven disjoint, such a task is only ever returned as a SOLO batch
 * (never co-scheduled with others); a known task whose footprint overlaps the batch is deferred to
 * a later round (freed once the blocking task merges). The batch is capped at `cap` (clamped to
 * >= 1). Selection preserves priority order.
 */
export function selectDisjointBatch(
  orderedIds: string[],
  filesById: Map<string, string[]>,
  cap: number
): string[] {
  const limit = Math.max(1, Math.floor(cap));
  const batch: string[] = [];
  const used = new Set<string>();
  for (const id of orderedIds) {
    if (batch.length >= limit) break;
    const files = filesById.get(id);
    if (files === undefined) {
      // Unknown footprint: allowed only as the sole member of the batch. If the batch is already
      // forming with known-footprint tasks, defer this one (it runs solo in a later round).
      if (batch.length === 0) {
        batch.push(id);
        break;
      }
      continue;
    }
    if (files.some((f) => used.has(f))) continue; // overlaps the batch → defer
    batch.push(id);
    for (const f of files) used.add(f);
  }
  return batch;
}
