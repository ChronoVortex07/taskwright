// src/test/unit/requestMergeWorktreeTarget.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { TreeFieldService } from '../../core/TreeFieldService';
import {
  parseWorktreeEntries,
  isSamePath,
  requestMergeHandler,
  type McpHandlerDeps,
} from '../../mcp/handlers';
import type { GitExecFn, RunFn, BoardOps } from '../../core/finishTask';
import type { QueueFsDeps } from '../../core/mergeQueue';

const PORCELAIN = `worktree /repo/primary
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/primary/.worktrees/task-7-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/task-7-x

worktree /repo/primary/.worktrees/detached-one
HEAD 3333333333333333333333333333333333333333
detached

worktree /repo/bare.git
bare
`;

describe('parseWorktreeEntries', () => {
  it('groups each porcelain stanza into { path, branch, detached, bare }', () => {
    const entries = parseWorktreeEntries(PORCELAIN);
    expect(entries).toEqual([
      { path: '/repo/primary', branch: 'main', detached: false, bare: false },
      {
        path: '/repo/primary/.worktrees/task-7-x',
        branch: 'task-7-x',
        detached: false,
        bare: false,
      },
      {
        path: '/repo/primary/.worktrees/detached-one',
        branch: null,
        detached: true,
        bare: false,
      },
      { path: '/repo/bare.git', branch: null, detached: false, bare: true },
    ]);
  });

  it('strips the refs/heads/ prefix and tolerates CRLF + a trailing stanza with no blank line', () => {
    const entries = parseWorktreeEntries(
      'worktree /a\r\nHEAD abc\r\nbranch refs/heads/feature/x\r\n'
    );
    expect(entries).toEqual([
      { path: '/a', branch: 'feature/x', detached: false, bare: false },
    ]);
  });

  it('returns [] for empty output and ignores leading noise before the first `worktree` line', () => {
    expect(parseWorktreeEntries('')).toEqual([]);
    expect(parseWorktreeEntries('garbage\nbranch refs/heads/x\n')).toEqual([]);
  });
});

describe('isSamePath', () => {
  it('is case-insensitive on Windows-like platforms (drive-letter case must not matter)', () => {
    // Regression: git worktree list reports `C:\…` while primaryRoot may be derived as `c:\…`.
    expect(isSamePath('C:/repo/.worktrees/x', 'c:/repo/.worktrees/x', true)).toBe(true);
    expect(isSamePath('C:/Repo/A', 'c:/repo/a', true)).toBe(true);
  });
  it('is case-sensitive on POSIX-like platforms', () => {
    expect(isSamePath('/repo/a', '/repo/a', false)).toBe(true);
    expect(isSamePath('/repo/A', '/repo/a', false)).toBe(false);
  });
  it('normalizes separators/segments before comparing', () => {
    expect(isSamePath('/repo/a/b', '/repo/./a/b', false)).toBe(true);
  });
});

