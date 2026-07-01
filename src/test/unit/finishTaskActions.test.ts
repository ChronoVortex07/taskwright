import { describe, it, expect } from 'vitest';
import {
  hasCodeWip,
  ffMergeToBase,
  openPullRequest,
  removeWorktree,
  deleteBranch,
  type GitExecFn,
  type RunFn,
} from '../../core/finishTask';

function gitExec(
  handler: (args: string[]) => { stdout?: string; stderr?: string } | Error
): GitExecFn {
  return async (_cwd, args) => {
    const r = handler(args);
    if (r instanceof Error) throw r;
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

describe('hasCodeWip', () => {
  it('ignores dirty files under backlog/ (board bookkeeping)', () => {
    expect(hasCodeWip(' M backlog/tasks/TASK-7 - x.md\n')).toBe(false);
    expect(hasCodeWip('')).toBe(false);
  });
  it('flags dirty files outside backlog/', () => {
    expect(hasCodeWip(' M src/app.ts\n')).toBe(true);
    expect(hasCodeWip(' M backlog/tasks/a.md\n M src/app.ts\n')).toBe(true);
  });
  it('handles rename entries (arrow syntax)', () => {
    expect(hasCodeWip('R  backlog/a.md -> backlog/b.md\n')).toBe(false);
    expect(hasCodeWip('R  src/a.ts -> src/b.ts\n')).toBe(true);
  });
  it('handles quoted rename destinations with spaces', () => {
    expect(hasCodeWip('R  "backlog/a b.md" -> "backlog/c d.md"\n')).toBe(false);
    expect(hasCodeWip('R  "backlog/a b.md" -> "src/c d.ts"\n')).toBe(true);
  });
});

describe('ffMergeToBase', () => {
  it('fast-forwards when primary is on base and has no code WIP', async () => {
    const calls: string[][] = [];
    const exec = gitExec((a) => {
      calls.push(a);
      if (a[0] === 'symbolic-ref') return { stdout: 'main' };
      if (a[0] === 'status') return { stdout: ' M backlog/tasks/x.md\n' }; // board only
      return { stdout: '' };
    });
    expect(await ffMergeToBase(exec, '/primary', 'main', 'task-7-x')).toEqual({ ok: true });
    expect(calls).toContainEqual(['merge', '--ff-only', 'task-7-x']);
  });

  it('aborts when primary is not on the base branch', async () => {
    const exec = gitExec((a) => (a[0] === 'symbolic-ref' ? { stdout: 'other' } : { stdout: '' }));
    const r = await ffMergeToBase(exec, '/primary', 'main', 'task-7-x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('main');
  });

  it('aborts on a detached HEAD (symbolic-ref throws)', async () => {
    const exec = gitExec((a) =>
      a[0] === 'symbolic-ref' ? new Error('ref HEAD is not a symbolic ref') : { stdout: '' }
    );
    const r = await ffMergeToBase(exec, '/primary', 'main', 'task-7-x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('detached');
  });

  it('aborts when the primary tree has code WIP', async () => {
    const exec = gitExec((a) => {
      if (a[0] === 'symbolic-ref') return { stdout: 'main' };
      if (a[0] === 'status') return { stdout: ' M src/app.ts\n' };
      return { stdout: '' };
    });
    const r = await ffMergeToBase(exec, '/primary', 'main', 'task-7-x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('uncommitted');
  });

  it('aborts when the fast-forward merge fails', async () => {
    const exec = gitExec((a) => {
      if (a[0] === 'symbolic-ref') return { stdout: 'main' };
      if (a[0] === 'status') return { stdout: '' };
      if (a[0] === 'merge') return new Error('not possible to fast-forward');
      return { stdout: '' };
    });
    const r = await ffMergeToBase(exec, '/primary', 'main', 'task-7-x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('fast-forward');
  });
});

describe('openPullRequest', () => {
  it('pushes and opens a PR, capturing the URL', async () => {
    const exec = gitExec((a) => (a[0] === 'remote' ? { stdout: 'origin\n' } : { stdout: '' }));
    const ran: string[] = [];
    const run: RunFn = async (_cwd, cmd) => {
      ran.push(cmd);
      if (cmd.startsWith('gh pr create'))
        return { code: 0, stdout: 'https://github.com/o/r/pull/42\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await openPullRequest(exec, run, '/wt', 'task-7-x', 'main');
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/42' });
    expect(ran.some((c) => c.startsWith('gh pr create'))).toBe(true);
  });

  it('aborts with a setup message when there is no remote', async () => {
    const exec = gitExec((a) => (a[0] === 'remote' ? { stdout: '' } : { stdout: '' }));
    const run: RunFn = async () => ({ code: 0, stdout: '', stderr: '' });
    const r = await openPullRequest(exec, run, '/wt', 'task-7-x', 'main');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('remote');
  });

  it('aborts when gh fails (e.g. not installed)', async () => {
    const exec = gitExec((a) => (a[0] === 'remote' ? { stdout: 'origin\n' } : { stdout: '' }));
    const run: RunFn = async (_cwd, cmd) =>
      cmd.startsWith('gh')
        ? { code: 127, stdout: '', stderr: 'gh: command not found' }
        : { code: 0, stdout: '', stderr: '' };
    const r = await openPullRequest(exec, run, '/wt', 'task-7-x', 'main');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('gh');
  });

  it('returns ok with url undefined when gh prints no URL', async () => {
    const exec = gitExec((a) => (a[0] === 'remote' ? { stdout: 'origin\n' } : { stdout: '' }));
    const run: RunFn = async () => ({ code: 0, stdout: 'done, no url here', stderr: '' });
    const r = await openPullRequest(exec, run, '/wt', 'task-7-x', 'main');
    expect(r).toEqual({ ok: true, url: undefined });
  });
});

describe('best-effort cleanup', () => {
  it('removeWorktree forces removal then prunes, swallowing errors', async () => {
    const calls: string[][] = [];
    const exec: GitExecFn = async (_cwd, args) => {
      calls.push(args);
      if (args.includes('remove')) throw new Error('busy'); // e.g. cwd still inside on Windows
      return { stdout: '', stderr: '' };
    };
    await expect(removeWorktree(exec, '/primary', '.worktrees/task-7-x')).resolves.toBeUndefined();
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '.worktrees/task-7-x']);
    expect(calls).toContainEqual(['worktree', 'prune']);
  });

  it('removeWorktree removes then prunes on the happy path', async () => {
    const calls: string[][] = [];
    const exec: GitExecFn = async (_cwd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    };
    await removeWorktree(exec, '/primary', '.worktrees/task-7-x');
    expect(calls).toEqual([
      ['worktree', 'remove', '--force', '.worktrees/task-7-x'],
      ['worktree', 'prune'],
    ]);
  });

  it('deleteBranch swallows errors', async () => {
    const exec: GitExecFn = async () => {
      throw new Error('branch not fully merged');
    };
    await expect(deleteBranch(exec, '/primary', 'task-7-x')).resolves.toBeUndefined();
  });
});
