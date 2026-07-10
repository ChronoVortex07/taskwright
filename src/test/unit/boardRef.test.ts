import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  snapshotBoardRoot,
  materializeToBoardRoot,
  pruneStaleBoardFiles,
  setLocalRef,
  fetchRef,
  pushRef,
  pushRefForceWithLease,
  isAncestor,
  revCount,
  commitTreeRoot,
  readRefFileMap,
  mergeBaseOf,
  commitMergedTree,
  type BoardGitExec,
} from '../../core/boardRef';
import { makeTempGitRepo, TempRepo } from './helpers/tempGitRepo';

// Real-git plumbing against temp repos: dozens of git spawns per test. On a
// loaded Windows box (e.g. parallel merge-queue verifies) spawn latency alone
// can blow vitest's 5s default — these are not 5s-shaped tests.
vi.setConfig({ testTimeout: 30_000 });

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
  it('exposes the default ref name and board subdirs (incl. milestones, DRAFT-19/TASK-36)', () => {
    expect(DEFAULT_BOARD_REF).toBe('taskwright-board');
    expect([...BOARD_SUBDIRS]).toEqual(['tasks', 'drafts', 'completed', 'archive', 'milestones']);
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
      'backlog/milestones/',
    ]);
    repo.writeFile('backlog/config.yml', 'project_name: "temp"\n');
    repo.writeFile('backlog/tasks/task-1 - A.md', '---\nid: TASK-1\n---\nA\n');
    repo.writeFile('backlog/tasks/task-2 - B.md', '---\nid: TASK-2\n---\nB\n');
    repo.writeFile('backlog/milestones/m-1 - Launch.md', '---\nid: m-1\n---\nLaunch\n');
  });
  afterEach(() => repo.cleanup());

  it('snapshots only the board subdirs onto the ref (root commit), including milestones (DRAFT-19/TASK-36)', async () => {
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

    // the ref tree contains board tasks + milestones but NOT config.yml
    const files = (await repo.git(['ls-tree', '-r', '--name-only', 'refs/heads/taskwright-board']))
      .trim()
      .split('\n')
      .sort();
    expect(files).toEqual([
      'backlog/milestones/m-1 - Launch.md',
      'backlog/tasks/task-1 - A.md',
      'backlog/tasks/task-2 - B.md',
    ]);

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
    repo.addGitignore(['backlog/tasks/', 'backlog/milestones/']);
    repo.writeFile('backlog/config.yml', 'project_name: "temp"\n');
    // Build a ref that contains tasks A and B, and one milestone.
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A-on-ref\n');
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B-on-ref\n');
    repo.writeFile('backlog/milestones/m-1 - Launch.md', 'm1-on-ref\n');
    await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'ref state',
      exec: defaultBoardExec,
    });
  });
  afterEach(() => repo.cleanup());

  it('refuses to materialize a ref whose tree contains non-board paths', async () => {
    // Point the board ref at the repo's HEAD — a full code tree, simulating the
    // ref being poisoned with a code commit (the 2026-07 root-flush incident).
    await repo.git(['update-ref', 'refs/heads/taskwright-board', await repo.headSha()]);
    repo.writeFile('README.md', 'local-work\n');

    await expect(
      materializeRefToWorktree({
        repoRoot: repo.root,
        ref: 'taskwright-board',
        indexFile: indexFile(),
        exec: defaultBoardExec,
      })
    ).rejects.toThrow(/non-board path/);

    // Nothing outside the board dirs was written…
    expect(read('README.md')).toBe('local-work\n');
    // …and local board files were NOT pruned against the bogus tree.
    expect(exists('backlog/tasks/task-1 - A.md')).toBe(true);
    expect(exists('backlog/tasks/task-2 - B.md')).toBe(true);
  });

  it('overwrites, adds, and prunes local board files to match the ref, including milestones', async () => {
    // Diverge the working copy: A modified locally, B removed, C added locally,
    // the milestone edited locally, plus a bogus local-only milestone.
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A-local-edit\n');
    fs.rmSync(path.join(repo.root, 'backlog/tasks/task-2 - B.md'));
    repo.writeFile('backlog/tasks/task-3 - C.md', 'C-local-only\n');
    repo.writeFile('backlog/milestones/m-1 - Launch.md', 'm1-local-edit\n');
    repo.writeFile('backlog/milestones/m-2 - Local-only.md', 'm2-local-only\n');
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
    expect(read('backlog/milestones/m-1 - Launch.md')).toBe('m1-on-ref\n'); // overwritten from ref
    expect(exists('backlog/milestones/m-2 - Local-only.md')).toBe(false); // pruned
    expect(read('backlog/config.yml')).toBe('project_name: "temp"\n'); // untouched
    expect(result.files).toEqual([
      'backlog/milestones/m-1 - Launch.md',
      'backlog/tasks/task-1 - A.md',
      'backlog/tasks/task-2 - B.md',
    ]);
    expect(await repo.headSha()).toBe(headBefore); // user git state untouched
  });
});

