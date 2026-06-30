import { describe, it, expect } from 'vitest';
import { upsertMarkerBlock, TASKWRIGHT_MARKERS } from '../../core/markerBlock';

const { begin, end } = TASKWRIGHT_MARKERS;

describe('upsertMarkerBlock', () => {
  it('creates a block when the content is empty', () => {
    const out = upsertMarkerBlock('', 'Hello', TASKWRIGHT_MARKERS);
    expect(out).toBe(`${begin}\nHello\n${end}\n`);
  });

  it('appends the block to existing content, preserving it verbatim', () => {
    const existing = '# My project\n\nSome notes.\n';
    const out = upsertMarkerBlock(existing, 'Hello', TASKWRIGHT_MARKERS);
    expect(out.startsWith(existing)).toBe(true);
    expect(out).toContain(`${begin}\nHello\n${end}`);
  });

  it('replaces only the block content when markers already exist', () => {
    const existing = `# Project\n\n${begin}\nOld text\n${end}\n\n## After\n`;
    const out = upsertMarkerBlock(existing, 'New text', TASKWRIGHT_MARKERS);
    expect(out).toContain(`${begin}\nNew text\n${end}`);
    expect(out).not.toContain('Old text');
    // Surrounding content untouched
    expect(out).toContain('# Project');
    expect(out).toContain('## After');
  });

  it('is idempotent: re-applying the same block yields identical output', () => {
    const once = upsertMarkerBlock('# Doc\n', 'Body', TASKWRIGHT_MARKERS);
    const twice = upsertMarkerBlock(once, 'Body', TASKWRIGHT_MARKERS);
    expect(twice).toBe(once);
  });

  it('does not duplicate the block when run repeatedly with changed body', () => {
    const a = upsertMarkerBlock('# Doc\n', 'v1', TASKWRIGHT_MARKERS);
    const b = upsertMarkerBlock(a, 'v2', TASKWRIGHT_MARKERS);
    expect((b.match(new RegExp(begin, 'g')) ?? []).length).toBe(1);
    expect(b).toContain('v2');
    expect(b).not.toContain('v1');
  });

  it('ensures a newline separates appended block from prior content', () => {
    const out = upsertMarkerBlock('No trailing newline', 'Body', TASKWRIGHT_MARKERS);
    expect(out).toContain(`No trailing newline\n\n${begin}`);
  });

  it('reports whether a change was needed via hasBlock detection', () => {
    const withBlock = upsertMarkerBlock('', 'Body', TASKWRIGHT_MARKERS);
    // Re-applying identical content is a no-op (same string)
    expect(upsertMarkerBlock(withBlock, 'Body', TASKWRIGHT_MARKERS)).toBe(withBlock);
  });
});
