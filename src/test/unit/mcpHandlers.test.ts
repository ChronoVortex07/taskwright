import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { ClaimService } from '../../core/ClaimService';
import {
  getActiveTask,
  claimTaskHandler,
  releaseTaskHandler,
  type McpHandlerDeps,
} from '../../mcp/handlers';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
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
  return { root: ROOT, parser: new BacklogParser(BACKLOG), claimService: new ClaimService() };
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
});
