import { describe, it, expect } from 'vitest';
import {
  parseStatusesLine,
  desiredStatuses,
  rewriteStatusesLine,
  intermediateStatusOf,
  statusesEqual,
  planStatusSync,
} from '../../core/mergeStatusConfig';

const CONFIG = `project_name: "taskwright"
default_status: "To Do"
statuses: ["To Do", "In Progress", "Done"]
labels: []
task_prefix: "task"
`;

describe('parseStatusesLine', () => {
  it('parses a quoted statuses array', () => {
    expect(parseStatusesLine(CONFIG)).toEqual(['To Do', 'In Progress', 'Done']);
  });
  it('returns [] when no statuses line', () => {
    expect(parseStatusesLine('project_name: "x"\n')).toEqual([]);
  });
});

describe('desiredStatuses', () => {
  it('inserts the intermediate just before the done (last) status', () => {
    expect(desiredStatuses(['To Do', 'In Progress', 'Done'], 'manual-review')).toEqual([
      'To Do',
      'In Progress',
      'Pending Review',
      'Done',
    ]);
  });
  it('renames a different intermediate in place', () => {
    expect(
      desiredStatuses(['To Do', 'In Progress', 'Pending Review', 'Done'], 'auto-merge')
    ).toEqual(['To Do', 'In Progress', 'Awaiting Merge', 'Done']);
  });
  it('is idempotent when already correct', () => {
    const s = ['To Do', 'In Progress', 'Awaiting PR', 'Done'];
    expect(desiredStatuses(s, 'auto-pr')).toEqual(s);
  });
  it('normalizes a misplaced intermediate to before-done', () => {
    expect(
      desiredStatuses(['To Do', 'Pending Review', 'In Progress', 'Done'], 'manual-review')
    ).toEqual(['To Do', 'In Progress', 'Pending Review', 'Done']);
  });
});

describe('intermediateStatusOf', () => {
  it('finds the active intermediate status', () => {
    expect(intermediateStatusOf(['To Do', 'Awaiting Merge', 'Done'])).toBe('Awaiting Merge');
  });
  it('returns undefined when none present', () => {
    expect(intermediateStatusOf(['To Do', 'In Progress', 'Done'])).toBeUndefined();
  });
});

describe('rewriteStatusesLine', () => {
  it('replaces only the statuses line and preserves the rest', () => {
    const out = rewriteStatusesLine(CONFIG, ['To Do', 'In Progress', 'Pending Review', 'Done']);
    expect(out).toContain('statuses: ["To Do", "In Progress", "Pending Review", "Done"]');
    expect(out).toContain('project_name: "taskwright"');
    expect(out).toContain('task_prefix: "task"');
  });
  it('leaves text unchanged when there is no statuses line', () => {
    const text = 'project_name: "x"\n';
    expect(rewriteStatusesLine(text, ['A', 'B'])).toBe(text);
  });
  it('preserves CRLF line endings', () => {
    const crlf = CONFIG.replace(/\n/g, '\r\n');
    expect(rewriteStatusesLine(crlf, ['To Do', 'Done'])).toContain('\r\n');
  });
});

describe('statusesEqual', () => {
  it('true for same order, false otherwise', () => {
    expect(statusesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(statusesEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(statusesEqual(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('planStatusSync', () => {
  it('reports the change + migration when adding the intermediate', () => {
    const plan = planStatusSync(['To Do', 'In Progress', 'Done'], 'manual-review');
    expect(plan.changed).toBe(true);
    expect(plan.statuses).toEqual(['To Do', 'In Progress', 'Pending Review', 'Done']);
    expect(plan.migrateFrom).toBeUndefined();
    expect(plan.migrateTo).toBeUndefined();
  });
  it('reports a rename migration when the mode changes', () => {
    const plan = planStatusSync(['To Do', 'In Progress', 'Pending Review', 'Done'], 'auto-merge');
    expect(plan.changed).toBe(true);
    expect(plan.migrateFrom).toBe('Pending Review');
    expect(plan.migrateTo).toBe('Awaiting Merge');
  });
  it('reports no change when already correct', () => {
    const plan = planStatusSync(
      ['To Do', 'In Progress', 'Pending Review', 'Done'],
      'manual-review'
    );
    expect(plan.changed).toBe(false);
    expect(plan.migrateFrom).toBeUndefined();
  });
});

describe('planStatusSync — auto-pr from a fresh 3-status board', () => {
  it('inserts Awaiting PR with no rename migration', () => {
    const plan = planStatusSync(['To Do', 'In Progress', 'Done'], 'auto-pr');
    expect(plan.statuses).toEqual(['To Do', 'In Progress', 'Awaiting PR', 'Done']);
    expect(plan.changed).toBe(true);
    expect(plan.migrateFrom).toBeUndefined();
  });
});
