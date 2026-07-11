import { describe, it, expect, vi } from 'vitest';
import {
  buildWorktreeAddArgs,
  createWorktree,
  worktreeListContainsPath,
  worktreePathFor,
} from '../../core/WorktreeService';

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
  it('reuses an existing directory only when Git confirms it is a registered worktree', async () => {
    const worktreePath = '/repo/.worktrees/task-7';
    const exec = vi.fn(async () => ({
      stdout: `worktree /repo\nHEAD abc\n\nworktree ${worktreePath}\nHEAD def\n`,
      stderr: '',
    }));
    const result = await createWorktree('/repo', 'task-7', {
      exec,
      pathExists: () => true,
    });
    expect(result.created).toBe(false);
    expect(exec).toHaveBeenCalledWith('/repo', ['worktree', 'list', '--porcelain']);
  });

  it('removes an empty orphan directory before recreating the worktree', async () => {
    const calls: string[][] = [];
    const removeDir = vi.fn();
    const exec = vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: 'worktree /repo\nHEAD abc\n', stderr: '' };
      }
      if (args[0] === 'rev-parse') throw new Error('unknown revision');
      return { stdout: '', stderr: '' };
    });

    const result = await createWorktree('/repo', 'task-7', {
      exec,
      pathExists: () => true,
      readDir: () => [],
      removeDir,
    });

    expect(removeDir).toHaveBeenCalledWith(result.path);
    expect(result.created).toBe(true);
    expect(calls).toContainEqual(['worktree', 'add', '-b', 'task-7', result.path]);
  });

  it('refuses to delete or reuse a non-empty unregistered directory', async () => {
    const removeDir = vi.fn();
    const exec = vi.fn(async () => ({ stdout: 'worktree /repo\nHEAD abc\n', stderr: '' }));

    await expect(
      createWorktree('/repo', 'task-7', {
        exec,
        pathExists: () => true,
        readDir: () => ['user-file.txt'],
        removeDir,
      })
    ).rejects.toThrow(/not a registered Git worktree.*not empty/i);
    expect(removeDir).not.toHaveBeenCalled();
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

describe('worktreeListContainsPath', () => {
  it('normalizes separators and Windows path case', () => {
    const porcelain =
      'worktree C:/Users/Alice/Repo/.worktrees/TASK-7\nHEAD abc\nbranch refs/heads/task-7\n';
    expect(
      worktreeListContainsPath(porcelain, 'c:\\users\\alice\\repo\\.worktrees\\task-7', true)
    ).toBe(true);
  });
});
