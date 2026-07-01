import type { MergeMode } from './mergeQueue';
import { INTERMEDIATE_STATUSES, intermediateStatusForMode } from './mergeConfig';

const DONE_STATUS = 'Done';

/**
 * Parse the `statuses: ["A", "B", ...]` line from raw config.yml text.
 * Only recognizes a SINGLE-LINE `statuses: [...]` array — Taskwright's own
 * writer always emits single-line — so callers must not assume multi-line
 * YAML array syntax is parsed.
 */
export function parseStatusesLine(configText: string): string[] {
  const m = configText.match(/^statuses:\s*\[(.*)\]\s*$/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * The canonical statuses list for `mode`. Renames an existing intermediate
 * status in place (never reordering the user's board); otherwise inserts the
 * mode's intermediate immediately before the terminal "Done" column. A custom
 * board that does not end in "Done" is left untouched — Taskwright must not
 * silently rewrite a status list whose shape it doesn't recognize.
 */
export function desiredStatuses(current: string[], mode: MergeMode): string[] {
  const target = intermediateStatusForMode(mode);
  const existingIdx = current.findIndex((s) => INTERMEDIATE_STATUSES.includes(s));
  if (existingIdx >= 0) {
    if (current[existingIdx] === target) return current;
    const next = [...current];
    next[existingIdx] = target;
    return next;
  }
  // Insertion precondition: only a board ending in the standard "Done" column
  // gets an intermediate auto-inserted; anything else is left as-is.
  if (current.length === 0 || current[current.length - 1] !== DONE_STATUS) {
    return current;
  }
  const next = [...current];
  next.splice(next.length - 1, 0, target); // before the done (last) status
  return next;
}

/** The active intermediate status in a list, or undefined when none. */
export function intermediateStatusOf(statuses: string[]): string | undefined {
  return statuses.find((s) => INTERMEDIATE_STATUSES.includes(s));
}

/** Order-sensitive equality for a statuses list. */
export function statusesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Surgically replace the `statuses:` line, preserving all other lines + EOL. */
export function rewriteStatusesLine(configText: string, statuses: string[]): string {
  const esc = (s: string) => s.replace(/"/g, '\\"');
  const rendered = `statuses: [${statuses.map((s) => `"${esc(s)}"`).join(', ')}]`;
  const eol = configText.includes('\r\n') ? '\r\n' : '\n';
  const lines = configText.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^statuses:\s*\[/.test(l));
  if (idx === -1) return configText;
  lines[idx] = rendered;
  return lines.join(eol);
}

/**
 * Plan the config sync for a mode: the target statuses list, whether it differs
 * from `current`, and (when an existing intermediate is being renamed) the
 * from/to statuses so in-flight tasks can be migrated.
 */
export function planStatusSync(
  current: string[],
  mode: MergeMode
): { statuses: string[]; changed: boolean; migrateFrom?: string; migrateTo?: string } {
  const statuses = desiredStatuses(current, mode);
  const changed = !statusesEqual(current, statuses);
  const from = intermediateStatusOf(current);
  const to = intermediateStatusForMode(mode);
  const rename = from && from !== to ? { migrateFrom: from, migrateTo: to } : {};
  return { statuses, changed, ...rename };
}
