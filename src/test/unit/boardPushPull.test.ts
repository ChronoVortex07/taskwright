import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pushBoard, pullBoard } from '../../core/boardPushPull';
import { refTip, defaultBoardExec, type BoardGitExec } from '../../core/boardRef';
import { makeTempGitRepo, TempRepo } from './helpers/tempGitRepo';

const execFileAsync = promisify(execFile);
const REF = 'taskwright-board';
const REMOTE = 'origin';

/** Make `origin` a bare repo and one working clone of it, both in tmp. */
async function makeOriginAndClone(): Promise<{
  origin: string;
  clone: TempRepo;
  cleanup: () => void;
}> {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-pushpull-origin-'));
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

/** A second clone of the same origin, sharing no state with the first. */
async function addSecondClone(origin: string): Promise<TempRepo> {
  const clone = await makeTempGitRepo();
  await clone.git(['remote', 'add', 'origin', origin]);
  await clone.git(['fetch', '-q', 'origin', 'main']);
  await clone.git(['reset', '-q', '--hard', 'origin/main']);
  return clone;
}

describe('pushBoard / pullBoard (Board Sync v2 Task F)', () => {
  let cleanupAll: (() => void)[] = [];

  afterEach(() => {
    cleanupAll.forEach((fn) => fn());
    cleanupAll = [];
  });

  it('first push creates the remote ref cleanly (no prior remote state)', async () => {
    const { clone, cleanup } = await makeOriginAndClone();
    cleanupAll.push(cleanup);
    clone.addGitignore(['backlog/tasks/']);
    clone.writeFile('backlog/tasks/task-1 - A.md', '---\nid: TASK-1\n---\nA\n');
    const headBefore = await clone.headSha();

    const result = await pushBoard({
      cwd: clone.root,
      ref: REF,
      remote: REMOTE,
      message: 'push',
    });

    expect(result.pushed).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(await clone.headSha()).toBe(headBefore); // real git state untouched
  });

  it('two-clone round trip: push A -> pull B reflects A', async () => {
    const { origin: bareOrigin, clone: cloneA, cleanup } = await makeOriginAndClone();
    cleanupAll.push(cleanup);
    cloneA.addGitignore(['backlog/tasks/']);
    cloneA.writeFile('backlog/tasks/task-1 - A.md', '---\nid: TASK-1\n---\nA\n');

    const pushResult = await pushBoard({
      cwd: cloneA.root,
      ref: REF,
      remote: REMOTE,
      message: 'push from A',
    });
    expect(pushResult.pushed).toBe(true);

    const cloneB = await addSecondClone(bareOrigin);
    cleanupAll.push(() => cloneB.cleanup());
    cloneB.addGitignore(['backlog/tasks/']);

    const pullResult = await pullBoard({
      cwd: cloneB.root,
      ref: REF,
      remote: REMOTE,
      message: 'pull into B',
    });

    expect(pullResult.pulled).toBe(true);
    expect(pullResult.conflicts).toEqual([]);
    expect(pullResult.files).toEqual(['backlog/tasks/task-1 - A.md']);
    expect(fs.readFileSync(path.join(cloneB.root, 'backlog/tasks/task-1 - A.md'), 'utf-8')).toBe(
      '---\nid: TASK-1\n---\nA\n'
    );
  });

  it('pull_board with no remote ref yet reports not-pulled', async () => {
    const { clone, cleanup } = await makeOriginAndClone();
    cleanupAll.push(cleanup);
    clone.addGitignore(['backlog/tasks/']);

    const result = await pullBoard({ cwd: clone.root, ref: REF, remote: REMOTE, message: 'pull' });

    expect(result.pulled).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('concurrent disjoint adds from two clones union cleanly on push (no conflicts)', async () => {
    const { origin: bareOrigin, clone: cloneA, cleanup } = await makeOriginAndClone();
    cleanupAll.push(cleanup);
    cloneA.addGitignore(['backlog/tasks/']);
    cloneA.writeFile(
      'backlog/tasks/task-1 - A.md',
      "---\nid: TASK-1\nupdated_date: '2026-07-01 09:00'\n---\nA\n"
    );
    await pushBoard({ cwd: cloneA.root, ref: REF, remote: REMOTE, message: 'A seeds' });

    const cloneB = await addSecondClone(bareOrigin);
    cleanupAll.push(() => cloneB.cleanup());
    cloneB.addGitignore(['backlog/tasks/']);
    await pullBoard({ cwd: cloneB.root, ref: REF, remote: REMOTE, message: 'B pulls seed' });

    // Disjoint adds on each side.
    cloneA.writeFile(
      'backlog/tasks/task-2 - B.md',
      "---\nid: TASK-2\nupdated_date: '2026-07-01 09:05'\n---\nB\n"
    );
    cloneB.writeFile(
      'backlog/tasks/task-3 - C.md',
      "---\nid: TASK-3\nupdated_date: '2026-07-01 09:05'\n---\nC\n"
    );

    const pushA = await pushBoard({
      cwd: cloneA.root,
      ref: REF,
      remote: REMOTE,
      message: 'A adds B',
    });
    expect(pushA.pushed).toBe(true);
    expect(pushA.conflicts).toEqual([]);

    const pushB = await pushBoard({
      cwd: cloneB.root,
      ref: REF,
      remote: REMOTE,
      message: 'B adds C',
    });
    expect(pushB.pushed).toBe(true);
    expect(pushB.conflicts).toEqual([]); // disjoint adds union cleanly, no conflict

    const pullA = await pullBoard({
      cwd: cloneA.root,
      ref: REF,
      remote: REMOTE,
      message: 'A pulls',
    });
    expect(pullA.pulled).toBe(true);
    expect(pullA.conflicts).toEqual([]);
    expect(pullA.files.sort()).toEqual([
      'backlog/tasks/task-1 - A.md',
      'backlog/tasks/task-2 - B.md',
      'backlog/tasks/task-3 - C.md',
    ]);
    expect(fs.existsSync(path.join(cloneA.root, 'backlog/tasks/task-3 - C.md'))).toBe(true);
  });

  it('same-task edit on both sides surfaces a conflict; newer updated_date wins', { timeout: 15_000 }, async () => {
    const { origin: bareOrigin, clone: cloneA, cleanup } = await makeOriginAndClone();
    cleanupAll.push(cleanup);
    cloneA.addGitignore(['backlog/tasks/']);
    cloneA.writeFile(
      'backlog/tasks/task-1 - A.md',
      "---\nid: TASK-1\nupdated_date: '2026-07-01 09:00'\n---\noriginal\n"
    );
    await pushBoard({ cwd: cloneA.root, ref: REF, remote: REMOTE, message: 'A seeds' });

    const cloneB = await addSecondClone(bareOrigin);
    cleanupAll.push(() => cloneB.cleanup());
    cloneB.addGitignore(['backlog/tasks/']);
    await pullBoard({ cwd: cloneB.root, ref: REF, remote: REMOTE, message: 'B pulls seed' });

    // Both sides edit the SAME task, B's edit is newer.
    cloneA.writeFile(
      'backlog/tasks/task-1 - A.md',
      "---\nid: TASK-1\nupdated_date: '2026-07-01 10:00'\n---\nA-edit\n"
    );
    await pushBoard({ cwd: cloneA.root, ref: REF, remote: REMOTE, message: 'A edits' });

    cloneB.writeFile(
      'backlog/tasks/task-1 - A.md',
      "---\nid: TASK-1\nupdated_date: '2026-07-01 11:00'\n---\nB-edit\n"
    );
    const pushB = await pushBoard({
      cwd: cloneB.root,
      ref: REF,
      remote: REMOTE,
      message: 'B edits',
    });

    expect(pushB.pushed).toBe(true);
    expect(pushB.conflicts).toHaveLength(1);
    expect(pushB.conflicts[0]).toMatchObject({
      id: 'TASK-1',
      reason: 'edited-both',
      resolution: 'ours', // B is "ours" from B's own perspective, and B is newer
    });

    const pullA = await pullBoard({
      cwd: cloneA.root,
      ref: REF,
      remote: REMOTE,
      message: 'A pulls',
    });
    expect(pullA.pulled).toBe(true);
    expect(
      fs.readFileSync(path.join(cloneA.root, 'backlog/tasks/task-1 - A.md'), 'utf-8')
    ).toContain('B-edit'); // newer (B's) edit wins
  });

  it('a board push never dirties the working tree or moves HEAD', async () => {
    const { clone, cleanup } = await makeOriginAndClone();
    cleanupAll.push(cleanup);
    clone.addGitignore(['.taskwright/', 'backlog/tasks/']);
    clone.writeFile('backlog/tasks/task-1 - A.md', 'A\n');
    const headBefore = await clone.headSha();
    const statusBefore = (await clone.git(['status', '--porcelain'])).trim();

    await pushBoard({ cwd: clone.root, ref: REF, remote: REMOTE, message: 'push' });

    expect(await clone.headSha()).toBe(headBefore);
    expect((await clone.git(['status', '--porcelain'])).trim()).toBe(statusBefore);
  });

  it('a rejected push (remote moved after fetch) is surfaced, not silently lost', async () => {
    const { origin: bareOrigin, clone: cloneA, cleanup } = await makeOriginAndClone();
    cleanupAll.push(cleanup);
    cloneA.addGitignore(['backlog/tasks/']);
    cloneA.writeFile('backlog/tasks/task-1 - A.md', 'A\n');
    await pushBoard({ cwd: cloneA.root, ref: REF, remote: REMOTE, message: 'seed' });

    const cloneC = await addSecondClone(bareOrigin);
    cleanupAll.push(() => cloneC.cleanup());
    cloneC.addGitignore(['backlog/tasks/']);

    cloneA.writeFile('backlog/tasks/task-2 - B.md', 'B\n');

    // Race: right after our fetch step (inside syncLocalRefWithRemote), a third
    // clone advances the remote past what we just fetched, so our own push —
    // computed against the now-stale fetched tip — is rejected.
    let fetched = false;
    const racingExec: BoardGitExec = async (cwd, args, env) => {
      const out = await defaultBoardExec(cwd, args, env);
      if (!fetched && args[0] === 'fetch') {
        fetched = true;
        cloneC.writeFile('backlog/tasks/task-3 - C.md', 'C\n');
        await pushBoard({ cwd: cloneC.root, ref: REF, remote: REMOTE, message: 'C races in' });
      }
      return out;
    };

    const result = await pushBoard({
      cwd: cloneA.root,
      ref: REF,
      remote: REMOTE,
      message: 'A pushes but loses the race',
      exec: racingExec,
    });

    expect(result.pushed).toBe(false);
    expect(result.rejected).toBe(true);

    // Local ref still advanced (nothing lost) — a retry (plain pushBoard call)
    // would fetch C's commit, merge, and succeed.
    expect(await refTip(cloneA.root, REF, defaultBoardExec)).toBe(result.commit);
  });
});
