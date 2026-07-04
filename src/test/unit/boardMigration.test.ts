import { describe, it, expect } from 'vitest';
import {
  BOARD_IGNORE_BEGIN,
  BOARD_IGNORE_END,
  boardIgnoreBlock,
  applyBoardIgnore,
  boardTrackedPaths,
} from '../../core/boardMigration';

describe('boardMigration', () => {
  it('block ignores the five board subdirs under the fenced markers', () => {
    const block = boardIgnoreBlock('backlog');
    expect(block.startsWith(BOARD_IGNORE_BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(BOARD_IGNORE_END)).toBe(true);
    for (const d of ['tasks', 'drafts', 'completed', 'archive', 'milestones']) {
      expect(block).toContain(`backlog/${d}/`);
    }
  });

  it('appends the block when absent, preserving existing content', () => {
    const out = applyBoardIgnore('node_modules/\ndist/\n', 'backlog');
    expect(out).toContain('node_modules/');
    expect(out).toContain('dist/');
    expect(out).toContain('backlog/tasks/');
  });

  it('is idempotent — replaces the block instead of duplicating it', () => {
    const once = applyBoardIgnore('dist/\n', 'backlog');
    const twice = applyBoardIgnore(once, 'backlog');
    const occurrences = twice.split(BOARD_IGNORE_BEGIN).length - 1;
    expect(occurrences).toBe(1);
  });

  it('lists the five tracked dir paths for rm --cached', () => {
    expect(boardTrackedPaths('backlog')).toEqual([
      'backlog/tasks',
      'backlog/drafts',
      'backlog/completed',
      'backlog/archive',
      'backlog/milestones',
    ]);
  });
});
