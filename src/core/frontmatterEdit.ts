/**
 * Surgical, single-field edits to a task file's YAML frontmatter. Taskwright's
 * own fields (claims, plan links) are written this way — only the targeted line
 * changes, so Backlog.md's canonical frontmatter round-trips byte-for-byte
 * instead of being re-serialized through the CLI.
 */

export interface FrontmatterSplit {
  /** Up to and including the opening `---`. */
  before: string[];
  /** The field lines between the fences. */
  fields: string[];
  /** The closing `---` and everything after it. */
  after: string[];
}

/** Split a document into frontmatter parts, or null when it has no block. */
export function splitFrontmatter(content: string): FrontmatterSplit | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { before: lines.slice(0, 1), fields: lines.slice(1, i), after: lines.slice(i) };
    }
  }
  return null;
}

/** Single-quote a value YAML would otherwise mis-parse (spaces, @-prefix, etc.). */
export function quoteValue(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

const fieldKeyRe = (key: string): RegExp => new RegExp(`^${key}:`);

/**
 * Set a scalar field in the frontmatter, replacing it in place when present or
 * appending it after the existing fields. Returns `content` unchanged when it
 * has no frontmatter block.
 */
export function upsertScalarField(content: string, key: string, value: string): string {
  const split = splitFrontmatter(content);
  if (!split) return content;
  const line = `${key}: ${quoteValue(value)}`;
  const re = fieldKeyRe(key);
  const idx = split.fields.findIndex((f) => re.test(f));
  const fields = [...split.fields];
  if (idx >= 0) {
    fields[idx] = line;
  } else {
    fields.push(line);
  }
  return [...split.before, ...fields, ...split.after].join('\n');
}

/**
 * Set the `status` field in place, **unquoted** — Backlog.md serializes status
 * as a plain scalar even when it contains spaces (`status: In Progress`), so
 * quoting it would break the byte-for-byte frontmatter contract. Replaces the
 * existing `status:` line (preserving field order); returns `content` unchanged
 * when there is no frontmatter block or no existing status line.
 */
export function setStatusField(content: string, status: string): string {
  const split = splitFrontmatter(content);
  if (!split) return content;
  const re = fieldKeyRe('status');
  const idx = split.fields.findIndex((f) => re.test(f));
  if (idx < 0) return content;
  const fields = [...split.fields];
  fields[idx] = `status: ${status}`;
  return [...split.before, ...fields, ...split.after].join('\n');
}

/**
 * Remove a field from the frontmatter. Idempotent: returns the exact input
 * string when the field (or frontmatter) is absent.
 */
export function removeField(content: string, key: string): string {
  const split = splitFrontmatter(content);
  if (!split) return content;
  const re = fieldKeyRe(key);
  const fields = split.fields.filter((f) => !re.test(f));
  if (fields.length === split.fields.length) return content;
  return [...split.before, ...fields, ...split.after].join('\n');
}
