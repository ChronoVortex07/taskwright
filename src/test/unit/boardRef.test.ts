import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_BOARD_REF,
  BOARD_SUBDIRS,
  qualifyRef,
  refTip,
  defaultBoardExec,
  snapshotBoardToRef,
  materializeRefToWorktree,
  setLocalRef,
  fetchRef,
  pushRef,
} from '../../core/boardRef';
import { makeTempGitRepo, TempRepo } from './helpers/tempGitRepo';

const execFileAsync = promisify(execFile);

/** Make `origin` a bare repo and `clone` a working clone of it, both in tmp. */
async function makeOriginAndClone(): Promise<{
  origin: string;
  clone: TempRepo;
  cleanup: () => void;
}> {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-origin-'));
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

describe('boardRef constants + qualifyRef', () => {
  it('exposes the default ref name and board subdirs', () => {
    expect(DEFAULT_BOARD_REF).toBe('taskwright-board');
    expect([...BOARD_SUBDIRS]).toEqual(['tasks', 'drafts', 'completed', 'archive']);
  });

  it('qualifies a short ref name to refs/heads/*', () => {
    expect(qualifyRef('taskwright-board')).toBe('refs/heads/taskwright-board');
  });

  it('passes an already-qualified ref through unchanged', () => {
    expect(qualifyRef('refs/heads/taskwright-board')).toBe('refs/heads/taskwright-board');
    expect(qualifyRef('refs/taskwright/board')).toBe('refs/taskwright/board');
  });
});

describe('refTip', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await makeTempGitRepo();
  });
  afterEach(() => repo.cleanup());

  it('returns null for a ref that does not exist', async () => {
    expect(await refTip(repo.root, 'taskwright-board', defaultBoardExec)).toBeNull();
  });

  it('returns the commit sha for an existing ref', async () => {
    const head = await repo.headSha();
    await repo.git(['update-ref', 'refs/heads/taskwright-board', head]);
    expect(await refTip(repo.root, 'taskwright-board', defaultBoardExec)).toBe(head);
  });
});

describe('snapshotBoardToRef', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore([
      '.taskwright/',
      'backlog/tasks/',
      'backlog/drafts/',
      'backlog/completed/',
      'backlog/archive/',
    ]);
    repo.writeFile('backlog/config.yml', 'project_name: "temp"\n');
    repo.writeFile('backlog/tasks/task-1 - A.md', '---\nid: TASK-1\n---\nA\n');
    repo.writeFile('backlog/tasks/task-2 - B.md', '---\nid: TASK-2\n---\nB\n');
  });
  afterEach(() => repo.cleanup());

  it('snapshots only the board subdirs onto the ref (root commit)', async () => {
    const headBefore = await repo.headSha();
    const statusBefore = (await repo.git(['status', '--porcelain'])).trim();

    const result = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'snapshot',
      exec: defaultBoardExec,
    });

    // ref points at the new commit
    expect(await refTip(repo.root, 'taskwright-board', defaultBoardExec)).toBe(result.commit);

    // the ref tree contains board tasks but NOT config.yml
    const files = (await repo.git(['ls-tree', '-r', '--name-only', 'refs/heads/taskwright-board']))
      .trim()
      .split('\n')
      .sort();
    expect(files).toEqual(['backlog/tasks/task-1 - A.md', 'backlog/tasks/task-2 - B.md']);

    // root commit has no parent
    const parents = (await repo.git(['rev-list', '--parents', '-n', '1', result.commit]))
      .trim()
      .split(' ');
    expect(parents).toHaveLength(1); // just the commit sha, no parents

    // user git state untouched: HEAD unchanged, and the snapshot changed nothing
    // in the working tree or the real index (status is identical to before).
    expect(await repo.headSha()).toBe(headBefore);
    expect((await repo.git(['status', '--porcelain'])).trim()).toBe(statusBefore);
  });

  it('chains a parented commit when parent is provided', async () => {
    const first = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'first',
      exec: defaultBoardExec,
    });
    repo.writeFile('backlog/tasks/task-3 - C.md', '---\nid: TASK-3\n---\nC\n');
    const second = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'second',
      parent: first.commit,
      exec: defaultBoardExec,
    });

    const parents = (await repo.git(['rev-list', '--parents', '-n', '1', second.commit]))
      .trim()
      .split(' ');
    expect(parents).toEqual([second.commit, first.commit]);
  });
});

