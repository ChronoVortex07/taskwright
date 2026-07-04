import { describe, it, expect } from 'vitest';
import { mergeBoards, type BoardFileMap } from '../../core/boardMerge';

/** Minimal valid task-file content with a given `updated_date` (or none). */
function taskFile(id: string, body: string, updatedDate?: string): string {
  const fm = [
    '---',
    `id: ${id}`,
    `title: ${id} title`,
    'status: To Do',
    'assignee: []',
    'dependencies: []',
    ...(updatedDate ? [`updated_date: '${updatedDate}'`] : []),
    '---',
    '',
    `## Description`,
    body,
    '',
  ].join('\n');
  return fm;
}

describe('mergeBoards', () => {
  it('unions disjoint adds from both sides (add/add of different tasks)', () => {
    const ours: BoardFileMap = { 'backlog/tasks/TASK-1 - A.md': taskFile('TASK-1', 'a') };
    const theirs: BoardFileMap = { 'backlog/tasks/TASK-2 - B.md': taskFile('TASK-2', 'b') };

    const { merged, conflicts } = mergeBoards(undefined, ours, theirs);

    expect(merged).toEqual({ ...ours, ...theirs });
    expect(conflicts).toEqual([]);
  });

  it('keeps an edit made on only one side (ours edits, theirs unchanged)', () => {
    const base: BoardFileMap = { 'backlog/tasks/TASK-1 - A.md': taskFile('TASK-1', 'base') };
    const ours: BoardFileMap = { 'backlog/tasks/TASK-1 - A.md': taskFile('TASK-1', 'edited') };
    const theirs: BoardFileMap = { ...base };

    const { merged, conflicts } = mergeBoards(base, ours, theirs);

    expect(merged['backlog/tasks/TASK-1 - A.md']).toBe(ours['backlog/tasks/TASK-1 - A.md']);
    expect(conflicts).toEqual([]);
  });

  it('keeps an edit made on only the other side (theirs edits, ours unchanged)', () => {
    const base: BoardFileMap = { 'backlog/tasks/TASK-1 - A.md': taskFile('TASK-1', 'base') };
    const ours: BoardFileMap = { ...base };
    const theirs: BoardFileMap = { 'backlog/tasks/TASK-1 - A.md': taskFile('TASK-1', 'edited') };

    const { merged, conflicts } = mergeBoards(base, ours, theirs);

    expect(merged['backlog/tasks/TASK-1 - A.md']).toBe(theirs['backlog/tasks/TASK-1 - A.md']);
    expect(conflicts).toEqual([]);
  });

  it('edited on both sides: newer updated_date wins (ours newer)', () => {
    const path = 'backlog/tasks/TASK-1 - A.md';
    const base: BoardFileMap = { [path]: taskFile('TASK-1', 'base', '2026-01-01 00:00') };
    const ours: BoardFileMap = { [path]: taskFile('TASK-1', 'ours-edit', '2026-01-03 00:00') };
    const theirs: BoardFileMap = { [path]: taskFile('TASK-1', 'theirs-edit', '2026-01-02 00:00') };

    const { merged, conflicts } = mergeBoards(base, ours, theirs);

    expect(merged[path]).toBe(ours[path]);
    expect(conflicts).toEqual([{ path, id: 'TASK-1', reason: 'edited-both', resolution: 'ours' }]);
  });

  it('edited on both sides: newer updated_date wins (theirs newer)', () => {
    const path = 'backlog/tasks/TASK-1 - A.md';
    const base: BoardFileMap = { [path]: taskFile('TASK-1', 'base', '2026-01-01 00:00') };
    const ours: BoardFileMap = { [path]: taskFile('TASK-1', 'ours-edit', '2026-01-02 00:00') };
    const theirs: BoardFileMap = { [path]: taskFile('TASK-1', 'theirs-edit', '2026-01-03 00:00') };

    const { merged, conflicts } = mergeBoards(base, ours, theirs);

    expect(merged[path]).toBe(theirs[path]);
    expect(conflicts).toEqual([
      { path, id: 'TASK-1', reason: 'edited-both', resolution: 'theirs' },
    ]);
  });

  it('edited on both sides with a tied updated_date keeps theirs and surfaces a conflict', () => {
    const path = 'backlog/tasks/TASK-1 - A.md';
    const base: BoardFileMap = { [path]: taskFile('TASK-1', 'base', '2026-01-01 00:00') };
    const ours: BoardFileMap = { [path]: taskFile('TASK-1', 'ours-edit', '2026-01-02 00:00') };
    const theirs: BoardFileMap = { [path]: taskFile('TASK-1', 'theirs-edit', '2026-01-02 00:00') };

    const { merged, conflicts } = mergeBoards(base, ours, theirs);

    expect(merged[path]).toBe(theirs[path]);
    expect(conflicts).toEqual([{ path, id: 'TASK-1', reason: 'tie', resolution: 'theirs' }]);
  });

  it('edited on both sides with an unparseable/missing updated_date keeps theirs and surfaces a conflict', () => {
    const path = 'backlog/tasks/TASK-1 - A.md';
    const base: BoardFileMap = { [path]: taskFile('TASK-1', 'base', '2026-01-01 00:00') };
    // Neither side sets updated_date on their edit.
    const ours: BoardFileMap = { [path]: taskFile('TASK-1', 'ours-edit') };
    const theirs: BoardFileMap = { [path]: taskFile('TASK-1', 'theirs-edit') };

    const { merged, conflicts } = mergeBoards(base, ours, theirs);

    expect(merged[path]).toBe(theirs[path]);
    expect(conflicts).toEqual([
      { path, id: 'TASK-1', reason: 'unparseable', resolution: 'theirs' },
    ]);
  });

  it('delete-vs-edit: ours deletes, theirs edits — keeps the edit and surfaces a conflict', () => {
    const path = 'backlog/tasks/TASK-1 - A.md';
    const base: BoardFileMap = { [path]: taskFile('TASK-1', 'base') };
    const ours: BoardFileMap = {}; // deleted
    const theirs: BoardFileMap = { [path]: taskFile('TASK-1', 'theirs-edit') };

    const { merged, conflicts } = mergeBoards(base, ours, theirs);

    expect(merged[path]).toBe(theirs[path]);
    expect(conflicts).toEqual([
      { path, id: 'TASK-1', reason: 'delete-vs-edit', resolution: 'theirs' },
    ]);
  });

  it('delete-vs-edit: theirs deletes, ours edits — keeps the edit and surfaces a conflict', () => {
    const path = 'backlog/tasks/TASK-1 - A.md';
    const base: BoardFileMap = { [path]: taskFile('TASK-1', 'base') };
    const ours: BoardFileMap = { [path]: taskFile('TASK-1', 'ours-edit') };
    const theirs: BoardFileMap = {}; // deleted

    const { merged, conflicts } = mergeBoards(base, ours, theirs);

    expect(merged[path]).toBe(ours[path]);
    expect(conflicts).toEqual([
      { path, id: 'TASK-1', reason: 'delete-vs-edit', resolution: 'ours' },
    ]);
  });

  it('a clean delete on one side (other side unchanged from base) drops the file with no conflict', () => {
    const path = 'backlog/tasks/TASK-1 - A.md';
    const base: BoardFileMap = { [path]: taskFile('TASK-1', 'base') };
    const ours: BoardFileMap = {}; // deleted
    const theirs: BoardFileMap = { ...base }; // unchanged

    const { merged, conflicts } = mergeBoards(base, ours, theirs);

    expect(merged[path]).toBeUndefined();
    expect(conflicts).toEqual([]);
  });

  it('deleted on both sides drops the file with no conflict', () => {
    const path = 'backlog/tasks/TASK-1 - A.md';
    const base: BoardFileMap = { [path]: taskFile('TASK-1', 'base') };

    const { merged, conflicts } = mergeBoards(base, {}, {});

    expect(merged[path]).toBeUndefined();
    expect(conflicts).toEqual([]);
  });

  it('identical content on both sides is not a conflict even without a common base', () => {
    const path = 'backlog/tasks/TASK-1 - A.md';
    const content = taskFile('TASK-1', 'same');
    const ours: BoardFileMap = { [path]: content };
    const theirs: BoardFileMap = { [path]: content };

    const { merged, conflicts } = mergeBoards(undefined, ours, theirs);

    expect(merged[path]).toBe(content);
    expect(conflicts).toEqual([]);
  });

  it('derives the conflict id from the milestone/draft filename convention', () => {
    const path = 'backlog/drafts/DRAFT-7 - Explore-caching.md';
    const base: BoardFileMap = { [path]: taskFile('DRAFT-7', 'base') };
    const ours: BoardFileMap = { [path]: taskFile('DRAFT-7', 'ours-edit') };
    const theirs: BoardFileMap = {};

    const { conflicts } = mergeBoards(base, ours, theirs);

    expect(conflicts[0]?.id).toBe('DRAFT-7');
  });
});
