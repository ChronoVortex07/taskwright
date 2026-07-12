import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  planMigrationSteps,
  verifyMove,
  readBoardDirFileMap,
  executeVerifiedMove,
  moveBoardIntoWorktree,
  type MigrationFacts,
  type MoveFailure,
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
    expect(verifyMove(map, { ...map }, new Set())).toEqual({ ok: true, blocking: [], eolOnly: [] });
  });

  it('classifies a file the board lacks as absent', () => {
    const result = verifyMove({ 'backlog/tasks/a.md': 'A\n' }, {}, new Set());
    expect(result.ok).toBe(false);
    expect(result.blocking).toEqual([{ path: 'backlog/tasks/a.md', reason: 'absent' }]);
  });

  it('classifies a genuinely different file as content-drift', () => {
    const result = verifyMove(
      { 'backlog/tasks/a.md': 'A\n' },
      { 'backlog/tasks/a.md': 'DIFFERENT\n' },
      new Set()
    );
    expect(result.ok).toBe(false);
    expect(result.blocking).toEqual([{ path: 'backlog/tasks/a.md', reason: 'content-drift' }]);
  });

  // TASK-123: the permanent blocker. A repo with `.gitattributes: * text=auto`
  // normalizes CRLF→LF into the blob on `git add` — in-tree attributes override
  // NO_EOL_CONVERT's config flags — so the board worktree checks the file out as
  // LF while the primary's on-disk bytes are still CRLF. That is git's own
  // declared policy applied to the file, not lost content: it verifies OK (and is
  // reported), or migration can never succeed in such a repo.
  it('treats an EOL-only difference as verified, not a failure', () => {
    const result = verifyMove(
      { 'backlog/tasks/a.md': 'A\r\nB\r\n' },
      { 'backlog/tasks/a.md': 'A\nB\n' },
      new Set()
    );
    expect(result.ok).toBe(true);
    expect(result.blocking).toEqual([]);
    expect(result.eolOnly).toEqual([{ path: 'backlog/tasks/a.md', reason: 'eol-only' }]);
  });

  it('accepts a differing file when the fold surfaced it as a conflict', () => {
    const result = verifyMove(
      { 'backlog/tasks/a.md': 'A\n' },
      { 'backlog/tasks/a.md': 'THEIRS-NEWER\n' },
      new Set(['backlog/tasks/a.md'])
    );
    expect(result).toEqual({ ok: true, blocking: [], eolOnly: [] });
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

  it('moves an EOL-only file out of the primary (git normalized it; nothing is lost)', async () => {
    const primary = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-mig-primary-'));
    const board = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-mig-board-'));
    try {
      const write = (root: string, rel: string, content: string): void => {
        const abs = path.join(root, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      };
      write(primary, 'backlog/tasks/task-1 - A.md', 'A\r\nB\r\n'); // CRLF on disk
      write(board, 'backlog/tasks/task-1 - A.md', 'A\nB\n'); // LF after the git round-trip

      const result = await executeVerifiedMove({ primaryRoot: primary, boardWorktree: board });

      expect(result.moved).toBe(1);
      expect(result.notInBoard).toEqual([]);
      expect(fs.existsSync(path.join(primary, 'backlog', 'tasks', 'task-1 - A.md'))).toBe(false);
    } finally {
      fs.rmSync(primary, { recursive: true, force: true });
      fs.rmSync(board, { recursive: true, force: true });
    }
  });
});

/**
 * TASK-123 AC#3: a pre-existing board worktree whose working tree has drifted
 * from the live board (the shape every retry of a failed migration lands in —
 * the aborted attempt leaves the worktree behind, and any task edited since
 * differs) must be FOLDED, not aborted against. Otherwise one failed attempt
 * wedges the repo permanently: each retry re-compares against the same stale
 * content and re-aborts.
 */
describe('moveBoardIntoWorktree (drift heals instead of wedging)', () => {
  const mk = (): { primary: string; board: string } => ({
    primary: fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-mv-primary-')),
    board: fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-mv-board-')),
  });
  const write = (root: string, rel: string, content: string): void => {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const read = (root: string, rel: string): string =>
    fs.readFileSync(path.join(root, ...rel.split('/')), 'utf-8');

  it('folds a stale board file forward from the primary and completes the move', async () => {
    const { primary, board } = mk();
    try {
      const rel = 'backlog/tasks/task-88 - Live.md';
      write(primary, rel, "---\nid: TASK-88\nupdated_date: '2026-07-13 00:30'\n---\nNEW\n");
      write(board, rel, "---\nid: TASK-88\nupdated_date: '2026-07-12 09:00'\n---\nOLD\n");

      let committed = 0;
      const result = await moveBoardIntoWorktree({
        primaryRoot: primary,
        boardWorktree: board,
        commit: async () => {
          committed++;
        },
      });

      expect(result.ok).toBe(true);
      expect(result.folded).toBe(true);
      expect(committed).toBe(1);
      // The board now holds the LIVE content, and the primary copy is gone.
      expect(read(board, rel)).toContain('NEW');
      expect(fs.existsSync(path.join(primary, ...rel.split('/')))).toBe(false);
      expect(result.blocking).toEqual([]);
    } finally {
      fs.rmSync(primary, { recursive: true, force: true });
      fs.rmSync(board, { recursive: true, force: true });
    }
  });

  it('needs no fold when the board already matches (EOL-only diffs are not drift)', async () => {
    const { primary, board } = mk();
    try {
      write(primary, 'backlog/tasks/task-1 - A.md', 'A\r\n');
      write(board, 'backlog/tasks/task-1 - A.md', 'A\n');

      let committed = 0;
      const result = await moveBoardIntoWorktree({
        primaryRoot: primary,
        boardWorktree: board,
        commit: async () => {
          committed++;
        },
      });

      expect(result.ok).toBe(true);
      expect(result.folded).toBe(false);
      expect(committed).toBe(0);
      expect(result.eolOnly.map((f: MoveFailure) => f.path)).toEqual([
        'backlog/tasks/task-1 - A.md',
      ]);
      expect(fs.existsSync(path.join(primary, 'backlog', 'tasks', 'task-1 - A.md'))).toBe(false);
    } finally {
      fs.rmSync(primary, { recursive: true, force: true });
      fs.rmSync(board, { recursive: true, force: true });
    }
  });
});
