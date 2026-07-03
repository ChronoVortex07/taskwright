import { describe, it, expect } from 'vitest';
import { parseCategoriesLine, isReservedCategory, addCategoryLine } from '../../core/categoriesConfig';

const CONFIG = 'project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n';

describe('parseCategoriesLine', () => {
  it('parses a single-line categories array', () => {
    expect(parseCategoriesLine('categories: ["Features", "Platform"]\n')).toEqual(['Features', 'Platform']);
  });
  it('returns [] when absent', () => {
    expect(parseCategoriesLine(CONFIG)).toEqual([]);
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
});
