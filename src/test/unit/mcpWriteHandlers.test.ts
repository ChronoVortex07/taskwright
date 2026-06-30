import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { createTaskHandler } from '../../mcp/handlers';
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

  it('creates a draft when draft is set, with the given title', async () => {
    const summary = await createTaskHandler(deps(), { title: 'Spike caching', draft: true });
    expect(summary.id).toBe('DRAFT-1');
    expect(summary.title).toBe('Spike caching');
    expect(fs.existsSync(path.join(backlogPath, 'drafts', 'draft-1 - Spike-caching.md'))).toBe(
      true
    );
  });
});
