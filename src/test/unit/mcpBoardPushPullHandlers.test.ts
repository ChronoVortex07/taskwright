/**
 * Tests for pushBoardHandler / pullBoardHandler (Board Sync v2 Task F).
 *
 * `deps.gitExec` (used only by `gitFacts` to locate `sync-config.json`) is
 * faked to point at a scratch directory — never real git — so these tests
 * can't accidentally resolve against THIS repo's own `.git` (see
 * `mcpMergeHandlers.test.ts`'s identical `makeGitExec` convention). The
 * actual board git-plumbing (`deps.boardExec`, defaulting to real git) runs
 * against real temporary git repos, matching `boardPushPull.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { TreeFieldService } from '../../core/TreeFieldService';
import { pushBoardHandler, pullBoardHandler, type McpHandlerDeps } from '../../mcp/handlers';
import type { GitExecFn } from '../../core/finishTask';
import { writeSyncConfig, syncConfigPath, DEFAULT_SYNC_CONFIG } from '../../core/syncConfig';
import { nodeQueueFs } from '../../core/mergeQueue';
import { makeTempGitRepo, TempRepo } from './helpers/tempGitRepo';

// Real-git plumbing against temp origin+clone repos (many spawns per test). On
// a loaded Windows box (e.g. parallel merge-queue verifies) spawn latency alone
// can blow vitest's 5s default — these are not 5s-shaped tests.
vi.setConfig({ testTimeout: 30_000 });

const execFileAsync = promisify(execFile);

async function makeOriginAndClone(): Promise<{
  origin: string;
  clone: TempRepo;
  cleanup: () => void;
}> {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-mcp-pushpull-origin-'));
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const clone = await makeTempGitRepo();
  await clone.git(['remote', 'add', 'origin', origin]);
  await clone.git(['push', '-q', 'origin', 'main']);
  return {
    origin,
    clone,
    cleanup: () => {
      clone.cleanup();
      fs.rmSync(origin, { recursive: true, force: true });
    },
  };
}

async function addSecondClone(origin: string): Promise<TempRepo> {
  const clone = await makeTempGitRepo();
  await clone.git(['remote', 'add', 'origin', origin]);
  await clone.git(['fetch', '-q', 'origin', 'main']);
  await clone.git(['reset', '-q', '--hard', 'origin/main']);
  return clone;
}

/** A gitFacts-only fake: commonDir is a scratch dir, never this repo's real `.git`. */
function makeFakeGitExec(commonDir: string): GitExecFn {
  return async (_cwd, args) => {
    if (args.join(' ') === 'rev-parse --git-dir') return { stdout: commonDir, stderr: '' };
    if (args.join(' ') === 'rev-parse --git-common-dir') return { stdout: commonDir, stderr: '' };
    if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
    return { stdout: '', stderr: '' };
  };
}

function makeDeps(
  root: string,
  commonDir: string,
  overrides: Partial<McpHandlerDeps> = {}
): McpHandlerDeps {
  const backlog = path.join(root, 'backlog');
  return {
    root,
    backlogPath: backlog,
    parser: new BacklogParser(backlog),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
    treeFieldService: new TreeFieldService(),
    gitExec: makeFakeGitExec(commonDir),
    ...overrides,
  };
}

describe('pushBoardHandler / pullBoardHandler', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  });

  function scratchCommonDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-mcp-pushpull-common-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it('is a no-op with a message when sync is off (the default)', async () => {
    const { clone, cleanup } = await makeOriginAndClone();
    cleanups.push(cleanup);
    clone.addGitignore(['.taskwright/', 'backlog/tasks/']);
    const commonDir = scratchCommonDir();
    const deps = makeDeps(clone.root, commonDir);

    const push = await pushBoardHandler(deps);
    expect(push.pushed).toBe(false);
    expect(push.message).toMatch(/sync is off/i);

    const pull = await pullBoardHandler(deps);
    expect(pull.pulled).toBe(false);
    expect(pull.message).toMatch(/sync is off/i);
  });

  it('pushes from one clone and pulls into another when sync mode is git', async () => {
    const { origin, clone: cloneA, cleanup } = await makeOriginAndClone();
    cleanups.push(cleanup);
    cloneA.addGitignore(['.taskwright/', 'backlog/tasks/']);
    cloneA.writeFile('backlog/tasks/task-1 - A.md', '---\nid: TASK-1\n---\nA\n');
    const commonDirA = scratchCommonDir();
    writeSyncConfig(
      syncConfigPath(commonDirA),
      { ...DEFAULT_SYNC_CONFIG, mode: 'git' },
      nodeQueueFs
    );

    const pushResult = await pushBoardHandler(makeDeps(cloneA.root, commonDirA));
    expect(pushResult.pushed).toBe(true);
    expect(pushResult.conflicts).toEqual([]);

    const cloneB = await addSecondClone(origin);
    cleanups.push(() => cloneB.cleanup());
    cloneB.addGitignore(['.taskwright/', 'backlog/tasks/']);
    const commonDirB = scratchCommonDir();
    writeSyncConfig(
      syncConfigPath(commonDirB),
      { ...DEFAULT_SYNC_CONFIG, mode: 'git' },
      nodeQueueFs
    );

    const pullResult = await pullBoardHandler(makeDeps(cloneB.root, commonDirB));
    expect(pullResult.pulled).toBe(true);
    expect(pullResult.files).toEqual(['backlog/tasks/task-1 - A.md']);
    expect(pullResult.conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(cloneB.root, 'backlog/tasks/task-1 - A.md'), 'utf-8')).toBe(
      '---\nid: TASK-1\n---\nA\n'
    );
    // Real-git integration: many subprocess spawns; the 5s default flakes under load.
  }, 60_000);

  it('pull_board reports not-pulled when the remote has no board ref yet', async () => {
    const { clone, cleanup } = await makeOriginAndClone();
    cleanups.push(cleanup);
    clone.addGitignore(['.taskwright/', 'backlog/tasks/']);
    const commonDir = scratchCommonDir();
    writeSyncConfig(
      syncConfigPath(commonDir),
      { ...DEFAULT_SYNC_CONFIG, mode: 'git' },
      nodeQueueFs
    );

    const result = await pullBoardHandler(makeDeps(clone.root, commonDir));
    expect(result.pulled).toBe(false);
    expect(result.files).toEqual([]);
  });
});
