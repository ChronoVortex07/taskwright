/**
 * Tree find (not filter) — locate tasks on the canvas by id/title/description and walk
 * them in reading order. vscode-free and pure so it can be unit-tested without a webview.
 *
 * The match predicate is deliberately IDENTICAL to the List tab's search
 * (ListView.svelte) — search behaving the same on every tab is the parity property this
 * feature exists to deliver.
 *
 * Results are ordered SPATIALLY (band/x, then lane/y), not by array order, so Enter walks
 * the tree left-to-right, top-to-bottom the way a human reads it.
 */
import type { Task } from './types';
import type { TreeGeometry } from './treeGeometry';

/** Does this task match the query? Case-insensitive substring over id, title, description. */
function matches(task: Task, lowerQuery: string): boolean {
  return (
    task.id.toLowerCase().includes(lowerQuery) ||
    task.title.toLowerCase().includes(lowerQuery) ||
    (task.description ?? '').toLowerCase().includes(lowerQuery)
  );
}

/**
 * Matching task ids, ordered by their laid-out position: x (band) first, then y (lane).
 * Tasks absent from `geometry.nodes` are excluded — they cannot be centered on.
 */
export function findMatches(tasks: Task[], query: string, geometry: TreeGeometry): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: Array<{ id: string; x: number; y: number }> = [];
  for (const t of tasks) {
    if (!matches(t, q)) continue;
    const box = geometry.nodes.get(t.id);
    if (!box) continue;
    hits.push({ id: t.id, x: box.x, y: box.y });
  }

  hits.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  return hits.map((h) => h.id);
}

/** Step `current` by `dir`, wrapping at both ends. `total` must be >= 1. */
export function cycleIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0;
  return (current + dir + total) % total;
}