describe('pruneStaleBoardFiles (prune tolerates concurrent removal)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-prune-'));
    fs.mkdirSync(path.join(dir, 'backlog', 'tasks'), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('removes listed files absent from the keep set and leaves kept files', () => {
    const stale = path.join(dir, 'backlog', 'tasks', 'task-9 - Stale.md');
    const keeper = path.join(dir, 'backlog', 'tasks', 'task-1 - A.md');
    fs.writeFileSync(stale, 'stale\n');
    fs.writeFileSync(keeper, 'A\n');

    pruneStaleBoardFiles(
      dir,
      ['backlog/tasks/task-1 - A.md', 'backlog/tasks/task-9 - Stale.md'],
      new Set(['backlog/tasks/task-1 - A.md'])
    );

    expect(fs.existsSync(stale)).toBe(false); // pruned (absent from keep)
    expect(fs.existsSync(keeper)).toBe(true); // kept
  });

  it('does NOT throw when a listed prune target was already removed concurrently', () => {
    // The snapshot lists a stale file, but a sibling materialize on the same
    // shared working tree (another poll / an MCP session) unlinks it before we
    // reach the prune. This is the board.materialized freeze: the unforced
    // fs.rmSync here threw ENOENT, aborting materialize before it advanced the
    // marker, so refreshBoard re-materialized on every ~20s poll indefinitely.
    const listed = ['backlog/tasks/task-9 - Vanished.md'];
    const abs = path.join(dir, 'backlog', 'tasks', 'task-9 - Vanished.md');
    expect(fs.existsSync(abs)).toBe(false); // already gone (concurrent unlink)

    expect(() => pruneStaleBoardFiles(dir, listed, new Set<string>())).not.toThrow();
  });
});

