// src/test/unit/requestBranchMergeHandler.test.ts
//
// TASK-127 — `request_branch_merge`: the MCP surface of the task-less merge path.
// It must reuse the task path's target resolution, its gates, and its abort codes
// (AC3), while making no board mutation and leaving the dev worktree in place
// unless removal is opted into (AC2).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { TreeFieldService } from '../../core/TreeFieldService';
import { requestBranchMergeHandler, type McpHandlerDeps } from '../../mcp/handlers';
import type { GitExecFn, RunFn, BoardOps } from '../../core/finishTask';
import { branchMergeKey, MergeQueueStore, mergeQueuePath } from '../../core/mergeQueue';
import type { QueueFsDeps } from '../../core/mergeQueue';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-branch-merge-'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function memFs(store: Record<string, string> = {}): QueueFsDeps {
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

/** auto-merge config (no manual gate) with an empty verify list unless overridden. */
function configFs(
  primaryRoot: string,
  over: Record<string, unknown> = {},
  store: Record<string, string> = {}
): QueueFsDeps {
  store[path.join(primaryRoot, '.git', 'taskwright', 'merge-config.json')] = JSON.stringify({
    mode: 'auto-merge',
    verifyCommands: [],
    ...over,
  });
  return memFs(store);
}

interface ExecOpts {
  dirty?: boolean;
  detached?: boolean;
  omitFromList?: boolean;
  /** The branch checked out in the target worktree. */
  targetBranch?: string;
  onArgs?: (args: string[]) => void;
}

/** A primary-rooted session (deps.root === primaryRoot) with one linked dev worktree. */
function devGitExec(primaryRoot: string, worktreeAbs: string, opts: ExecOpts = {}): GitExecFn {
  const targetBranch = opts.targetBranch ?? 'tech-tree-p5';
  return async (cwd, args) => {
    opts.onArgs?.(args);
    const joined = args.join(' ');
    if (joined === 'rev-parse --git-dir' || joined === 'rev-parse --git-common-dir')
      return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'list') {
      const branchLine = opts.detached ? 'detached' : `branch refs/heads/${targetBranch}`;
      const stanza = opts.omitFromList
        ? ''
        : `\nworktree ${worktreeAbs}\nHEAD 2222222222222222222222222222222222222222\n${branchLine}\n`;
      return {
        stdout: `worktree ${primaryRoot}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n${stanza}`,
        stderr: '',
      };
    }
    if (args[0] === 'status') {
      if (cwd === worktreeAbs && opts.dirty) return { stdout: ' M src/x.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'symbolic-ref')
      return { stdout: cwd === primaryRoot ? 'main' : targetBranch, stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('refs/heads/main'))
      return { stdout: 'abc', stderr: '' };
    if (args[0] === 'rev-parse') throw new Error('no ref');
    return { stdout: '', stderr: '' }; // rebase / merge / worktree remove / branch -D / diff
  };
}

function spyBoard(): BoardOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setStatus: async (id, s) => void calls.push(`setStatus:${id}:${s}`),
    release: async (id) => void calls.push(`release:${id}`),
    resetTaskFile: async (id) => void calls.push(`resetTaskFile:${id}`),
  };
}

function handlerDeps(root: string, over: Partial<McpHandlerDeps>): McpHandlerDeps {
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
    now: () => new Date('2026-07-14T12:00:00.000Z'),
    sleep: async () => {},
    ...over,
  };
}

/** A primary root with a linked `.worktrees/tech-tree-p5` dev worktree on disk. */
function scaffold(): { primaryRoot: string; worktreeAbs: string } {
  const primaryRoot = path.join(tmpDir, 'primary');
  const worktreeAbs = path.join(primaryRoot, '.worktrees', 'tech-tree-p5');
  fs.mkdirSync(worktreeAbs, { recursive: true });
  return { primaryRoot, worktreeAbs };
}

