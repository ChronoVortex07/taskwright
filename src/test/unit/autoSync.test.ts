import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  autoCommitBoard,
  acquireSyncLock,
  runBoardAutoSync,
  BoardSyncScheduler,
} from '../../core/autoSync';
import type { BoardGitExec } from '../../core/boardRef';
import { boardWorktreePathFor } from '../../core/boardRoot';

const REF = 'taskwright-board';
const REMOTE = 'origin';

/** Scripted git that matches arg prefixes (ignoring leading `-c k=v` pairs). */
function scriptedExec(
  rules: Array<{ match: string[]; stdout?: string | (() => string); fail?: boolean }>
): BoardGitExec & { calls: Array<{ cwd: string; args: string[] }> } {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const exec = (async (cwd: string, args: string[]) => {
    calls.push({ cwd, args });
    const stripped = [...args];
    while (stripped[0] === '-c') stripped.splice(0, 2);
    for (const rule of rules) {
      if (rule.match.every((m, i) => stripped[i] === m)) {
        if (rule.fail) throw new Error(`scripted failure for ${rule.match.join(' ')}`);
        const out = typeof rule.stdout === 'function' ? rule.stdout() : (rule.stdout ?? '');
        return { stdout: out, stderr: '' };
      }
    }
    return { stdout: '', stderr: '' };
  }) as BoardGitExec & { calls: Array<{ cwd: string; args: string[] }> };
  (exec as unknown as { calls: unknown }).calls = calls;
  return exec;
}

const stripped = (args: string[]): string[] => {
  const a = [...args];
  while (a[0] === '-c') a.splice(0, 2);
  return a;
};

describe('autoCommitBoard', () => {
  const worktree = path.join('/repo', '.taskwright', 'board');

  it('stages only the five board state dirs and commits with an identity fallback', async () => {
    const exec = scriptedExec([
      { match: ['status', '--porcelain'], stdout: ' M backlog/tasks/task-1 - X.md\n' },
      { match: ['rev-parse', 'HEAD'], stdout: 'newsha\n' },
    ]);

    const result = await autoCommitBoard(worktree, { exec, pathExists: () => true });

    expect(result).toEqual({ committed: true, sha: 'newsha' });
    const add = exec.calls.find((c) => stripped(c.args)[0] === 'add');
    expect(add).toBeDefined();
    expect(stripped(add!.args)).toEqual([
      'add',
      '-A',
      '--',
      'backlog/tasks',
      'backlog/drafts',
      'backlog/completed',
      'backlog/archive',
      'backlog/milestones',
    ]);
    const commit = exec.calls.find((c) => stripped(c.args)[0] === 'commit');
    expect(commit).toBeDefined();
    expect(commit!.args).toContain('user.name=Taskwright');
    expect(commit!.args).toContain('user.email=taskwright@local');
  });

  it('is a no-op on a clean tree', async () => {
    const exec = scriptedExec([{ match: ['status', '--porcelain'], stdout: '' }]);

    const result = await autoCommitBoard(worktree, { exec, pathExists: () => true });

    expect(result).toEqual({ committed: false });
    expect(exec.calls.some((c) => stripped(c.args)[0] === 'commit')).toBe(false);
  });
});

