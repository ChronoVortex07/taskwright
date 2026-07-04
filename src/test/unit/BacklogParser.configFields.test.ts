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
  describe('Config: Additional Fields', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should parse auto_commit option from config', async () => {
      const configContent = `auto_commit: true`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.auto_commit).toBe(true);
    });

    it('should parse bypass_git_hooks option from config', async () => {
      const configContent = `bypass_git_hooks: true`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.bypass_git_hooks).toBe(true);
    });

    it('should parse auto_open_browser option from config', async () => {
      const configContent = `auto_open_browser: false`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.auto_open_browser).toBe(false);
    });

    it('should parse default_port option from config', async () => {
      const configContent = `default_port: 8080`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.default_port).toBe(8080);
    });

    it('should parse max_column_width option from config', async () => {
      const configContent = `max_column_width: 5`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.max_column_width).toBe(5);
    });

    it('should parse task_prefix option from config', async () => {
      const configContent = `task_prefix: "PROJ"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.task_prefix).toBe('PROJ');
    });

    it('should parse date_format option from config', async () => {
      const configContent = `date_format: "yyyy-mm-dd"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.date_format).toBe('yyyy-mm-dd');
    });

    it('should parse default_status option from config', async () => {
      const configContent = `default_status: "Backlog"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.default_status).toBe('Backlog');
    });

    it('should parse priorities array from config', async () => {
      const configContent = `priorities: ["critical", "high", "medium", "low"]`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.priorities).toEqual(['critical', 'high', 'medium', 'low']);
    });

    it('should parse default_assignee option from config', async () => {
      const configContent = `default_assignee: "@alice"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.default_assignee).toBe('@alice');
    });

    it('should parse default_reporter option from config', async () => {
      const configContent = `default_reporter: "@bob"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.default_reporter).toBe('@bob');
    });

    it('should parse default_editor option from config', async () => {
      const configContent = `default_editor: "vim"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.default_editor).toBe('vim');
    });

    it('should parse definition_of_done array from config', async () => {
      const configContent = `
definition_of_done:
  - "Code reviewed"
  - "Tests passing"
  - "Documentation updated"
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.definition_of_done).toEqual([
        'Code reviewed',
        'Tests passing',
        'Documentation updated',
      ]);
    });

    it('should parse timezone_preference option from config', async () => {
      const configContent = `timezone_preference: "America/New_York"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.timezone_preference).toBe('America/New_York');
    });

    it('should parse include_date_time_in_dates option from config', async () => {
      const configContent = `include_date_time_in_dates: true`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.include_date_time_in_dates).toBe(true);
    });

    it('should parse on_status_change option from config', async () => {
      const configContent = `on_status_change: "auto_commit"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.on_status_change).toBe('auto_commit');
    });

    it('should parse milestones array from config', async () => {
      const configContent = `
milestones:
  - name: "v1.0"
    description: "Initial release"
  - name: "v2.0"
    description: "Major update"
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.milestones).toEqual([
        { name: 'v1.0', description: 'Initial release' },
        { name: 'v2.0', description: 'Major update' },
      ]);
    });

    it('should parse milestones as simple string array from config', async () => {
      const configContent = `milestones: ["v1.0", "v2.0", "v3.0"]`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.milestones).toEqual(['v1.0', 'v2.0', 'v3.0']);
    });

    it('should parse config with all fields populated', async () => {
      const configContent = `
project_name: "Full Config Project"
default_status: "Backlog"
default_assignee: "@lead"
default_reporter: "@pm"
default_editor: "code"
statuses: ["Backlog", "To Do", "In Progress", "Review", "Done"]
priorities: ["critical", "high", "medium", "low"]
labels: ["bug", "feature", "docs"]
milestones:
  - name: "v1.0"
    description: "Initial release"
definition_of_done:
  - "Code reviewed"
  - "Tests passing"
date_format: "yyyy-mm-dd"
max_column_width: 5
auto_open_browser: true
default_port: 3000
remote_operations: true
auto_commit: false
bypass_git_hooks: false
check_active_branches: true
active_branch_days: 14
task_prefix: "PROJ"
task_resolution_strategy: most_recent
zero_padded_ids: true
timezone_preference: "UTC"
include_date_time_in_dates: false
on_status_change: "auto_commit"
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.project_name).toBe('Full Config Project');
      expect(config.default_status).toBe('Backlog');
      expect(config.default_assignee).toBe('@lead');
      expect(config.default_reporter).toBe('@pm');
      expect(config.default_editor).toBe('code');
      expect(config.statuses).toEqual(['Backlog', 'To Do', 'In Progress', 'Review', 'Done']);
      expect(config.priorities).toEqual(['critical', 'high', 'medium', 'low']);
      expect(config.labels).toEqual(['bug', 'feature', 'docs']);
      expect(config.milestones).toHaveLength(1);
      expect(config.definition_of_done).toEqual(['Code reviewed', 'Tests passing']);
      expect(config.date_format).toBe('yyyy-mm-dd');
      expect(config.max_column_width).toBe(5);
      expect(config.auto_open_browser).toBe(true);
      expect(config.default_port).toBe(3000);
      expect(config.remote_operations).toBe(true);
      expect(config.auto_commit).toBe(false);
      expect(config.bypass_git_hooks).toBe(false);
      expect(config.check_active_branches).toBe(true);
      expect(config.active_branch_days).toBe(14);
      expect(config.task_prefix).toBe('PROJ');
      expect(config.task_resolution_strategy).toBe('most_recent');
      expect(config.zero_padded_ids).toBe(3); // true normalized to 3
      expect(config.timezone_preference).toBe('UTC');
      expect(config.include_date_time_in_dates).toBe(false);
      expect(config.on_status_change).toBe('auto_commit');
    });

    it('should handle empty YAML file (null content)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('');

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config).toEqual({});
    });

    it('should handle YAML file with only comments', async () => {
      const configContent = `
# This is a comment
# Another comment
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config).toEqual({});
    });
  });

  describe('Config: camelCase to snake_case normalization', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should normalize autoCommit to auto_commit', async () => {
      const configContent = `autoCommit: true`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.auto_commit).toBe(true);
    });

    it('should normalize bypassGitHooks to bypass_git_hooks', async () => {
      const configContent = `bypassGitHooks: true`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.bypass_git_hooks).toBe(true);
    });

    it('should normalize checkActiveBranches to check_active_branches', async () => {
      const configContent = `checkActiveBranches: true`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.check_active_branches).toBe(true);
    });

    it('should normalize activeBranchDays to active_branch_days', async () => {
      const configContent = `activeBranchDays: 30`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.active_branch_days).toBe(30);
    });

    it('should normalize remoteOperations to remote_operations', async () => {
      const configContent = `remoteOperations: false`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.remote_operations).toBe(false);
    });

    it('should normalize taskResolutionStrategy to task_resolution_strategy', async () => {
      const configContent = `taskResolutionStrategy: most_progressed`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.task_resolution_strategy).toBe('most_progressed');
    });

    it('should normalize zeroPaddedIds to zero_padded_ids', async () => {
      const configContent = `zeroPaddedIds: true`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.zero_padded_ids).toBe(3); // true normalized to 3
    });

    it('should normalize autoOpenBrowser to auto_open_browser', async () => {
      const configContent = `autoOpenBrowser: true`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.auto_open_browser).toBe(true);
    });

    it('should normalize defaultPort to default_port', async () => {
      const configContent = `defaultPort: 9090`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.default_port).toBe(9090);
    });

    it('should normalize maxColumnWidth to max_column_width', async () => {
      const configContent = `maxColumnWidth: 8`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.max_column_width).toBe(8);
    });

    it('should normalize projectName to project_name', async () => {
      const configContent = `projectName: "Camel Case Project"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.project_name).toBe('Camel Case Project');
    });

    it('should normalize defaultStatus to default_status', async () => {
      const configContent = `defaultStatus: "In Progress"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.default_status).toBe('In Progress');
    });

    it('should normalize defaultAssignee to default_assignee', async () => {
      const configContent = `defaultAssignee: "@charlie"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.default_assignee).toBe('@charlie');
    });

    it('should normalize defaultReporter to default_reporter', async () => {
      const configContent = `defaultReporter: "@dave"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.default_reporter).toBe('@dave');
    });

    it('should normalize defaultEditor to default_editor', async () => {
      const configContent = `defaultEditor: "nano"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.default_editor).toBe('nano');
    });

    it('should normalize definitionOfDone to definition_of_done', async () => {
      const configContent = `definitionOfDone: ["Code reviewed", "Tests pass"]`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.definition_of_done).toEqual(['Code reviewed', 'Tests pass']);
    });

    it('should normalize timezonePreference to timezone_preference', async () => {
      const configContent = `timezonePreference: "Europe/London"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.timezone_preference).toBe('Europe/London');
    });

    it('should normalize includeDateTimeInDates to include_date_time_in_dates', async () => {
      const configContent = `includeDateTimeInDates: true`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.include_date_time_in_dates).toBe(true);
    });

    it('should normalize onStatusChange to on_status_change', async () => {
      const configContent = `onStatusChange: "auto_commit"`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.on_status_change).toBe('auto_commit');
    });

    it('should handle mixed camelCase and snake_case in same config', async () => {
      const configContent = `
projectName: "Mixed Config"
default_status: "To Do"
autoCommit: true
bypass_git_hooks: false
checkActiveBranches: true
active_branch_days: 7
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.project_name).toBe('Mixed Config');
      expect(config.default_status).toBe('To Do');
      expect(config.auto_commit).toBe(true);
      expect(config.bypass_git_hooks).toBe(false);
      expect(config.check_active_branches).toBe(true);
      expect(config.active_branch_days).toBe(7);
    });

    it('should prefer snake_case when both variants present', async () => {
      const configContent = `
auto_commit: true
autoCommit: false
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      // snake_case should come first in YAML iteration and win
      expect(config.auto_commit).toBe(true);
    });

    it('should handle snake_case fields that are already in correct format', async () => {
      const configContent = `
project_name: "Snake Case Only"
check_active_branches: true
remote_operations: false
task_resolution_strategy: most_recent
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const parser = new BacklogParser('/fake/backlog');
      const config = await parser.getConfig();

      expect(config.project_name).toBe('Snake Case Only');
      expect(config.check_active_branches).toBe(true);
      expect(config.remote_operations).toBe(false);
      expect(config.task_resolution_strategy).toBe('most_recent');
    });
  });
});
