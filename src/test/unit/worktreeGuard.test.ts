import { describe, it, expect } from 'vitest';
import {
  isPrimaryTree,
  shouldBlockCommit,
  collectDispatchedBranches,
} from '../../core/worktreeGuard';

describe('isPrimaryTree', () => {
  it('is true for the primary .git dir', () => {
    expect(isPrimaryTree('/repo/.git')).toBe(true);
    expect(isPrimaryTree('C:\\repo\\.git')).toBe(true);
  });
  it('is false for a linked worktree git dir', () => {
    expect(isPrimaryTree('/repo/.git/worktrees/task-7')).toBe(false);
    expect(isPrimaryTree('C:\\repo\\.git\\worktrees\\task-7')).toBe(false);
  });
});

describe('shouldBlockCommit', () => {
  const dispatched = ['task-7-login', 'task-9-prereq'];

  it('blocks a dispatched branch committed in the primary tree', () => {
    const d = shouldBlockCommit({
      gitDir: '/repo/.git',
      branch: 'task-7-login',
      dispatchedBranches: dispatched,
    });
    expect(d.block).toBe(true);
    expect(d.message).toContain('.worktrees/task-7-login');
    expect(d.message).toContain('--no-verify');
  });

  it('allows the same branch when committed inside its worktree', () => {
    expect(
      shouldBlockCommit({
        gitDir: '/repo/.git/worktrees/task-7-login',
        branch: 'task-7-login',
        dispatchedBranches: dispatched,
      }).block
    ).toBe(false);
  });

  it('allows the integration branch in the primary tree', () => {
    expect(
      shouldBlockCommit({ gitDir: '/repo/.git', branch: 'main', dispatchedBranches: dispatched })
        .block
    ).toBe(false);
  });

  it('allows an undispatched branch in the primary tree', () => {
    expect(
      shouldBlockCommit({ gitDir: '/repo/.git', branch: 'hotfix', dispatchedBranches: dispatched })
        .block
    ).toBe(false);
  });

  it('allows a detached HEAD (null branch)', () => {
    expect(
      shouldBlockCommit({ gitDir: '/repo/.git', branch: null, dispatchedBranches: dispatched })
        .block
    ).toBe(false);
  });
});

describe('collectDispatchedBranches', () => {
  it('returns the immediate subdirectory names of <root>/.worktrees', () => {
    const seen: string[] = [];
    const result = collectDispatchedBranches('/repo', {
      listDirs: (dir) => {
        seen.push(dir.replace(/\\/g, '/'));
        return ['task-7-login', 'task-9-prereq'];
      },
    });
    expect(seen[0]).toBe('/repo/.worktrees');
    expect(result).toEqual(['task-7-login', 'task-9-prereq']);
  });

  it('returns [] when there are no worktrees', () => {
    expect(collectDispatchedBranches('/repo', { listDirs: () => [] })).toEqual([]);
  });
});
