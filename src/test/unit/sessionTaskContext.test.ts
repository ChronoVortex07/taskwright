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
import {
  createTaskHandler,
  startTaskHandler,
  claimTaskHandler,
  releaseTaskHandler,
  editTaskHandler,
  getActiveTask,
  type McpHandlerDeps,
} from '../../mcp/handlers';
import { writeActiveTask, clearActiveTask } from '../../core/activeTask';
import { recordSessionTask, readSessionTasks } from '../../core/sessionTasks';

/**
 * TASK-129. A session that bootstraps its own worktree with `start_task` is the
 * one session that CANNOT see its own active task: `start_task` seeds the marker
 * inside the new worktree, while the MCP server stays rooted in the primary tree.
 * So (a) start_task/claim_task hand back the full task context up front, and
 * (b) get_active_task falls back to the task THIS session started/claimed.
 */

let root: string;
let backlogPath: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sessctx-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    'project_name: "test"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n',
    'utf-8'
  );
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

describe('start_task returns full task context (TASK-129 AC1)', () => {
  it('hands back the task summary so no follow-up board lookup is needed', async () => {
    await createTaskHandler(deps(), {
      title: 'Add login',
      description: 'Wire up the login form.',
      acceptanceCriteria: [{ text: 'Form submits' }, { text: 'Errors surface' }],
    });

    const res = await startTaskHandler(deps(), { taskId: 'TASK-1' });

    expect(res.task).toBeDefined();
    expect(res.task?.id).toBe('TASK-1');
    expect(res.task?.title).toBe('Add login');
    expect(res.task?.description).toContain('Wire up the login form.');
    expect(res.task?.acceptanceCriteria.map((ac) => ac.text)).toEqual([
      'Form submits',
      'Errors surface',
    ]);
    // The board file path — so nobody has to hunt for it (git-auto moves the board).
    expect(res.task?.filePath).toBeTruthy();
    expect(fs.existsSync(res.task!.filePath)).toBe(true);
    // Bootstrap contract still holds.
    expect(res.worktree).toBe('.worktrees/task-1-add-login');
  });

  it('records the task in the session ledger', async () => {
    await createTaskHandler(deps(), { title: 'Add login' });
    await startTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(readSessionTasks(root).map((e) => e.taskId)).toEqual(['TASK-1']);
  });
});

describe('claim_task returns full task context (TASK-129 AC1)', () => {
  it('hands back the task summary, reflecting the post-claim status', async () => {
    await createTaskHandler(deps(), {
      title: 'Add login',
      description: 'Wire up the login form.',
      acceptanceCriteria: [{ text: 'Form submits' }],
    });

    const res = await claimTaskHandler(deps(), { taskId: 'TASK-1', worktree: 'task-1-add-login' });

    expect(res.claimed).toBe(true);
    expect(res.task).toBeDefined();
    expect(res.task?.id).toBe('TASK-1');
    expect(res.task?.description).toContain('Wire up the login form.');
    expect(res.task?.acceptanceCriteria.map((ac) => ac.text)).toEqual(['Form submits']);
    // claim advances To Do -> In Progress; the echoed context must not be stale.
    expect(res.task?.status).toBe('In Progress');
    expect(res.task?.claimedBy).toBe(res.claimedBy);
  });

  it('hands back the context on an idempotent re-claim too', async () => {
    await createTaskHandler(deps(), { title: 'Add login' });
    await claimTaskHandler(deps(), { taskId: 'TASK-1', worktree: 'task-1-add-login' });
    const again = await claimTaskHandler(deps(), { taskId: 'TASK-1', worktree: 'task-1-add-login' });
    expect(again.alreadyClaimed).toBe(true);
    expect(again.task?.id).toBe('TASK-1');
  });

  it('records the task in the session ledger', async () => {
    await createTaskHandler(deps(), { title: 'Add login' });
    await claimTaskHandler(deps(), { taskId: 'TASK-1', worktree: 'task-1-add-login' });
    expect(readSessionTasks(root).map((e) => e.taskId)).toEqual(['TASK-1']);
  });

  it('does not record a surrendered claim (someone else holds it)', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Add login' });
    // Another session holds it: seed the claim on the BOARD directly, not through this
    // session's claim_task (which would — correctly — be this session's own claim).
    await d.claimService.claimTask('TASK-1', '@agent/other', d.parser, {
      worktree: 'task-1-theirs',
    });

    const res = await claimTaskHandler(deps(), { taskId: 'TASK-1', worktree: 'task-1-mine' });
    expect(res.surrendered).toBe(true);
    expect(res.claimed).toBe(false);
    expect(res.heldBy).toBe('@agent/other');
    // A task we do NOT hold is not in flight for us — it must not enter the ledger,
    // or a later get_active_task would hand us someone else's work.
    expect(res.task).toBeUndefined();
    expect(readSessionTasks(root)).toEqual([]);
  });
});

