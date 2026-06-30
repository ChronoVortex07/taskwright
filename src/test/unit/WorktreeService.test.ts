import { describe, it, expect, vi } from 'vitest';
import { buildWorktreeAddArgs, createWorktree, worktreePathFor } from '../../core/WorktreeService';

describe('worktreePathFor', () => {
  it('places worktrees under <repo>/.worktrees/<branch>', () => {
    const p = worktreePathFor('/repo', 'task-7-login');
    expect(p.replace(/\\/g, '/')).toBe('/repo/.worktrees/task-7-login');
  });
});

describe('buildWorktreeAddArgs', () => {
  it('creates a new branch when it does not exist yet', () => {
    expect(buildWorktreeAddArgs('/wt', 'task-7', false)).toEqual([
      'worktree',
      'add',
      '-b',
      'task-7',
      '/wt',
    ]);
  });

  it('checks out an existing branch without -b', () => {
    expect(buildWorktreeAddArgs('/wt', 'task-7', true)).toEqual([
      'worktree',
      'add',
      '/wt',
      'task-7',
    ]);
  });
});

describe('createWorktree', () => {
  it('returns the existing worktree without running git when the dir is present', async () => {
    const exec = vi.fn();
    const result = await createWorktree('/repo', 'task-7', {
      exec,
      pathExists: () => true,
    });
    expect(result.created).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('creates a new branch + worktree when neither exists', async () => {
    const calls: string[][] = [];
    const exec = vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      // rev-parse --verify fails => branch does not exist
      if (args[0] === 'rev-parse') throw new Error('unknown revision');
      return { stdout: '', stderr: '' };
    });
    const result = await createWorktree('/repo', 'task-7', {
      exec,
      pathExists: () => false,
    });
    expect(result.created).toBe(true);
    expect(result.branch).toBe('task-7');
    expect(calls).toContainEqual(['worktree', 'add', '-b', 'task-7', result.path]);
  });

  it('reuses an existing branch (no -b) when it already exists', async () => {
    const calls: string[][] = [];
    const exec = vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    await createWorktree('/repo', 'task-7', { exec, pathExists: () => false });
    expect(calls.some((a) => a.includes('-b'))).toBe(false);
    expect(calls).toContainEqual(['worktree', 'add', expect.any(String), 'task-7']);
  });
});
