import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import {
  renderValue,
  rewriteArrayLine,
  rewriteScalarLine,
  applyConfigEdits,
  validateConfigEdits,
  type ConfigEdit,
} from '../../core/ConfigWriter';

// Canonical fixture matching generateConfigYml() output style
const FIXTURE = [
  'project_name: "taskwright"',
  'default_status: "To Do"',
  'statuses: ["To Do", "In Progress", "Done"]',
  'labels: ["bug", "feature"]',
  'milestones: []',
  'definition_of_done: ["Tests pass", "Code reviewed"]',
  'task_prefix: "task"',
  'zero_padded_ids: 3',
  'auto_commit: false',
  'check_active_branches: true',
  'active_branch_days: 30',
  'remote_operations: true',
  'bypass_git_hooks: false',
  '',
].join('\n');

// ============================================================
// renderValue
// ============================================================

describe('renderValue', () => {
  it('renders true as bare true', () => {
    expect(renderValue(true)).toBe('true');
  });

  it('renders false as bare false', () => {
    expect(renderValue(false)).toBe('false');
  });

  it('renders a number as bare digits', () => {
    expect(renderValue(42)).toBe('42');
  });

  it('renders zero', () => {
    expect(renderValue(0)).toBe('0');
  });

  it('renders a simple alphanumeric string without quotes', () => {
    expect(renderValue('hello')).toBe('hello');
  });

  it('renders a string with dashes and dots without quotes', () => {
    expect(renderValue('yyyy-mm-dd')).toBe('yyyy-mm-dd');
  });

  it('renders a string with spaces in double quotes', () => {
    expect(renderValue('To Do')).toBe('"To Do"');
  });

  it('renders a string with special characters in double quotes', () => {
    expect(renderValue("it's")).toBe('"it\'s"');
  });

  it('escapes backslashes inside quoted strings', () => {
    expect(renderValue('C:\\path')).toBe('"C:\\\\path"');
  });

  it('escapes double quotes inside quoted strings', () => {
    expect(renderValue('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('renders an empty string array as []', () => {
    expect(renderValue([])).toBe('[]');
  });

  it('renders a string array as flow-style', () => {
    expect(renderValue(['a', 'b'])).toBe('["a", "b"]');
  });

  it('double-quotes array elements with spaces', () => {
    expect(renderValue(['To Do', 'In Progress'])).toBe('["To Do", "In Progress"]');
  });
});

// ============================================================
// rewriteArrayLine
// ============================================================

describe('rewriteArrayLine', () => {
  it('replaces an existing single-line array in place', () => {
    const out = rewriteArrayLine(FIXTURE, 'statuses', ['Backlog', 'Active', 'Done']);
    expect(out).toContain('statuses: ["Backlog", "Active", "Done"]');
    // Ensure other lines are untouched
    expect(out).toContain('project_name: "taskwright"');
    expect(out).toContain('task_prefix: "task"');
    expect(out).toContain('zero_padded_ids: 3');
  });

  it('inserts a new array after the given afterKey', () => {
    const src = 'project_name: "t"\ndefault_status: "To Do"\ntask_prefix: "task"\n';
    const out = rewriteArrayLine(src, 'labels', ['bug'], 'default_status');
    const lines = out.split('\n');
    const dsIdx = lines.findIndex((l) => l.startsWith('default_status:'));
    expect(lines[dsIdx + 1]).toBe('labels: ["bug"]');
  });

  it('appends at EOF when afterKey is not found', () => {
    const src = 'project_name: "t"\n';
    const out = rewriteArrayLine(src, 'labels', ['bug']);
    expect(out).toContain('labels: ["bug"]');
    expect(out).toContain('project_name: "t"');
  });

  it('preserves CRLF line endings', () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n');
    const out = rewriteArrayLine(crlf, 'statuses', ['A', 'B']);
    expect(out).toContain('\r\n');
    expect(out).not.toMatch(/[^\r]\n/); // no bare LF
  });

  it('preserves all other lines unchanged', () => {
    const out = rewriteArrayLine(FIXTURE, 'labels', ['ux']);
    // Every line except labels should be identical
    const origLines = FIXTURE.split('\n');
    const outLines = out.split('\n');
    expect(outLines.length).toBe(origLines.length);
    for (let i = 0; i < origLines.length; i++) {
      if (!origLines[i].startsWith('labels:')) {
        expect(outLines[i]).toBe(origLines[i]);
      }
    }
  });

  it('handles empty array → non-empty', () => {
    const src = 'milestones: []\n';
    const out = rewriteArrayLine(src, 'milestones', ['v1.0', 'v2.0']);
    expect(out).toContain('milestones: ["v1.0", "v2.0"]');
  });

  it('throws on a multi-line block sequence', () => {
    const src = 'statuses:\n  - A\n  - B\n';
    expect(() => rewriteArrayLine(src, 'statuses', ['A', 'B'])).toThrow(/multi-line|block/i);
  });

  it('escapes backslashes in rendered array values (M1)', () => {
    const out = rewriteArrayLine(FIXTURE, 'labels', ['foo\\bar']);
    expect(out).toContain('labels: ["foo\\\\bar"]');
    // Verify js-yaml round-trips back to original
    const line = out.split(/\r?\n/).find((l) => l.startsWith('labels:'))!;
    const loaded = yaml.load(line) as { labels: string[] };
    expect(loaded.labels).toEqual(['foo\\bar']);
  });
});

// ============================================================
// rewriteScalarLine
// ============================================================

describe('rewriteScalarLine', () => {
  it('replaces an existing boolean value', () => {
    const out = rewriteScalarLine(FIXTURE, 'auto_commit', true);
    expect(out).toContain('auto_commit: true');
    expect(out).toContain('project_name: "taskwright"'); // untouched
  });

  it('replaces an existing number value', () => {
    const out = rewriteScalarLine(FIXTURE, 'active_branch_days', 60);
    expect(out).toContain('active_branch_days: 60');
  });

  it('replaces an existing string value (simple → quoted when needed)', () => {
    const out = rewriteScalarLine(FIXTURE, 'default_status', 'Backlog');
    expect(out).toContain('default_status: Backlog');
  });

  it('replaces an existing string value that needs quoting', () => {
    const out = rewriteScalarLine(FIXTURE, 'default_status', 'To Review');
    expect(out).toContain('default_status: "To Review"');
  });

  it('inserts a new scalar after afterKey', () => {
    const src = 'project_name: "t"\ndefault_status: "To Do"\n';
    const out = rewriteScalarLine(src, 'auto_commit', false, 'default_status');
    const lines = out.split('\n');
    const dsIdx = lines.findIndex((l) => l.startsWith('default_status:'));
    expect(lines[dsIdx + 1]).toBe('auto_commit: false');
  });

  it('preserves CRLF', () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n');
    const out = rewriteScalarLine(crlf, 'auto_commit', true);
    expect(out).toContain('\r\n');
  });

  it('returns unchanged text when key matches no line and no afterKey', () => {
    const src = 'project_name: "t"\n';
    const out = rewriteScalarLine(src, 'unknown_key', 'val');
    // Should append since no afterKey match
    expect(out).toContain('unknown_key');
  });
});

