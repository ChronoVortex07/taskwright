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
  completeTaskHandler,
  archiveTaskHandler,
  restoreTaskHandler,
  promoteDraftHandler,
  promoteDraftsHandler,
  demoteTaskHandler,
  createSubtaskHandler,
  getActiveTask,
  claimTaskHandler,
  createCategoryHandler,
} from '../../mcp/handlers';
import type { McpHandlerDeps } from '../../mcp/handlers';
import { writeActiveTask } from '../../core/activeTask';

let root: string;
let backlogPath: string;

function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-mcp-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    'project_name: "test"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n',
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

beforeEach(scaffold);
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('createTaskHandler', () => {
  it('creates a task and returns its summary', async () => {
    const summary = await createTaskHandler(deps(), {
      title: 'Add login',
      description: 'Users can sign in',
      priority: 'high',
      labels: ['feature'],
    });
    expect(summary.id).toBe('TASK-1');
    expect(summary.title).toBe('Add login');
    expect(summary.priority).toBe('high');
    expect(summary.labels).toEqual(['feature']);
    expect(summary.description).toContain('Users can sign in');
    expect(fs.existsSync(path.join(backlogPath, 'tasks', 'task-1 - Add-login.md'))).toBe(true);
  });

  it('rejects an invalid status before writing anything', async () => {
    await expect(createTaskHandler(deps(), { title: 'X', status: 'Nope' })).rejects.toThrow(
      'Invalid status'
    );
    expect(fs.readdirSync(path.join(backlogPath, 'tasks'))).toHaveLength(0);
  });

  it('rejects an empty-string status', async () => {
    await expect(createTaskHandler(deps(), { title: 'X', status: '' })).rejects.toThrow(
      'Invalid status'
    );
    expect(fs.readdirSync(path.join(backlogPath, 'tasks'))).toHaveLength(0);
  });

  it('creates a draft when draft is set, with the given title', async () => {
    const summary = await createTaskHandler(deps(), { title: 'Spike caching', draft: true });
    expect(summary.id).toBe('DRAFT-1');
    expect(summary.title).toBe('Spike caching');
    expect(fs.existsSync(path.join(backlogPath, 'drafts', 'draft-1 - Spike-caching.md'))).toBe(
      true
    );
  });

  it('draft create writes priority + milestone into the DRAFT file (GAP-2)', async () => {
    const d = deps();
    // seed a milestone-less config; priority is validated against config priorities
    const summary = await createTaskHandler(d, {
      title: 'Proposed feature', draft: true, priority: 'high', milestone: 'v1', category: 'Features',
    });
    expect(summary.id).toBe('DRAFT-1');
    const file = fs.readFileSync(
      path.join(backlogPath, 'drafts', 'draft-1 - Proposed-feature.md'), 'utf-8'
    );
    expect(file).toMatch(/^priority:\s*high/m);
    expect(file).toMatch(/^milestone:\s*v1/m);
    expect(file).toMatch(/^category:\s*Features/m);
    expect(file).toMatch(/^status:\s*To Do/m); // D2: a no-status draft defaults to the board status, not a synthetic 'Draft'
  });
});

describe('editTaskHandler', () => {
  it('updates fields and acceptance criteria', async () => {
    await createTaskHandler(deps(), { title: 'Edit me' });
    const summary = await editTaskHandler(deps(), {
      taskId: 'TASK-1',
      status: 'In Progress',
      priority: 'low',
      acceptanceCriteria: [{ text: 'compiles' }, { text: 'tested', checked: true }],
    });
    expect(summary.status).toBe('In Progress');
    expect(summary.priority).toBe('low');
    expect(summary.acceptanceCriteria.map((c) => c.text)).toEqual(['compiles', 'tested']);
    expect(summary.acceptanceCriteria[1].checked).toBe(true);
  });

  it('rejects an invalid status', async () => {
    await createTaskHandler(deps(), { title: 'Edit me' });
    await expect(editTaskHandler(deps(), { taskId: 'TASK-1', status: 'Nope' })).rejects.toThrow(
      'Invalid status'
    );
  });

  it('rejects an empty-string status', async () => {
    await createTaskHandler(deps(), { title: 'Edit me' });
    await expect(editTaskHandler(deps(), { taskId: 'TASK-1', status: '' })).rejects.toThrow(
      'Invalid status'
    );
  });

  it('throws when the task does not exist', async () => {
    await expect(editTaskHandler(deps(), { taskId: 'TASK-404', title: 'x' })).rejects.toThrow(
      'TASK-404'
    );
  });
});