describe('get_active_task session fallback (TASK-129 AC2/AC3/AC5)', () => {
  it('returns active:false when there is no marker and no session claim', async () => {
    await createTaskHandler(deps(), { title: 'Add login' });
    const res = await getActiveTask(deps());
    expect(res.active).toBe(false);
    expect(res.source).toBe('none');
    expect(res.task).toBeUndefined();
  });

  it('falls back to the task this session started (the start_task blind spot)', async () => {
    await createTaskHandler(deps(), { title: 'Add login', description: 'Wire it up.' });
    // start_task seeds the marker INSIDE the worktree; the session root has none.
    const started = await startTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(fs.existsSync(path.join(root, '.taskwright', 'active-task.json'))).toBe(false);
    expect(started.worktreeAbs).toBeTruthy();

    const res = await getActiveTask(deps());
    expect(res.active).toBe(true);
    expect(res.source).toBe('session');
    expect(res.task?.id).toBe('TASK-1');
    expect(res.task?.description).toContain('Wire it up.');
    // It says which source it used.
    expect(res.message).toMatch(/session|start_task|claim/i);
  });

  it('falls back to the task this session claimed', async () => {
    await createTaskHandler(deps(), { title: 'Add login' });
    await claimTaskHandler(deps(), { taskId: 'TASK-1', worktree: 'task-1-add-login' });
    const res = await getActiveTask(deps());
    expect(res.active).toBe(true);
    expect(res.source).toBe('session');
    expect(res.task?.id).toBe('TASK-1');
  });

  it('the marker still WINS over the session fallback (dispatched sessions unchanged)', async () => {
    await createTaskHandler(deps(), { title: 'Add login' }); // TASK-1
    await createTaskHandler(deps(), { title: 'Fix logout' }); // TASK-2
    // This session claimed TASK-2, but the board/dispatch marker says TASK-1.
    await claimTaskHandler(deps(), { taskId: 'TASK-2', worktree: 'task-2-fix-logout' });
    writeActiveTask(root, 'TASK-1');

    const res = await getActiveTask(deps());
    expect(res.active).toBe(true);
    expect(res.source).toBe('marker');
    expect(res.task?.id).toBe('TASK-1');

    // Remove the marker and the session fallback takes over.
    clearActiveTask(root);
    const after = await getActiveTask(deps());
    expect(after.source).toBe('session');
    expect(after.task?.id).toBe('TASK-2');
  });

  it('never guesses when the session has several tasks in flight (parallel subagents)', async () => {
    await createTaskHandler(deps(), { title: 'Add login' }); // TASK-1
    await createTaskHandler(deps(), { title: 'Fix logout' }); // TASK-2
    // One orchestrator session, one MCP root, two bootstrapped worktrees: the
    // server cannot tell which in-session subagent is asking (MCP carries no cwd).
    await startTaskHandler(deps(), { taskId: 'TASK-1' });
    await startTaskHandler(deps(), { taskId: 'TASK-2' });

    const res = await getActiveTask(deps());
    expect(res.active).toBe(false);
    expect(res.source).toBe('none');
    expect(res.task).toBeUndefined();
    expect(res.candidates).toEqual(['TASK-1', 'TASK-2']);
    expect(res.message).toContain('TASK-1');
    expect(res.message).toContain('TASK-2');
  });

  it('release_task forgets the session task', async () => {
    await createTaskHandler(deps(), { title: 'Add login' });
    await claimTaskHandler(deps(), { taskId: 'TASK-1', worktree: 'task-1-add-login' });
    expect((await getActiveTask(deps())).active).toBe(true);

    await releaseTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(readSessionTasks(root)).toEqual([]);
    const res = await getActiveTask(deps());
    expect(res.active).toBe(false);
    expect(res.source).toBe('none');
  });

  it('a finished (Done) task is not "in flight" — it drops out of the fallback', async () => {
    await createTaskHandler(deps(), { title: 'Add login' }); // TASK-1
    await createTaskHandler(deps(), { title: 'Fix logout' }); // TASK-2
    await claimTaskHandler(deps(), { taskId: 'TASK-1', worktree: 'task-1-add-login' });
    await claimTaskHandler(deps(), { taskId: 'TASK-2', worktree: 'task-2-fix-logout' });
    // Two in flight -> ambiguous.
    expect((await getActiveTask(deps())).active).toBe(false);

    // request_merge marks TASK-1 Done; a sequential session moves on to TASK-2.
    await editTaskHandler(deps(), { taskId: 'TASK-1', status: 'Done' });
    const res = await getActiveTask(deps());
    expect(res.active).toBe(true);
    expect(res.source).toBe('session');
    expect(res.task?.id).toBe('TASK-2');
  });

  it('ignores a ledger entry whose task no longer exists', async () => {
    await createTaskHandler(deps(), { title: 'Add login' });
    recordSessionTask(root, { taskId: 'TASK-404', via: 'claim_task' });
    const res = await getActiveTask(deps());
    expect(res.active).toBe(false);
    expect(res.source).toBe('none');
  });

  it('ignores a stale ledger entry (older than the claim staleness window)', async () => {
    await createTaskHandler(deps(), { title: 'Add login' });
    await claimTaskHandler(deps(), { taskId: 'TASK-1', worktree: 'task-1-add-login' });
    // Backdate the entry well past the 12h staleness window.
    const p = path.join(root, '.taskwright', 'session-tasks.json');
    const entries = JSON.parse(fs.readFileSync(p, 'utf-8')) as Array<{ at: string }>;
    entries[0].at = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(p, JSON.stringify(entries), 'utf-8');

    const res = await getActiveTask(deps());
    expect(res.active).toBe(false);
    expect(res.source).toBe('none');
  });

  it('still reports not-found when a MARKER points at a missing task', async () => {
    writeActiveTask(root, 'TASK-999');
    const res = await getActiveTask(deps());
    expect(res.active).toBe(false);
    expect(res.message).toContain('TASK-999');
  });
});