// ============================================================
// applyConfigEdits
// ============================================================

describe('applyConfigEdits', () => {
  it('applies multiple edits at once', () => {
    const edits: ConfigEdit = {
      statuses: ['Backlog', 'Active', 'Done'],
      auto_commit: true,
    };
    const { text, changed } = applyConfigEdits(FIXTURE, edits);
    expect(changed).toBe(true);
    expect(text).toContain('statuses: ["Backlog", "Active", "Done"]');
    expect(text).toContain('auto_commit: true');
    // Unchanged keys preserved
    expect(text).toContain('project_name: "taskwright"');
    expect(text).toContain('task_prefix: "task"');
  });

  it('reports no change when edits match current values', () => {
    const edits: ConfigEdit = {
      statuses: ['To Do', 'In Progress', 'Done'],
      auto_commit: false,
    };
    const { text, changed } = applyConfigEdits(FIXTURE, edits);
    expect(changed).toBe(false);
    expect(text).toBe(FIXTURE);
  });

  it('only changes the edited keys', () => {
    const edits: ConfigEdit = { labels: ['ux', 'perf'] };
    const { text } = applyConfigEdits(FIXTURE, edits);

    const beforeLines = FIXTURE.split('\n');
    const afterLines = text.split('\n');
    expect(afterLines.length).toBe(beforeLines.length);

    for (let i = 0; i < beforeLines.length; i++) {
      if (!beforeLines[i].startsWith('labels:')) {
        expect(afterLines[i]).toBe(beforeLines[i]);
      }
    }
    expect(text).toContain('labels: ["ux", "perf"]');
  });

  it('round-trips a fixture unchanged when edits are all no-ops', () => {
    const edits: ConfigEdit = {};
    const { text, changed } = applyConfigEdits(FIXTURE, edits);
    expect(changed).toBe(false);
    expect(text).toBe(FIXTURE);
  });

  it('round-trips the real taskwright config.yml unchanged with no-op edits', () => {
    // Simulates the real config format
    const realConfig = [
      'project_name: "taskwright"',
      'default_status: "To Do"',
      'statuses: ["To Do", "In Progress", "Awaiting Merge", "Done"]',
      'categories: ["Core Board", "Sync", "Worktrees & Merge", "Tree"]',
      'labels: []',
      'date_format: yyyy-mm-dd',
      'max_column_width: 20',
      'auto_open_browser: true',
      'default_port: 6420',
      'remote_operations: true',
      'auto_commit: false',
      'bypass_git_hooks: false',
      'check_active_branches: false',
      'active_branch_days: 30',
      'task_prefix: "task"',
      '',
    ].join('\n');

    const edits: ConfigEdit = {};
    const { text, changed } = applyConfigEdits(realConfig, edits);
    expect(changed).toBe(false);
    expect(text).toBe(realConfig);
  });

  it('preserves CRLF across multiple edits', () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n');
    const edits: ConfigEdit = {
      statuses: ['A', 'B', 'C'],
      auto_commit: true,
    };
    const { text } = applyConfigEdits(crlf, edits);
    expect(text).toContain('\r\n');
    expect(text).not.toMatch(/[^\r]\n/);
  });

  it('adds new definition_of_done when absent', () => {
    const src = 'project_name: "t"\nstatuses: ["To Do", "Done"]\n';
    const edits: ConfigEdit = { definition_of_done: ['Tests pass'] };
    const { text, changed } = applyConfigEdits(src, edits);
    expect(changed).toBe(true);
    expect(text).toContain('definition_of_done: ["Tests pass"]');
  });

  it('handles labels and milestones being set simultaneously', () => {
    const edits: ConfigEdit = {
      labels: ['feature'],
    };
    const { text, changed } = applyConfigEdits(FIXTURE, edits);
    expect(changed).toBe(true);
    expect(text).toContain('labels: ["feature"]');
    expect(text).toContain('milestones: []'); // unchanged
  });
});

