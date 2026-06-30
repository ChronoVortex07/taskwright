import { describe, it, expect } from 'vitest';
import {
  quoteValue,
  removeField,
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
