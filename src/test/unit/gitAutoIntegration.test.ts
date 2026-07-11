import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeTempGitRepo, type TempRepo } from './helpers/tempGitRepo';
import { boardWorktreePathFor } from '../../core/boardRoot';
import { ensureBoardWorktree, boardWorktreeStatusOf } from '../../core/boardWorktree';
import { autoCommitBoard, runBoardAutoSync } from '../../core/autoSync';
import {
  gatherMigrationFacts,
  planMigrationSteps,
  verifyMove,
  readBoardDirFileMap,
  executeVerifiedMove,
  cleanMaterializedMarker,
  foldPrimaryStrays,
} from '../../core/boardHomeMigration';
import {
  snapshotBoardToRef,
  materializeRefToWorktree,
  refTip,
  defaultBoardExec,
} from '../../core/boardRef';
import { applyBoardIgnore, boardTrackedPaths } from '../../core/boardMigration';

/**
 * git-auto board home (TASK-91) — end-to-end over real temp git repos: the
 * S1–S6 migration matrix, the auto-commit/sync round trip across two clones,
 * offline degradation, worktree-loss repair, reverse migration, and the
 * "dirty board never blocks a merge" structural proof.
 */

const execFileAsync = promisify(execFile);
const REF = 'taskwright-board';
const REMOTE = 'origin';

const TASK_1 = (body: string, updated = '2026-07-11 08:00'): string =>
  [
    '---',
    'id: TASK-1',
    'title: First',
    'status: To Do',
    'assignee: []',
    "created_date: '2026-07-10 09:00'",
    `updated_date: '${updated}'`,
    'labels: []',
    'dependencies: []',
    '---',
    '',
    body,
    '',
  ].join('\n');

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function repoWithBoard(): Promise<TempRepo> {
  const repo = await makeTempGitRepo();
  cleanups.push(() => repo.cleanup());
  repo.writeFile('backlog/config.yml', "project_name: 'X'\n");
  repo.writeFile('backlog/tasks/task-1 - First.md', TASK_1('Original body.'));
  repo.writeFile('backlog/milestones/m-1 - Age.md', '---\nid: m-1\ntitle: Age\n---\n');
  return repo;
}

function bareRemoteFor(repo: TempRepo): string {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-bare-'));
  cleanups.push(() => fs.rmSync(bare, { recursive: true, force: true }));
  return bare;
}

async function initBareRemote(repo: TempRepo): Promise<string> {
  const bare = bareRemoteFor(repo);
  await execFileAsync('git', ['init', '--bare', '-q', bare]);
  await repo.git(['remote', 'add', REMOTE, bare]);
  return bare;
}

/** The migration core sequence enableSync's migrateToGitAuto drives (sans vscode). */
async function migrateCores(repo: TempRepo): Promise<void> {
  const facts = await gatherMigrationFacts(repo.root, REF);
  const steps = planMigrationSteps(facts);

  if (steps.includes('untrack')) {
    const gitignorePath = path.join(repo.root, '.gitignore');
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    fs.writeFileSync(gitignorePath, applyBoardIgnore(existing), 'utf-8');
    await repo.git(['rm', '-r', '--cached', '--ignore-unmatch', ...boardTrackedPaths()]);
    await repo.git(['add', '.gitignore']);
    await repo.git(['commit', '-q', '-m', 'move board off code branches (git-auto)']);
  }
  if (steps.includes('seed-fresh') || steps.includes('seed-fold-ref')) {
    const parent = await refTip(repo.root, REF);
    await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: REF,
      indexFile: path.join(repo.root, '.taskwright', 'board.index'),
      message: 'pre-git-auto board snapshot',
      parent: parent ?? undefined,
    });
  }
  const ensured = await ensureBoardWorktree({ primaryRoot: repo.root, ref: REF, remote: REMOTE });
  if (steps.includes('verified-move')) {
    const verification = verifyMove(
      readBoardDirFileMap(repo.root),
      readBoardDirFileMap(ensured.path),
      new Set()
    );
    expect(verification.ok).toBe(true);
    await executeVerifiedMove({ primaryRoot: repo.root, boardWorktree: ensured.path });
  }
  if (steps.includes('clean-marker')) cleanMaterializedMarker(repo.root);
}

