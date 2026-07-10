import { describe, it, expect } from 'vitest';
import {
  quoteValue,
  removeField,
  setStatusField,
  splitFrontmatter,
  upsertScalarField,
} from '../../core/frontmatterEdit';

const doc = ['---', 'id: TASK-1', 'title: Example', '---', '', '## Description', 'Body.'].join(
  '\n'
);

describe('splitFrontmatter', () => {
  it('returns null when there is no frontmatter block', () => {
    expect(splitFrontmatter('no frontmatter here')).toBeNull();
  });

  it('splits the opening fence, fields, and the rest', () => {
    const split = splitFrontmatter(doc);
    expect(split).not.toBeNull();
    expect(split!.fields).toEqual(['id: TASK-1', 'title: Example']);
    expect(split!.after[0]).toBe('---');
  });
});

describe('quoteValue', () => {
  it('leaves path-safe values unquoted', () => {
    expect(quoteValue('docs/superpowers/plans/2026-06-30-foo.md')).toBe(
      'docs/superpowers/plans/2026-06-30-foo.md'
    );
  });

  it('quotes values with spaces and escapes single quotes', () => {
    expect(quoteValue("a b's")).toBe("'a b''s'");
  });
});

describe('upsertScalarField', () => {
  it('appends the field when it is absent', () => {
    const out = upsertScalarField(doc, 'plan', 'docs/plan.md');
    expect(splitFrontmatter(out)!.fields).toEqual([
      'id: TASK-1',
      'title: Example',
      'plan: docs/plan.md',
    ]);
  });

  it('replaces the value when the field already exists', () => {
    const withPlan = upsertScalarField(doc, 'plan', 'docs/old.md');
    const out = upsertScalarField(withPlan, 'plan', 'docs/new.md');
    const fields = splitFrontmatter(out)!.fields;
    expect(fields.filter((f) => f.startsWith('plan:'))).toEqual(['plan: docs/new.md']);
  });

  it('quotes values that need quoting', () => {
    const out = upsertScalarField(doc, 'plan', 'my plan.md');
    expect(splitFrontmatter(out)!.fields).toContain("plan: 'my plan.md'");
  });

  it('returns content unchanged when there is no frontmatter', () => {
    expect(upsertScalarField('body only', 'plan', 'x.md')).toBe('body only');
  });
});

describe('setStatusField', () => {
  const withStatus = [
    '---',
    'id: TASK-1',
    'status: To Do',
    'title: Example',
    '---',
    '',
    'Body.',
  ].join('\n');

  it('replaces the status value in place, preserving field order', () => {
    const out = setStatusField(withStatus, 'In Progress');
    expect(splitFrontmatter(out)!.fields).toEqual([
      'id: TASK-1',
      'status: In Progress',
      'title: Example',
    ]);
  });

  it('writes multi-word statuses unquoted (Backlog.md byte-for-byte contract)', () => {
    const out = setStatusField(withStatus, 'Pending Review');
    expect(out).toContain('status: Pending Review');
    expect(out).not.toContain("status: 'Pending Review'");
  });

  it('leaves the body and other fields untouched', () => {
    const out = setStatusField(withStatus, 'Done');
    expect(out).toBe(
      ['---', 'id: TASK-1', 'status: Done', 'title: Example', '---', '', 'Body.'].join('\n')
    );
  });

  it('returns content unchanged when there is no status line', () => {
    expect(setStatusField(doc, 'Done')).toBe(doc);
  });

  it('returns content unchanged when there is no frontmatter', () => {
    expect(setStatusField('body only', 'Done')).toBe('body only');
  });
});

describe('removeField', () => {
  it('removes the field line', () => {
    const withPlan = upsertScalarField(doc, 'plan', 'docs/plan.md');
    const out = removeField(withPlan, 'plan');
    expect(splitFrontmatter(out)!.fields).toEqual(['id: TASK-1', 'title: Example']);
  });

  it('is idempotent — unchanged when the field is absent', () => {
    expect(removeField(doc, 'plan')).toBe(doc);
  });
});

describe('folded/multi-line values (TASK-89 continuation safety)', () => {
  // A full BacklogWriter rewrite (js-yaml, lineWidth 80) folds long scalars:
  //   worktree: >-
  //     task-89-very-long-branch-name
  // Surgical removal must take the continuation line(s) with the key.
  const folded = [
    '---',
    'id: TASK-1',
    'title: Example',
    'worktree: >-',
    '  task-89-claim-identity-per-session-claimed-by-idempotent-re-claim-for-the-same',
    'category: Core Board',
    '---',
    '',
    'Body.',
  ].join('\n');

  it('removeField removes a folded value together with its continuation lines', () => {
    const out = removeField(folded, 'worktree');
    expect(splitFrontmatter(out)!.fields).toEqual([
      'id: TASK-1',
      'title: Example',
      'category: Core Board',
    ]);
  });

  it('removeField keeps adjacent keys intact after removing a folded value', () => {
    const out = removeField(folded, 'worktree');
    expect(out).toContain('category: Core Board');
    expect(out).not.toContain('task-89-claim-identity');
  });

  it('upsertScalarField replaces a folded value without leaving a dangling continuation', () => {
    const out = upsertScalarField(folded, 'worktree', 'short-branch');
    expect(splitFrontmatter(out)!.fields).toEqual([
      'id: TASK-1',
      'title: Example',
      'worktree: short-branch',
      'category: Core Board',
    ]);
  });

  it('removeField also handles block-sequence values (list continuations)', () => {
    const withList = [
      '---',
      'id: TASK-1',
      'labels:',
      '  - one',
      '  - two',
      'category: Core Board',
      '---',
      'Body.',
    ].join('\n');
    const out = removeField(withList, 'labels');
    expect(splitFrontmatter(out)!.fields).toEqual(['id: TASK-1', 'category: Core Board']);
  });
});
