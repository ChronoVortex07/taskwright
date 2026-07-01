import type { MergeMode } from './mergeQueue';
import { INTERMEDIATE_STATUSES, intermediateStatusForMode } from './mergeConfig';

/** Parse the `statuses: ["A", "B", ...]` line from raw config.yml text. */
export function parseStatusesLine(configText: string): string[] {
  const m = configText.match(/^statuses:\s*\[(.*)\]\s*$/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * The canonical statuses list for `mode`: exactly one intermediate status (the
 * mode's), placed immediately before the last (done) status. Any pre-existing
 * intermediate is removed first, so this both inserts (none present) and renames
 * (a different one present) in one pass.
 */
export function desiredStatuses(current: string[], mode: MergeMode): string[] {
  const target = intermediateStatusForMode(mode);
  const withoutIntermediate = current.filter((s) => !INTERMEDIATE_STATUSES.includes(s));
  if (withoutIntermediate.length === 0) return [target];
  const result = [...withoutIntermediate];
  result.splice(result.length - 1, 0, target); // before the done (last) status
  return result;
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
