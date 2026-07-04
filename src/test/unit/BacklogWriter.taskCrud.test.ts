import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BacklogWriter } from '../../core/BacklogWriter';
import { BacklogParser } from '../../core/BacklogParser';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 1000 }),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// Helper to mock readdirSync with string array (simulating withFileTypes: false)
function mockReaddirSync(files: string[]) {
  vi.mocked(fs.readdirSync).mockReturnValue(files as unknown as ReturnType<typeof fs.readdirSync>);
}

describe('BacklogWriter', () => {
  let writer: BacklogWriter;
  let mockParser: BacklogParser;

  beforeEach(() => {
    writer = new BacklogWriter();
    mockParser = new BacklogParser('/fake/backlog');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('updateTaskStatus', () => {
    it('should update status in YAML frontmatter', async () => {
      const originalContent = `---
id: TASK-1
title: Test Task
status: To Do
priority: high
---

## Description
Test description
`;
      vi.mocked(fs.readFileSync).mockReturnValue(originalContent);
      mockReaddirSync(['task-1 - Test-Task.md']);

      await writer.updateTaskStatus('TASK-1', 'In Progress', mockParser);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;

      // Parse the written YAML to verify
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      expect(match).toBeTruthy();
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.status).toBe('In Progress');
    });

    it('should update status for all status types', async () => {
      const testCases = [
        { status: 'To Do' as const },
        { status: 'In Progress' as const },
        { status: 'Done' as const },
        { status: 'Draft' as const },
      ];

      for (const { status } of testCases) {
        vi.mocked(fs.writeFileSync).mockClear();

        const content = `---
id: TASK-1
title: Test
status: To Do
---
`;
        vi.mocked(fs.readFileSync).mockReturnValue(content);
        mockReaddirSync(['task-1.md']);

        await writer.updateTaskStatus('TASK-1', status, mockParser);

        const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
        const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
        const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
        expect(frontmatter.status).toBe(status);
      }
    });
  });
  describe('toggleChecklistItem', () => {
    it('should toggle unchecked item to checked', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria
- [ ] #1 First item
- [ ] #2 Second item
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.toggleChecklistItem('TASK-1', 'acceptanceCriteria', 1, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('- [x] #1 First item');
      expect(writtenContent).toContain('- [ ] #2 Second item');
    });

    it('should toggle checked item to unchecked', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria
- [x] #1 First item
- [ ] #2 Second item
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.toggleChecklistItem('TASK-1', 'acceptanceCriteria', 1, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('- [ ] #1 First item');
    });

    it('toggles only the targeted list when AC and DoD share an item number', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 AC first
- [ ] #2 AC second
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 DoD first
<!-- DOD:END -->
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.toggleChecklistItem('TASK-1', 'acceptanceCriteria', 1, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('- [x] #1 AC first');
      expect(writtenContent).toContain('- [ ] #1 DoD first');
    });

    it('toggles the DoD item without affecting the AC item of the same number', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 AC first
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 DoD first
- [ ] #2 DoD second
<!-- DOD:END -->
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.toggleChecklistItem('TASK-1', 'definitionOfDone', 1, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('- [ ] #1 AC first');
      expect(writtenContent).toContain('- [x] #1 DoD first');
    });

    it('scopes the toggle by section for legacy files without AC/DoD markers', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria
- [ ] #1 AC first

## Definition of Done
- [ ] #1 DoD first
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.toggleChecklistItem('TASK-1', 'acceptanceCriteria', 1, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('- [x] #1 AC first');
      expect(writtenContent).toContain('- [ ] #1 DoD first');
    });
  });
  describe('updateTask', () => {
    it('should update priority', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
priority: low
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { priority: 'high' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.priority).toBe('high');
    });

    it('should update title', async () => {
      const content = `---
id: TASK-1
title: Old Title
status: To Do
---

# TASK-1 - Old Title
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { title: 'New Title' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.title).toBe('New Title');
    });

    it('should update labels array', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
labels: []
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { labels: ['bug', 'urgent'] }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.labels).toEqual(['bug', 'urgent']);
    });

    it('should update dependencies array', async () => {
      const content = `---
id: TASK-2
title: Test
status: To Do
dependencies: []
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-2.md']);

      await writer.updateTask('TASK-2', { dependencies: ['TASK-1', 'TASK-3'] }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.dependencies).toEqual(['TASK-1', 'TASK-3']);
    });

    it('should preserve body content', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description
Important description text

## Acceptance Criteria
- [ ] #1 First criterion
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('## Description');
      expect(writtenContent).toContain('Important description text');
      expect(writtenContent).toContain('## Acceptance Criteria');
      expect(writtenContent).toContain('- [ ] #1 First criterion');
    });

    it('should update description with markers', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Old description
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
- [ ] #1 First criterion
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { description: 'New description text' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('<!-- SECTION:DESCRIPTION:BEGIN -->');
      expect(writtenContent).toContain('New description text');
      expect(writtenContent).toContain('<!-- SECTION:DESCRIPTION:END -->');
      expect(writtenContent).not.toContain('Old description');
      expect(writtenContent).toContain('## Acceptance Criteria');
    });
  });
  describe('createTask', () => {
    it('should create a new task file with auto-generated ID', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync(['task-1.md', 'task-5.md', 'task-3.md']);

      const result = await writer.createTask('/fake/backlog', {
        title: 'New Feature',
      });

      expect(result.id).toBe('TASK-6'); // Next after highest ID (5)
      expect(result.filePath).toContain('task-6 - New-Feature.md');
      expect(fs.writeFileSync).toHaveBeenCalled();

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      expect(match).toBeTruthy();
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.id).toBe('TASK-6');
      expect(frontmatter.title).toBe('New Feature');
      expect(frontmatter.status).toBe('To Do');
    });

    it('should create task with all optional fields', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      await writer.createTask('/fake/backlog', {
        title: 'Full Task',
        description: 'Task description',
        status: 'In Progress',
        priority: 'high',
        labels: ['bug', 'urgent'],
        milestone: 'v1.0',
      });

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.status).toBe('In Progress');
      expect(frontmatter.priority).toBe('high');
      expect(frontmatter.labels).toEqual(['bug', 'urgent']);
      expect(frontmatter.milestone).toBe('v1.0');
      expect(writtenContent).toContain('Task description');
    });

    it('should create tasks directory if it does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockReaddirSync([]);

      await writer.createTask('/fake/backlog', { title: 'Test' });

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('tasks'),
        expect.objectContaining({ recursive: true })
      );
    });

    it('should sanitize special characters in filename', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const result = await writer.createTask('/fake/backlog', {
        title: 'Fix: bug #123 (urgent!)',
      });

      expect(result.filePath).toContain('task-1 - Fix-bug-123-urgent.md');
    });

    it('should handle task ID generation with gaps', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Files with gaps: 1, 3, 5, 10 - should create task-11
      mockReaddirSync(['task-1.md', 'task-3.md', 'task-5.md', 'task-10.md']);

      const result = await writer.createTask('/fake/backlog', {
        title: 'Gap Test',
      });

      expect(result.id).toBe('TASK-11');
    });

    it('should handle empty tasks directory', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const result = await writer.createTask('/fake/backlog', {
        title: 'First Task',
      });

      expect(result.id).toBe('TASK-1');
    });

    it('should handle title with only special characters', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const result = await writer.createTask('/fake/backlog', {
        title: '!@#$%^&*()',
      });

      // Should still create a file with sanitized (possibly empty) title portion
      expect(result.filePath).toContain('task-1');
    });

    it('should handle title with unicode characters', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      await writer.createTask('/fake/backlog', {
        title: 'ðŸš€ Feature with Ã©mojis and cafÃ©',
      });

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // Mirrors upstream canonical serialization: js-yaml escapes astral-plane
      // codepoints when dumped; YAML parsers decode them back to the original.
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      expect(match).toBeTruthy();
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.title).toBe('ðŸš€ Feature with Ã©mojis and cafÃ©');
    });

    it('should handle very long title by truncating filename', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const longTitle = 'A'.repeat(200);
      const result = await writer.createTask('/fake/backlog', {
        title: longTitle,
      });

      // Filename should be truncated but full title preserved in content
      expect(result.filePath.length).toBeLessThan(200);
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain(longTitle);
    });

    it('should use default TASK prefix when no parser provided', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const result = await writer.createTask('/fake/backlog', {
        title: 'Test Task',
      });

      expect(result.id).toBe('TASK-1');
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('id: TASK-1');
    });

    it('should use custom task_prefix from config when parser provided', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      // Create a mock parser with custom config
      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ task_prefix: 'ISSUE' }),
      } as unknown as BacklogParser;

      const result = await writer.createTask(
        '/fake/backlog',
        { title: 'Test Issue' },
        mockParserWithConfig
      );

      expect(result.id).toBe('ISSUE-1');
      expect(result.filePath).toContain('issue-1 - Test-Issue.md');
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('id: ISSUE-1');
    });

    it('should return uppercase ID regardless of config prefix case', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ task_prefix: 'task' }),
      } as unknown as BacklogParser;

      const result = await writer.createTask(
        '/fake/backlog',
        { title: 'Test Task' },
        mockParserWithConfig
      );

      expect(result.id).toBe('TASK-1');
      expect(result.filePath).toContain('task-1 - Test-Task.md');
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('id: TASK-1');
    });

    it('should fallback to TASK prefix when config has no task_prefix', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      // Create a mock parser with config that lacks task_prefix
      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ project_name: 'My Project' }),
      } as unknown as BacklogParser;

      const result = await writer.createTask(
        '/fake/backlog',
        { title: 'Test Task' },
        mockParserWithConfig
      );

      expect(result.id).toBe('TASK-1');
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('id: TASK-1');
    });
  });
  describe('createTask with zero_padded_ids', () => {
    it('should zero-pad task ID when zero_padded_ids is 3', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ zero_padded_ids: 3 }),
      } as unknown as BacklogParser;

      const result = await writer.createTask(
        '/fake/backlog',
        { title: 'Padded Task' },
        mockParserWithConfig
      );

      expect(result.id).toBe('TASK-001');
      expect(result.filePath).toContain('task-001 - Padded-Task.md');
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('id: TASK-001');
    });

    it('should not pad when zero_padded_ids is undefined', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({}),
      } as unknown as BacklogParser;

      const result = await writer.createTask(
        '/fake/backlog',
        { title: 'Unpadded Task' },
        mockParserWithConfig
      );

      expect(result.id).toBe('TASK-1');
      expect(result.filePath).toContain('task-1 - Unpadded-Task.md');
    });

    it('should pad with custom width (4)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync(['task-0009 - Existing.md']);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ zero_padded_ids: 4 }),
      } as unknown as BacklogParser;

      const result = await writer.createTask(
        '/fake/backlog',
        { title: 'Wide Pad' },
        mockParserWithConfig
      );

      expect(result.id).toBe('TASK-0010');
      expect(result.filePath).toContain('task-0010 - Wide-Pad.md');
    });

    it('should combine zero_padded_ids and custom task_prefix', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ task_prefix: 'PROJ', zero_padded_ids: 3 }),
      } as unknown as BacklogParser;

      const result = await writer.createTask(
        '/fake/backlog',
        { title: 'Project Task' },
        mockParserWithConfig
      );

      expect(result.id).toBe('PROJ-001');
      expect(result.filePath).toContain('proj-001 - Project-Task.md');
    });
  });
  describe('createTask with custom prefix file scanning', () => {
    it('should scan files with custom prefix for next ID', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync(['proj-1 - First.md', 'proj-3 - Third.md']);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ task_prefix: 'PROJ' }),
      } as unknown as BacklogParser;

      const result = await writer.createTask(
        '/fake/backlog',
        { title: 'Next Project' },
        mockParserWithConfig
      );

      expect(result.id).toBe('PROJ-4');
    });
  });
  describe('createSubtask with custom prefix', () => {
    it('should use prefix from parent ID in filename', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const result = await writer.createSubtask('ISSUE-5', '/fake/backlog', mockParser);

      expect(result.id).toBe('ISSUE-5.1');
      expect(result.filePath).toContain('issue-5.1 - Untitled.md');
    });

    it('should scan with correct prefix pattern for existing subtasks', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync(['proj-3 - Parent.md', 'proj-3.1 - Sub-A.md', 'proj-3.2 - Sub-B.md']);

      const result = await writer.createSubtask('PROJ-3', '/fake/backlog', mockParser);

      expect(result.id).toBe('PROJ-3.3');
      expect(result.filePath).toContain('proj-3.3 - Untitled.md');
    });
  });
  describe('createTask with config defaults', () => {
    it('should use default_status from config when no explicit status', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ default_status: 'Backlog' }),
      } as unknown as BacklogParser;

      await writer.createTask('/fake/backlog', { title: 'Default Status' }, mockParserWithConfig);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.status).toBe('Backlog');
    });

    it('should use explicit status over config default_status', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ default_status: 'Backlog' }),
      } as unknown as BacklogParser;

      await writer.createTask(
        '/fake/backlog',
        { title: 'Explicit Status', status: 'In Progress' },
        mockParserWithConfig
      );

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.status).toBe('In Progress');
    });

    it('should apply default_assignee from config', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ default_assignee: '@dev' }),
      } as unknown as BacklogParser;

      await writer.createTask('/fake/backlog', { title: 'With Assignee' }, mockParserWithConfig);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.assignee).toEqual(['@dev']);
    });

    it('should use explicit assignee over config default_assignee', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ default_assignee: '@dev' }),
      } as unknown as BacklogParser;

      await writer.createTask(
        '/fake/backlog',
        { title: 'Custom Assignee', assignee: ['@alice'] },
        mockParserWithConfig
      );

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.assignee).toEqual(['@alice']);
    });

    it('should apply default_reporter from config', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({ default_reporter: '@pm' }),
      } as unknown as BacklogParser;

      await writer.createTask('/fake/backlog', { title: 'With Reporter' }, mockParserWithConfig);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.reporter).toBe('@pm');
    });

    it('should not inject DoD section even when definition_of_done configured', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({
          definition_of_done: ['Tests pass', 'Code reviewed'],
        }),
      } as unknown as BacklogParser;

      await writer.createTask('/fake/backlog', { title: 'With DoD' }, mockParserWithConfig);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // DoD is no longer created on new tasks (removed from the UI; parsing/serialization
      // of existing DoD sections stays intact for Backlog.md compat).
      expect(writtenContent).not.toContain('## Definition of Done');
      expect(writtenContent).not.toContain('<!-- DOD:BEGIN -->');
      // The Description and Acceptance Criteria sections still render.
      expect(writtenContent).toContain('## Acceptance Criteria');
    });

    it('should not include DoD section when definition_of_done not configured', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const mockParserWithConfig = {
        getConfig: vi.fn().mockResolvedValue({}),
      } as unknown as BacklogParser;

      await writer.createTask('/fake/backlog', { title: 'Without DoD' }, mockParserWithConfig);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).not.toContain('## Definition of Done');
    });
  });
});