describe('boardRef round-trip', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');
  const read = (rel: string) => fs.readFileSync(path.join(repo.root, rel), 'utf-8');
  const exists = (rel: string) => fs.existsSync(path.join(repo.root, rel));

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore(['backlog/tasks/', 'backlog/milestones/']);
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A\n');
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B\n');
    repo.writeFile('backlog/milestones/m-1 - Launch.md', 'M\n');
  });
  afterEach(() => repo.cleanup());

  it('materialize restores the exact snapshotted state (incl. milestones) and is idempotent', async () => {
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
    repo.writeFile('backlog/milestones/m-1 - Launch.md', 'M-wrecked\n');

    const first = await materializeRefToWorktree({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      exec: defaultBoardExec,
    });
    expect(read('backlog/tasks/task-1 - A.md')).toBe('A\n');
    expect(read('backlog/tasks/task-2 - B.md')).toBe('B\n');
    expect(read('backlog/milestones/m-1 - Launch.md')).toBe('M\n');

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

describe('snapshotBoardRoot / materializeToBoardRoot (Board Sync v2 Task D — root-resolving wrappers)', () => {
  // Real primary checkout + a linked `.worktrees/<branch>` worktree with NO
  // local `backlog/` at all (mirrors production: it's git-ignored, so `git
  // worktree add` never populates it) — proves the wrappers resolve the ONE
  // physical board (the primary's) via `resolvePrimaryWorktreeRoot`, exactly
  // like `resolveBoardRoot` (Task A/B), rather than looking next to `cwd`.
  let tmpDir: string;
  let primary: string;
  let worktreePath: string;
  const indexFile = () => path.join(primary, '.taskwright', 'board.index');
  const read = (rel: string) => fs.readFileSync(path.join(primary, rel), 'utf-8');
  const exists = (rel: string) => fs.existsSync(path.join(primary, rel));

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-boardroot-ref-'));
    primary = path.join(tmpDir, 'primary');
    fs.mkdirSync(primary, { recursive: true });
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: primary });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: primary });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: primary });
    fs.writeFileSync(
      path.join(primary, '.gitignore'),
      'backlog/tasks/\nbacklog/drafts/\nbacklog/completed/\nbacklog/archive/\nbacklog/milestones/\n.worktrees/\n.taskwright/\n'
    );
    await execFileAsync('git', ['add', '.gitignore'], { cwd: primary });
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: primary });

    fs.mkdirSync(path.join(primary, 'backlog', 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(primary, 'backlog', 'milestones'), { recursive: true });
    fs.writeFileSync(path.join(primary, 'backlog', 'tasks', 'task-1 - A.md'), 'A\n');
    fs.writeFileSync(path.join(primary, 'backlog', 'milestones', 'm-1 - Launch.md'), 'M\n');

    worktreePath = path.join(primary, '.worktrees', 'task-7-x');
    await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', 'task-7-x'], {
      cwd: primary,
    });
    expect(fs.existsSync(path.join(worktreePath, 'backlog'))).toBe(false);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('snapshots the primary board (incl. milestones) when invoked from a linked worktree with no local backlog/', async () => {
    const headBefore = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: primary }).then(
      (r) => r.stdout.trim()
    );

    const result = await snapshotBoardRoot({
      cwd: worktreePath,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'snapshot from worktree',
      exec: defaultBoardExec,
    });

    const files = (
      await execFileAsync('git', ['ls-tree', '-r', '--name-only', 'refs/heads/taskwright-board'], {
        cwd: primary,
      })
    ).stdout
      .trim()
      .split('\n')
      .sort();
    expect(files).toEqual(['backlog/milestones/m-1 - Launch.md', 'backlog/tasks/task-1 - A.md']);
    expect(await refTip(primary, 'taskwright-board', defaultBoardExec)).toBe(result.commit);

    // The primary's real HEAD/index/branch are untouched.
    const headAfter = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: primary }).then(
      (r) => r.stdout.trim()
    );
    expect(headAfter).toBe(headBefore);
  });

  it('materializes into the primary board when invoked from a linked worktree, restoring wrecked/pruned files', async () => {
    await snapshotBoardRoot({
      cwd: worktreePath,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'seed',
      exec: defaultBoardExec,
    });

    // Wreck the primary's board (the one physical board), same as if a sibling
    // session had corrupted it — never anything worktree-local.
    fs.writeFileSync(path.join(primary, 'backlog', 'tasks', 'task-1 - A.md'), 'A-wrecked\n');
    fs.writeFileSync(path.join(primary, 'backlog', 'milestones', 'm-1 - Launch.md'), 'M-wrecked\n');
    fs.writeFileSync(path.join(primary, 'backlog', 'tasks', 'task-2 - Local-only.md'), 'stray\n');

    const result = await materializeToBoardRoot({
      cwd: worktreePath,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      exec: defaultBoardExec,
    });

    expect(read('backlog/tasks/task-1 - A.md')).toBe('A\n');
    expect(read('backlog/milestones/m-1 - Launch.md')).toBe('M\n');
    expect(exists('backlog/tasks/task-2 - Local-only.md')).toBe(false); // pruned (not on ref)
    expect(result.files).toEqual([
      'backlog/milestones/m-1 - Launch.md',
      'backlog/tasks/task-1 - A.md',
    ]);

    // Nothing was ever written under the worktree itself — it has no backlog/.
    expect(fs.existsSync(path.join(worktreePath, 'backlog'))).toBe(false);
  });

  it('refuses to materialize into the primary board when the ref is poisoned with a non-board-path tree', async () => {
    const primaryHead = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: primary })
    ).stdout.trim();
    await execFileAsync('git', ['update-ref', 'refs/heads/taskwright-board', primaryHead], {
      cwd: primary,
    });

    await expect(
      materializeToBoardRoot({
        cwd: worktreePath,
        ref: 'taskwright-board',
        indexFile: indexFile(),
        exec: defaultBoardExec,
      })
    ).rejects.toThrow(/non-board path/);

    // The primary board is untouched by the refused materialize.
    expect(read('backlog/tasks/task-1 - A.md')).toBe('A\n');
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

  it('pushRef skips local hooks (board-ref pushes are data snapshots, not code)', async () => {
    // A pre-push hook that always rejects, standing in for this repo's own
    // depcheck/license-check hook, which can run for 90+ seconds — far past
    // any reasonable git-plumbing timeout. Board-ref pushes never carry code,
    // so they must not be gated by code-quality hooks at all.
    const hooksDir = path.join(clone.root, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-push');
    fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    await snapshotBoardToRef({
      repoRoot: clone.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'seed',
      exec: defaultBoardExec,
    });
    const push = await pushRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec);
    expect(push.ok).toBe(true);
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

describe('fetchRef FETCH_HEAD immunity (root-flush regression)', () => {
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

  it('returns the fetched board tip even when FETCH_HEAD is concurrently overwritten', async () => {
    const { commit } = await snapshotBoardToRef({
      repoRoot: clone.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'seed',
      exec: defaultBoardExec,
    });
    await pushRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec);

    // Simulate a concurrent full `git fetch origin` (VS Code autofetch, GitKraken):
    // immediately after fetchRef's own fetch completes, FETCH_HEAD is rewritten
    // with `main`'s (old) tip as its for-merge line. Resolving via FETCH_HEAD
    // would return this interloper sha — which is exactly how the board poll once
    // materialized a stale `origin/main` over the whole repo root.
    const interloperSha = await clone.headSha();
    expect(interloperSha).not.toBe(commit);
    const poisoningExec: BoardGitExec = async (cwd, args, env) => {
      const out = await defaultBoardExec(cwd, args, env);
      if (args[0] === 'fetch') {
        fs.writeFileSync(
          path.join(clone.root, '.git', 'FETCH_HEAD'),
          `${interloperSha}\t\tbranch 'main' of ${origin}\n`
        );
      }
      return out;
    };

    expect(await fetchRef(clone.root, 'origin', 'taskwright-board', poisoningExec)).toBe(commit);
  });

  it('follows a compacted (force-moved) remote board ref', async () => {
    const { commit: first } = await snapshotBoardToRef({
      repoRoot: clone.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's1',
      exec: defaultBoardExec,
    });
    await pushRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec);
    expect(await fetchRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec)).toBe(first);

    // Compact: replace the history with a parentless commit and force-push (lease).
    const root = await commitTreeRoot(clone.root, 'taskwright-board', 'compact', defaultBoardExec);
    await setLocalRef(clone.root, 'taskwright-board', root, defaultBoardExec);
    const push = await pushRefForceWithLease(
      clone.root,
      'origin',
      'taskwright-board',
      first,
      defaultBoardExec
    );
    expect(push.ok).toBe(true);

    // The fetch must survive the non-fast-forward move of the remote ref.
    expect(await fetchRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec)).toBe(root);
  });

  it('pushRefForceWithLease also skips local hooks (compaction is a data rewrite, not code)', async () => {
    const { commit: first } = await snapshotBoardToRef({
      repoRoot: clone.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's1',
      exec: defaultBoardExec,
    });
    await pushRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec);

    const hooksDir = path.join(clone.root, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const root = await commitTreeRoot(clone.root, 'taskwright-board', 'compact', defaultBoardExec);
    await setLocalRef(clone.root, 'taskwright-board', root, defaultBoardExec);
    const push = await pushRefForceWithLease(
      clone.root,
      'origin',
      'taskwright-board',
      first,
      defaultBoardExec
    );
    expect(push.ok).toBe(true);
  });
});