function makeMemFsDeps(store: Record<string, string> = {}): QueueFsDeps {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(store, p),
    read: (p) => {
      if (Object.prototype.hasOwnProperty.call(store, p)) return store[p];
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
    writeAtomic: (p, data) => {
      store[p] = data;
    },
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wt-target-'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

interface ExecOpts {
  dirtyWorktree?: boolean;
  detachedTarget?: boolean;
  omitTargetFromList?: boolean;
  /** Return a RELATIVE `.git` for rev-parse --git-dir/--git-common-dir, as git does from the
   *  primary tree — the case that broke the worktree target when path.resolve dropped the cwd. */
  relativeGitDir?: boolean;
  onArgs?: (args: string[]) => void;
}

/**
 * Git exec for a session rooted at `primaryRoot` (deps.root === primaryRoot),
 * targeting the linked worktree `worktreeAbs`. Answers every git call the
 * handler + requestMerge core make on the happy path.
 */
function targetGitExec(primaryRoot: string, worktreeAbs: string, opts: ExecOpts = {}): GitExecFn {
  return async (cwd, args) => {
    opts.onArgs?.(args);
    const joined = args.join(' ');
    if (joined === 'rev-parse --git-dir')
      return { stdout: opts.relativeGitDir ? '.git' : path.join(primaryRoot, '.git'), stderr: '' };
    if (joined === 'rev-parse --git-common-dir')
      return { stdout: opts.relativeGitDir ? '.git' : path.join(primaryRoot, '.git'), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'list') {
      const branchLine = opts.detachedTarget ? 'detached' : 'branch refs/heads/task-7-x';
      const targetStanza = opts.omitTargetFromList
        ? ''
        : `\nworktree ${worktreeAbs}\nHEAD 2222222222222222222222222222222222222222\n${branchLine}\n`;
      return {
        stdout: `worktree ${primaryRoot}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n${targetStanza}`,
        stderr: '',
      };
    }
    if (args[0] === 'status') {
      if (cwd === worktreeAbs && opts.dirtyWorktree) return { stdout: ' M src/x.ts\n', stderr: '' };
      return { stdout: '', stderr: '' }; // clean (primary + worktree)
    }
    if (args[0] === 'symbolic-ref') {
      if (cwd === primaryRoot) return { stdout: 'main', stderr: '' };
      return { stdout: 'task-7-x', stderr: '' };
    }
    if (args[0] === 'rebase') return { stdout: '', stderr: '' };
    if (args[0] === 'merge') return { stdout: '', stderr: '' };
    if (args[0] === 'worktree') return { stdout: '', stderr: '' }; // remove / prune
    if (args[0] === 'branch') return { stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('refs/heads/main')) return { stdout: 'abc', stderr: '' };
    if (args[0] === 'rev-parse') throw new Error('no ref');
    return { stdout: '', stderr: '' };
  };
}

function recordingBoard(): BoardOps & { statuses: string[]; released: string[] } {
  const rec = {
    statuses: [] as string[],
    released: [] as string[],
    setStatus: async (_id: string, s: string) => {
      rec.statuses.push(s);
    },
    release: async (id: string) => {
      rec.released.push(id);
    },
    resetTaskFile: async () => {},
  };
  return rec;
}

/** auto-merge config in an in-memory fsDeps keyed by the shared commonDir. */
function autoMergeFsDeps(primaryRoot: string): QueueFsDeps {
  const store: Record<string, string> = {};
  const commonDir = path.join(primaryRoot, '.git');
  store[path.join(commonDir, 'taskwright', 'merge-config.json')] = JSON.stringify({
    mode: 'auto-merge',
    verifyCommands: [], // skip real verify so the test runs no bun commands
  });
  return makeMemFsDeps(store);
}

function makeHandlerDeps(root: string, overrides: Partial<McpHandlerDeps>): McpHandlerDeps {
  const backlog = path.join(root, 'backlog');
  return {
    root,
    backlogPath: backlog,
    parser: new BacklogParser(backlog),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
    treeFieldService: new TreeFieldService(),
    shellRun: (async () => ({ code: 0, stdout: '', stderr: '' })) as RunFn,
    now: () => new Date('2026-07-08T12:00:00.000Z'),
    sleep: async () => {},
    ...overrides,
  };
}

describe('requestMergeHandler — explicit worktree target (root-override, DRAFT-4)', () => {
  it('valid target: primary-rooted call completes rebase -> verify -> queue -> ff-merge -> cleanup', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const worktreeAbs = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(worktreeAbs, { recursive: true });

    const removeArgs: string[][] = [];
    const exec = targetGitExec(primaryRoot, worktreeAbs, {
      onArgs: (a) => {
        if (a[0] === 'worktree' && a[1] === 'remove') removeArgs.push(a);
      },
    });
    const board = recordingBoard();

    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, { gitExec: exec, board, fsDeps: autoMergeFsDeps(primaryRoot) }),
      { taskId: 'TASK-7', worktree: 'task-7-x' }
    );

    expect(r.status).toBe('merged');
    expect(board.statuses[0]).toBe('Awaiting Merge'); // auto-merge intermediate status
    expect(board.statuses.at(-1)).toBe('Done');
    expect(board.released).toEqual(['TASK-7']);
    // Cleanup ran against the validated worktree's primaryRoot-relative path.
    expect(removeArgs.at(-1)).toEqual(['worktree', 'remove', '--force', '.worktrees/task-7-x']);
  });

  it('accepts a repo-root-relative .worktrees path form as well as a bare branch name', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const worktreeAbs = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(worktreeAbs, { recursive: true });
    const board = recordingBoard();

    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, {
        gitExec: targetGitExec(primaryRoot, worktreeAbs),
        board,
        fsDeps: autoMergeFsDeps(primaryRoot),
      }),
      { taskId: 'TASK-7', worktree: '.worktrees/task-7-x' }
    );
    expect(r.status).toBe('merged');
  });

  it('resolves a RELATIVE --git-dir/--git-common-dir (primary tree) against deps.root, not the process cwd', async () => {
    // Regression: from the primary tree git returns ".git" (relative). A bare path.resolve()
    // resolved it against the MCP process cwd, so primaryRoot — and thus the worktree target —
    // came out wrong and Gate 2 wrongly reported "not a linked worktree". Resolving against
    // deps.root fixes it. Without the fix this call aborts instead of merging.
    const primaryRoot = path.join(tmpDir, 'primary');
    const worktreeAbs = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(worktreeAbs, { recursive: true });
    const board = recordingBoard();

    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, {
        gitExec: targetGitExec(primaryRoot, worktreeAbs, { relativeGitDir: true }),
        board,
        fsDeps: autoMergeFsDeps(primaryRoot),
      }),
      { taskId: 'TASK-7', worktree: 'task-7-x' }
    );
    expect(r.status).toBe('merged');
    expect(board.statuses.at(-1)).toBe('Done');
  });

  it('bare primary-tree call (no worktree arg) still aborts with the isPrimaryTree message', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    fs.mkdirSync(primaryRoot, { recursive: true });
    // rev-parse --git-dir returns .git with NO /.git/worktrees/ segment => primary.
    const primaryExec: GitExecFn = async (_c, args) => {
      if (args.join(' ') === 'rev-parse --git-dir') return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
      if (args.join(' ') === 'rev-parse --git-common-dir') return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
      if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, { gitExec: primaryExec, fsDeps: makeMemFsDeps() }),
      { taskId: 'TASK-7' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/primary tree/i);
  });

  it('refuses a dirty target with a clear reason', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const worktreeAbs = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(worktreeAbs, { recursive: true });
    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, {
        gitExec: targetGitExec(primaryRoot, worktreeAbs, { dirtyWorktree: true }),
        board: recordingBoard(),
        fsDeps: autoMergeFsDeps(primaryRoot),
      }),
      { taskId: 'TASK-7', worktree: 'task-7-x' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/uncommitted/i);
  });

  it('refuses a detached target with a clear reason', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const worktreeAbs = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(worktreeAbs, { recursive: true });
    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, {
        gitExec: targetGitExec(primaryRoot, worktreeAbs, { detachedTarget: true }),
        board: recordingBoard(),
        fsDeps: autoMergeFsDeps(primaryRoot),
      }),
      { taskId: 'TASK-7', worktree: 'task-7-x' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/detached/i);
  });

  it('refuses a target that is not a linked worktree of this repo', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const worktreeAbs = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(worktreeAbs, { recursive: true });
    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, {
        gitExec: targetGitExec(primaryRoot, worktreeAbs, { omitTargetFromList: true }),
        board: recordingBoard(),
        fsDeps: autoMergeFsDeps(primaryRoot),
      }),
      { taskId: 'TASK-7', worktree: 'task-7-x' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/not a linked worktree/i);
  });

  it('refuses a target outside .worktrees/ before any git worktree call', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    fs.mkdirSync(primaryRoot, { recursive: true });
    const listCalls: string[][] = [];
    const exec: GitExecFn = async (_c, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') listCalls.push(args);
      if (args.join(' ') === 'rev-parse --git-dir') return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
      if (args.join(' ') === 'rev-parse --git-common-dir') return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
      if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, { gitExec: exec, board: recordingBoard(), fsDeps: makeMemFsDeps() }),
      { taskId: 'TASK-7', worktree: '../evil' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/\.worktrees/i);
    expect(listCalls).toHaveLength(0); // containment rejected before listing worktrees
  });
});
