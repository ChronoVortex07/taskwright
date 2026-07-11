import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { boardWorktreeStatusOf, ensureBoardWorktree } from '../../core/boardWorktree';
import type { BoardGitExec } from '../../core/boardRef';
import { boardWorktreePathFor } from '../../core/boardRoot';
import { makeTempGitRepo, type TempRepo } from './helpers/tempGitRepo';

const REF = 'taskwright-board';
const REMOTE = 'origin';

/**
 * Scripted git: each rule matches a prefix of the args and yields stdout or a
 * throw. Records every call for sequence assertions.
 */
function scriptedExec(
  rules: Array<{ match: string[]; stdout?: string; fail?: boolean }>
): BoardGitExec & { calls: Array<{ cwd: string; args: string[] }> } {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const exec = (async (cwd: string, args: string[]) => {
    calls.push({ cwd, args });
    for (const rule of rules) {
      // Ignore leading `-c k=v` config flags when matching.
      const stripped = [...args];
      while (stripped[0] === '-c') stripped.splice(0, 2);
      if (rule.match.every((m, i) => stripped[i] === m)) {
        if (rule.fail) throw new Error(`scripted failure for ${rule.match.join(' ')}`);
        return { stdout: rule.stdout ?? '', stderr: '' };
      }
    }
    return { stdout: '', stderr: '' };
  }) as BoardGitExec & { calls: Array<{ cwd: string; args: string[] }> };
  (exec as unknown as { calls: unknown }).calls = calls;
  return exec;
}

function strippedCalls(exec: { calls: Array<{ cwd: string; args: string[] }> }): string[][] {
  return exec.calls.map((c) => {
    const args = [...c.args];
    while (args[0] === '-c') args.splice(0, 2);
    return args;
  });
}

describe('ensureBoardWorktree (unit, scripted git)', () => {
  const primary = path.join('/repo');
  const dir = boardWorktreePathFor(primary);

  it('short-circuits when the worktree is already healthy', async () => {
    const exec = scriptedExec([
      { match: ['rev-parse', '--git-dir'], stdout: '.git/worktrees/board\n' },
    ]);

    const result = await ensureBoardWorktree({
      primaryRoot: primary,
      ref: REF,
      remote: REMOTE,
      exec,
      pathExists: (p) => p === dir,
    });

    expect(result).toEqual({ path: dir, created: false, seeded: 'existing' });
    expect(strippedCalls(exec).some((a) => a[0] === 'worktree' && a[1] === 'add')).toBe(false);
  });

  it('adds the worktree from an existing local branch', async () => {
    const exec = scriptedExec([
      { match: ['rev-parse', '--verify', '--quiet', `refs/heads/${REF}`], stdout: 'abc123\n' },
    ]);

    const result = await ensureBoardWorktree({
      primaryRoot: primary,
      ref: REF,
      remote: REMOTE,
      exec,
      pathExists: () => false,
    });

    expect(result.created).toBe(true);
    expect(result.seeded).toBe('from-local-ref');
    const calls = strippedCalls(exec);
    expect(calls).toContainEqual(['worktree', 'prune']);
    expect(calls).toContainEqual(['worktree', 'add', dir, REF]);
  });

  it('creates the local branch from the fetched remote tip when there is no local ref', async () => {
    const exec = scriptedExec([
      { match: ['rev-parse', '--verify', '--quiet', `refs/heads/${REF}`], fail: true },
      { match: ['fetch', '--quiet', REMOTE], stdout: '' },
      {
        match: ['rev-parse', '--verify', '--quiet', `refs/taskwright/fetch/${REF}`],
        stdout: 'feed42\n',
      },
    ]);

    const result = await ensureBoardWorktree({
      primaryRoot: primary,
      ref: REF,
      remote: REMOTE,
      exec,
      pathExists: () => false,
    });

    expect(result.seeded).toBe('from-remote');
    const calls = strippedCalls(exec);
    expect(calls).toContainEqual(['branch', REF, 'feed42']);
    expect(calls).toContainEqual(['worktree', 'add', dir, REF]);
  });

  it('seeds an empty root commit when neither a local ref nor a remote exists', async () => {
    const exec = scriptedExec([
      { match: ['rev-parse', '--verify', '--quiet', `refs/heads/${REF}`], fail: true },
      { match: ['fetch', '--quiet', REMOTE], fail: true },
      { match: ['write-tree'], stdout: 'tree01\n' },
      { match: ['commit-tree', 'tree01'], stdout: 'root01\n' },
    ]);

    const result = await ensureBoardWorktree({
      primaryRoot: primary,
      ref: REF,
      remote: REMOTE,
      exec,
      pathExists: () => false,
    });

    expect(result.seeded).toBe('none');
    const calls = strippedCalls(exec);
    expect(calls).toContainEqual(['read-tree', '--empty']);
    expect(calls).toContainEqual(['branch', REF, 'root01']);
    expect(calls).toContainEqual(['worktree', 'add', dir, REF]);
  });
});

describe('boardWorktree (integration, real git)', () => {
  let repo: TempRepo | undefined;

  afterEach(() => {
    repo?.cleanup();
    repo = undefined;
  });

  it('creates, reuses, and repairs the hidden board worktree', async () => {
    repo = await makeTempGitRepo();
    const dir = boardWorktreePathFor(repo.root);

    const first = await ensureBoardWorktree({ primaryRoot: repo.root, ref: REF, remote: REMOTE });
    expect(first.created).toBe(true);
    expect(first.seeded).toBe('none');
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    expect(await boardWorktreeStatusOf(repo.root, REF)).toBe('ok');

    const second = await ensureBoardWorktree({ primaryRoot: repo.root, ref: REF, remote: REMOTE });
    expect(second).toEqual({ path: dir, created: false, seeded: 'existing' });

    // Simulate `git clean -dfx` / manual deletion: the branch (durable store)
    // survives in the common git dir; the worktree is reproducible.
    fs.rmSync(dir, { recursive: true, force: true });
    expect(await boardWorktreeStatusOf(repo.root, REF)).toBe('dir-missing');

    const repaired = await ensureBoardWorktree({
      primaryRoot: repo.root,
      ref: REF,
      remote: REMOTE,
    });
    expect(repaired.created).toBe(true);
    expect(repaired.seeded).toBe('from-local-ref');
    expect(await boardWorktreeStatusOf(repo.root, REF)).toBe('ok');
  }, 30_000);
});
