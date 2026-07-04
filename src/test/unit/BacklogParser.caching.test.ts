import { describe, it, expect, vi, afterEach } from 'vitest';
import { BacklogParser } from '../../core/BacklogParser';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 1000 }),
  };
});

describe('BacklogParser', () => {
  describe('Task file caching', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should not call readFileSync on second getTasks() with unchanged mtimes', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1 - My-Task.md']);
      vi.mocked(fs.readFileSync).mockReturnValue(`---
id: TASK-1
title: My Task
status: To Do
---
`);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);

      const parser = new BacklogParser('/fake/backlog');

      // First call: should read from disk
      const tasks1 = await parser.getTasksFromFolder('tasks');
      expect(tasks1).toHaveLength(1);
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);

      // Second call: same mtime, should use cache
      const tasks2 = await parser.getTasksFromFolder('tasks');
      expect(tasks2).toHaveLength(1);
      expect(tasks2[0].id).toBe('TASK-1');
      // readFileSync should NOT have been called again
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    });

    it('should re-read only the file whose mtime changed', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'task-1 - First.md',
        'task-2 - Second.md',
      ]);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('task-1')) return `---\nid: TASK-1\ntitle: First\nstatus: To Do\n---\n`;
        return `---\nid: TASK-2\ntitle: Second\nstatus: To Do\n---\n`;
      });
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);

      const parser = new BacklogParser('/fake/backlog');

      // First call: reads both files
      await parser.getTasksFromFolder('tasks');
      expect(fs.readFileSync).toHaveBeenCalledTimes(2);

      // Change mtime of task-2 only
      vi.mocked(fs.statSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('task-2')) return { mtimeMs: 2000 } as fs.Stats;
        return { mtimeMs: 1000 } as fs.Stats;
      });
      vi.mocked(fs.readFileSync).mockClear();
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('task-1')) return `---\nid: TASK-1\ntitle: First\nstatus: To Do\n---\n`;
        return `---\nid: TASK-2\ntitle: Second Updated\nstatus: In Progress\n---\n`;
      });

      const tasks = await parser.getTasksFromFolder('tasks');
      // Only task-2 should have been re-read
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('task-2'), 'utf-8');
      // task-2 should have updated content
      const task2 = tasks.find((t) => t.id === 'TASK-2');
      expect(task2?.title).toBe('Second Updated');
      expect(task2?.status).toBe('In Progress');
    });

    it('should evict cache entries for deleted files', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);

      // First call: two files
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'task-1 - First.md',
        'task-2 - Second.md',
      ]);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('task-1')) return `---\nid: TASK-1\ntitle: First\nstatus: To Do\n---\n`;
        return `---\nid: TASK-2\ntitle: Second\nstatus: To Do\n---\n`;
      });

      const parser = new BacklogParser('/fake/backlog');
      const tasks1 = await parser.getTasksFromFolder('tasks');
      expect(tasks1).toHaveLength(2);

      // Second call: task-2 deleted
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1 - First.md']);
      vi.mocked(fs.readFileSync).mockClear();

      const tasks2 = await parser.getTasksFromFolder('tasks');
      expect(tasks2).toHaveLength(1);
      expect(tasks2[0].id).toBe('TASK-1');
      // task-1 should have come from cache (not re-read)
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('should force full re-read after invalidateTaskCache()', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1 - My-Task.md']);
      vi.mocked(fs.readFileSync).mockReturnValue(`---
id: TASK-1
title: My Task
status: To Do
---
`);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);

      const parser = new BacklogParser('/fake/backlog');
      await parser.getTasksFromFolder('tasks');
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);

      // Invalidate and re-read
      parser.invalidateTaskCache();
      vi.mocked(fs.readFileSync).mockClear();

      await parser.getTasksFromFolder('tasks');
      // Should have re-read since cache was cleared
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    });

    it('should invalidate only a specific file path', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'task-1 - First.md',
        'task-2 - Second.md',
      ]);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('task-1')) return `---\nid: TASK-1\ntitle: First\nstatus: To Do\n---\n`;
        return `---\nid: TASK-2\ntitle: Second\nstatus: To Do\n---\n`;
      });
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);

      const parser = new BacklogParser('/fake/backlog');
      await parser.getTasksFromFolder('tasks');
      expect(fs.readFileSync).toHaveBeenCalledTimes(2);

      // Invalidate only task-1. Build the key with path.join so it matches the
      // platform-native cache key (path.join yields backslashes on Windows).
      parser.invalidateTaskCache(path.join('/fake/backlog', 'tasks', 'task-1 - First.md'));
      vi.mocked(fs.readFileSync).mockClear();

      await parser.getTasksFromFolder('tasks');
      // Only task-1 should have been re-read (task-2 from cache)
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('task-1'), 'utf-8');
    });

    it('should cache tasks across different folders independently', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);

      (fs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation((dirPath: string) => {
        if (String(dirPath).endsWith('tasks')) return ['task-1 - Active.md'];
        if (String(dirPath).endsWith('drafts')) return ['draft-1 - Draft.md'];
        return [];
      });
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('task-1')) return `---\nid: TASK-1\ntitle: Active\nstatus: To Do\n---\n`;
        return `---\nid: DRAFT-1\ntitle: Draft\nstatus: Draft\n---\n`;
      });

      const parser = new BacklogParser('/fake/backlog');

      // Read tasks folder
      await parser.getTasksFromFolder('tasks');
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);

      // Read drafts folder
      await parser.getTasksFromFolder('drafts');
      expect(fs.readFileSync).toHaveBeenCalledTimes(2);

      vi.mocked(fs.readFileSync).mockClear();

      // Re-read both - both should be cached
      await parser.getTasksFromFolder('tasks');
      await parser.getTasksFromFolder('drafts');
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });
  });
});
