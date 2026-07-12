/**
 * Tests for requestMergeHandler and getActiveTask queuePosition.
 *
 * Strategy: use real temp directories instead of vi.mock('fs'). This avoids a
 * vitest v4.1.8 + Node v24 + SWC transformer OOM crash that occurs when the test
 * module contains too many complex closures (even in a vi.mock factory).
 *
 * Queue/config I/O is injected via deps.fsDeps (in-memory QueueFsDeps), so
 * BacklogParser and readActiveTask can use the real fs against temp dirs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { TreeFieldService } from '../../core/TreeFieldService';
import { requestMergeHandler, getActiveTask, type McpHandlerDeps } from '../../mcp/handlers';
import type { GitExecFn, RunFn, MergeProgress } from '../../core/finishTask';
import type { QueueFsDeps } from '../../core/mergeQueue';

/** In-memory QueueFsDeps backed by a plain object — no vi.mock needed. */
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const TASK_MD = `---
id: TASK-7
title: Sample
status: In Progress
assignee: []
dependencies: []
---
## Description
<!-- SECTION:DESCRIPTION:BEGIN -->
x
<!-- SECTION:DESCRIPTION:END -->
`;

/**
 * Set up a minimal backlog directory structure under `root` with a single task.
 */
function scaffoldBacklog(root: string): void {
  const tasksDir = path.join(root, 'backlog', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, 'task-7 - Sample.md'), TASK_MD, 'utf-8');
}

/**
 * Write active-task.json under root/.taskwright/.
 */
function writeActiveTask(root: string, taskId: string): void {
  const dir = path.join(root, '.taskwright');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'active-task.json'),
    JSON.stringify({ taskId, setAt: '2026-07-01T00:00:00Z' }),
    'utf-8'
  );
}

/**
 * Git facts: worktree gitDir, common dir, branch, plus happy-path merge ops.
 * `primaryRoot` is '/primary' for ff-merge symbolic-ref checks.
 */
function makeGitExec(primaryRoot: string): GitExecFn {
  return async (cwd, args) => {
    if (args.join(' ') === 'rev-parse --git-dir') {
      if (cwd === primaryRoot) return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
      return { stdout: `${primaryRoot}/.git/worktrees/task-7-x`, stderr: '' };
    }
    if (args.join(' ') === 'rev-parse --git-common-dir')
      return { stdout: `${primaryRoot}/.git`, stderr: '' };
    if (args[0] === 'symbolic-ref') {
      // primary tree is on 'main'; worktree is on 'task-7-x'
      if (cwd === primaryRoot) return { stdout: 'main', stderr: '' };
      return { stdout: 'task-7-x', stderr: '' };
    }
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args[0] === 'rebase') return { stdout: '', stderr: '' };
    if (args[0] === 'merge') return { stdout: '', stderr: '' };
    if (args[0] === 'worktree') return { stdout: '', stderr: '' };
    if (args[0] === 'branch') return { stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('refs/heads/main'))
      return { stdout: 'abc', stderr: '' };
    if (args[0] === 'rev-parse') throw new Error('no ref');
    return { stdout: '', stderr: '' };
  };
}

function makeDeps(root: string, overrides: Partial<McpHandlerDeps> = {}): McpHandlerDeps {
  const backlog = path.join(root, 'backlog');
  const primaryRoot = path.dirname(path.dirname(root)); // /primary from /primary/.worktrees/task-7-x
  return {
    root,
    backlogPath: backlog,
    parser: new BacklogParser(backlog),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
    treeFieldService: new TreeFieldService(),
    gitExec: makeGitExec(primaryRoot),
    shellRun: (async () => ({ code: 0, stdout: '', stderr: '' })) as RunFn,
    now: () => new Date('2026-07-01T12:00:00.000Z'),
    sleep: async () => {},
    ...overrides,
  };
}

