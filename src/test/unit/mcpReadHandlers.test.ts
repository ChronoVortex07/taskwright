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
  listCategoriesHandler,
  listMilestonesHandler,
  getBoardHandler,
  searchTasksHandler,
} from '../../mcp/handlers';
import type { McpHandlerDeps } from '../../mcp/handlers';

/** Write a raw task .md into an arbitrary backlog subfolder (completed/, archive/tasks/). */
function seedTaskFile(
  folder: string,
  id: string,
  fields: { title: string; status?: string; category?: string; milestone?: string }
): void {
  const dir = path.join(backlogPath, folder);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [`id: ${id}`, `title: ${fields.title}`, `status: ${fields.status ?? 'Done'}`];
  if (fields.milestone) lines.push(`milestone: ${fields.milestone}`);
  if (fields.category) lines.push(`category: ${fields.category}`);
  const body = `---\n${lines.join('\n')}\n---\n\n## Description\n\n${fields.title}\n`;
  fs.writeFileSync(path.join(dir, `${id} - ${fields.title}.md`), body, 'utf-8');
}

let root: string, backlogPath: string;
function scaffold(configExtra = ''): void {
  // Tests that need configExtra call scaffold(...) again inside the test body —
  // remove the beforeEach tmpdir first so it doesn't leak (afterEach only removes
  // the latest root).
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-read-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(backlogPath, 'drafts'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    `project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n${configExtra}`,
    'utf-8'
  );
}
function deps(): McpHandlerDeps {
  return {
    root, backlogPath,
    parser: new BacklogParser(backlogPath), writer: new BacklogWriter(),
    claimService: new ClaimService(), planService: new PlanService(),
    treeFieldService: new TreeFieldService(),
  };
}
beforeEach(() => scaffold());
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('listCategoriesHandler', () => {
  it('returns laneOrder vocabulary with counts and reserved flags', async () => {
    scaffold('categories: ["Features", "Platform"]\n');
    const d = deps();
    await createTaskHandler(d, { title: 'A', category: 'Features' });
    await createTaskHandler(d, { title: 'B', category: 'Features' });
    await createTaskHandler(d, { title: 'C' }); // Misc
    await createTaskHandler(d, { title: 'Bug', type: 'bug', causedBy: undefined }); // Bugs lane
    const cats = await listCategoriesHandler(d);
    const byName = new Map(cats.map((c) => [c.category, c]));
    expect(byName.get('Features')!.count).toBe(2);
    expect(byName.get('Features')!.reserved).toBe(false);
    expect(byName.get('Platform')!.count).toBe(0); // declared, unused
    expect(byName.get('Misc')!.reserved).toBe(true);
    expect(byName.get('Bugs')!.reserved).toBe(true);
    expect(byName.get('Bugs')!.count).toBe(1);
    // reserved lanes are last, declared order preserved:
    expect(cats.map((c) => c.category).slice(0, 2)).toEqual(['Features', 'Platform']);
    expect(cats.map((c) => c.category).slice(-2)).toEqual(['Misc', 'Bugs']);
  });

  it('counts drafts in the universe (canvas parity)', async () => {
    scaffold('categories: ["Features"]\n');
    const d = deps();
    await createTaskHandler(d, { title: 'D', draft: true, category: 'Features' });
    const cats = await listCategoriesHandler(d);
    expect(cats.find((c) => c.category === 'Features')!.count).toBe(1);
  });

  // R1 (Task 4 review): a task whose stored casing differs from the canonical
  // laneOrder entry must still be counted under that lane (case-insensitive keying).
  it('counts a task whose stored category casing differs from the canonical lane', async () => {
    scaffold('categories: ["Features"]\n');
    const d = deps();
    await createTaskHandler(d, { title: 'X', category: 'features' }); // lowercase on disk
    const cats = await listCategoriesHandler(d);
    expect(cats.find((c) => c.category === 'Features')!.count).toBe(1);
  });
});

describe('listMilestonesHandler', () => {
  it('orders by bandOrder and counts task/done per band; Backburner absorbs unset', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'A', milestone: 'v1' });
    await createTaskHandler(d, { title: 'B', milestone: 'v1' });
    await editTaskHandler(d, { taskId: 'TASK-2', status: 'Done' });
    await createTaskHandler(d, { title: 'C' }); // no milestone → Backburner
    const ms = await listMilestonesHandler(d);
    const byName = new Map(ms.map((m) => [m.name, m]));
    expect(byName.get('v1')!.taskCount).toBe(2);
    expect(byName.get('v1')!.doneCount).toBe(1);
    expect(byName.get('Backburner')!.taskCount).toBe(1);
    expect(byName.get('Backburner')!.id).toBeUndefined();
    expect(ms[ms.length - 1].name).toBe('Backburner'); // always last
    // order is 0-based, ascending, matching bandOrder:
    expect(ms.map((m) => m.order)).toEqual(ms.map((_m, i) => i));
  });
});

