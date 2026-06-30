import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import {
  createTaskHandler,
  editTaskHandler,
  completeTaskHandler,
  archiveTaskHandler,
  restoreTaskHandler,
  promoteDraftHandler,
  demoteTaskHandler,
  createSubtaskHandler,
} from '../../mcp/handlers';
import type { McpHandlerDeps } from '../../mcp/handlers';

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
    expect(demoted.status).toBe('Draft');
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
