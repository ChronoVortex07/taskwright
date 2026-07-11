import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { TreeFieldService } from '../../core/TreeFieldService';
import { createTaskHandler, startTaskHandler } from '../../mcp/handlers';
import type { McpHandlerDeps } from '../../mcp/handlers';
import { activeTaskPath } from '../../core/activeTask';

let root: string;
let backlogPath: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-starth-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    'project_name: "test"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n',
    'utf-8'
  );
  // A git worktree add needs a HEAD commit to branch from.
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['add', '-A']);
  git(['commit', '-m', 'init', '--no-verify']);
}

function deps(): McpHandlerDeps {
  return {
    root,
    backlogPath,
    parser: new BacklogParser(backlogPath),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
    treeFieldService: new TreeFieldService(),
  };
}

beforeEach(scaffold);
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('startTaskHandler', () => {
  it('creates the task worktree, seeds its active task, and returns the contract shape', async () => {
    await createTaskHandler(deps(), { title: 'Add login' }); // TASK-1
    const res = await startTaskHandler(deps(), { taskId: 'TASK-1' });

    expect(res.taskId).toBe('TASK-1');
    expect(res.branch).toBe('task-1-add-login');
    expect(res.worktree).toBe('.worktrees/task-1-add-login');
    // repoRoot = path.dirname(backlogPath) = root, so the worktree lands under the primary.
    expect(res.worktreeAbs).toBe(path.join(root, '.worktrees', 'task-1-add-login'));
    expect(res.created).toBe(true);
    expect(res.relaunchHint).toContain(res.worktreeAbs);

    // Worktree exists and its active task points at TASK-1.
    expect(fs.existsSync(res.worktreeAbs)).toBe(true);
    const active = activeTaskPath(res.worktreeAbs);
    expect(fs.existsSync(active)).toBe(true);
    expect(JSON.parse(fs.readFileSync(active, 'utf-8')).taskId).toBe('TASK-1');
  });

  it('is idempotent (a second call reuses the worktree)', async () => {
    await createTaskHandler(deps(), { title: 'Add login' }); // TASK-1
    const first = await startTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(first.created).toBe(true);
    const second = await startTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(second.created).toBe(false);
    expect(second.worktreeAbs).toBe(first.worktreeAbs);
  });

  it('uses the primary code root when git-auto stores the board in a hidden worktree', async () => {
    const boardBacklog = path.join(root, '.taskwright', 'board', 'backlog');
    fs.mkdirSync(path.join(boardBacklog, 'tasks'), { recursive: true });
    fs.copyFileSync(path.join(backlogPath, 'config.yml'), path.join(boardBacklog, 'config.yml'));
    const gitAutoDeps: McpHandlerDeps = {
      ...deps(),
      primaryRoot: root,
      backlogPath: boardBacklog,
      parser: new BacklogParser(boardBacklog),
    };

    await createTaskHandler(gitAutoDeps, { title: 'Repair sync' });
    const res = await startTaskHandler(gitAutoDeps, { taskId: 'TASK-1' });

    expect(res.worktreeAbs).toBe(path.join(root, '.worktrees', 'task-1-repair-sync'));
    expect(fs.existsSync(path.join(res.worktreeAbs, 'src'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(activeTaskPath(res.worktreeAbs), 'utf-8')).taskId).toBe(
      'TASK-1'
    );
  });

  it('errors on an unknown task id', async () => {
    await expect(startTaskHandler(deps(), { taskId: 'TASK-404' })).rejects.toThrow('TASK-404');
  });
});