describe('ref-relation helpers', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');
  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore(['.taskwright/', 'backlog/tasks/']);
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A\n');
  });
  afterEach(() => repo.cleanup());

  it('revCount is 0 for a missing ref and grows per snapshot', async () => {
    expect(await revCount(repo.root, 'taskwright-board', defaultBoardExec)).toBe(0);
    const c1 = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's1',
      exec: defaultBoardExec,
    });
    expect(await revCount(repo.root, 'taskwright-board', defaultBoardExec)).toBe(1);
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B\n');
    await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's2',
      parent: c1.commit,
      exec: defaultBoardExec,
    });
    expect(await revCount(repo.root, 'taskwright-board', defaultBoardExec)).toBe(2);
  });

  it('isAncestor reflects the commit chain', async () => {
    const c1 = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's1',
      exec: defaultBoardExec,
    });
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B\n');
    const c2 = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's2',
      parent: c1.commit,
      exec: defaultBoardExec,
    });
    expect(await isAncestor(repo.root, c1.commit, c2.commit, defaultBoardExec)).toBe(true);
    expect(await isAncestor(repo.root, c2.commit, c1.commit, defaultBoardExec)).toBe(false);
  });

  it('commitTreeRoot wraps the ref tree in a parentless commit', async () => {
    await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's1',
      exec: defaultBoardExec,
    });
    const root = await commitTreeRoot(repo.root, 'taskwright-board', 'compact', defaultBoardExec);
    const parents = (await repo.git(['rev-list', '--parents', '-n', '1', root])).trim().split(' ');
    expect(parents).toHaveLength(1); // no parents
    const refTree = (await repo.git(['rev-parse', 'refs/heads/taskwright-board^{tree}'])).trim();
    const rootTree = (await repo.git(['rev-parse', `${root}^{tree}`])).trim();
    expect(rootTree).toBe(refTree);
  });
});

