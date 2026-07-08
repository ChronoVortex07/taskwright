import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { TreeFieldService } from '../../core/TreeFieldService';
import {
  createTaskHandler,
  editTaskHandler,
  claimTaskHandler,
  nextReadyTasksHandler,
} from '../../mcp/handlers';
import type { McpHandlerDeps } from '../../mcp/handlers';
import type { GitExecFn } from '../../core/finishTask';
import { mergeQueuePath, type QueueFsDeps } from '../../core/mergeQueue';

let root: string, backlogPath: string;
function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ready-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(backlogPath, 'drafts'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    'project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n',
    'utf-8'
  );
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
beforeEach(() => scaffold());
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('nextReadyTasksHandler', () => {
  it('includes a task once its dependency is Done; excludes blocked and Done tasks', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Base' }); // TASK-1
    await createTaskHandler(d, { title: 'Dep', dependencies: ['TASK-1'] }); // TASK-2

    // Blocked while TASK-1 is open: only TASK-1 is ready.
    let ready = await nextReadyTasksHandler(d, {});
    expect(ready.map((r) => r.id)).toEqual(['TASK-1']);

    // Finish TASK-1 ⇒ it drops out (Done) and TASK-2 unblocks.
    await editTaskHandler(d, { taskId: 'TASK-1', status: 'Done' });
    ready = await nextReadyTasksHandler(d, {});
    expect(ready.map((r) => r.id)).toEqual(['TASK-2']);
    // Rows are the get_board compact shape:
    expect(ready[0]).toHaveProperty('blockedBy');
    expect(ready[0]).toHaveProperty('locked', false);
  });

  it('excludes a task held by a live claim', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'A' }); // TASK-1
    await createTaskHandler(d, { title: 'B' }); // TASK-2
    await claimTaskHandler(d, { taskId: 'TASK-1', claimedBy: '@other' }); // claimedAt = now → live
    const ready = await nextReadyTasksHandler(d, {});
    expect(ready.map((r) => r.id)).toEqual(['TASK-2']);
  });

  it('excludes a task that is in the shared merge queue (injected git + queue fs)', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'A' }); // TASK-1
    await createTaskHandler(d, { title: 'B' }); // TASK-2

    const commonDir = path.join(root, '.git');
    const queueFile = mergeQueuePath(commonDir);
    const queue = {
      version: 1,
      entries: [
        {
          taskId: 'TASK-2',
          branch: 'b',
          worktree: '.worktrees/b',
          mode: 'auto-merge',
          submittedAt: '',
          approved: false,
          active: true,
          activeAt: null,
        },
      ],
    };
    const gitExec: GitExecFn = async (_cwd, args) => {
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: `${commonDir}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const fsDeps: QueueFsDeps = {
      exists: (p) => p === queueFile,
      read: (p) => (p === queueFile ? `${JSON.stringify(queue)}\n` : ''),
      writeAtomic: () => {},
    };

    const ready = await nextReadyTasksHandler({ ...d, gitExec, fsDeps }, {});
    expect(ready.map((r) => r.id)).toEqual(['TASK-1']); // TASK-2 is mid-integration
  });

  it('filters by category and honors limit; sorts by priority', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Hi', category: 'Features', priority: 'high' }); // TASK-1
    await createTaskHandler(d, { title: 'Lo', category: 'Features', priority: 'low' }); // TASK-2
    await createTaskHandler(d, { title: 'Other', category: 'Platform' }); // TASK-3 (no priority)

    // Category filter → only the Features lane, high before low.
    const feats = await nextReadyTasksHandler(d, { category: 'Features' });
    expect(feats.map((r) => r.id)).toEqual(['TASK-1', 'TASK-2']);

    // Limit caps to the top of the priority order across the whole board.
    const one = await nextReadyTasksHandler(d, { limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0].id).toBe('TASK-1'); // highest priority overall
  });

  it('never returns drafts (a draft must be promoted before dispatch)', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Real' }); // TASK-1
    await createTaskHandler(d, { title: 'Idea', draft: true }); // DRAFT-1
    const ready = await nextReadyTasksHandler(d, {});
    expect(ready.map((r) => r.id)).toEqual(['TASK-1']);
  });
});
