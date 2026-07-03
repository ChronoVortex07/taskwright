import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import { parseCategoriesLine, isReservedCategory, addCategoryLine } from '../../core/categoriesConfig';

const CONFIG = 'project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n';

describe('parseCategoriesLine', () => {
  it('parses a single-line categories array', () => {
    expect(parseCategoriesLine('categories: ["Features", "Platform"]\n')).toEqual(['Features', 'Platform']);
  });
  it('returns [] when absent', () => {
    expect(parseCategoriesLine(CONFIG)).toEqual([]);
  });
  // M3: a comma inside a quoted entry must not be split into two categories.
  it('does not mis-split a comma-bearing quoted category', () => {
    expect(parseCategoriesLine('categories: ["A, B"]\n')).toEqual(['A, B']);
  });
});

describe('isReservedCategory', () => {
  it('rejects the reserved lane names case-insensitively', () => {
    for (const r of ['Bugs', 'misc', 'BACKBURNER']) expect(isReservedCategory(r)).toBe(true);
    expect(isReservedCategory('Features')).toBe(false);
  });
});

describe('addCategoryLine', () => {
  it('appends to an existing categories line, preserving other lines + EOL', () => {
    const src = 'statuses: ["To Do"]\ncategories: ["Features"]\ntask_prefix: "task"\n';
    const out = addCategoryLine(src, 'Platform');
    expect(parseCategoriesLine(out)).toEqual(['Features', 'Platform']);
    expect(out).toContain('task_prefix: "task"');
  });
  it('inserts a categories line after statuses when absent', () => {
    const out = addCategoryLine(CONFIG, 'Features');
    const lines = out.split('\n');
    const sIdx = lines.findIndex((l) => l.startsWith('statuses:'));
    expect(lines[sIdx + 1]).toBe('categories: ["Features"]');
    expect(out).toContain('default_status: "To Do"'); // untouched
  });
  it('preserves CRLF', () => {
    const crlf = CONFIG.replace(/\n/g, '\r\n');
    const out = addCategoryLine(crlf, 'Features');
    expect(out).toContain('\r\n');
    expect(out).not.toMatch(/[^\r]\n/); // no bare LF introduced
  });
  it('appends at EOF when there is no statuses line', () => {
    const src = 'project_name: "t"\n';
    const out = addCategoryLine(src, 'Features');
    expect(parseCategoriesLine(out)).toEqual(['Features']);
  });
  it('throws on a block-sequence categories: form instead of inserting a duplicate key', () => {
    const src =
      'statuses: ["To Do"]\ncategories:\n  - Features\n  - Platform\ntask_prefix: "task"\n';
    expect(() => addCategoryLine(src, 'Data')).toThrow(/multi-line|block/i);
  });
  it('throws on a categories: line whose array does not close on the same line', () => {
    const src = 'statuses: ["To Do"]\ncategories: ["Features",\n  "Platform"]\n';
    expect(() => addCategoryLine(src, 'Data')).toThrow(/multi-line|block/i);
  });
  // M1: a backslash in the name must be escaped so the rendered line is valid YAML
  // that js-yaml round-trips back to the exact original name (else getConfig() ⇒ {}).
  it('escapes backslashes so the rendered line round-trips through js-yaml (M1)', () => {
    for (const name of ['some\\module', 'foo\\']) {
      const out = addCategoryLine(CONFIG, name);
      const line = out.split(/\r?\n/).find((l) => l.startsWith('categories:'))!;
      const loaded = yaml.load(line) as { categories: string[] };
      expect(loaded.categories).toEqual([name]);
      // and our own parser must recover it too
      expect(parseCategoriesLine(out)).toEqual([name]);
    }
  });
  // M3: re-reading a stored comma-bearing category and appending a new one must not
  // corrupt the existing entry into two categories.
  it('preserves a comma-bearing category across a subsequent addCategoryLine (M3)', () => {
    const src = 'statuses: ["To Do"]\ncategories: ["A, B"]\ntask_prefix: "task"\n';
    const out = addCategoryLine(src, 'C');
    expect(parseCategoriesLine(out)).toEqual(['A, B', 'C']);
  });
});
