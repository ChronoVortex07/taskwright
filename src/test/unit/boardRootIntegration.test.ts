/**
 * Real-git integration test for Board Sync v2 Task B (spec §2.1): proves a
 * write issued from a linked `.worktrees/<branch>` worktree is immediately
 * visible from the primary checkout's board, with NO materialize step — the
 * two sides never touch a copy, only the one physical `backlog/` directory
 * that `resolveBoardRoot()` resolves both of them to.
 *
 * The linked worktree deliberately has NO local `backlog/` directory at all
 * (mirroring production: it's git-ignored, so `git worktree add` never
 * populates it) — this is the exact scenario that broke pre-Task-B, since
 * worktree-local path resolution would have pointed at a directory that
 * doesn't exist.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveBoardRoot } from '../../core/boardRoot';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000 });
  return stdout.trim();
}

const TASK_MD = `---
id: TASK-1
title: Sample
status: To Do
assignee: []
dependencies: []
---
## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Sample task for the two-worktree visibility integration test.

<!-- SECTION:DESCRIPTION:END -->
`;

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('resolveBoardRoot integration — two-worktree write visibility (no materialize)', () => {
  it('a write from a linked worktree (with no local backlog/ at all) is immediately visible from the primary', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-board-root-int-'));
    const primary = path.join(tmpDir, 'primary');
    fs.mkdirSync(primary, { recursive: true });

    await git(primary, 'init', '-b', 'main');
    await git(primary, 'config', 'user.email', 'test@example.com');
    await git(primary, 'config', 'user.name', 'Test User');

    // backlog/ is git-ignored in real projects — mirror that so the linked
    // worktree created below genuinely has no local copy of it.
    fs.writeFileSync(path.join(primary, '.gitignore'), 'backlog/\n.worktrees/\n', 'utf-8');
    await git(primary, 'add', '.gitignore');
    await git(primary, 'commit', '-m', 'init');

    const tasksDir = path.join(primary, 'backlog', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'task-1 - Sample.md'), TASK_MD, 'utf-8');

    // Linked worktree — untracked backlog/ is NOT carried over by `git worktree add`.
    const worktreePath = path.join(primary, '.worktrees', 'task-1-x');
    await git(primary, 'worktree', 'add', worktreePath, '-b', 'task-1-x');
    expect(fs.existsSync(path.join(worktreePath, 'backlog'))).toBe(false);

    // Resolve the board root from the WORKTREE's cwd — must find the primary's
    // backlog/, not a (nonexistent) worktree-local one.
    const boardRootFromWorktree = await resolveBoardRoot(worktreePath);
    expect(path.normalize(boardRootFromWorktree)).toBe(
      path.normalize(path.join(primary, 'backlog'))
    );

    // Write "from the worktree" — using the resolved primary root, exactly as
    // an MCP server launched with TASKWRIGHT_ROOT=worktreePath now does.
    const writerParser = new BacklogParser(boardRootFromWorktree);
    const writer = new BacklogWriter();
    await writer.updateTask('TASK-1', { status: 'In Progress' }, writerParser);

    // Resolve the board root independently from the PRIMARY's cwd, with a
    // fresh parser instance — no shared cache, no materialize/copy step.
    const boardRootFromPrimary = await resolveBoardRoot(primary);
    expect(path.normalize(boardRootFromPrimary)).toBe(path.normalize(boardRootFromWorktree));

    const readerParser = new BacklogParser(boardRootFromPrimary);
    const task = await readerParser.getTask('TASK-1');

    expect(task?.status).toBe('In Progress');

    // The write landed on the one physical board dir, not in a copy inside
    // the worktree (which has no backlog/ dir at all).
    expect(fs.existsSync(path.join(worktreePath, 'backlog'))).toBe(false);
  });
});
