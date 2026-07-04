import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { TreeFieldService } from '../../core/TreeFieldService';
import {
  getActiveTask,
  claimTaskHandler,
  releaseTaskHandler,
  attachPlanHandler,
  type McpHandlerDeps,
} from '../../mcp/handlers';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 1000 }),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const ROOT = '/repo';
const BACKLOG = path.join(ROOT, 'backlog');
const TASK_FILE = 'task-7 - Sample.md';

const TASK_CONTENT = `---
id: TASK-7
title: Sample task
status: To Do
assignee: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Do the thing.
<!-- SECTION:DESCRIPTION:END -->
`;

/** Route readFileSync to the active-task json or the task file by path. */
function routeReads(activeJson: string | null) {
  vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
    const str = String(p);
    if (str.includes('active-task.json')) {
      if (activeJson === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return activeJson;
    }
    return TASK_CONTENT;
  });
}

function makeDeps(): McpHandlerDeps {
  return {
    root: ROOT,
    backlogPath: BACKLOG,
    parser: new BacklogParser(BACKLOG),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
    treeFieldService: new TreeFieldService(),
  };
}

describe('mcp handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([TASK_FILE] as unknown as ReturnType<
      typeof fs.readdirSync
    >);
  });
  afterEach(() => vi.clearAllMocks());

  describe('getActiveTask', () => {
    it('reports no active task when none is set', async () => {
      routeReads(null);
      const result = await getActiveTask(makeDeps());
      expect(result.active).toBe(false);
      expect(result.message).toBeTruthy();
    });

    it('returns the active task summary when set and present', async () => {
      routeReads(JSON.stringify({ taskId: 'TASK-7', setAt: '2026-06-30T14:00:00.000Z' }));
      const result = await getActiveTask(makeDeps());
      expect(result.active).toBe(true);
      expect(result.task?.id).toBe('TASK-7');
      expect(result.task?.title).toBe('Sample task');
      expect(result.task?.description).toContain('Do the thing.');
    });

    it('reports not-found when the active id has no matching task', async () => {
      routeReads(JSON.stringify({ taskId: 'TASK-999', setAt: 'x' }));
      const result = await getActiveTask(makeDeps());
      expect(result.active).toBe(false);
      expect(result.message).toContain('TASK-999');
    });
  });

  describe('claimTaskHandler', () => {
    it('writes a claim and echoes it back', async () => {
      routeReads(null);
      const result = await claimTaskHandler(makeDeps(), {
        taskId: 'TASK-7',
        claimedBy: '@agent',
        worktree: 'feature/x',
      });
      expect(result.claimed).toBe(true);
      expect(result.claimedBy).toBe('@agent');
      expect(result.worktree).toBe('feature/x');
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('claimed_by:');
    });

    it('throws when the task is missing', async () => {
      routeReads(null);
      vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
      await expect(
        claimTaskHandler(makeDeps(), { taskId: 'TASK-404', claimedBy: '@agent' })
      ).rejects.toThrow('TASK-404');
    });
  });

  describe('releaseTaskHandler', () => {
    it('clears the claim and confirms', async () => {
      routeReads(null);
      const result = await releaseTaskHandler(makeDeps(), { taskId: 'TASK-7' });
      expect(result.released).toBe(true);
      expect(result.taskId).toBe('TASK-7');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('attachPlanHandler', () => {
    it('writes a normalized plan link and echoes it back', async () => {
      routeReads(null);
      const result = await attachPlanHandler(makeDeps(), {
        taskId: 'TASK-7',
        plan: 'docs\\superpowers\\plans\\p.md',
      });
      expect(result.attached).toBe(true);
      expect(result.plan).toBe('docs/superpowers/plans/p.md');
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('plan: docs/superpowers/plans/p.md');
    });
  });

  describe('getActiveTask subtasks derivation (FIX 1 — SDD branch)', () => {
    // create_subtask writes only the CHILD's parent_task_id, never the parent's
    // frontmatter subtasks[]. getTask populates subtasks ONLY from the parent's
    // frontmatter, and computeSubtasks (the provider-side derivation) never runs on
    // the MCP path. So without FIX 1 a dispatched parent returns subtasks: undefined
    // and /execute-task's independent-subtasks (SDD) branch can never fire.
    const PARENT = `---
id: TASK-7
title: Parent task
status: To Do
assignee: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parent.
<!-- SECTION:DESCRIPTION:END -->
`;
    const CHILD_A = `---
id: TASK-7.1
title: Child A
status: To Do
assignee: []
dependencies: []
parent_task_id: TASK-7
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Child A.
<!-- SECTION:DESCRIPTION:END -->
`;
    const CHILD_B = `---
id: TASK-7.2
title: Child B
status: To Do
assignee: []
dependencies: []
parent_task_id: TASK-7
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Child B.
<!-- SECTION:DESCRIPTION:END -->
`;

    it('derives subtasks from children carrying parent_task_id (not from parent frontmatter)', async () => {
      // Parent has NO frontmatter subtasks[]; the two children carry parent_task_id.
      vi.mocked(fs.readdirSync).mockReturnValue([
        'task-7 - Parent.md',
        'task-7.1 - Child-A.md',
        'task-7.2 - Child-B.md',
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
        const str = String(p).replace(/\\/g, '/');
        if (str.includes('active-task.json')) {
          return JSON.stringify({ taskId: 'TASK-7', setAt: 'x' });
        }
        if (str.endsWith('task-7.1 - Child-A.md')) return CHILD_A;
        if (str.endsWith('task-7.2 - Child-B.md')) return CHILD_B;
        return PARENT;
      });

      const result = await getActiveTask(makeDeps());
      expect(result.active).toBe(true);
      expect(result.task?.id).toBe('TASK-7');
      // The whole point: subtasks are DERIVED from children, never hand-set on input.
      expect(result.task?.subtasks).toEqual(['TASK-7.1', 'TASK-7.2']);
    });
  });

  describe('getActiveTask plan progress', () => {
    it('includes checkbox progress for a task with an attached plan', async () => {
      const taskWithPlan = TASK_CONTENT.replace(
        'dependencies: []',
        'dependencies: []\nplan: docs/plan.md'
      );
      vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
        const str = String(p);
        if (str.includes('active-task.json')) {
          return JSON.stringify({ taskId: 'TASK-7', setAt: 'x' });
        }
        if (str.replace(/\\/g, '/').endsWith('docs/plan.md')) {
          return '- [x] one\n- [ ] two\n- [ ] three\n';
        }
        return taskWithPlan;
      });

      const result = await getActiveTask(makeDeps());
      expect(result.task?.plan).toBe('docs/plan.md');
      expect(result.task?.planProgress).toEqual({
        total: 3,
        done: 1,
        percent: 33,
        exists: true,
      });
    });
  });
});