describe('readRefFileMap (Board Sync v2 Task F — push/pull merge core)', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore(['backlog/tasks/', 'backlog/milestones/']);
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A\n');
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B\n');
    repo.writeFile('backlog/milestones/m-1 - Launch.md', 'M\n');
  });
  afterEach(() => repo.cleanup());

  it('reads a commit tree into a path -> content map, matching ls-tree', async () => {
    const { commit } = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'snapshot',
      exec: defaultBoardExec,
    });

    const map = await readRefFileMap(repo.root, commit, defaultBoardExec);

    expect(map).toEqual({
      'backlog/tasks/task-1 - A.md': 'A\n',
      'backlog/tasks/task-2 - B.md': 'B\n',
      'backlog/milestones/m-1 - Launch.md': 'M\n',
    });
  });

  it('returns an empty map for a commit with an empty tree', async () => {
    const env = { GIT_INDEX_FILE: indexFile() };
    fs.mkdirSync(path.dirname(indexFile()), { recursive: true });
    await execFileAsync('git', ['read-tree', '--empty'], {
      cwd: repo.root,
      env: { ...process.env, ...env },
    });
    const tree = (
      await execFileAsync('git', ['write-tree'], {
        cwd: repo.root,
        env: { ...process.env, ...env },
      })
    ).stdout.trim();
    const commit = (
      await execFileAsync('git', ['commit-tree', tree, '-m', 'empty'], {
        cwd: repo.root,
        env: { ...process.env, ...env },
      })
    ).stdout.trim();

    expect(await readRefFileMap(repo.root, commit, defaultBoardExec)).toEqual({});
  });
});

describe('mergeBaseOf (Board Sync v2 Task F)', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore(['backlog/tasks/']);
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A\n');
  });
  afterEach(() => repo.cleanup());

  it('finds the common ancestor of two commits chained from a shared parent', async () => {
    const base = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'base',
      exec: defaultBoardExec,
    });
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B\n');
    const left = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'left',
      parent: base.commit,
      exec: defaultBoardExec,
    });
    repo.writeFile('backlog/tasks/task-3 - C.md', 'C\n');
    const right = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'right',
      parent: base.commit,
      exec: defaultBoardExec,
    });

    expect(await mergeBaseOf(repo.root, left.commit, right.commit, defaultBoardExec)).toBe(
      base.commit
    );
  });

  it('returns null for unrelated histories', async () => {
    const orphan = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'refs/heads/other-orphan',
      indexFile: indexFile(),
      message: 'orphan',
      exec: defaultBoardExec,
    });
    const main = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'main',
      exec: defaultBoardExec,
    });

    expect(await mergeBaseOf(repo.root, orphan.commit, main.commit, defaultBoardExec)).toBeNull();
  });
});

describe('commitMergedTree (Board Sync v2 Task F)', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore(['backlog/tasks/']);
  });
  afterEach(() => repo.cleanup());

  it('builds a commit whose tree is exactly the given file map, with the given parents', async () => {
    const p1 = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'refs/heads/p1',
      indexFile: indexFile(),
      message: 'p1',
      exec: defaultBoardExec,
    });
    const p2 = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'refs/heads/p2',
      indexFile: indexFile(),
      message: 'p2',
      exec: defaultBoardExec,
    });
    const headBefore = await repo.headSha();
    const statusBefore = (await repo.git(['status', '--porcelain'])).trim();

    const merged = {
      'backlog/tasks/task-1 - A.md': 'A-merged\n',
      'backlog/tasks/task-2 - B.md': 'B-merged\n',
    };
    const commit = await commitMergedTree({
      repoRoot: repo.root,
      indexFile: indexFile(),
      parents: [p1.commit, p2.commit],
      message: 'merged',
      files: merged,
      exec: defaultBoardExec,
    });

    expect(await readRefFileMap(repo.root, commit, defaultBoardExec)).toEqual(merged);
    const parents = (await repo.git(['rev-list', '--parents', '-n', '1', commit]))
      .trim()
      .split(' ');
    expect(parents).toEqual([commit, p1.commit, p2.commit]);

    // Isolated index: real git state untouched.
    expect(await repo.headSha()).toBe(headBefore);
    expect((await repo.git(['status', '--porcelain'])).trim()).toBe(statusBefore);
  });

  it('produces an empty-tree commit for an empty file map', async () => {
    const commit = await commitMergedTree({
      repoRoot: repo.root,
      indexFile: indexFile(),
      parents: [],
      message: 'empty',
      files: {},
      exec: defaultBoardExec,
    });
    expect(await readRefFileMap(repo.root, commit, defaultBoardExec)).toEqual({});
    const parents = (await repo.git(['rev-list', '--parents', '-n', '1', commit]))
      .trim()
      .split(' ');
    expect(parents).toHaveLength(1); // no parents
  });
});
