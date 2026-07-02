import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TreeFieldService } from '../../core/TreeFieldService';
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

describe('TreeFieldService', () => {
  let service: TreeFieldService;
  let parser: BacklogParser;

  beforeEach(() => {
    service = new TreeFieldService();
    parser = new BacklogParser('/fake/backlog');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync(['task-1 - Sample-task.md']);
    vi.mocked(fs.readFileSync).mockReturnValue(TASK);
  });

  afterEach(() => vi.clearAllMocks());

  it('writes category the parser reads back, preserving canonical frontmatter + body', async () => {
    const stored = await service.setCategory('TASK-1', '  Backend  ', parser);
    expect(stored).toBe('Backend');
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain('Body stays intact.');
    const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
    expect(task?.category).toBe('Backend');
    expect(task?.title).toBe('Sample task');
    expect(task?.status).toBe('To Do');
  });

  it('writes caused_by and replaces (never duplicates) an existing value', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      TASK.replace('---\n\n##', 'caused_by: TASK-8\n---\n\n##')
    );
    const stored = await service.setCausedBy('TASK-1', 'TASK-9', parser);
    expect(stored).toBe('TASK-9');
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect((written.match(/^caused_by:/gm) ?? []).length).toBe(1);
    expect(written).toContain('caused_by: TASK-9');
  });

  it('clearCategory / clearCausedBy remove the fields idempotently', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      TASK.replace('---\n\n##', 'category: Backend\ncaused_by: TASK-9\n---\n\n##')
    );
    await service.clearCategory('TASK-1', parser);
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).not.toContain('category:');
    // caused_by survives an unrelated clear
    expect(written).toContain('caused_by: TASK-9');
  });

  it('clearType removes the type field surgically, leaving siblings intact', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      TASK.replace('---\n\n##', 'type: bug\ncategory: Backend\n---\n\n##')
    );
    await service.clearType('TASK-1', parser);
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).not.toContain('type:');
    // an unrelated sibling field survives the clear
    expect(written).toContain('category: Backend');
  });

  it('preserves CRLF line endings', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(TASK.replace(/\n/g, '\r\n'));
    await service.setCategory('TASK-1', 'Backend', parser);
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain('\r\n');
  });

  it('invalidates the parser cache for the written file', async () => {
    const spy = vi.spyOn(parser, 'invalidateTaskCache');
    await service.setCategory('TASK-1', 'Backend', parser);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('task-1 - Sample-task.md') as unknown as string
    );
  });

  it('throws when the task does not exist', async () => {
    mockReaddirSync([]);
    await expect(service.setCategory('TASK-404', 'Backend', parser)).rejects.toThrow('TASK-404');
  });
});