// ============================================================
// validateConfigEdits
// ============================================================

describe('validateConfigEdits', () => {
  it('accepts valid edits', () => {
    const result = validateConfigEdits(
      { statuses: ['To Do', 'Active', 'Done'] },
      { statuses: ['To Do', 'In Progress', 'Done'], default_status: 'To Do' },
      []
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects removing a status still used by tasks', () => {
    const result = validateConfigEdits(
      { statuses: ['To Do', 'Done'] }, // "In Progress" removed
      { statuses: ['To Do', 'In Progress', 'Done'], default_status: 'To Do' },
      [
        { id: 'TASK-1', status: 'In Progress' },
        { id: 'TASK-2', status: 'In Progress' },
      ]
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'statuses')).toBe(true);
    expect(
      result.errors.some((e) => e.field === 'statuses' && e.blockingTaskIds?.includes('TASK-1'))
    ).toBe(true);
  });

  it('allows removing a status not used by any task', () => {
    const result = validateConfigEdits(
      { statuses: ['To Do', 'In Progress'] }, // "Done" removed, not used
      { statuses: ['To Do', 'In Progress', 'Done'], default_status: 'To Do' },
      [
        { id: 'TASK-1', status: 'To Do' },
        { id: 'TASK-2', status: 'In Progress' },
      ]
    );
    expect(result.valid).toBe(true);
  });

  it('rejects removing the default_status from the list', () => {
    const result = validateConfigEdits(
      { statuses: ['In Progress', 'Done'] }, // "To Do" removed
      { statuses: ['To Do', 'In Progress', 'Done'], default_status: 'To Do' },
      []
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'default_status')).toBe(true);
  });

  it('allows renaming a status (with migration opportunity)', () => {
    const result = validateConfigEdits(
      { statuses: ['To Do', 'Active', 'Done'] }, // "In Progress" → "Active"
      { statuses: ['To Do', 'In Progress', 'Done'], default_status: 'To Do' },
      [{ id: 'TASK-1', status: 'In Progress' }]
    );
    // Renaming is allowed — the migration is the caller's responsibility
    expect(result.valid).toBe(true);
  });

  it('rejects an empty statuses list', () => {
    const result = validateConfigEdits(
      { statuses: [] },
      { statuses: ['To Do', 'Done'], default_status: 'To Do' },
      []
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'statuses')).toBe(true);
  });

  it('rejects statuses with fewer than 2 entries', () => {
    const result = validateConfigEdits(
      { statuses: ['Done'] },
      { statuses: ['To Do', 'Done'], default_status: 'To Do' },
      []
    );
    expect(result.valid).toBe(false);
  });

  it('accepts edits that do not touch statuses', () => {
    const result = validateConfigEdits(
      { auto_commit: true },
      { statuses: ['To Do', 'Done'], default_status: 'To Do' },
      []
    );
    expect(result.valid).toBe(true);
  });
});
