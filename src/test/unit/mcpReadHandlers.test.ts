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
} from '../../mcp/handlers';
import type { McpHandlerDeps } from '../../mcp/handlers';

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
