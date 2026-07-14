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

    it('no-active-task message names the from-any-session bootstrap path (DRAFT-7)', async () => {
      routeReads(null);
      const result = await getActiveTask(makeDeps());
      expect(result.active).toBe(false);
      expect(result.message).toContain('/execute-task');
      expect(result.message?.toLowerCase()).toContain('bootstrap');
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

    it('advances status from "To Do" to "In Progress" when claiming', async () => {
      routeReads(null);
      await claimTaskHandler(makeDeps(), { taskId: 'TASK-7', claimedBy: '@agent' });
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // Status should be advanced from the first to the second configured status.
      expect(written).toContain('status: In Progress');
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

  describe('claimTaskHandler identity & idempotent re-claim (TASK-89)', () => {
    const WORKTREE_ROOT = path.join(ROOT, '.worktrees', 'task-7-sample');

    function makeWorktreeDeps(overrides: Partial<McpHandlerDeps> = {}): McpHandlerDeps {
      return { ...makeDeps(), root: WORKTREE_ROOT, ...overrides };
    }

    /** Route reads to task content with the given claim lines injected. */
    function routeClaimedReads(claimLines: string[]): void {
      const content = TASK_CONTENT.replace(
        'dependencies: []',
        ['dependencies: []', ...claimLines].join('\n')
      );
      vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
        const str = String(p);
        if (str.includes('active-task.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return content;
      });
    }

    /** A 'YYYY-MM-DD HH:mm' local timestamp `hoursAgo` hours in the past. */
    function stampHoursAgo(hoursAgo: number): string {
      const d = new Date(Date.now() - hoursAgo * 3600_000);
      const pad = (n: number): string => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    it('derives the claimant identity from a .worktrees session root', async () => {
      routeReads(null);
      const result = await claimTaskHandler(makeWorktreeDeps(), { taskId: 'TASK-7' });
      expect(result.claimed).toBe(true);
      expect(result.claimedBy).toBe('@agent/task-7-sample');
      // The derived branch is recorded as the claim's worktree too.
      expect(result.worktree).toBe('task-7-sample');
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain("claimed_by: '@agent/task-7-sample'");
    });

    it('derives the identity from an explicit worktree arg when given', async () => {
      routeReads(null);
      const result = await claimTaskHandler(makeDeps(), {
        taskId: 'TASK-7',
        worktree: 'task-9-z',
      });
      expect(result.claimed).toBe(true);
      expect(result.claimedBy).toBe('@agent/task-9-z');
      expect(result.worktree).toBe('task-9-z');
    });

    it('falls back to the git branch for a primary-rooted session', async () => {
      routeReads(null);
      const gitExec = vi.fn().mockResolvedValue({ stdout: 'main\n', stderr: '' });
      const result = await claimTaskHandler({ ...makeDeps(), gitExec }, { taskId: 'TASK-7' });
      expect(gitExec).toHaveBeenCalledWith(ROOT, ['rev-parse', '--abbrev-ref', 'HEAD']);
      expect(result.claimedBy).toBe('@agent/main');
    });

    it('falls back to the bare @agent when no branch is derivable', async () => {
      routeReads(null);
      const gitExec = vi.fn().mockRejectedValue(new Error('not a git repo'));
      const result = await claimTaskHandler({ ...makeDeps(), gitExec }, { taskId: 'TASK-7' });
      expect(result.claimed).toBe(true);
      expect(result.claimedBy).toBe('@agent');
    });

    it('re-claiming your own task is an idempotent no-op (claimed: true, no board write)', async () => {
      routeClaimedReads([
        "claimed_by: '@agent/task-7-sample'",
        `claimed_at: '${stampHoursAgo(1)}'`,
      ]);
      const result = await claimTaskHandler(makeWorktreeDeps(), { taskId: 'TASK-7' });
      expect(result.claimed).toBe(true);
      expect(result.surrendered).toBeUndefined();
      expect(result.alreadyClaimed).toBe(true);
      expect(result.claimedBy).toBe('@agent/task-7-sample');
      // The BOARD must not churn: no task file is rewritten. (The session-task ledger
      // under .taskwright/ IS refreshed — see below — but it is local and git-ignored,
      // not board state.)
      const boardWrites = vi
        .mocked(fs.writeFileSync)
        .mock.calls.filter((c) => String(c[0]).includes(TASK_FILE));
      expect(boardWrites).toHaveLength(0);
    });

    it('a self re-claim still refreshes the session ledger (TASK-129 restart case)', async () => {
      // A relaunched session in the same worktree re-claims its own task; that no-op on the
      // board is exactly when it must (re)learn which task it is on, so get_active_task can
      // answer from the ledger rather than reporting active:false.
      routeClaimedReads([
        "claimed_by: '@agent/task-7-sample'",
        `claimed_at: '${stampHoursAgo(1)}'`,
      ]);
      const result = await claimTaskHandler(makeWorktreeDeps(), { taskId: 'TASK-7' });
      expect(result.alreadyClaimed).toBe(true);
      expect(result.task?.id).toBe('TASK-7');
      const ledgerWrites = vi
        .mocked(fs.writeFileSync)
        .mock.calls.filter((c) => String(c[0]).includes('session-tasks.json'));
      expect(ledgerWrites.length).toBeGreaterThan(0);
    });

    it('a different identity holding a live claim surrenders with heldBy', async () => {
      routeClaimedReads(["claimed_by: '@agent/task-8-other'", `claimed_at: '${stampHoursAgo(1)}'`]);
      const result = await claimTaskHandler(makeWorktreeDeps(), { taskId: 'TASK-7' });
      expect(result.claimed).toBe(false);
      expect(result.surrendered).toBe(true);
      expect(result.heldBy).toBe('@agent/task-8-other');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('a stale foreign claim is overridden without surrendering', async () => {
      routeClaimedReads([
        "claimed_by: '@agent/task-8-other'",
        `claimed_at: '${stampHoursAgo(13)}'`,
      ]);
      const result = await claimTaskHandler(makeWorktreeDeps(), { taskId: 'TASK-7' });
      expect(result.claimed).toBe(true);
      expect(result.surrendered).toBeUndefined();
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain("claimed_by: '@agent/task-7-sample'");
    });

    it('upgrades a legacy generic @agent claim in place instead of surrendering', async () => {
      routeClaimedReads(["claimed_by: '@agent'", `claimed_at: '${stampHoursAgo(1)}'`]);
      const result = await claimTaskHandler(makeWorktreeDeps(), { taskId: 'TASK-7' });
      expect(result.claimed).toBe(true);
      expect(result.claimedBy).toBe('@agent/task-7-sample');
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain("claimed_by: '@agent/task-7-sample'");
    });

    it('an explicit claimedBy arg is used verbatim and beats derivation', async () => {
      routeReads(null);
      const result = await claimTaskHandler(makeWorktreeDeps(), {
        taskId: 'TASK-7',
        claimedBy: '@codex/worker-3',
      });
      expect(result.claimed).toBe(true);
      expect(result.claimedBy).toBe('@codex/worker-3');
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
