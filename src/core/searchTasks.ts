/**
 * Pure keyword ranker for the tech-tree `search_tasks` MCP tool (P4). Baseline is
 * substring keyword matching (no embeddings — semantic search is a flagged later
 * enhancement). Case-insensitive; a task is included only when EVERY query token
 * matches at least one field. Per-token score sums the weights of the fields it
 * appears in (title 3, labels/category 2, description 1); the task score is the sum
 * over tokens. Ties break stably by id ascending.
 */
export interface SearchableTask {
  id: string;
  title: string;
  description?: string;
  labels?: string[];
  category?: string;
}

export function searchTasks<T extends SearchableTask>(
  tasks: T[],
  query: string,
  opts: { limit?: number } = {}
): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(
      'A non-empty search query is required (use get_board to list the whole board).'
    );
  }
  const limit = opts.limit ?? 20;
  const scored: Array<{ task: T; score: number }> = [];
  for (const t of tasks) {
    const title = t.title.toLowerCase();
    const labelsCat = [...(t.labels ?? []), t.category ?? ''].join(' ').toLowerCase();
    const desc = (t.description ?? '').toLowerCase();
    let total = 0;
    let allMatch = true;
    for (const tok of tokens) {
      let s = 0;
      if (title.includes(tok)) s += 3;
      if (labelsCat.includes(tok)) s += 2;
      if (desc.includes(tok)) s += 1;
      if (s === 0) {
        allMatch = false;
        break;
      }
      total += s;
    }
    if (allMatch) scored.push({ task: t, score: total });
  }
  scored.sort((a, b) => b.score - a.score || a.task.id.localeCompare(b.task.id));
  return scored.slice(0, limit).map((s) => s.task);
}