describe('git-auto migration matrix (integration)', () => {
  it('S1: ignored board migrates — files verified into the worktree, gone from the primary', async () => {
    const repo = await repoWithBoard();
    repo.addGitignore(['backlog/tasks/', 'backlog/drafts/', 'backlog/completed/', 'backlog/archive/']);

    await migrateCores(repo);

    const board = boardWorktreePathFor(repo.root);
    expect(fs.existsSync(path.join(board, 'backlog', 'tasks', 'task-1 - First.md'))).toBe(true);
    expect(fs.existsSync(path.join(board, 'backlog', 'milestones', 'm-1 - Age.md'))).toBe(true);
    expect(fs.existsSync(path.join(repo.root, 'backlog', 'tasks'))).toBe(false);
    expect(fs.existsSync(path.join(repo.root, 'backlog', 'milestones'))).toBe(false);
    // config.yml stays with the code (split root).
    expect(fs.existsSync(path.join(repo.root, 'backlog', 'config.yml'))).toBe(true);
  }, 30_000);

  it('S2: TRACKED board files (stale 4-dir block) — untracked, block upgraded, uncommitted edit survives', async () => {
    const repo = await repoWithBoard();
    // Track the board on the code branch (the 3-of-5-repos state), with the
    // pre-milestones fenced block on disk.
    fs.writeFileSync(
      path.join(repo.root, '.gitignore'),
      '# >>> taskwright synced board >>>\nbacklog/tasks/\nbacklog/drafts/\nbacklog/completed/\nbacklog/archive/\n# <<< taskwright synced board <<<\n'
    );
    await repo.git(['add', '-f', 'backlog']);
    await repo.git(['commit', '-q', '-m', 'track board (legacy repo state)']);
    // An uncommitted board edit right before migration — the working tree is truth.
    repo.writeFile('backlog/tasks/task-1 - First.md', TASK_1('Uncommitted edit.', '2026-07-11 09:00'));

    const facts = await gatherMigrationFacts(repo.root, REF);
    expect(facts.trackedBoardFiles.length).toBeGreaterThan(0);
    await migrateCores(repo);

    const gitignore = fs.readFileSync(path.join(repo.root, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('backlog/milestones/');
    const tracked = (await repo.git(['ls-files', '--', ...boardTrackedPaths()])).trim();
    expect(tracked).toBe('');
    const moved = fs.readFileSync(
      path.join(boardWorktreePathFor(repo.root), 'backlog', 'tasks', 'task-1 - First.md'),
      'utf-8'
    );
    expect(moved).toContain('Uncommitted edit.');
  }, 30_000);

  it('S3: existing stale ref + remote ahead — history continues, remote folds, push fast-forwards', async () => {
    const repo = await repoWithBoard();
    const bare = await initBareRemote(repo);

    // v2-era ref: an OLD snapshot, pushed to the remote.
    await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: REF,
      indexFile: path.join(repo.root, '.taskwright', 'board.index'),
      message: 'v2 snapshot',
    });
    await repo.git(['push', '-q', REMOTE, `refs/heads/${REF}:refs/heads/${REF}`]);
    const oldTip = await refTip(repo.root, REF);

    // The remote moves ahead: a second clone edits TASK-1 with a NEWER updated_date.
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-clone-'));
    cleanups.push(() => fs.rmSync(cloneDir, { recursive: true, force: true }));
    await execFileAsync('git', ['clone', '-q', bare, cloneDir]);
    const cloneEnsured = await ensureBoardWorktree({ primaryRoot: cloneDir, ref: REF, remote: REMOTE });
    expect(cloneEnsured.seeded).toBe('from-remote');
    fs.writeFileSync(
      path.join(cloneEnsured.path, 'backlog', 'tasks', 'task-1 - First.md'),
      TASK_1('Remote-newer body.', '2026-07-12 10:00')
    );
    await autoCommitBoard(cloneEnsured.path);
    const clonePush = await runBoardAutoSync({ primaryRoot: cloneDir, ref: REF, remote: REMOTE });
    expect('skipped' in clonePush).toBe(false);
    if (!('skipped' in clonePush)) expect(clonePush.pushed).toBe(true);

    // Meanwhile the live board here diverges (older updated_date than the remote).
    repo.writeFile('backlog/tasks/task-1 - First.md', TASK_1('Local divergent body.', '2026-07-11 12:00'));

    await migrateCores(repo); // seed-fold-ref: snapshot parented on oldTip

    const sync = await runBoardAutoSync({ primaryRoot: repo.root, ref: REF, remote: REMOTE });
    expect('skipped' in sync).toBe(false);
    if ('skipped' in sync) return;
    expect(sync.merged).toBe(true);
    expect(sync.pushed).toBe(true); // fast-forward for the remote: two-parent merge
    expect(sync.conflicts.map((c) => c.id)).toContain('TASK-1');
    // Newer updated_date (the remote side) won; history still reaches the old tip.
    const content = fs.readFileSync(
      path.join(boardWorktreePathFor(repo.root), 'backlog', 'tasks', 'task-1 - First.md'),
      'utf-8'
    );
    expect(content).toContain('Remote-newer body.');
    const mergedTip = await refTip(repo.root, REF);
    const { stdout } = await execFileAsync('git', ['merge-base', '--is-ancestor', oldTip!, mergedTip!], { cwd: repo.root }).then(
      () => ({ stdout: 'yes' }),
      () => ({ stdout: 'no' })
    );
    expect(stdout).toBe('yes');
  }, 30_000);

  it('S4: v1 board.materialized marker is cleaned by the migration', async () => {
    const repo = await repoWithBoard();
    repo.writeFile('.taskwright/board.materialized', 'deadbeef\n');

    const facts = await gatherMigrationFacts(repo.root, REF);
    expect(facts.hasMaterializedMarker).toBe(true);
    expect(planMigrationSteps(facts)).toContain('clean-marker');
    await migrateCores(repo);

    expect(fs.existsSync(path.join(repo.root, '.taskwright', 'board.materialized'))).toBe(false);
  }, 30_000);

  it('S6: re-running the migration is a no-op', async () => {
    const repo = await repoWithBoard();
    await migrateCores(repo);
    const countAfterFirst = (await repo.git(['rev-list', '--count', REF])).trim();

    const facts = await gatherMigrationFacts(repo.root, REF);
    expect(planMigrationSteps(facts)).toEqual(['noop']);
    const again = await ensureBoardWorktree({ primaryRoot: repo.root, ref: REF, remote: REMOTE });
    expect(again.created).toBe(false);
    expect((await repo.git(['rev-list', '--count', REF])).trim()).toBe(countAfterFirst);
  }, 30_000);
});