describe('getBoardHandler', () => {
  it('returns compact summaries over tasks+drafts; drafts flagged; unset lane/band omitted', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Feature X', category: 'Features', milestone: 'v1' });
    await createTaskHandler(d, { title: 'Loose' }); // Misc + Backburner (omitted)
    await createTaskHandler(d, { title: 'Idea', draft: true });
    const board = await getBoardHandler(d, {});
    const byId = new Map(board.map((b) => [b.id, b]));
    expect(byId.get('TASK-1')!.category).toBe('Features');
    expect(byId.get('TASK-2')!.category).toBeUndefined(); // Misc not synthesized
    expect(byId.get('TASK-2')!.milestone).toBeUndefined(); // Backburner not synthesized
    expect(byId.get('DRAFT-1')!.draft).toBe(true);
    expect(byId.get('TASK-1')!.draft).toBe(false);
  });

  it('filters by category (Misc/Bugs match), milestone (Backburner matches unset), status', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'A', category: 'Features', milestone: 'v1' });
    await createTaskHandler(d, { title: 'B' }); // Misc + Backburner
    expect((await getBoardHandler(d, { category: 'Features' })).map((b) => b.id)).toEqual([
      'TASK-1',
    ]);
    expect((await getBoardHandler(d, { category: 'Misc' })).map((b) => b.id)).toEqual(['TASK-2']);
    expect((await getBoardHandler(d, { milestone: 'Backburner' })).map((b) => b.id)).toEqual([
      'TASK-2',
    ]);
    expect(
      (await getBoardHandler(d, { status: 'To Do' })).map((b) => b.id).sort()
    ).toEqual(['TASK-1', 'TASK-2']);
  });

  it('reports locked/blockedBy from the derivation', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Base' }); // TASK-1
    await createTaskHandler(d, { title: 'Dep', dependencies: ['TASK-1'] }); // TASK-2 blocked by TASK-1
    const board = await getBoardHandler(d, {});
    const t2 = board.find((b) => b.id === 'TASK-2')!;
    expect(t2.locked).toBe(true);
    expect(t2.blockedBy).toEqual(['TASK-1']);
  });
});

describe('searchTasksHandler', () => {
  it('ranks compact summaries over the tasks+drafts universe', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Login flow' });
    await createTaskHandler(d, { title: 'Dashboard', description: 'login widget' });
    const res = await searchTasksHandler(d, { query: 'login' });
    expect(res.map((r) => r.id)).toEqual(['TASK-1', 'TASK-2']);
    expect(res[0]).toHaveProperty('locked'); // compact summary shape (same as get_board)
  });

  it('errors on a blank query', async () => {
    await expect(searchTasksHandler(deps(), { query: '  ' })).rejects.toThrow(/query/i);
  });
});

// R2 (Task 4 review): completed/ and archive/tasks/ tasks gate the derivation but
// must never be counted or emitted by the read tools.
describe('universe exclusion (completed/archive)', () => {
  it('excludes completed/archived tasks from counts and get_board output', async () => {
    scaffold('categories: ["Features"]\n');
    const d = deps();
    await createTaskHandler(d, { title: 'Live', category: 'Features', milestone: 'v1' });
    await editTaskHandler(d, { taskId: 'TASK-1', status: 'Done' });
    seedTaskFile('completed', 'TASK-90', {
      title: 'Done one',
      status: 'Done',
      category: 'Features',
      milestone: 'v1',
    });
    seedTaskFile('archive/tasks', 'TASK-91', {
      title: 'Archived one',
      status: 'Done',
      category: 'Features',
      milestone: 'v1',
    });

    const cats = await listCategoriesHandler(d);
    expect(cats.find((c) => c.category === 'Features')!.count).toBe(1); // only the live task

    const ms = await listMilestonesHandler(d);
    const v1 = ms.find((m) => m.name === 'v1')!;
    expect(v1.taskCount).toBe(1);
    expect(v1.doneCount).toBe(1);

    const board = await getBoardHandler(d, {});
    expect(board.map((b) => b.id).sort()).toEqual(['TASK-1']);
  });
});
