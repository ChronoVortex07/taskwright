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
      await service.claimTask('TASK-1', '@alice', parser, { now: new Date(2026, 5, 30, 14, 5) });
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('Body stays intact.');
      const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
      expect(task?.title).toBe('Sample task');
      expect(task?.status).toBe('To Do');
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
