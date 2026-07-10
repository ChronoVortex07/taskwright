/**
 * Real-git integration test for Fix 1: proves that resetTaskFile prevents the
 * ff-merge collision caused by the intermediate-status write to the primary tree.
 *
 * Uses actual git commands and real fs — no mocks for git/fs. Board ops and
 * MergeQueueStore use real implementations. Sleep and run are no-ops/stubs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { requestMerge, type GitExecFn, type RunFn } from '../../core/finishTask';
import { MergeQueueStore, mergeQueuePath, nodeQueueFs } from '../../core/mergeQueue';
import { makePrimaryBoard } from '../../mcp/handlers';

const execFileAsync = promisify(execFile);

const realExec: GitExecFn = (cwd, args) =>
  execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });

const stubRun: RunFn = async () => ({ code: 0, stdout: '', stderr: '' });

const TASK_MD = `---
id: TASK-7
title: Sample
status: In Progress
assignee: []
dependencies: []
---
## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Sample task for integration test.

<!-- SECTION:DESCRIPTION:END -->
`;

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000 });
  return stdout.trim();
}

describe('requestMerge integration — Fix 1: resetTaskFile enables ff-merge after status write', () => {
  it('merges cleanly after intermediate-status write to primary tree', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-int-'));
    const primary = path.join(tmpDir, 'primary');
    fs.mkdirSync(primary, { recursive: true });

    // Init primary repo
    await git(primary, 'init', '-b', 'main');
    await git(primary, 'config', 'user.email', 'test@example.com');
    await git(primary, 'config', 'user.name', 'Test User');

    // .gitignore must include .worktrees/ so the untracked worktree dir doesn't
    // appear as code WIP in git status --porcelain (matches real repo behaviour).
    fs.writeFileSync(path.join(primary, '.gitignore'), '.worktrees/\n', 'utf-8');

    // Create initial task file on main
    const tasksDir = path.join(primary, 'backlog', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'task-7 - Sample.md'), TASK_MD, 'utf-8');
    await git(primary, 'add', '.');
    await git(primary, 'commit', '-m', 'init');

    // Create worktree on task-7-x branch
    const worktreeRel = '.worktrees/task-7-x';
    const worktreePath = path.join(primary, worktreeRel);
    await git(primary, 'worktree', 'add', worktreePath, '-b', 'task-7-x');
    await git(primary, 'config', 'user.email', 'test@example.com');
    await git(primary, 'config', 'user.name', 'Test User');

    // In worktree: modify task file and commit
    const wtTaskFile = path.join(worktreePath, 'backlog', 'tasks', 'task-7 - Sample.md');
    fs.writeFileSync(wtTaskFile, TASK_MD + '\n<!-- worktree change -->\n', 'utf-8');
    await git(worktreePath, 'config', 'user.email', 'test@example.com');
    await git(worktreePath, 'config', 'user.name', 'Test User');
    await git(worktreePath, 'add', '.');
    await git(worktreePath, 'commit', '-m', 'task-7: implementation done');

    // Simulate intermediate-status write in primary tree (leaves file dirty)
    const board = makePrimaryBoard(primary, realExec);
    await board.setStatus('TASK-7', 'Pending Review');

    // Verify the primary tree task file IS dirty now (the bug condition)
    const porcelain = await git(primary, 'status', '--porcelain');
    expect(porcelain).toMatch(/task-7/); // dirty

    // Set up real queue
    const gitDir = path.join(primary, '.git');
    const queue = new MergeQueueStore(mergeQueuePath(gitDir), nodeQueueFs);

    // Call requestMerge with real board and real exec
    const result = await requestMerge(
      {
        root: worktreePath,
        primaryRoot: primary,
        branch: 'task-7-x',
        worktreeRel,
        config: {
          mode: 'auto-merge',
          verifyCommands: [],
          staleMinutes: 30,
          verifyTimeoutMs: 600_000,
        },
        queue,
        board,
        exec: realExec,
        run: stubRun,
        now: () => new Date('2026-07-01T12:00:00Z'),
        sleep: async () => {},
      },
      'TASK-7'
    );

    // Assert: merged successfully
    expect(result.status).toBe('merged');

    // Assert: the task stays on the board in tasks/ (NOT filed into completed/) —
    // request_merge marks it Done but no longer auto-completes.
    const tasksDirAfter = path.join(primary, 'backlog', 'tasks');
    const taskFilesAfter = fs.existsSync(tasksDirAfter) ? fs.readdirSync(tasksDirAfter) : [];
    expect(taskFilesAfter.some((f) => f.includes('task-7'))).toBe(true);

    const completedDir = path.join(primary, 'backlog', 'completed');
    const completedFiles = fs.existsSync(completedDir) ? fs.readdirSync(completedDir) : [];
    expect(completedFiles.some((f) => f.includes('task-7'))).toBe(false);

    // Assert: the task file (still in tasks/) has status: Done
    const taskFile = path.join(tasksDirAfter, taskFilesAfter.find((f) => f.includes('task-7'))!);
    const taskContent = fs.readFileSync(taskFile, 'utf-8');
    expect(taskContent).toMatch(/^status:\s*Done/m);

    // Assert: the branch commit is on main (ff actually happened)
    const mainLog = await git(primary, 'log', '--oneline', 'main');
    expect(mainLog).toMatch(/task-7/i);

    // Assert: queue is empty (dequeued)
    expect(queue.read().entries).toHaveLength(0);
    // Real-git integration: many subprocess spawns; the 5s default flakes under load.
  }, 60_000);
});