describe('requestBranchMergeHandler — the task-less close (TASK-127)', () => {
  it('merges a named dev worktree with no taskId: rebase -> verify -> queue -> ff-merge', async () => {
    const { primaryRoot, worktreeAbs } = scaffold();
    const calls: string[][] = [];
    const board = spyBoard();

    const r = await requestBranchMergeHandler(
      handlerDeps(primaryRoot, {
        gitExec: devGitExec(primaryRoot, worktreeAbs, { onArgs: (a) => calls.push(a) }),
        board,
        fsDeps: configFs(primaryRoot),
      }),
      { worktree: 'tech-tree-p5' }
    );

    expect(r.status).toBe('merged');
    if (r.status === 'merged') {
      expect(r.branch).toBe('tech-tree-p5');
      expect(r.worktree).toBe('.worktrees/tech-tree-p5');
      expect(r.worktreeRemoved).toBe(false);
    }
    expect(calls).toContainEqual(['rebase', 'main']);
    expect(calls).toContainEqual(['merge', '--ff-only', 'tech-tree-p5']);
    // AC2: not one board write.
    expect(board.calls).toEqual([]);
    // AC2: the dev worktree (and its branch) survive the merge by default.
    expect(calls.some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(false);
    expect(calls.some((a) => a[0] === 'branch' && a[1] === '-D')).toBe(false);
  });

  it('tears the worktree down when removeWorktree is opted into', async () => {
    const { primaryRoot, worktreeAbs } = scaffold();
    const calls: string[][] = [];

    const r = await requestBranchMergeHandler(
      handlerDeps(primaryRoot, {
        gitExec: devGitExec(primaryRoot, worktreeAbs, { onArgs: (a) => calls.push(a) }),
        fsDeps: configFs(primaryRoot),
      }),
      { worktree: 'tech-tree-p5', removeWorktree: true }
    );

    expect(r.status).toBe('merged');
    if (r.status === 'merged') expect(r.worktreeRemoved).toBe(true);
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '.worktrees/tech-tree-p5']);
    expect(calls).toContainEqual(['branch', '-D', 'tech-tree-p5']);
  });

  it('enqueues under a `branch:` key that cannot collide with a task ID', async () => {
    const { primaryRoot, worktreeAbs } = scaffold();
    const store: Record<string, string> = {};
    // A foreign head holds the right of way, so we park and can inspect the entry.
    const fsDeps = configFs(primaryRoot, {}, store);
    store[mergeQueuePath(path.join(primaryRoot, '.git'))] = JSON.stringify({
      version: 1,
      entries: [
        {
          taskId: 'TASK-9',
          branch: 'task-9-y',
          worktree: '.worktrees/task-9-y',
          mode: 'auto-merge',
          submittedAt: '2026-07-14T11:00:00.000Z',
          approved: false,
          active: false,
          activeAt: null,
        },
      ],
    });

    const r = await requestBranchMergeHandler(
      handlerDeps(primaryRoot, {
        gitExec: devGitExec(primaryRoot, worktreeAbs),
        fsDeps,
      }),
      { worktree: 'tech-tree-p5', waitMinutes: 0 }
    );

    expect(r.status).toBe('pending');
    if (r.status === 'pending') {
      expect(r.branch).toBe('tech-tree-p5');
      expect(r.queuePosition).toBe(2); // behind the task merge — ONE shared FIFO
      expect(r.ticket).toContain('branch:tech-tree-p5');
    }
    const queued = new MergeQueueStore(mergeQueuePath(path.join(primaryRoot, '.git')), fsDeps)
      .read()
      .entries.map((e) => e.taskId);
    expect(queued).toEqual(['TASK-9', branchMergeKey('tech-tree-p5')]);
  });

  it('reuses verify_failed (not a new code) when the dev branch fails verification', async () => {
    const { primaryRoot, worktreeAbs } = scaffold();
    const r = await requestBranchMergeHandler(
      handlerDeps(primaryRoot, {
        gitExec: devGitExec(primaryRoot, worktreeAbs),
        fsDeps: configFs(primaryRoot, { verifyCommands: ['bun run test'] }),
        shellRun: (async () => ({ code: 1, stdout: 'FAIL', stderr: '' })) as RunFn,
      }),
      { worktree: 'tech-tree-p5' }
    );

    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.code).toBe('verify_failed');
  });

  it('aborts wrong_root when called bare from the primary tree — the same misuse, the same code', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    fs.mkdirSync(primaryRoot, { recursive: true });
    const primaryExec: GitExecFn = async (_c, args) => {
      const joined = args.join(' ');
      if (joined === 'rev-parse --git-dir' || joined === 'rev-parse --git-common-dir')
        return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
      if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    const r = await requestBranchMergeHandler(
      handlerDeps(primaryRoot, { gitExec: primaryExec, fsDeps: memFs() }),
      {}
    );

    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') {
      expect(r.code).toBe('wrong_root');
      // The advice must name THIS tool, not send the caller to request_merge.
      expect(r.reason).toContain('request_branch_merge');
      expect(r.reason).toMatch(/worktree/i);
    }
  });

  it('refuses to merge the base branch into itself', async () => {
    const { primaryRoot, worktreeAbs } = scaffold();
    const r = await requestBranchMergeHandler(
      handlerDeps(primaryRoot, {
        gitExec: devGitExec(primaryRoot, worktreeAbs, { targetBranch: 'main' }),
        fsDeps: configFs(primaryRoot),
      }),
      { worktree: 'tech-tree-p5' }
    );

    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/base branch/i);
  });

  it('refuses a dirty dev worktree (never silently drops its WIP)', async () => {
    const { primaryRoot, worktreeAbs } = scaffold();
    const r = await requestBranchMergeHandler(
      handlerDeps(primaryRoot, {
        gitExec: devGitExec(primaryRoot, worktreeAbs, { dirty: true }),
        fsDeps: configFs(primaryRoot),
      }),
      { worktree: 'tech-tree-p5' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/uncommitted/i);
  });

  it('refuses a detached target, and one outside .worktrees/', async () => {
    const { primaryRoot, worktreeAbs } = scaffold();
    const detached = await requestBranchMergeHandler(
      handlerDeps(primaryRoot, {
        gitExec: devGitExec(primaryRoot, worktreeAbs, { detached: true }),
        fsDeps: configFs(primaryRoot),
      }),
      { worktree: 'tech-tree-p5' }
    );
    expect(detached.status).toBe('aborted');
    if (detached.status === 'aborted') expect(detached.reason).toMatch(/detached/i);

    const outside = await requestBranchMergeHandler(
      handlerDeps(primaryRoot, {
        gitExec: devGitExec(primaryRoot, worktreeAbs),
        fsDeps: configFs(primaryRoot),
      }),
      { worktree: '../evil' }
    );
    expect(outside.status).toBe('aborted');
    if (outside.status === 'aborted') expect(outside.reason).toMatch(/\.worktrees/i);
  });
});