describe('materializeRefToWorktree', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');
  const read = (rel: string) => fs.readFileSync(path.join(repo.root, rel), 'utf-8');
  const exists = (rel: string) => fs.existsSync(path.join(repo.root, rel));

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore(['backlog/tasks/']);
    repo.writeFile('backlog/config.yml', 'project_name: "temp"\n');
    // Build a ref that contains tasks A and B.
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A-on-ref\n');
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B-on-ref\n');
    await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'ref state',
      exec: defaultBoardExec,
    });
  });
  afterEach(() => repo.cleanup());

  it('overwrites, adds, and prunes local board files to match the ref', async () => {
    // Diverge the working copy: A modified locally, B removed, C added locally.
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A-local-edit\n');
    fs.rmSync(path.join(repo.root, 'backlog/tasks/task-2 - B.md'));
    repo.writeFile('backlog/tasks/task-3 - C.md', 'C-local-only\n');
    const headBefore = await repo.headSha();

    const result = await materializeRefToWorktree({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      exec: defaultBoardExec,
    });

    expect(read('backlog/tasks/task-1 - A.md')).toBe('A-on-ref\n'); // overwritten from ref
    expect(read('backlog/tasks/task-2 - B.md')).toBe('B-on-ref\n'); // restored from ref
    expect(exists('backlog/tasks/task-3 - C.md')).toBe(false); // pruned (absent from ref)
    expect(read('backlog/config.yml')).toBe('project_name: "temp"\n'); // untouched
    expect(result.files).toEqual(['backlog/tasks/task-1 - A.md', 'backlog/tasks/task-2 - B.md']);
    expect(await repo.headSha()).toBe(headBefore); // user git state untouched
  });
});

describe('boardRef round-trip', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');
  const read = (rel: string) => fs.readFileSync(path.join(repo.root, rel), 'utf-8');
  const exists = (rel: string) => fs.existsSync(path.join(repo.root, rel));

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore(['backlog/tasks/']);
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A\n');
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B\n');
  });
  afterEach(() => repo.cleanup());

  it('materialize restores the exact snapshotted state and is idempotent', async () => {
    await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'state',
      exec: defaultBoardExec,
    });

    // Wreck the working copy.
    fs.rmSync(path.join(repo.root, 'backlog/tasks/task-1 - A.md'));
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B-wrecked\n');

    const first = await materializeRefToWorktree({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      exec: defaultBoardExec,
    });
    expect(read('backlog/tasks/task-1 - A.md')).toBe('A\n');
    expect(read('backlog/tasks/task-2 - B.md')).toBe('B\n');

    // Running materialize again changes nothing.
    const second = await materializeRefToWorktree({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      exec: defaultBoardExec,
    });
    expect(second.files).toEqual(first.files);
    expect(read('backlog/tasks/task-1 - A.md')).toBe('A\n');
    expect(exists('backlog/tasks/task-2 - B.md')).toBe(true);
  });
});

describe('remote ref helpers', () => {
  let origin: string;
  let clone: TempRepo;
  let cleanup: () => void;
  const indexFile = () => path.join(clone.root, '.taskwright', 'board.index');

  beforeEach(async () => {
    ({ origin, clone, cleanup } = await makeOriginAndClone());
    clone.addGitignore(['.taskwright/', 'backlog/tasks/']);
    clone.writeFile('backlog/tasks/task-1 - A.md', 'A\n');
  });
  afterEach(() => cleanup());

  it('setLocalRef points a ref at a sha', async () => {
    const head = await clone.headSha();
    await setLocalRef(clone.root, 'taskwright-board', head, defaultBoardExec);
    expect(await refTip(clone.root, 'taskwright-board', defaultBoardExec)).toBe(head);
  });

  it('fetchRef returns null when origin lacks the ref, sha once it exists', async () => {
    expect(await fetchRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec)).toBeNull();

    const { commit } = await snapshotBoardToRef({
      repoRoot: clone.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'seed',
      exec: defaultBoardExec,
    });
    const push = await pushRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec);
    expect(push.ok).toBe(true);

    expect(await fetchRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec)).toBe(commit);
  });

  it('pushRef reports a non-fast-forward rejection', async () => {
    // Seed origin from clone A.
    await snapshotBoardToRef({
      repoRoot: clone.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's1',
      exec: defaultBoardExec,
    });
    await pushRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec);

    // Second clone advances origin.
    const cloneB = await makeTempGitRepo();
    await cloneB.git(['remote', 'add', 'origin', origin]);
    cloneB.addGitignore(['.taskwright/', 'backlog/tasks/']);
    await setLocalRef(
      cloneB.root,
      'taskwright-board',
      (await fetchRef(cloneB.root, 'origin', 'taskwright-board', defaultBoardExec))!,
      defaultBoardExec
    );
    cloneB.writeFile('backlog/tasks/task-2 - B.md', 'B\n');
    await snapshotBoardToRef({
      repoRoot: cloneB.root,
      ref: 'taskwright-board',
      indexFile: path.join(cloneB.root, '.taskwright/board.index'),
      message: 's2',
      parent: (await refTip(cloneB.root, 'taskwright-board', defaultBoardExec)) ?? undefined,
      exec: defaultBoardExec,
    });
    await pushRef(cloneB.root, 'origin', 'taskwright-board', defaultBoardExec);

    // Clone A makes a divergent commit on the OLD base and pushes -> rejected.
    clone.writeFile('backlog/tasks/task-3 - C.md', 'C\n');
    await snapshotBoardToRef({
      repoRoot: clone.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's3',
      parent: (await refTip(clone.root, 'taskwright-board', defaultBoardExec)) ?? undefined,
      exec: defaultBoardExec,
    });
    const push = await pushRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec);
    expect(push.ok).toBe(false);
    expect(push.rejected).toBe(true);

    cloneB.cleanup();
  });
});
