import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { bootstrapTaskWorktree } from '../../core/startTask';
import { activeTaskPath } from '../../core/activeTask';
import { cancellationMarkerPath } from '../../core/cancellationMarker';

let repoRoot: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-start-'));
  // A git worktree add needs at least one commit (a valid HEAD to branch from).
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# temp\n', 'utf-8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'init', '--no-verify']);
});
afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

/** Minimal deps: getTask returns the id+title needed for the branch slug. */
const stubDeps = (task?: { id: string; title: string }) => ({
  repoRoot,
  getTask: async (id: string) => (task && task.id === id ? task : undefined),
});

describe('bootstrapTaskWorktree', () => {
  it('creates .worktrees/<branch>, seeds the active task inside it, and returns the contract shape', async () => {
    const result = await bootstrapTaskWorktree(stubDeps({ id: 'TASK-7', title: 'Add login' }), 'TASK-7');

    // Deterministic branch + repo-root-relative path (locked contract).
    expect(result.branch).toBe('task-7-add-login');
    expect(result.worktree).toBe('.worktrees/task-7-add-login');
    expect(result.created).toBe(true);
    expect(result.taskId).toBe('TASK-7');
    expect(result.worktreeAbs).toBe(path.join(repoRoot, '.worktrees', 'task-7-add-login'));
    // relaunchHint names the absolute worktree and the skill to run there.
    expect(result.relaunchHint).toContain(result.worktreeAbs);
    expect(result.relaunchHint).toContain('/execute-task');

    // The worktree dir exists on disk (git worktree add actually ran).
    expect(fs.existsSync(result.worktreeAbs)).toBe(true);
    // The active task was seeded INTO the worktree's own .taskwright/.
    const activeFile = activeTaskPath(result.worktreeAbs);
    expect(fs.existsSync(activeFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(activeFile, 'utf-8')).taskId).toBe('TASK-7');
    // No stale cancellation marker on a fresh worktree.
    expect(fs.existsSync(cancellationMarkerPath(result.worktreeAbs))).toBe(false);
  });

  it('is idempotent: a second call reuses the worktree (created:false), re-seeds active, clears a stale marker', async () => {
    const deps = stubDeps({ id: 'TASK-7', title: 'Add login' });
    const first = await bootstrapTaskWorktree(deps, 'TASK-7');
    expect(first.created).toBe(true);

    // Simulate a stale marker landing between runs (e.g. a prior leaked cancel).
    fs.mkdirSync(path.join(first.worktreeAbs, '.taskwright'), { recursive: true });
    fs.writeFileSync(cancellationMarkerPath(first.worktreeAbs), '{}', 'utf-8');

    const second = await bootstrapTaskWorktree(deps, 'TASK-7');
    expect(second.created).toBe(false); // dir reused, no git worktree add
    expect(second.worktreeAbs).toBe(first.worktreeAbs);
    expect(fs.existsSync(activeTaskPath(second.worktreeAbs))).toBe(true); // still seeded
    expect(fs.existsSync(cancellationMarkerPath(second.worktreeAbs))).toBe(false); // stale marker cleared
  });

  it('throws when the task id is unknown', async () => {
    await expect(bootstrapTaskWorktree(stubDeps(), 'TASK-404')).rejects.toThrow('TASK-404');
  });

  it('throws a friendly error when repoRoot is not a git repository', async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-nongit-'));
    try {
      const deps = {
        repoRoot: nonGit,
        getTask: async () => ({ id: 'TASK-7', title: 'Add login' }),
      };
      await expect(bootstrapTaskWorktree(deps, 'TASK-7')).rejects.toThrow(/git repository/);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
