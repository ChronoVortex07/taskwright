import { describe, it, expect } from 'vitest';
import { extractPlanFiles, selectDisjointBatch } from '../../core/planFiles';

const PLAN = `# Some Feature Implementation Plan

**Goal:** do a thing.

## File Structure

**Create:**

- \`src/core/foo.ts\` — the new core.
- \`src/test/unit/foo.test.ts\` — its tests.

**Modify:**

- \`src/mcp/handlers.ts:123-145\` — add the handler.
- \`src/mcp/server.ts:206\` — register it.

**Test:**

- \`e2e/foo.spec.ts\`

---

## Task 1: something

- Modify: \`src/other/notcounted.ts\` — this is under a later heading, must NOT be collected.
`;

describe('extractPlanFiles', () => {
  it('collects backtick paths under the File Structure section, stripping line ranges', () => {
    expect(extractPlanFiles(PLAN).sort()).toEqual(
      [
        'e2e/foo.spec.ts',
        'src/core/foo.ts',
        'src/mcp/handlers.ts',
        'src/mcp/server.ts',
        'src/test/unit/foo.test.ts',
      ].sort()
    );
  });

  it('ignores paths outside the File Structure section', () => {
    expect(extractPlanFiles(PLAN)).not.toContain('src/other/notcounted.ts');
  });

  it('skips backtick tokens that are prose, not paths', () => {
    const md = '## File Structure\n\n- Modify: `src/a.ts` calls `foo()` and `bar`\n';
    expect(extractPlanFiles(md)).toEqual(['src/a.ts']);
  });

  it('returns [] when there is no File Structure section', () => {
    expect(extractPlanFiles('# Plan\n\n## Tasks\n\n- `src/a.ts`\n')).toEqual([]);
  });

  it('handles a matching heading at any level and CRLF line endings', () => {
    const md = '### File Structure\r\n\r\n- `src/a.ts`\r\n- `src/b.ts`\r\n';
    expect(extractPlanFiles(md).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('selectDisjointBatch', () => {
  it('batches pairwise-file-disjoint tasks up to the cap, in priority order', () => {
    const files = new Map<string, string[]>([
      ['TASK-1', ['src/a.ts']],
      ['TASK-2', ['src/b.ts']],
      ['TASK-3', ['src/c.ts']],
    ]);
    expect(selectDisjointBatch(['TASK-1', 'TASK-2', 'TASK-3'], files, 3)).toEqual([
      'TASK-1',
      'TASK-2',
      'TASK-3',
    ]);
    expect(selectDisjointBatch(['TASK-1', 'TASK-2', 'TASK-3'], files, 2)).toEqual([
      'TASK-1',
      'TASK-2',
    ]);
  });

  it('defers a task whose footprint overlaps the batch (keeps the higher-priority one)', () => {
    const files = new Map<string, string[]>([
      ['TASK-1', ['src/shared.ts']],
      ['TASK-2', ['src/shared.ts', 'src/b.ts']], // overlaps TASK-1 → deferred
      ['TASK-3', ['src/c.ts']], // disjoint → included
    ]);
    expect(selectDisjointBatch(['TASK-1', 'TASK-2', 'TASK-3'], files, 3)).toEqual([
      'TASK-1',
      'TASK-3',
    ]);
  });

  it('returns an unknown-footprint task as a SOLO batch when it is first', () => {
    const files = new Map<string, string[]>([['TASK-2', ['src/b.ts']]]); // TASK-1 unknown
    expect(selectDisjointBatch(['TASK-1', 'TASK-2'], files, 3)).toEqual(['TASK-1']);
  });

  it('never co-schedules an unknown-footprint task behind a forming known batch', () => {
    const files = new Map<string, string[]>([
      ['TASK-1', ['src/a.ts']], // known
      // TASK-2 unknown (absent) → deferred, not co-scheduled
      ['TASK-3', ['src/c.ts']], // known, disjoint → included
    ]);
    expect(selectDisjointBatch(['TASK-1', 'TASK-2', 'TASK-3'], files, 3)).toEqual([
      'TASK-1',
      'TASK-3',
    ]);
  });

  it('treats an empty declared footprint as known-and-disjoint', () => {
    const files = new Map<string, string[]>([
      ['TASK-1', []],
      ['TASK-2', ['src/b.ts']],
    ]);
    expect(selectDisjointBatch(['TASK-1', 'TASK-2'], files, 3)).toEqual(['TASK-1', 'TASK-2']);
  });

  it('returns [] for an empty ready set and clamps a non-positive cap to 1', () => {
    expect(selectDisjointBatch([], new Map(), 3)).toEqual([]);
    const files = new Map<string, string[]>([
      ['TASK-1', ['src/a.ts']],
      ['TASK-2', ['src/b.ts']],
    ]);
    expect(selectDisjointBatch(['TASK-1', 'TASK-2'], files, 0)).toEqual(['TASK-1']);
  });
});
