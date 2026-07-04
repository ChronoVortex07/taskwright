import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaimService } from '../../core/ClaimService';
import { BacklogParser } from '../../core/BacklogParser';
import * as fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 1000 }),
  };
});

function mockReaddirSync(files: string[]) {
  vi.mocked(fs.readdirSync).mockReturnValue(files as unknown as ReturnType<typeof fs.readdirSync>);
}

const TASK = `---
id: TASK-1
title: Sample task
status: To Do
assignee: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Body stays intact.
<!-- SECTION:DESCRIPTION:END -->
`;

describe('ClaimService', () => {
  let service: ClaimService;
  let parser: BacklogParser;

  beforeEach(() => {
    service = new ClaimService();
    parser = new BacklogParser('/fake/backlog');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync(['task-1 - Sample-task.md']);
    vi.mocked(fs.readFileSync).mockReturnValue(TASK);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('claimTask', () => {
    it('writes a claim the parser reads back and returns it', async () => {
      const claim = await service.claimTask('TASK-1', '@alice', parser, {
        worktree: 'feature/login',
        now: new Date(2026, 5, 30, 14, 5),
      });

      expect(claim.claimedBy).toBe('@alice');
      expect(claim.worktree).toBe('feature/login');
      expect(claim.claimedAt).toBe('2026-06-30 14:05');

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
      expect(task?.claimedBy).toBe('@alice');
      expect(task?.worktree).toBe('feature/login');
      expect(task?.claimedAt).toBe('2026-06-30 14:05');
    });

    it('preserves the task body and existing frontmatter', async () => {
      // Use a task already "In Progress" so the status transition is a no-op,
      // letting us verify that all OTHER frontmatter fields are preserved.
      const inProgressTask = TASK.replace('status: To Do', 'status: In Progress');
      vi.mocked(fs.readFileSync).mockReturnValue(inProgressTask);
      await service.claimTask('TASK-1', '@alice', parser, { now: new Date(2026, 5, 30, 14, 5) });
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('Body stays intact.');
      const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
      expect(task?.title).toBe('Sample task');
      expect(task?.status).toBe('In Progress');
    });

    it('preserves CRLF line endings when the original used them', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(TASK.replace(/\n/g, '\r\n'));
      await service.claimTask('TASK-1', '@alice', parser, { now: new Date(2026, 5, 30, 14, 5) });
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written.includes('\r\n')).toBe(true);
      expect(written).toContain('claimed_by:');
    });

    it('invalidates the parser cache for the written file', async () => {
      const spy = vi.spyOn(parser, 'invalidateTaskCache');
      await service.claimTask('TASK-1', '@alice', parser, { now: new Date(2026, 5, 30, 14, 5) });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('task-1 - Sample-task.md') as unknown as string
      );
    });

    it('throws when the task does not exist', async () => {
      mockReaddirSync([]);
      await expect(service.claimTask('TASK-404', '@alice', parser)).rejects.toThrow('TASK-404');
    });

    describe('status transition', () => {
      const CONFIG_YML = `project_name: Test
statuses: ['To Do', 'In Progress', 'Done']
default_status: 'To Do'
`;

      function routeReads(taskContent: string) {
        vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
          const str = String(p).replace(/\\/g, '/');
          if (str.endsWith('config.yml') || str.endsWith('config.yaml')) return CONFIG_YML;
          return taskContent;
        });
      }

      it('advances status from "To Do" to "In Progress" on claim', async () => {
        routeReads(TASK);
        await service.claimTask('TASK-1', '@alice', parser, {
          now: new Date(2026, 5, 30, 14, 5),
        });

        const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
        const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
        expect(task?.status).toBe('In Progress');
        expect(task?.claimedBy).toBe('@alice');
      });

      it('leaves status unchanged when already "In Progress"', async () => {
        const inProgressTask = TASK.replace('status: To Do', 'status: In Progress');
        routeReads(inProgressTask);
        await service.claimTask('TASK-1', '@alice', parser, {
          now: new Date(2026, 5, 30, 14, 5),
        });

        const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
        const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
        expect(task?.status).toBe('In Progress');
      });

      it('leaves status unchanged when "Done"', async () => {
        const doneTask = TASK.replace('status: To Do', 'status: Done');
        routeReads(doneTask);
        await service.claimTask('TASK-1', '@alice', parser, {
          now: new Date(2026, 5, 30, 14, 5),
        });

        const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
        const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
        expect(task?.status).toBe('Done');
      });

      it('defaults to "In Progress" when config has fewer than 2 statuses', async () => {
        const oneStatusConfig = `project_name: Test
statuses: ['Backlog']
default_status: 'Backlog'
`;
        vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
          const str = String(p).replace(/\\/g, '/');
          if (str.endsWith('config.yml') || str.endsWith('config.yaml')) return oneStatusConfig;
          return TASK;
        });
        await service.claimTask('TASK-1', '@alice', parser, {
          now: new Date(2026, 5, 30, 14, 5),
        });

        const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
        const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
        // The task has status "To Do" but the config only has ["Backlog"]. Since
        // "To Do" ≠ "Backlog" (statuses[0]), no transition occurs — status stays "To Do".
        // The inProgressStatus fallback ("In Progress") is unused here because the
        // task's current status does not match the board's first status.
        expect(task?.status).toBe('To Do');
      });

      it('uses the board\'s second configured status (not a hardcoded value)', async () => {
        const customConfig = `project_name: Test
statuses: ['Open', 'Working', 'Review', 'Closed']
default_status: 'Open'
`;
        vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
          const str = String(p).replace(/\\/g, '/');
          if (str.endsWith('config.yml') || str.endsWith('config.yaml')) return customConfig;
          return TASK.replace('status: To Do', 'status: Open');
        });
        await service.claimTask('TASK-1', '@alice', parser, {
          now: new Date(2026, 5, 30, 14, 5),
        });

        const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
        const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
        expect(task?.status).toBe('Working');
      });

      it('uses setStatusField (unquoted status) for byte-for-byte compatibility', async () => {
        routeReads(TASK);
        await service.claimTask('TASK-1', '@alice', parser, {
          now: new Date(2026, 5, 30, 14, 5),
        });

        const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
        // setStatusField writes status as an unquoted scalar — no quotes around "In Progress".
        expect(written).toContain('status: In Progress');
        expect(written).not.toContain("status: 'In Progress'");
      });
    });
  });

  describe('releaseTask', () => {
    it('removes the claim so the parser sees none', async () => {
      const claimed = `---
id: TASK-1
title: Sample task
status: To Do
assignee: []
dependencies: []
claimed_by: '@alice'
claimed_at: '2026-06-30 14:05'
---

## Description

Body stays intact.
`;
      vi.mocked(fs.readFileSync).mockReturnValue(claimed);
      await service.releaseTask('TASK-1', parser);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
      expect(task?.claimedBy).toBeUndefined();
      expect(task?.claimedAt).toBeUndefined();
    });

    it('throws when the task does not exist', async () => {
      mockReaddirSync([]);
      await expect(service.releaseTask('TASK-404', parser)).rejects.toThrow('TASK-404');
    });
  });
});
