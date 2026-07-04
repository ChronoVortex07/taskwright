/**
 * Surgical config.yml editor.
 *
 * Follows the established line-by-line replacement pattern from
 * `mergeStatusConfig.ts` and `categoriesConfig.ts`: match a single key line via
 * regex, replace it in place, preserve EOL style and all other lines byte-for-byte.
 * Never re-serializes the entire YAML document — only the changed keys are touched.
 */

/** Field ordering: the key that each config field naturally follows in config.yml. */
const AFTER_KEY: Record<string, string | undefined> = {
  statuses: 'default_status',
  labels: 'statuses',
  categories: 'statuses',
  milestones: 'labels',
  definition_of_done: 'milestones',
  priorities: 'labels',
  auto_commit: 'definition_of_done',
  check_active_branches: 'auto_commit',
  active_branch_days: 'check_active_branches',
  remote_operations: 'active_branch_days',
  bypass_git_hooks: 'remote_operations',
  default_status: 'project_name',
  zero_padded_ids: 'task_prefix',
};

export interface ConfigEdit {
  statuses?: string[];
  labels?: string[];
  priorities?: string[];
  definition_of_done?: string[];
  default_status?: string;
  auto_commit?: boolean;
  check_active_branches?: boolean;
  active_branch_days?: number;
  remote_operations?: boolean;
  bypass_git_hooks?: boolean;
}

// ── renderValue ──────────────────────────────────────────────

/**
 * Render a value for the right-hand side of `key: <rendered>`.
 * Matches generateConfigYml() output style in initBacklog.ts.
 */
export function renderValue(value: string | number | boolean | string[]): string {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    // All array elements are always double-quoted (matches generateConfigYml in initBacklog.ts)
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `[${value.map((v) => `"${esc(String(v))}"`).join(', ')}]`;
  }
  // String
  return stringValue(value);
}

/** Render a single string value: quoted when it contains spaces or special chars. */
function stringValue(s: string): string {
  // bare when simple alphanumeric with common safe chars
  if (/^[a-zA-Z0-9._\-/:]+$/.test(s)) {
    return s;
  }
  // must be double-quoted (matches generateConfigYml)
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// ── Line-level helpers ────────────────────────────────────────

/** Detect EOL style from text. */
function detectEOL(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Find the line index matching `^key:` (regex-safe).
 * Returns -1 if absent.
 */
function findKeyLine(lines: string[], key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}:`);
  return lines.findIndex((l) => re.test(l));
}

/**
 * Replace or insert a line at `key`. If the key exists, replace the line.
 * If absent, insert after `afterKey`'s line. If afterKey is absent too, append at EOF.
 */
function upsertLine(
  lines: string[],
  key: string,
  rendered: string,
  afterKey?: string
): { lines: string[]; changed: boolean } {
  const idx = findKeyLine(lines, key);
  if (idx !== -1) {
    if (lines[idx] === rendered) return { lines, changed: false };
    const next = [...lines];
    next[idx] = rendered;
    return { lines: next, changed: true };
  }

  // Insert: find anchor
  const anchor = afterKey ? findKeyLine(lines, afterKey) : -1;
  const insertIdx = anchor !== -1 ? anchor + 1 : lines.length;
  const next = [...lines];
  next.splice(insertIdx, 0, rendered);
  return { lines: next, changed: true };
}

// ── rewriteArrayLine ──────────────────────────────────────────

/**
 * Surgical single-line array replacement for `key: [...]`.
 * Only handles single-line flow arrays. Throws on multi-line blocks.
 * `afterKey` overrides the default insertion anchor from AFTER_KEY.
 */
export function rewriteArrayLine(
  text: string,
  key: string,
  values: string[],
  afterKey?: string
): string {
  const eol = detectEOL(text);
  const lines = text.split(/\r?\n/);
  const rendered = `${key}: ${renderValue(values)}`;

  const idx = findKeyLine(lines, key);
  if (idx !== -1) {
    const existing = lines[idx].trim();
    // Refuse multi-line block sequences
    if (
      existing === `${key}:` &&
      idx + 1 < lines.length &&
      lines[idx + 1].trimStart().startsWith('-')
    ) {
      throw new Error(
        `The config has a multi-line \`${key}:\` block; the single-line array form is ` +
          'required for automated edits.'
      );
    }
    // If the existing value spans multiple lines (array not closing on same line), block it too
    if (existing.startsWith(`${key}:`) && !/^[^:]+:\s*\[.*\]\s*$/.test(existing)) {
      throw new Error(
        `The config has a multi-line \`${key}:\` entry; the single-line array form is ` +
          'required for automated edits.'
      );
    }
  }

  const anchor = afterKey ?? AFTER_KEY[key];
  const result = upsertLine(lines, key, rendered, anchor);
  return result.lines.join(eol);
}

// ── rewriteScalarLine ─────────────────────────────────────────

/**
 * Surgical scalar replacement for `key: value`.
 * `afterKey` overrides the default insertion anchor from AFTER_KEY.
 */
