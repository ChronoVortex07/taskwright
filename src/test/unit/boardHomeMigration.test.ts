import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  planMigrationSteps,
  verifyMove,
  readBoardDirFileMap,
  executeVerifiedMove,
  type MigrationFacts,
} from '../../core/boardHomeMigration';

function facts(overrides: Partial<MigrationFacts> = {}): MigrationFacts {
  return {
    hasStateDirs: false,
    trackedBoardFiles: [],
    localRefTip: null,
    boardWorktreeOk: false,
    hasMaterializedMarker: false,
    ...overrides,
  };
}

describe('planMigrationSteps (S0–S6 classifier)', () => {
  it('S0/S5 fresh — no board state: just add the worktree (ensure picks remote vs empty)', () => {
    expect(planMigrationSteps(facts())).toEqual(['add-worktree']);
  });

  it('S1 board ignored in primary: fresh seed, worktree, verified move', () => {
    expect(planMigrationSteps(facts({ hasStateDirs: true }))).toEqual([
      'seed-fresh',
      'add-worktree',
      'verified-move',
    ]);
  });

  it('S2 tracked board files: untrack first, then the S1 sequence', () => {
    expect(
      planMigrationSteps(
        facts({ hasStateDirs: true, trackedBoardFiles: ['backlog/tasks/task-1 - X.md'] })
      )
    ).toEqual(['untrack', 'seed-fresh', 'add-worktree', 'verified-move']);
  });

  it('S3 existing ref: fold-seed (parented on the tip) instead of a fresh seed', () => {
    expect(planMigrationSteps(facts({ hasStateDirs: true, localRefTip: 'abc' }))).toEqual([
      'seed-fold-ref',
      'add-worktree',
      'verified-move',
    ]);
  });

  it('S4 v1 marker: cleaned as the last step of any migration', () => {
    expect(planMigrationSteps(facts({ hasStateDirs: true, hasMaterializedMarker: true }))).toEqual([
      'seed-fresh',
      'add-worktree',
      'verified-move',
      'clean-marker',
    ]);
  });

  it('S6 already migrated: noop (plus marker cleanup when one lingers)', () => {
    expect(planMigrationSteps(facts({ boardWorktreeOk: true }))).toEqual(['noop']);
    expect(
      planMigrationSteps(facts({ boardWorktreeOk: true, hasMaterializedMarker: true }))
    ).toEqual(['clean-marker', 'noop']);
  });
});

describe('verifyMove', () => {
  it('ok when every primary file is byte-identical in the board', () => {
    const map = { 'backlog/tasks/a.md': 'A\n', 'backlog/milestones/m-1.md': 'M\n' };
    expect(verifyMove(map, { ...map }, new Set())).toEqual({ ok: true, missing: [] });
  });

  it('flags a primary file the board lacks or differs on', () => {
    const result = verifyMove(
      { 'backlog/tasks/a.md': 'A\n' },
      { 'backlog/tasks/a.md': 'DIFFERENT\n' },
      new Set()
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['backlog/tasks/a.md']);
  });

  it('accepts a differing file when the fold surfaced it as a conflict', () => {
    const result = verifyMove(
      { 'backlog/tasks/a.md': 'A\n' },
      { 'backlog/tasks/a.md': 'THEIRS-NEWER\n' },
      new Set(['backlog/tasks/a.md'])
    );
    expect(result).toEqual({ ok: true, missing: [] });
  });
});

describe('readBoardDirFileMap / executeVerifiedMove (real fs)', () => {
  it('moves verified files out of the primary, leaves divergent ones, prunes empty dirs', async () => {
    const primary = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-mig-primary-'));
    const board = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-mig-board-'));
    try {
      const write = (root: string, rel: string, content: string): void => {
        const abs = path.join(root, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      };
      write(primary, 'backlog/tasks/task-1 - A.md', 'A\n');
      write(primary, 'backlog/milestones/m-1 - M.md', 'M\n');
      write(primary, 'backlog/drafts/DRAFT-1 - D.md', 'DIVERGENT\n');
      write(board, 'backlog/tasks/task-1 - A.md', 'A\n');
      write(board, 'backlog/milestones/m-1 - M.md', 'M\n');
      write(board, 'backlog/drafts/DRAFT-1 - D.md', 'other\n');

      expect(Object.keys(readBoardDirFileMap(primary)).sort()).toEqual([
        'backlog/drafts/DRAFT-1 - D.md',
        'backlog/milestones/m-1 - M.md',
        'backlog/tasks/task-1 - A.md',
      ]);

      const result = await executeVerifiedMove({ primaryRoot: primary, boardWorktree: board });

      expect(result.moved).toBe(2);
      expect(result.notInBoard).toEqual(['backlog/drafts/DRAFT-1 - D.md']);
      expect(result.lockedLeftBehind).toEqual([]);
      expect(fs.existsSync(path.join(primary, 'backlog', 'tasks'))).toBe(false);
      expect(fs.existsSync(path.join(primary, 'backlog', 'milestones'))).toBe(false);
      // The divergent file (and its dir) survives — never delete unverified bytes.
      expect(fs.existsSync(path.join(primary, 'backlog', 'drafts', 'DRAFT-1 - D.md'))).toBe(true);
    } finally {
      fs.rmSync(primary, { recursive: true, force: true });
      fs.rmSync(board, { recursive: true, force: true });
    }
  });
});
