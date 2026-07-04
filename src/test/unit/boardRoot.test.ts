import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import {
  parseWorktreeListPorcelain,
  boardRootFromPorcelain,
  resolveBoardRoot,
} from '../../core/boardRoot';

const norm = (p: string): string => p.replace(/\\/g, '/');

// A plain repo with no linked worktrees — `git worktree list --porcelain` still
// emits exactly one `worktree ` entry (the main/primary one).
const SINGLE_REPO_PORCELAIN = ['worktree /repo', 'HEAD abc123', 'branch refs/heads/main', ''].join(
  '\n'
);

// Primary + one linked `.worktrees/<branch>` worktree, matching real `git
// worktree list --porcelain` output (blank line separates entries).
const MULTI_WORKTREE_PORCELAIN = [
  'worktree /repo',
  'HEAD abc123',
  'branch refs/heads/board-sync-v2',
  '',
  'worktree /repo/.worktrees/task-7-login',
  'HEAD def456',
  'branch refs/heads/task-7-login',
  '',
].join('\n');

// A stale/prunable linked worktree (dir removed on disk but git's admin dir
// still lists it) should not confuse parsing of the *first* entry.
const PRUNABLE_TRAILING_PORCELAIN = [
  'worktree /repo',
  'HEAD abc123',
  'branch refs/heads/main',
  '',
  'worktree /repo/.worktrees/gone-branch',
  'HEAD def456',
  'branch refs/heads/gone-branch',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

const DETACHED_PORCELAIN = ['worktree /repo', 'HEAD abc123', 'detached', ''].join('\n');

describe('parseWorktreeListPorcelain', () => {
  it('extracts worktree paths in order', () => {
    expect(parseWorktreeListPorcelain(MULTI_WORKTREE_PORCELAIN)).toEqual([
      '/repo',
      '/repo/.worktrees/task-7-login',
    ]);
  });

  it('returns a single entry for a plain non-worktree repo', () => {
    expect(parseWorktreeListPorcelain(SINGLE_REPO_PORCELAIN)).toEqual(['/repo']);
  });

  it('returns an empty array when there are no worktree entries', () => {
    expect(parseWorktreeListPorcelain('')).toEqual([]);
  });
});

describe('boardRootFromPorcelain', () => {
  it('resolves the primary backlog dir in a plain non-worktree repo', () => {
    expect(norm(boardRootFromPorcelain(SINGLE_REPO_PORCELAIN))).toBe(
      norm(path.join('/repo', 'backlog'))
    );
  });

  it('resolves the *primary* backlog dir even when invoked from a linked worktree', () => {
    // The porcelain output is the same regardless of which worktree ran the
    // command — the primary is always the first entry — so this asserts we
    // key off entry order, not `cwd`.
    expect(norm(boardRootFromPorcelain(MULTI_WORKTREE_PORCELAIN))).toBe(
      norm(path.join('/repo', 'backlog'))
    );
  });

  it('ignores a detached HEAD worktree entry', () => {
    expect(norm(boardRootFromPorcelain(DETACHED_PORCELAIN))).toBe(
      norm(path.join('/repo', 'backlog'))
    );
  });

  it('ignores trailing prunable/stale linked-worktree metadata', () => {
    expect(norm(boardRootFromPorcelain(PRUNABLE_TRAILING_PORCELAIN))).toBe(
      norm(path.join('/repo', 'backlog'))
    );
  });

  it('throws when the porcelain output has no worktree entries', () => {
    expect(() => boardRootFromPorcelain('')).toThrow();
  });
});

describe('resolveBoardRoot', () => {
  it('runs `git worktree list --porcelain` in the given cwd and resolves the primary backlog dir', async () => {
    const exec = vi.fn(async (_cwd: string, _args: string[]) => ({
      stdout: MULTI_WORKTREE_PORCELAIN,
      stderr: '',
    }));

    const result = await resolveBoardRoot('/repo/.worktrees/task-7-login', { exec });

    expect(exec).toHaveBeenCalledWith('/repo/.worktrees/task-7-login', [
      'worktree',
      'list',
      '--porcelain',
    ]);
    expect(norm(result)).toBe(norm(path.join('/repo', 'backlog')));
  });

  it('returns the repo itself as the board root parent in a single-repo checkout', async () => {
    const exec = vi.fn(async () => ({ stdout: SINGLE_REPO_PORCELAIN, stderr: '' }));

    const result = await resolveBoardRoot('/repo', { exec });

    expect(norm(result)).toBe(norm(path.join('/repo', 'backlog')));
  });
});