describe('lifecycle moves', () => {
  it('completes a task into completed/', async () => {
    await createTaskHandler(deps(), { title: 'Finish me' });
    const result = await completeTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(result.outcome).toBe('completed');
    expect(result.path.replace(/\\/g, '/')).toContain('/completed/');
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('archives then restores a task', async () => {
    await createTaskHandler(deps(), { title: 'Archive me' });
    const archived = await archiveTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(archived.outcome).toBe('archived');
    expect(archived.path.replace(/\\/g, '/')).toContain('/archive/tasks/');

    const restored = await restoreTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(restored.outcome).toBe('restored');
    expect(restored.path.replace(/\\/g, '/')).toContain('/tasks/');
    expect(fs.existsSync(restored.path)).toBe(true);
  });

  it('throws completing a missing task', async () => {
    await expect(completeTaskHandler(deps(), { taskId: 'TASK-404' })).rejects.toThrow('TASK-404');
  });
});

describe('draft lifecycle', () => {
  it('promotes a draft to a task', async () => {
    const draft = await createTaskHandler(deps(), { title: 'Idea', draft: true });
    expect(draft.id).toBe('DRAFT-1');
    const promoted = await promoteDraftHandler(deps(), { taskId: 'DRAFT-1' });
    expect(promoted.id).toMatch(/^TASK-\d+$/);
    expect(promoted.status).toBe('To Do');
  });

  it('demotes a task to a draft', async () => {
    await createTaskHandler(deps(), { title: 'Too early' });
    const demoted = await demoteTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(demoted.id).toMatch(/^DRAFT-\d+$/);
    expect(demoted.status).toBe('To Do'); // P6/D2e: demote preserves the real status
  });

  it('a Done baseline draft round-trips its status and promotes to a Done task (P6/D2)', async () => {
    const d = deps();
    const draft = await createTaskHandler(d, { title: 'Auth subsystem', draft: true, status: 'Done', category: 'Platform' });
    expect(draft.id).toBe('DRAFT-1');
    const file = fs.readFileSync(
      path.join(backlogPath, 'drafts', 'draft-1 - Auth-subsystem.md'), 'utf-8'
    );
    expect(file).toMatch(/^status:\s*Done/m); // NOT a synthetic 'Draft'
    const promoted = await promoteDraftHandler(d, { taskId: 'DRAFT-1' });
    expect(promoted.id).toMatch(/^TASK-\d+$/);
    expect(promoted.status).toBe('Done'); // preserved on promote
  });
});

describe('promoteDraftsHandler', () => {
  it('bulk-promotes and rewires an inbound dependency', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Base', draft: true }); // DRAFT-1
    await createTaskHandler(d, { title: 'Uses', draft: true, dependencies: ['DRAFT-1'] }); // DRAFT-2 → dep DRAFT-1
    const res = await promoteDraftsHandler(d, { taskIds: ['DRAFT-1', 'DRAFT-2'] });
    expect(res.promoted).toHaveLength(2);
    const uses = fs.readFileSync(
      path.join(
        backlogPath,
        'tasks',
        fs.readdirSync(path.join(backlogPath, 'tasks')).find((f) => f.includes('Uses'))!
      ),
      'utf-8'
    );
    expect(uses).toMatch(/- TASK-1\b/);
    expect(uses).not.toMatch(/DRAFT/);
  });
});

describe('promoteDraftHandler (single, rerouted through the bulk core)', () => {
  it('still returns the promoted task summary (contract unchanged)', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Solo', draft: true }); // DRAFT-1
    const summary = await promoteDraftHandler(d, { taskId: 'DRAFT-1' });
    expect(summary.id).toBe('TASK-1');
    expect(summary.status).toBe('To Do');
  });
});

describe('createSubtaskHandler', () => {
  it('creates a titled subtask under its parent', async () => {
    await createTaskHandler(deps(), { title: 'Parent' });
    const sub = await createSubtaskHandler(deps(), {
      parentTaskId: 'TASK-1',
      title: 'Child step',
    });
    expect(sub.id).toBe('TASK-1.1');
    expect(sub.title).toBe('Child step');
  });
});

