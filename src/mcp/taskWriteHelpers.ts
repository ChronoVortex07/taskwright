/**
 * Pure input-shaping and validation for the Taskwright MCP write tools. No fs,
 * no MCP types — just transforms an agent's arguments into the shapes
 * `BacklogWriter` expects, and rejects obviously-invalid values early.
 */

/** A single acceptance-criteria / definition-of-done item from a tool call. */
export interface ChecklistInput {
  text: string;
  checked?: boolean;
}

/**
 * Render checklist items into Backlog.md's canonical body format
 * (`- [ ] #N text`, 1-based). The result is the content placed between the
 * AC/DOD markers by `BacklogWriter.updateTask`.
 */
export function renderChecklist(items: ChecklistInput[]): string {
  return items
    .map((item, i) => `- [${item.checked ? 'x' : ' '}] #${i + 1} ${item.text.trim()}`)
    .join('\n');
}

/** Throw unless `status` matches one of the board's configured statuses (case-insensitive). */
export function assertValidStatus(status: string, allowed: string[]): void {
  if (!allowed.some((s) => s.toLowerCase() === status.toLowerCase())) {
    throw new Error(
      `Invalid status "${status}". Allowed: ${allowed.join(', ') || '(none configured)'}.`
    );
  }
}

/** Throw unless `priority` is one of high/medium/low. */
export function assertValidPriority(priority: string): void {
  if (priority !== 'high' && priority !== 'medium' && priority !== 'low') {
    throw new Error(`Invalid priority "${priority}". Allowed: high, medium, low.`);
  }
}
