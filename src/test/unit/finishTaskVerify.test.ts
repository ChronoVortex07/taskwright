import { describe, it, expect } from 'vitest';
import {
  isWorktreeClean,
  resolveBaseBranch,
  rebaseOntoBase,
  runVerifyCommands,
  type GitExecFn,
  type RunFn,
} from '../../core/finishTask';

/** Build a GitExecFn from a map keyed by the git subcommand (args joined by space). */
function gitExec(
  handler: (args: string[]) => { stdout?: string; stderr?: string } | Error
): GitExecFn {
  return async (_cwd, args) => {
    const r = handler(args);
    if (r instanceof Error) throw r;
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

describe('isWorktreeClean', () => {
  it('is true when status --porcelain is empty', async () => {
    expect(
      await isWorktreeClean(
        gitExec(() => ({ stdout: '' })),
        '/wt'
      )
    ).toBe(true);
  });
  it('is false when there are changes', async () => {
    expect(
      await isWorktreeClean(
        gitExec(() => ({ stdout: ' M src/x.ts\n' })),
        '/wt'
      )
    ).toBe(false);
  });
});

describe('resolveBaseBranch', () => {
  it('prefers main when it exists', async () => {
    const exec = gitExec((a) =>
      a.includes('refs/heads/main') ? { stdout: 'abc' } : new Error('no')
    );
    expect(await resolveBaseBranch(exec, '/wt')).toBe('main');
  });
  it('falls back to master', async () => {
    const exec = gitExec((a) =>
      a.includes('refs/heads/master') ? { stdout: 'abc' } : new Error('no')
    );
    expect(await resolveBaseBranch(exec, '/wt')).toBe('master');
  });
  it('falls back to main when neither branch exists', async () => {
    const exec = gitExec(() => new Error('no branch'));
    expect(await resolveBaseBranch(exec, '/wt')).toBe('main');
  });
});

describe('rebaseOntoBase', () => {
  it('returns ok when the rebase succeeds', async () => {
    const calls: string[][] = [];
    const exec = gitExec((a) => {
      calls.push(a);
      return { stdout: '' };
    });
    expect(await rebaseOntoBase(exec, '/wt', 'main')).toEqual({ ok: true });
    expect(calls).toContainEqual(['rebase', 'main']);
    expect(calls).not.toContainEqual(['rebase', '--abort']); // no abort on success
  });

  it('captures conflicts and aborts on failure', async () => {
    const calls: string[][] = [];
    const exec = gitExec((a) => {
      calls.push(a);
      if (a[0] === 'rebase' && a[1] === 'main') return new Error('conflict');
      if (a.join(' ') === 'diff --name-only --diff-filter=U')
        return { stdout: 'src/a.ts\nsrc/b.ts\n' };
      return { stdout: '' };
    });
    const result = await rebaseOntoBase(exec, '/wt', 'main');
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual(['src/a.ts', 'src/b.ts']);
    expect(calls).toContainEqual(['rebase', '--abort']);
    // The conflict list MUST be captured before the abort wipes the unmerged paths.
    const diffIdx = calls.findIndex((a) => a.join(' ') === 'diff --name-only --diff-filter=U');
    const abortIdx = calls.findIndex((a) => a.join(' ') === 'rebase --abort');
    expect(diffIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(-1);
    expect(diffIdx).toBeLessThan(abortIdx);
  });

  it('returns empty conflicts (not undefined) when the diff capture itself throws', async () => {
    const exec = gitExec((a) => {
      if (a[0] === 'rebase' && a[1] === 'main') return new Error('conflict');
      if (a[0] === 'diff') return new Error('diff failed');
      return { stdout: '' };
    });
    const result = await rebaseOntoBase(exec, '/wt', 'main');
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual([]);
  });
});

describe('runVerifyCommands', () => {
  it('runs all commands in order and passes when all exit 0', async () => {
    const seen: string[] = [];
    const run: RunFn = async (_cwd, cmd) => {
      seen.push(cmd);
      return { code: 0, stdout: 'ok', stderr: '' };
    };
    expect(await runVerifyCommands(run, '/wt', ['a', 'b'])).toEqual({ ok: true });
    expect(seen).toEqual(['a', 'b']);
  });

  it('stops at the first failure and returns its output', async () => {
    const seen: string[] = [];
    const run: RunFn = async (_cwd, cmd) => {
      seen.push(cmd);
      return cmd === 'b'
        ? { code: 1, stdout: 'boom-out', stderr: 'boom-err' }
        : { code: 0, stdout: '', stderr: '' };
    };
    const result = await runVerifyCommands(run, '/wt', ['a', 'b', 'c']);
    expect(result.ok).toBe(false);
    expect(result.failedCommand).toBe('b');
    expect(result.output).toContain('boom-out');
    expect(result.output).toContain('boom-err');
    expect(seen).toEqual(['a', 'b']); // 'c' never runs
  });

  it('passes trivially on an empty command list', async () => {
    const run: RunFn = async () => ({ code: 0, stdout: '', stderr: '' });
    expect(await runVerifyCommands(run, '/wt', [])).toEqual({ ok: true });
  });
});