describe('git-auto engine (integration)', () => {
  it('round-trip: A writes → auto-commit → sync → B syncs and sees the task', async () => {
    const repoA = await repoWithBoard();
    const bare = await initBareRemote(repoA);
    await migrateCores(repoA);
    const syncA1 = await runBoardAutoSync({ primaryRoot: repoA.root, ref: REF, remote: REMOTE });
    expect(!('skipped' in syncA1) && syncA1.pushed).toBe(true);

    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-clone-'));
    cleanups.push(() => fs.rmSync(cloneDir, { recursive: true, force: true }));
    await execFileAsync('git', ['clone', '-q', bare, cloneDir]);
    const boardB = await ensureBoardWorktree({ primaryRoot: cloneDir, ref: REF, remote: REMOTE });
    expect(fs.existsSync(path.join(boardB.path, 'backlog', 'tasks', 'task-1 - First.md'))).toBe(true);

    // A writes a NEW task; the debounced commit + event sync publish it.
    fs.writeFileSync(
      path.join(boardWorktreePathFor(repoA.root), 'backlog', 'tasks', 'task-2 - Second.md'),
      TASK_1('Second task.').replace('TASK-1', 'TASK-2').replace('First', 'Second')
    );
    const commit = await autoCommitBoard(boardWorktreePathFor(repoA.root));
    expect(commit.committed).toBe(true);
    const syncA2 = await runBoardAutoSync({ primaryRoot: repoA.root, ref: REF, remote: REMOTE });
    expect(!('skipped' in syncA2) && syncA2.pushed).toBe(true);

    const syncB = await runBoardAutoSync({ primaryRoot: cloneDir, ref: REF, remote: REMOTE });
    expect('skipped' in syncB).toBe(false);
    expect(
      fs.existsSync(path.join(boardB.path, 'backlog', 'tasks', 'task-2 - Second.md'))
    ).toBe(true);
  }, 30_000);

  it('offline: no remote — commits accumulate, sync degrades without throwing', async () => {
    const repo = await repoWithBoard();
    await migrateCores(repo); // no remote configured at all

    fs.writeFileSync(
      path.join(boardWorktreePathFor(repo.root), 'backlog', 'tasks', 'task-1 - First.md'),
      TASK_1('Offline edit.', '2026-07-11 10:00')
    );
    const before = await refTip(repo.root, REF);
    const sync = await runBoardAutoSync({ primaryRoot: repo.root, ref: REF, remote: REMOTE });
    expect('skipped' in sync).toBe(false);
    if ('skipped' in sync) return;
    expect(sync.committed).toBe(true);
    expect(sync.pushed).toBe(false);
    expect(sync.remoteTip).toBeNull();
    expect(await refTip(repo.root, REF)).not.toBe(before); // the commit is retained
  }, 30_000);

  it('worktree loss: committed history survives deletion; repair restores it', async () => {
    const repo = await repoWithBoard();
    await migrateCores(repo);
    fs.writeFileSync(
      path.join(boardWorktreePathFor(repo.root), 'backlog', 'tasks', 'task-1 - First.md'),
      TASK_1('Committed before loss.', '2026-07-11 11:00')
    );
    await autoCommitBoard(boardWorktreePathFor(repo.root));

    fs.rmSync(boardWorktreePathFor(repo.root), { recursive: true, force: true });
    expect(await boardWorktreeStatusOf(repo.root, REF)).toBe('dir-missing');

    const repaired = await ensureBoardWorktree({ primaryRoot: repo.root, ref: REF, remote: REMOTE });
    expect(repaired.seeded).toBe('from-local-ref');
    expect(
      fs.readFileSync(
        path.join(repaired.path, 'backlog', 'tasks', 'task-1 - First.md'),
        'utf-8'
      )
    ).toContain('Committed before loss.');
  }, 30_000);

  it('split-brain heal: strays in the primary backlog/ fold into the board and are cleared', async () => {
    const repo = await repoWithBoard();
    await migrateCores(repo);
    // A stale pre-reload writer recreates a task in the primary tree.
    repo.writeFile('backlog/tasks/task-9 - Stray.md', TASK_1('Stray body.').replace('TASK-1', 'TASK-9'));

    const folded = await foldPrimaryStrays(repo.root);
    expect(folded).not.toBeNull();
    expect(
      fs.existsSync(
        path.join(boardWorktreePathFor(repo.root), 'backlog', 'tasks', 'task-9 - Stray.md')
      )
    ).toBe(true);
    expect(fs.existsSync(path.join(repo.root, 'backlog', 'tasks'))).toBe(false);
  }, 30_000);

  it('reverse migration: the board materializes back into the primary backlog/', async () => {
    const repo = await repoWithBoard();
    await migrateCores(repo);
    const worktree = boardWorktreePathFor(repo.root);
    fs.writeFileSync(
      path.join(worktree, 'backlog', 'tasks', 'task-1 - First.md'),
      TASK_1('Pending edit before leaving git-auto.', '2026-07-11 12:00')
    );

    // migrateFromGitAuto's core sequence (sans vscode):
    await autoCommitBoard(worktree);
    await materializeRefToWorktree({
      repoRoot: repo.root,
      ref: REF,
      indexFile: path.join(repo.root, '.taskwright', 'board.index'),
    });
    await defaultBoardExec(repo.root, ['worktree', 'remove', '--force', worktree]);
    await defaultBoardExec(repo.root, ['worktree', 'prune']);

    expect(
      fs.readFileSync(path.join(repo.root, 'backlog', 'tasks', 'task-1 - First.md'), 'utf-8')
    ).toContain('Pending edit before leaving git-auto.');
    expect(fs.existsSync(worktree)).toBe(false);
  }, 30_000);

  it('a dirty board never dirties the primary tree (the ffMergeToBase carve-out is inert)', async () => {
    const repo = await repoWithBoard();
    await migrateCores(repo);
    // Board writes land ONLY in the hidden worktree…
    fs.writeFileSync(
      path.join(boardWorktreePathFor(repo.root), 'backlog', 'tasks', 'task-1 - First.md'),
      TASK_1('Dirty board edit.', '2026-07-11 13:00')
    );
    // …so the PRIMARY tree's porcelain shows no board/.taskwright entry at all
    // (the .gitignore write below is the test's own noise, not board dirt).
    repo.addGitignore(['.taskwright/', 'backlog/']);
    const porcelain = (await repo.git(['status', '--porcelain'])).trim();
    const boardEntries = porcelain
      .split('\n')
      .filter((l) => l.includes('backlog/') || l.includes('.taskwright/'));
    expect(boardEntries).toEqual([]);
  }, 30_000);
});
