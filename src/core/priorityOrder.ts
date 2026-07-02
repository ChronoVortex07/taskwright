/**
 * Config-driven priority ordering for the tech tree (P1 §10 amendment). Priority
 * is a user-defined, highest-first ordered list sourced from config `priorities`
 * (falling back to the legacy high/medium/low). Bug severity reuses this list.
 * All comparisons are case-insensitive; an unknown or absent priority sorts last.
 */
export const DEFAULT_PRIORITIES: readonly string[] = ['high', 'medium', 'low'];

/** The effective, highest-first priority list: config `priorities` (trimmed, blanks dropped) or the default. */
export function resolvePriorities(config: { priorities?: string[] }): string[] {
  const configured = (config.priorities ?? []).map((p) => String(p).trim()).filter(Boolean);
  return configured.length > 0 ? configured : [...DEFAULT_PRIORITIES];
}

/** Case-insensitive index of `value` in `priorities`; `priorities.length` (sorts last) when unknown/absent. */
export function priorityRank(value: string | undefined, priorities: string[]): number {
  if (!value) return priorities.length;
  const lower = value.trim().toLowerCase();
  const idx = priorities.findIndex((p) => p.toLowerCase() === lower);
  return idx === -1 ? priorities.length : idx;
}

/** Comparator: lower rank (higher priority) first; unknown/absent last; ties equal. */
export function comparePriority(
  a: string | undefined,
  b: string | undefined,
  priorities: string[]
): number {
  return priorityRank(a, priorities) - priorityRank(b, priorities);
}