describe('requestMergeHandler', () => {
  it('rejects when run from the primary tree (not a worktree)', async () => {
    const root = tmpDir;
    scaffoldBacklog(root);
    // primary tree: git rev-parse --git-dir returns .git (no worktrees/ segment)
    const primaryExec: GitExecFn = async (_c, args) => {
      if (args.join(' ') === 'rev-parse --git-dir') return { stdout: `${root}/.git`, stderr: '' };
      if (args.join(' ') === 'rev-parse --git-common-dir')
        return { stdout: `${root}/.git`, stderr: '' };
      if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const backlog = path.join(root, 'backlog');
    const r = await requestMergeHandler(
      {
        root,
        backlogPath: backlog,
        parser: new BacklogParser(backlog),
        writer: new BacklogWriter(),
        claimService: new ClaimService(),
        planService: new PlanService(),
        treeFieldService: new TreeFieldService(),
        gitExec: primaryExec,
        shellRun: (async () => ({ code: 0, stdout: '', stderr: '' })) as RunFn,
      },
      { taskId: 'TASK-7' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') {
      expect(r.reason).toMatch(/worktree/i);
      // TASK-122: distinct from a cancellation. A session that bootstrapped its
      // own worktree via start_task is still MCP-rooted in the primary tree, so
      // a bare request_merge lands here — /execute-task used to read this abort
      // as "the worktree vanished ⇒ cancelled" and drop the finished work.
      expect(r.code).toBe('wrong_root');
    }
  });

  it('auto-merge integrates the task end-to-end', async () => {
    // Worktree layout: <tmpDir>/primary/.worktrees/task-7-x
    const primaryRoot = path.join(tmpDir, 'primary');
    const root = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(root, { recursive: true });
    scaffoldBacklog(root);

    // In-memory fsDeps holds merge-config.json
    const memStore: Record<string, string> = {};
    const commonDir = `${primaryRoot}/.git`;
    memStore[path.join(commonDir, 'taskwright', 'merge-config.json')] = JSON.stringify({
      mode: 'auto-merge',
      verifyCommands: [], // skip real verify so the test doesn't run bun commands
    });
    const fsDeps = makeMemFsDeps(memStore);

    const statuses: string[] = [];
    const released: string[] = [];
    const board = {
      setStatus: async (_id: string, s: string) => {
        statuses.push(s);
      },
      release: async (id: string) => {
        released.push(id);
      },
      resetTaskFile: async () => {},
    };

    const r = await requestMergeHandler(makeDeps(root, { board, fsDeps }), { taskId: 'TASK-7' });
    expect(r.status).toBe('merged');
    // Marked Done on the board and released, but not filed into completed/.
    expect(statuses.at(-1)).toBe('Done');
    expect(released).toEqual(['TASK-7']);
  });

  /** Scaffold a worktree + in-memory merge-config for the timeout tests. */
  function timeoutFixture(config: Record<string, unknown>): {
    root: string;
    fsDeps: QueueFsDeps;
    board: {
      setStatus: () => Promise<void>;
      release: () => Promise<void>;
      resetTaskFile: () => Promise<void>;
    };
    timeouts: Array<number | undefined>;
    run: RunFn;
  } {
    const primaryRoot = path.join(tmpDir, 'primary');
    const root = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(root, { recursive: true });
    scaffoldBacklog(root);
    const memStore: Record<string, string> = {};
    const commonDir = `${primaryRoot}/.git`;
    memStore[path.join(commonDir, 'taskwright', 'merge-config.json')] = JSON.stringify({
      mode: 'auto-merge',
      verifyCommands: ['fake verify'],
      ...config,
    });
    const timeouts: Array<number | undefined> = [];
    const run: RunFn = async (_cwd, _cmd, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { code: 0, stdout: '', stderr: '' };
    };
    return {
      root,
      fsDeps: makeMemFsDeps(memStore),
      board: {
        setStatus: async () => {},
        release: async () => {},
        resetTaskFile: async () => {},
      },
      timeouts,
      run,
    };
  }

  it('runs verify with the config verifyTimeoutMs by default', async () => {
    const f = timeoutFixture({ verifyTimeoutMs: 720_000 });
    const r = await requestMergeHandler(
      makeDeps(f.root, { board: f.board, fsDeps: f.fsDeps, shellRun: f.run }),
      { taskId: 'TASK-7' }
    );
    expect(r.status).toBe('merged');
    expect(f.timeouts.every((t) => t === 720_000)).toBe(true);
  });

  it('honors a per-call verifyTimeoutMinutes override', async () => {
    const f = timeoutFixture({});
    const r = await requestMergeHandler(
      makeDeps(f.root, { board: f.board, fsDeps: f.fsDeps, shellRun: f.run }),
      { taskId: 'TASK-7', verifyTimeoutMinutes: 25 }
    );
    expect(r.status).toBe('merged');
    expect(f.timeouts.length).toBeGreaterThan(0);
    expect(f.timeouts.every((t) => t === 25 * 60_000)).toBe(true);
  });

  it('clamps the per-call override to the repo-level verifyTimeoutMaxMs', async () => {
    const f = timeoutFixture({ verifyTimeoutMaxMs: 20 * 60_000 });
    const r = await requestMergeHandler(
      makeDeps(f.root, { board: f.board, fsDeps: f.fsDeps, shellRun: f.run }),
      { taskId: 'TASK-7', verifyTimeoutMinutes: 25 }
    );
    expect(r.status).toBe('merged');
    expect(f.timeouts.every((t) => t === 20 * 60_000)).toBe(true);
  });

  it('ignores a non-positive per-call override', async () => {
    const f = timeoutFixture({ verifyTimeoutMs: 720_000 });
    const r = await requestMergeHandler(
      makeDeps(f.root, { board: f.board, fsDeps: f.fsDeps, shellRun: f.run }),
      { taskId: 'TASK-7', verifyTimeoutMinutes: 0 }
    );
    expect(r.status).toBe('merged');
    expect(f.timeouts.every((t) => t === 720_000)).toBe(true);
  });

  it('returns pending (entry kept) when waitMinutes elapses before approval (TASK-88)', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const root = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(root, { recursive: true });
    scaffoldBacklog(root);
    const memStore: Record<string, string> = {};
    const commonDir = `${primaryRoot}/.git`;
    memStore[path.join(commonDir, 'taskwright', 'merge-config.json')] = JSON.stringify({
      mode: 'manual-review',
      verifyCommands: [],
    });
    const fsDeps = makeMemFsDeps(memStore);
    const board = {
      setStatus: async () => {},
      release: async () => {},
      resetTaskFile: async () => {},
    };
    // Never approved; waitMinutes 0 ⇒ one gate check, then pending.
    const r = await requestMergeHandler(makeDeps(root, { board, fsDeps }), {
      taskId: 'TASK-7',
      waitMinutes: 0,
    });
    expect(r.status).toBe('pending');
    if (r.status === 'pending') {
      expect(r.queuePosition).toBe(1);
      expect(r.ticket).toContain('TASK-7@');
    }
    const queued = JSON.parse(memStore[path.join(commonDir, 'taskwright', 'merge-queue.json')]);
    expect(queued.entries.map((e: { taskId: string }) => e.taskId)).toEqual(['TASK-7']);
  });

  it('threads onProgress through to the verify phase (TASK-88)', async () => {
    const f = timeoutFixture({});
    const events: MergeProgress[] = [];
    const r = await requestMergeHandler(
      makeDeps(f.root, { board: f.board, fsDeps: f.fsDeps, shellRun: f.run }),
      { taskId: 'TASK-7' },
      (e) => events.push(e)
    );
    expect(r.status).toBe('merged');
    expect(events.some((e) => e.phase === 'verify' && e.command === 'fake verify')).toBe(true);
  });
});

describe('getActiveTask queue position', () => {
  it('reports queuePosition when the active task is queued', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const root = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(root, { recursive: true });
    scaffoldBacklog(root);
    writeActiveTask(root, 'TASK-7');

    // In-memory fsDeps holds merge-queue.json
    const memStore: Record<string, string> = {};
    const commonDir = `${primaryRoot}/.git`;
    memStore[path.join(commonDir, 'taskwright', 'merge-queue.json')] = JSON.stringify({
      version: 1,
      entries: [
        {
          taskId: 'TASK-7',
          branch: 'task-7-x',
          worktree: '.worktrees/task-7-x',
          mode: 'manual-review',
          submittedAt: 'x',
          approved: false,
          active: false,
          activeAt: null,
        },
      ],
    });
    const fsDeps = makeMemFsDeps(memStore);

    const result = await getActiveTask(makeDeps(root, { fsDeps }));
    expect(result.active).toBe(true);
    expect(result.queuePosition).toBe(1);
  });
});