describe('synced claim routing', () => {
  const githubCfg = async () => ({
    mode: 'github' as const,
    ref: 'taskwright-board',
    remote: 'origin',
    pollSeconds: 20,
  });

  it('mode=off uses the legacy ClaimService path (no engine call)', async () => {
    routeReads(null);
    const deps: McpHandlerDeps = {
      ...makeDeps(),
      syncConfigForRoot: async () => ({
        mode: 'off',
        ref: 'taskwright-board',
        remote: 'origin',
        pollSeconds: 20,
      }),
      claimSynced: async () => {
        throw new Error('should not be called');
      },
    };
    const res = await claimTaskHandler(deps, { taskId: 'TASK-7', claimedBy: '@agent' });
    expect(res.claimed).toBe(true);
    expect(res.surrendered).toBeUndefined();
  });

  it('mode=github routes to the sync engine and maps a surrender', async () => {
    const deps: McpHandlerDeps = {
      ...makeDeps(),
      syncConfigForRoot: githubCfg,
      claimSynced: async () => ({ status: 'surrendered', by: '@alice' }),
    };
    const res = await claimTaskHandler(deps, { taskId: 'TASK-1', claimedBy: '@bob' });
    expect(res).toMatchObject({
      claimed: false,
      surrendered: true,
      heldBy: '@alice',
      taskId: 'TASK-1',
    });
  });

  it('mode=github maps a successful synced claim', async () => {
    const deps: McpHandlerDeps = {
      ...makeDeps(),
      syncConfigForRoot: githubCfg,
      claimSynced: async () => ({
        status: 'claimed',
        claim: { claimedBy: '@bob', claimedAt: '2026-07-01 09:00', worktree: 'task-1-x' },
      }),
    };
    const res = await claimTaskHandler(deps, { taskId: 'TASK-1', claimedBy: '@bob' });
    expect(res).toMatchObject({ claimed: true, claimedBy: '@bob', worktree: 'task-1-x' });
  });

  it('mode=github release routes to the engine', async () => {
    let released = false;
    const deps: McpHandlerDeps = {
      ...makeDeps(),
      syncConfigForRoot: githubCfg,
      releaseSynced: async () => {
        released = true;
        return { status: 'released' };
      },
    };
    const res = await releaseTaskHandler(deps, { taskId: 'TASK-1' });
    expect(res).toEqual({ released: true, taskId: 'TASK-1' });
    expect(released).toBe(true);
  });
});