describe('MCP summaries expose tech-tree derived fields (P1)', () => {
  it('a task summary includes dependencies, locked, and layout', async () => {
    await createTaskHandler(deps(), { title: 'Root' }); // TASK-1
    await createTaskHandler(deps(), { title: 'Dependent' }); // TASK-2
    // Make TASK-2 depend on TASK-1 via the writer directly (edit_task deps land in Task 8).
    const d = deps();
    await d.writer.updateTask('TASK-2', { dependencies: ['TASK-1'] }, d.parser);

    writeActiveTask(root, 'TASK-2');
    const result = await getActiveTask(deps());
    expect(result.active).toBe(true);
    expect(result.task?.dependencies).toEqual(['TASK-1']);
    expect(result.task?.locked).toBe(true); // TASK-1 is To Do, not Done
    expect(result.task?.blockedBy).toEqual(['TASK-1']);
    expect(result.task?.layout).toBeDefined();
  });
});

describe('create_task / edit_task tech-tree fields (P1)', () => {
  it('create_task persists category, type=bug, caused_by, dependencies', async () => {
    await createTaskHandler(deps(), { title: 'Origin' }); // TASK-1
    const summary = await createTaskHandler(deps(), {
      title: 'Broken login',
      type: 'bug',
      causedBy: 'TASK-1',
      category: 'Auth',
      dependencies: ['TASK-1'],
    });
    expect(summary.type).toBe('bug');
    expect(summary.causedBy).toBe('TASK-1');
    expect(summary.category).toBe('Auth');
    expect(summary.dependencies).toEqual(['TASK-1']);
  });

  it('edit_task sets and clears category/caused_by', async () => {
    await createTaskHandler(deps(), { title: 'A task' }); // TASK-1
    let s = await editTaskHandler(deps(), { taskId: 'TASK-1', category: 'Backend' });
    expect(s.category).toBe('Backend');
    s = await editTaskHandler(deps(), { taskId: 'TASK-1', category: '' });
    expect(s.category).toBeUndefined();
  });

  it('edit_task clears type surgically (empty string removes the field)', async () => {
    await createTaskHandler(deps(), { title: 'Was a bug', type: 'bug' }); // TASK-1
    let s = await editTaskHandler(deps(), { taskId: 'TASK-1', type: 'bug' });
    expect(s.type).toBe('bug');
    s = await editTaskHandler(deps(), { taskId: 'TASK-1', type: '' });
    expect(s.type).toBeUndefined();
  });

  it('rejects an invalid type value', async () => {
    await createTaskHandler(deps(), { title: 'A task' }); // TASK-1
    await expect(editTaskHandler(deps(), { taskId: 'TASK-1', type: 'feature' })).rejects.toThrow(
      'type'
    );
  });

  it('rejects caused_by on a non-bug task', async () => {
    await createTaskHandler(deps(), { title: 'Cause' }); // TASK-1
    await createTaskHandler(deps(), { title: 'Plain' }); // TASK-2
    await expect(editTaskHandler(deps(), { taskId: 'TASK-2', causedBy: 'TASK-1' })).rejects.toThrow(
      'bug'
    );
  });

  it('rejects a dependency that does not exist', async () => {
    await createTaskHandler(deps(), { title: 'A task' }); // TASK-1
    await expect(
      editTaskHandler(deps(), { taskId: 'TASK-1', dependencies: ['TASK-999'] })
    ).rejects.toThrow('does not exist');
  });

  it('rejects a dependency edit that would create a cycle', async () => {
    await createTaskHandler(deps(), { title: 'A' }); // TASK-1
    await createTaskHandler(deps(), { title: 'B' }); // TASK-2
    const d = deps();
    await d.writer.updateTask('TASK-2', { dependencies: ['TASK-1'] }, d.parser); // TASK-2 -> TASK-1
    // Now making TASK-1 depend on TASK-2 closes the cycle.
    await expect(
      editTaskHandler(deps(), { taskId: 'TASK-1', dependencies: ['TASK-2'] })
    ).rejects.toThrow('cycle');
  });
});

describe('claim_task gate (P1)', () => {
  it('refuses a locked task with locked/blockedBy and no claim', async () => {
    await createTaskHandler(deps(), { title: 'Root' }); // TASK-1 (To Do)
    await createTaskHandler(deps(), { title: 'Dependent' }); // TASK-2
    const d = deps();
    await d.writer.updateTask('TASK-2', { dependencies: ['TASK-1'] }, d.parser);

    const result = await claimTaskHandler(deps(), { taskId: 'TASK-2' });
    expect(result.claimed).toBe(false);
    expect(result.locked).toBe(true);
    expect(result.blockedBy).toEqual(['TASK-1']);
  });

  it('allows claiming once the dependency is done', async () => {
    await createTaskHandler(deps(), { title: 'Root' }); // TASK-1
    await createTaskHandler(deps(), { title: 'Dependent' }); // TASK-2
    const d = deps();
    await d.writer.updateTask('TASK-2', { dependencies: ['TASK-1'] }, d.parser);
    await d.writer.updateTask('TASK-1', { status: 'Done' }, d.parser);

    const result = await claimTaskHandler(deps(), { taskId: 'TASK-2', claimedBy: '@me' });
    expect(result.claimed).toBe(true);
  });
});

