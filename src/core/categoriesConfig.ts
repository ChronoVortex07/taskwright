/**
 * Surgical single-line editing of the `categories:` line in config.yml (P4). Mirrors
 * mergeStatusConfig.ts exactly: only a SINGLE-LINE `categories: [...]` array is
 * recognized (Taskwright's own writer always emits single-line) — multi-line YAML
 * arrays are out of scope. All other lines and the file's EOL are preserved.
 */

/** Reserved lane names owned by the layout module; never user categories. */
export const RESERVED_CATEGORIES = ['Bugs', 'Misc', 'Backburner'];

/** Parse the `categories: ["A", "B"]` line; [] when absent. */
export function parseCategoriesLine(configText: string): string[] {
  const m = configText.match(/^categories:\s*\[(.*)\]\s*$/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** True when `name` is a reserved lane (case-insensitive). */
export function isReservedCategory(name: string): boolean {
  return RESERVED_CATEGORIES.some((r) => r.toLowerCase() === name.trim().toLowerCase());
}

/**
 * Append `category` to the single-line `categories:` list, preserving EOL and all other
 * lines. If the line is absent, insert `categories: ["X"]` immediately after the
 * `statuses:` line (house configs always have one); if that too is absent, append at EOF.
 * Rendering matches mergeStatusConfig.rewriteStatusesLine (double-quoted entries), which
 * is what config.yml already uses for statuses.
 */
export function addCategoryLine(configText: string, category: string): string {
  const eol = configText.includes('\r\n') ? '\r\n' : '\n';
  const esc = (s: string) => s.replace(/"/g, '\\"');
  const next = [...parseCategoriesLine(configText), category];
  const rendered = `categories: [${next.map((c) => `"${esc(c)}"`).join(', ')}]`;
  const lines = configText.split(/\r?\n/);

  const idx = lines.findIndex((l) => /^categories:\s*\[/.test(l));
  if (idx !== -1) {
    lines[idx] = rendered;
    return lines.join(eol);
  }
  const statusIdx = lines.findIndex((l) => /^statuses:\s*\[/.test(l));
  if (statusIdx !== -1) {
    lines.splice(statusIdx + 1, 0, rendered);
    return lines.join(eol);
  }
  const body = lines.join(eol);
  return body.endsWith(eol) ? `${body}${rendered}${eol}` : `${body}${eol}${rendered}`;
}
