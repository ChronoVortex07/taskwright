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
  boardDoctorHandler,
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

  // TASK-33: when milestone files have IDs that differ from their names (the
  // real-world case — e.g. id=m-0, title="Foundation"), tasks assigned by name
  // must land in the real named band, not in a spurious ID-named discovered band.
  it('groups tasks into named bands when milestone IDs differ from names', async () => {
    // Create milestone files (id≠name) and tasks assigned by milestone NAME.
    const msDir = path.join(backlogPath, 'milestones');
    fs.mkdirSync(msDir, { recursive: true });
    fs.writeFileSync(
      path.join(msDir, 'm-0 - Foundation.md'),
      '---\nid: m-0\ntitle: Foundation\n---\n\n## Description\n\nCore infra\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(msDir, 'm-1 - Launch.md'),
      '---\nid: m-1\ntitle: Launch\n---\n\n## Description\n\nFirst release\n',
      'utf-8'
    );
    const d = deps();
    await createTaskHandler(d, { title: 'Core lib', milestone: 'Foundation' });
    await createTaskHandler(d, { title: 'CI pipeline', milestone: 'Foundation' });
    await createTaskHandler(d, { title: 'Landing page', milestone: 'Launch' });

    const ms = await listMilestonesHandler(d);
    const byName = new Map(ms.map((m) => [m.name, m]));

    // Foundation band should have 2 tasks (not 0)
    expect(byName.get('Foundation')!.taskCount).toBe(2);
    expect(byName.get('Foundation')!.id).toBe('m-0');
    // Launch band should have 1 task (not 0)
    expect(byName.get('Launch')!.taskCount).toBe(1);
    expect(byName.get('Launch')!.id).toBe('m-1');

    // Critical: there must be NO spurious bands named "m-0" or "m-1"
    // (these IDs should never appear as band names)
    expect(byName.has('m-0')).toBe(false);
    expect(byName.has('m-1')).toBe(false);

    // get_board filtered by milestone name must return the correct tasks
    const foundationTasks = await getBoardHandler(d, { milestone: 'Foundation' });
    expect(foundationTasks.map((t) => t.title).sort()).toEqual(['CI pipeline', 'Core lib']);

    const launchTasks = await getBoardHandler(d, { milestone: 'Launch' });
    expect(launchTasks.map((t) => t.title)).toEqual(['Landing page']);
  });
});

describe('getBoardHandler', () => {
  it('returns compact summaries over tasks+drafts; drafts flagged; unset lane/band omitted', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Feature X', category: 'Features', milestone: 'v1' });
    await createTaskHandler(d, { title: 'Loose' }); // Misc + Backburner (omitted)
    const idea = await createTaskHandler(d, { title: 'Idea', draft: true }); // TASK-3, in drafts/
    const board = await getBoardHandler(d, {});
    const byId = new Map(board.map((b) => [b.id, b]));
    expect(byId.get('TASK-1')!.category).toBe('Features');
    expect(byId.get('TASK-2')!.category).toBeUndefined(); // Misc not synthesized
    expect(byId.get('TASK-2')!.milestone).toBeUndefined(); // Backburner not synthesized
    // TASK-115: the draft carries a TASK-N id from the shared counter — its `draft` flag comes
    // from the FOLDER (drafts/), never from the id.
    expect(idea.id).toBe('TASK-3');
    expect(byId.get(idea.id)!.draft).toBe(true);
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
    expect((await getBoardHandler(d, { status: 'To Do' })).map((b) => b.id).sort()).toEqual([
      'TASK-1',
      'TASK-2',
    ]);
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

describe('boardDoctorHandler', () => {
  it('reports a healthy board when nothing has drifted', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Fine task' });
    const result = await boardDoctorHandler(d);
    expect(result.healthy).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('reports typed findings for drifted .taskwright state (read-only)', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Done one' });
    await editTaskHandler(d, { taskId: 'TASK-1', status: 'Done' });
    // Stale handoff for the Done task + dangling active-task pointer.
    fs.mkdirSync(path.join(root, '.taskwright', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(root, '.taskwright', 'handoff', 'TASK-1.md'), 'prompt');
    fs.writeFileSync(
      path.join(root, '.taskwright', 'active-task.json'),
      JSON.stringify({ taskId: 'TASK-404', setAt: '2026-07-01T00:00:00Z' })
    );

    const result = await boardDoctorHandler(d);
    expect(result.healthy).toBe(false);
    expect(result.findings.map((f) => [f.type, f.taskId]).sort()).toEqual([
      ['dangling-active-task', 'TASK-404'],
      ['stale-handoff', 'TASK-1'],
    ]);
    // Read-only: the drifted files are untouched.
    expect(fs.existsSync(path.join(root, '.taskwright', 'handoff', 'TASK-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.taskwright', 'active-task.json'))).toBe(true);
  });
});