describe('complete_task bug rule (P1)', () => {
  it('refuses to complete a bug with no caused_by', async () => {
    await createTaskHandler(deps(), { title: 'Bug', type: 'bug' }); // TASK-1
    await expect(completeTaskHandler(deps(), { taskId: 'TASK-1' })).rejects.toThrow('caused_by');
  });

  it('refuses when caused_by points at a nonexistent task', async () => {
    await createTaskHandler(deps(), { title: 'Bug', type: 'bug' }); // TASK-1
    const d = deps();
    await d.treeFieldService.setCausedBy('TASK-1', 'TASK-999', d.parser);
    await expect(completeTaskHandler(deps(), { taskId: 'TASK-1' })).rejects.toThrow(
      'does not exist'
    );
  });

  it('completes a bug with a valid caused_by', async () => {
    await createTaskHandler(deps(), { title: 'Cause' }); // TASK-1
    await createTaskHandler(deps(), { title: 'Bug', type: 'bug', causedBy: 'TASK-1' }); // TASK-2
    const result = await completeTaskHandler(deps(), { taskId: 'TASK-2' });
    expect(result.outcome).toBe('completed');
  });
});

describe('createCategoryHandler', () => {
  it('adds a new category to config.yml and reports created:true', async () => {
    const d = deps();
    const res = await createCategoryHandler(d, { category: 'Platform' });
    expect(res).toEqual({ created: true, category: 'Platform' });
    const cfg = fs.readFileSync(path.join(backlogPath, 'config.yml'), 'utf-8');
    expect(cfg).toMatch(/^categories:\s*\["Platform"\]/m);
  });

  it('is idempotent on a case-insensitive dupe (created:false, no error)', async () => {
    const d = deps();
    await createCategoryHandler(d, { category: 'Platform' });
    const res = await createCategoryHandler(d, { category: 'platform' });
    expect(res.created).toBe(false);
    expect(res.category).toBe('Platform'); // returns the existing canonical value
    const cfg = fs.readFileSync(path.join(backlogPath, 'config.yml'), 'utf-8');
    expect((cfg.match(/Platform/g) ?? []).length).toBe(1); // not duplicated
  });

  it('rejects reserved names and blanks', async () => {
    const d = deps();
    await expect(createCategoryHandler(d, { category: 'Bugs' })).rejects.toThrow(/reserved/);
    await expect(createCategoryHandler(d, { category: '  ' })).rejects.toThrow(/required/);
  });

  it('treats a discovered (task-only) category as an existing dupe', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'A', category: 'Data' }); // discovered, not in config
    const res = await createCategoryHandler(d, { category: 'data' });
    expect(res.created).toBe(false);
    expect(res.category).toBe('Data');
  });

  // M1: a backslash-bearing category name must not produce invalid YAML that makes
  // getConfig() silently return {} (losing statuses/labels/task_prefix for the board).
  it('a backslash-bearing category name does not corrupt the board config (M1)', async () => {
    const d = deps();
    await createCategoryHandler(d, { category: 'some\\module' });
    const cfg = await d.parser.getConfig();
    expect(cfg.statuses).toEqual(['To Do', 'In Progress', 'Done']); // NOT {} — config intact
    expect(await d.parser.getCategories()).toContain('some\\module');
  });

  it('rejects a multi-line categories: block and leaves the file byte-identical', async () => {
    const cfgPath = path.join(backlogPath, 'config.yml');
    const blockCfg =
      'project_name: "test"\nstatuses: ["To Do", "In Progress", "Done"]\ncategories:\n  - Features\n  - Platform\ndefault_status: "To Do"\ntask_prefix: "task"\n';
    fs.writeFileSync(cfgPath, blockCfg, 'utf-8');
    await expect(createCategoryHandler(deps(), { category: 'NewLane' })).rejects.toThrow(
      /multi-line|block/i
    );
    expect(fs.readFileSync(cfgPath, 'utf-8')).toBe(blockCfg); // untouched on disk
  });
});
