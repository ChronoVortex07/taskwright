/**
 * Tests for `runBoardSyncHook` (Board Sync v2 Task H) — the standalone
 * push/pull payload the opt-in `pre-push`/`post-merge` git hooks run. Mirrors
 * `mcpBoardPushPullHandlers.test.ts`'s real-temp-git-repo conventions, since
 * this is the same `pushBoard`/`pullBoard` core (Task F) invoked a different
 * way (a real `commonDir`, not an MCP `deps.root` + injected `gitExec`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBoardSyncHook } from '../../../scripts/hooks/board-sync-hook';
import { writeSyncConfig, syncConfigPath, DEFAULT_SYNC_CONFIG } from '../../core/syncConfig';
import { nodeQueueFs } from '../../core/mergeQueue';
import { makeTempGitRepo, TempRepo } from './helpers/tempGitRepo';

const execFileAsync = promisify(execFile);

async function makeOriginAndClone(): Promise<{
  origin: string;
  clone: TempRepo;
  cleanup: () => void;
}> {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-hook-origin-'));
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

describe('runBoardSyncHook', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  });

  it('is a no-op (skipped) with no error when sync is off (the default)', async () => {
    const { clone, cleanup } = await makeOriginAndClone();
    cleanups.push(cleanup);
    clone.addGitignore(['.taskwright/', 'backlog/tasks/']);
    const commonDir = path.join(clone.root, '.git');

    const logs: string[] = [];
    const result = await runBoardSyncHook('push', commonDir, { log: (m: string) => logs.push(m) });
    expect(result).toEqual({ skipped: true, reason: expect.stringMatching(/sync is off/i) });
    expect(logs.some((l) => /sync is off/i.test(l))).toBe(true);
  });

  it('pushes the live board from one clone and pulls it into another', async () => {
    const { origin, clone: cloneA, cleanup } = await makeOriginAndClone();
    cleanups.push(cleanup);
    cloneA.addGitignore(['.taskwright/', 'backlog/tasks/']);
    cloneA.writeFile('backlog/tasks/task-1 - A.md', '---\nid: TASK-1\n---\nA\n');
    const commonDirA = path.join(cloneA.root, '.git');
    writeSyncConfig(
      syncConfigPath(commonDirA),
      { ...DEFAULT_SYNC_CONFIG, mode: 'git' },
      nodeQueueFs
    );

    const pushResult = await runBoardSyncHook('push', commonDirA);
    expect(pushResult).toMatchObject({ pushed: true, conflicts: [] });

    const cloneB = await addSecondClone(origin);
    cleanups.push(() => cloneB.cleanup());
    cloneB.addGitignore(['.taskwright/', 'backlog/tasks/']);
    const commonDirB = path.join(cloneB.root, '.git');
    writeSyncConfig(
      syncConfigPath(commonDirB),
      { ...DEFAULT_SYNC_CONFIG, mode: 'git' },
      nodeQueueFs
    );

    const pullResult = await runBoardSyncHook('pull', commonDirB);
    expect(pullResult).toMatchObject({
      pulled: true,
      files: ['backlog/tasks/task-1 - A.md'],
      conflicts: [],
    });
    expect(fs.readFileSync(path.join(cloneB.root, 'backlog/tasks/task-1 - A.md'), 'utf-8')).toBe(
      '---\nid: TASK-1\n---\nA\n'
    );
    // Real-git integration: many subprocess spawns; the 5s default flakes under load.
  }, 60_000);

  it('logs (does not throw) when a pull has nothing to fetch yet', async () => {
    const { clone, cleanup } = await makeOriginAndClone();
    cleanups.push(cleanup);
    clone.addGitignore(['.taskwright/', 'backlog/tasks/']);
    const commonDir = path.join(clone.root, '.git');
    writeSyncConfig(
      syncConfigPath(commonDir),
      { ...DEFAULT_SYNC_CONFIG, mode: 'git' },
      nodeQueueFs
    );

    const logs: string[] = [];
    const result = await runBoardSyncHook('pull', commonDir, { log: (m: string) => logs.push(m) });
    expect(result).toMatchObject({ pulled: false, files: [] });
    expect(logs.length).toBeGreaterThan(0);
  });
});
