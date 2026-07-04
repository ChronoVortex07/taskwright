import { describe, it, expect, vi, afterEach } from 'vitest';
import { BacklogParser } from '../../core/BacklogParser';
import * as fs from 'fs';

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
  describe('getConfig', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should parse config.yml and return BacklogConfig', async () => {
      const configContent = `
project_name: "Test Project"
statuses: ["To Do", "In Progress", "Review", "Done"]
labels: ["bug", "feature"]
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.project_name).toBe('Test Project');
      expect(config.statuses).toEqual(['To Do', 'In Progress', 'Review', 'Done']);
      expect(config.labels).toEqual(['bug', 'feature']);
    });

    it('should return empty config when no config file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config).toEqual({});
    });

    it('should handle malformed YAML gracefully', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('invalid: yaml: content: [');

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config).toEqual({});
    });

    it('should cache config and return cached value on second call', async () => {
      const configContent = `project_name: "Cached Project"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);

      const parser = new BacklogParser('/fake/backlog');
      const config1 = await parser.getConfig();
      const config2 = await parser.getConfig();

      expect(config1.project_name).toBe('Cached Project');
      expect(config2.project_name).toBe('Cached Project');
      // readFileSync should only be called once (cached on second call)
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    });

    it('should re-read config when mtime changes', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`project_name: "V1"`);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);

      const parser = new BacklogParser('/fake/backlog');
      const config1 = await parser.getConfig();
      expect(config1.project_name).toBe('V1');

      // Simulate file modification
      vi.mocked(fs.readFileSync).mockReturnValue(`project_name: "V2"`);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000 } as fs.Stats);

      const config2 = await parser.getConfig();
      expect(config2.project_name).toBe('V2');
      expect(fs.readFileSync).toHaveBeenCalledTimes(2);
    });

    it('should re-read config after invalidateConfigCache()', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`project_name: "Original"`);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);

      const parser = new BacklogParser('/fake/backlog');
      await parser.getConfig();

      parser.invalidateConfigCache();

      vi.mocked(fs.readFileSync).mockReturnValue(`project_name: "Updated"`);
      const config = await parser.getConfig();
      expect(config.project_name).toBe('Updated');
      expect(fs.readFileSync).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStatuses', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return statuses from config', async () => {
      const configContent = `statuses: ["Backlog", "Active", "Complete"]`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const statuses = await parser.getStatuses();

      expect(statuses).toEqual(['Backlog', 'Active', 'Complete']);
    });

    it('should return default statuses when config has none', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const parser = new BacklogParser('/fake/backlog');
      const statuses = await parser.getStatuses();

      expect(statuses).toEqual(['To Do', 'In Progress', 'Done']);
    });
  });

  describe('Cross-Branch Config Options', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should parse check_active_branches option from config', async () => {
      const configContent = `
check_active_branches: true
active_branch_days: 30
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.check_active_branches).toBe(true);
      expect(config.active_branch_days).toBe(30);
    });

    it('should parse remote_operations option from config', async () => {
      const configContent = `
remote_operations: false
check_active_branches: false
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.remote_operations).toBe(false);
      expect(config.check_active_branches).toBe(false);
    });

    it('should parse task_resolution_strategy option from config', async () => {
      const configContent = `
task_resolution_strategy: most_progressed
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.task_resolution_strategy).toBe('most_progressed');
    });

    it('should normalize zero_padded_ids: true to 3', async () => {
      const configContent = `
zero_padded_ids: true
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.zero_padded_ids).toBe(3);
    });

    it('should parse zero_padded_ids as a number', async () => {
      const configContent = `
zero_padded_ids: 4
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.zero_padded_ids).toBe(4);
    });

    it('should handle config with all cross-branch options', async () => {
      const configContent = `
project_name: "Test Project"
check_active_branches: true
remote_operations: true
active_branch_days: 14
task_resolution_strategy: most_recent
zero_padded_ids: false
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.project_name).toBe('Test Project');
      expect(config.check_active_branches).toBe(true);
      expect(config.remote_operations).toBe(true);
      expect(config.active_branch_days).toBe(14);
      expect(config.task_resolution_strategy).toBe('most_recent');
      expect(config.zero_padded_ids).toBeUndefined();
    });

    it('should return undefined for missing cross-branch config options', async () => {
      const configContent = `
project_name: "Simple Project"
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.check_active_branches).toBeUndefined();
      expect(config.remote_operations).toBeUndefined();
      expect(config.active_branch_days).toBeUndefined();
      expect(config.task_resolution_strategy).toBeUndefined();
    });
  });

  describe('getTasksWithCrossBranch (Board Sync v2 Task C — unconditionally local-only)', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('returns exactly getTasks(), even when check_active_branches is true', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['task-1 - Local.md']);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
        if (String(filePath).endsWith('config.yml')) {
          return 'check_active_branches: true\n';
        }
        return `---\nid: TASK-1\ntitle: Local\nstatus: To Do\n---\n`;
      });

      const parser = new BacklogParser('/fake/backlog');
      const [local, crossBranch] = await Promise.all([
        parser.getTasks(),
        parser.getTasksWithCrossBranch(),
      ]);

      expect(crossBranch).toEqual(local);
      expect(crossBranch).toHaveLength(1);
      expect(crossBranch[0].id).toBe('TASK-1');
    });
  });
});