export function rewriteScalarLine(
  text: string,
  key: string,
  value: string | boolean | number,
  afterKey?: string
): string {
  const eol = detectEOL(text);
  const lines = text.split(/\r?\n/);
  const rendered = `${key}: ${renderValue(value)}`;
  const anchor = afterKey ?? AFTER_KEY[key];
  const result = upsertLine(lines, key, rendered, anchor);
  return result.lines.join(eol);
}

// ── applyConfigEdits ──────────────────────────────────────────

/**
 * Apply a set of edits to config text. Only changes the keys present in `edits`;
 * all other lines are preserved byte-for-byte.
 */
export function applyConfigEdits(
  text: string,
  edits: ConfigEdit
): { text: string; changed: boolean } {
  let result = text;
  let anyChange = false;

  // Array-valued keys (order matters for insertion chaining)
  const arrayKeys: Array<{ key: string; values: string[] }> = [];
  if (edits.statuses !== undefined) arrayKeys.push({ key: 'statuses', values: edits.statuses });
  if (edits.labels !== undefined) arrayKeys.push({ key: 'labels', values: edits.labels });
  if (edits.priorities !== undefined) arrayKeys.push({ key: 'priorities', values: edits.priorities });
  if (edits.definition_of_done !== undefined)
    arrayKeys.push({ key: 'definition_of_done', values: edits.definition_of_done });

  for (const { key, values } of arrayKeys) {
    const next = rewriteArrayLine(result, key, values);
    if (next !== result) {
      anyChange = true;
      result = next;
    }
  }

  // Scalar keys
  const scalarKeys: Array<{ key: string; value: string | boolean | number }> = [];
  if (edits.default_status !== undefined)
    scalarKeys.push({ key: 'default_status', value: edits.default_status });
  if (edits.auto_commit !== undefined)
    scalarKeys.push({ key: 'auto_commit', value: edits.auto_commit });
  if (edits.check_active_branches !== undefined)
    scalarKeys.push({ key: 'check_active_branches', value: edits.check_active_branches });
  if (edits.active_branch_days !== undefined)
    scalarKeys.push({ key: 'active_branch_days', value: edits.active_branch_days });
  if (edits.remote_operations !== undefined)
    scalarKeys.push({ key: 'remote_operations', value: edits.remote_operations });
  if (edits.bypass_git_hooks !== undefined)
    scalarKeys.push({ key: 'bypass_git_hooks', value: edits.bypass_git_hooks });

  for (const { key, value } of scalarKeys) {
    const next = rewriteScalarLine(result, key, value);
    if (next !== result) {
      anyChange = true;
      result = next;
    }
  }

  return { text: result, changed: anyChange };
}

// ── validateConfigEdits ───────────────────────────────────────

export interface ConfigValidationError {
  field: string;
  message: string;
  blockingTaskIds?: string[];
}

/**
 * Validate config edits against the current config and tasks.
 * Returns { valid, errors } — errors is empty when valid.
 */
export function validateConfigEdits(
  edits: ConfigEdit,
  currentConfig: { statuses?: string[]; default_status?: string },
  tasks: Array<{ id: string; status: string }>
): { valid: boolean; errors: ConfigValidationError[] } {
  const errors: ConfigValidationError[] = [];

  // Only validate statuses if the edit includes them
  if (edits.statuses !== undefined) {
    const newStatuses = edits.statuses;
    const oldStatuses = currentConfig.statuses ?? [];

    if (newStatuses.length < 2) {
      errors.push({
        field: 'statuses',
        message: 'At least 2 statuses are required.',
      });
    }

    // Check if the default_status would still be in the list
    const defaultStatus = edits.default_status ?? currentConfig.default_status;
    if (defaultStatus && !newStatuses.includes(defaultStatus)) {
      errors.push({
        field: 'default_status',
        message: `The default status "${defaultStatus}" must be one of the configured statuses.`,
      });
    }

    // Check for statuses being removed that are still in use.
    // A removed status at index i that is replaced by a new status (not in old set)
    // is a RENAME — allowed with migration. A removed status with no replacement
    // (pure deletion) is BLOCKED if tasks still use it.
    const removedStatuses = oldStatuses.filter((s) => !newStatuses.includes(s));
    const addedStatuses = newStatuses.filter((s) => !oldStatuses.includes(s));

    for (const removed of removedStatuses) {
      const blockingTasks = tasks.filter((t) => t.status === removed);
      if (blockingTasks.length === 0) continue; // no tasks affected, safe to remove

      // Try to detect a rename: removed at position i, replaced by a new status at same position
      const oldIdx = oldStatuses.indexOf(removed);
      const replacement = oldIdx >= 0 && oldIdx < newStatuses.length ? newStatuses[oldIdx] : undefined;
      const isRename = replacement !== undefined && addedStatuses.includes(replacement);

      if (!isRename) {
        errors.push({
          field: 'statuses',
          message: `Cannot remove status "${removed}": used by ${blockingTasks.length} task(s).`,
          blockingTaskIds: blockingTasks.map((t) => t.id),
        });
      }
      // Renames are allowed — the caller handles migration
    }
  }

  return { valid: errors.length === 0, errors };
}
