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
  pruneStaleBoardFiles,
  setLocalRef,
  fetchRef,
  pushRef,
  pushRefForceWithLease,
  isAncestor,
  revCount,
  commitTreeRoot,
  type BoardGitExec,
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
