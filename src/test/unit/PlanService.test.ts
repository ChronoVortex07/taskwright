import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlanService } from '../../core/PlanService';
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

Body stays intact.
`;

describe('PlanService', () => {
  let service: PlanService;
  let parser: BacklogParser;

  beforeEach(() => {
    service = new PlanService();
    parser = new BacklogParser('/fake/backlog');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync(['task-1 - Sample-task.md']);
    vi.mocked(fs.readFileSync).mockReturnValue(TASK);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('attachPlan', () => {
    it('writes a plan link the parser reads back, normalizing separators', async () => {
      const stored = await service.attachPlan(
        'TASK-1',
        'docs\\superpowers\\plans\\2026-06-30-foo.md',
        parser
      );
      expect(stored).toBe('docs/superpowers/plans/2026-06-30-foo.md');

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
      expect(task?.plan).toBe('docs/superpowers/plans/2026-06-30-foo.md');
    });

    it('preserves the task body and existing frontmatter', async () => {
      await service.attachPlan('TASK-1', 'docs/plan.md', parser);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('Body stays intact.');
      const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
      expect(task?.title).toBe('Sample task');
    });

    it('replaces an existing plan link instead of duplicating it', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        TASK.replace('---\n\n##', 'plan: docs/old.md\n---\n\n##')
      );
      await service.attachPlan('TASK-1', 'docs/new.md', parser);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect((written.match(/^plan:/gm) ?? []).length).toBe(1);
      expect(written).toContain('plan: docs/new.md');
    });

    it('invalidates the parser cache for the written file', async () => {
      const spy = vi.spyOn(parser, 'invalidateTaskCache');
      await service.attachPlan('TASK-1', 'docs/plan.md', parser);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('task-1 - Sample-task.md') as unknown as string
      );
    });

    it('throws when the task does not exist', async () => {
      mockReaddirSync([]);
      await expect(service.attachPlan('TASK-404', 'docs/plan.md', parser)).rejects.toThrow(
        'TASK-404'
      );
    });
  });

  describe('detachPlan', () => {
    it('removes the plan link so the parser sees none', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        TASK.replace('---\n\n##', 'plan: docs/plan.md\n---\n\n##')
      );
      await service.detachPlan('TASK-1', parser);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
      expect(task?.plan).toBeUndefined();
    });
  });
});