describe('acquireSyncLock', () => {
  it('is exclusive, and a stale lock is stolen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-lock-'));
    try {
      const release = acquireSyncLock(dir);
      expect(release).not.toBeNull();
      expect(acquireSyncLock(dir)).toBeNull();
      release!();
      const again = acquireSyncLock(dir);
      expect(again).not.toBeNull();

      // Backdate the live lock past the staleness window — a new acquire steals it.
      const lockPath = path.join(dir, 'board-sync.lock');
      const old = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(lockPath, old, old);
      const stolen = acquireSyncLock(dir, 60_000);
      expect(stolen).not.toBeNull();
      stolen!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('BoardSyncScheduler', () => {
  it('coalesces a write burst into one run after the debounce', async () => {
    let runs = 0;
    const timers: Array<() => void> = [];
    const scheduler = new BoardSyncScheduler({
      debounceMs: 5000,
      run: async () => {
        runs++;
      },
      setTimer: ((cb: () => void) => {
        timers.push(cb);
        return timers.length as unknown as NodeJS.Timeout;
      }) as typeof setTimeout,
      clearTimer: ((id: NodeJS.Timeout) => {
        timers[(id as unknown as number) - 1] = () => {};
      }) as typeof clearTimeout,
    });

    scheduler.noteWrite();
    scheduler.noteWrite();
    scheduler.noteWrite();
    // Only the LAST armed timer is live; earlier ones were cleared.
    for (const t of timers) t();
    await Promise.resolve();

    expect(runs).toBe(1);
    scheduler.dispose();
  });

  it('single-flights: a request during a run queues exactly one follow-up', async () => {
    let running = 0;
    let runs = 0;
    let releaseFirst: (() => void) | undefined;
    const scheduler = new BoardSyncScheduler({
      run: () =>
        new Promise<void>((resolve) => {
          running++;
          runs++;
          if (runs === 1) {
            releaseFirst = () => {
              running--;
              resolve();
            };
          } else {
            running--;
            resolve();
          }
        }),
    });

    scheduler.requestSync();
    expect(running).toBe(1);
    scheduler.requestSync();
    scheduler.requestSync();
    scheduler.requestSync();
    releaseFirst!();
    await new Promise((r) => setTimeout(r, 0));

    expect(runs).toBe(2); // first run + exactly one coalesced follow-up
    scheduler.dispose();
  });
});

describe('runBoardAutoSync', () => {
  function tmpLockDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-sync-'));
  }

  it('folds a diverged remote with a two-parent merge and reset --keep (never --hard)', async () => {
    const primary = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-primary-'));
    const worktree = boardWorktreePathFor(primary);
    const exec = scriptedExec([
      { match: ['status', '--porcelain'], stdout: '' },
      { match: ['rev-parse', '--verify', '--quiet', `refs/heads/${REF}`], stdout: 'local1\n' },
      { match: ['fetch', '--quiet', REMOTE], stdout: '' },
      {
        match: ['rev-parse', '--verify', '--quiet', `refs/taskwright/fetch/${REF}`],
        stdout: 'remote1\n',
      },
      { match: ['merge-base', '--is-ancestor', 'remote1', 'local1'], fail: true },
      { match: ['merge-base', 'local1', 'remote1'], stdout: 'base1\n' },
      { match: ['ls-tree', '-r', '--name-only', 'base1'], stdout: 'backlog/tasks/a.md\n' },
      { match: ['ls-tree', '-r', '--name-only', 'local1'], stdout: 'backlog/tasks/a.md\n' },
      { match: ['ls-tree', '-r', '--name-only', 'remote1'], stdout: 'backlog/tasks/a.md\n' },
      { match: ['show', 'base1:backlog/tasks/a.md'], stdout: 'base\n' },
      { match: ['show', 'local1:backlog/tasks/a.md'], stdout: 'base\n' },
      { match: ['show', 'remote1:backlog/tasks/a.md'], stdout: 'theirs-newer\n' },
      { match: ['hash-object', '-w', '--'], stdout: 'blob1\n' },
      { match: ['write-tree'], stdout: 'mtree1\n' },
      { match: ['commit-tree', 'mtree1'], stdout: 'merged1\n' },
      { match: ['push', '--no-verify', REMOTE], stdout: '' },
    ]);

    try {
      const outcome = await runBoardAutoSync({
        primaryRoot: primary,
        ref: REF,
        remote: REMOTE,
        exec,
      });

      expect('skipped' in outcome).toBe(false);
      if ('skipped' in outcome) return;
      expect(outcome.merged).toBe(true);
      expect(outcome.pushed).toBe(true);
      expect(outcome.error).toBeUndefined();
      const reset = exec.calls.find((c) => stripped(c.args)[0] === 'reset');
      expect(reset).toBeDefined();
      expect(reset!.cwd).toBe(worktree);
      expect(stripped(reset!.args)).toEqual(['reset', '--keep', 'merged1']);
      expect(exec.calls.some((c) => c.args.includes('--hard'))).toBe(false);
    } finally {
      fs.rmSync(primary, { recursive: true, force: true });
    }
  });

  it('degrades to an outcome (never throws) when the remote is unreachable', async () => {
    const primary = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-primary-'));
    const exec = scriptedExec([
      { match: ['status', '--porcelain'], stdout: '' },
      { match: ['rev-parse', '--verify', '--quiet', `refs/heads/${REF}`], stdout: 'local1\n' },
      { match: ['fetch', '--quiet', REMOTE], fail: true },
      { match: ['push', '--no-verify', REMOTE], fail: true },
    ]);

    try {
      const outcome = await runBoardAutoSync({
        primaryRoot: primary,
        ref: REF,
        remote: REMOTE,
        exec,
      });

      expect('skipped' in outcome).toBe(false);
      if ('skipped' in outcome) return;
      expect(outcome.merged).toBe(false);
      expect(outcome.pushed).toBe(false);
      expect(outcome.remoteTip).toBeNull();
    } finally {
      fs.rmSync(primary, { recursive: true, force: true });
    }
  });

  it('skips when another process holds the lock', async () => {
    const lockDir = tmpLockDir();
    try {
      const held = acquireSyncLock(lockDir);
      expect(held).not.toBeNull();
      const exec = scriptedExec([]);
      const outcome = await runBoardAutoSync({
        primaryRoot: '/nowhere',
        ref: REF,
        remote: REMOTE,
        lockDir,
        exec,
      });
      expect(outcome).toEqual({ skipped: 'locked' });
      expect(exec.calls.length).toBe(0);
      held!();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});
