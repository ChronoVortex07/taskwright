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

  describe('Edge Cases: updateTask', () => {
    it('should throw error when task not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      await expect(writer.updateTask('TASK-999', { status: 'Done' }, mockParser)).rejects.toThrow(
        'Task TASK-999 not found'
      );
    });

    it('should preserve all fields when updating single field', async () => {
      const content = `---
id: TASK-1
title: Original Title
status: To Do
priority: high
labels:
  - bug
  - urgent
milestone: v1.0
assignee:
  - alice
---

## Description

Original description
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;

      expect(frontmatter.status).toBe('Done');
      expect(frontmatter.title).toBe('Original Title');
      expect(frontmatter.priority).toBe('high');
      expect(frontmatter.labels).toEqual(['bug', 'urgent']);
      expect(frontmatter.milestone).toBe('v1.0');
    });

    it('should add description markers when updating description without markers', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

Old description without markers

## Acceptance Criteria

- [ ] #1 Test
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { description: 'New description' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('<!-- SECTION:DESCRIPTION:BEGIN -->');
      expect(writtenContent).toContain('New description');
      expect(writtenContent).toContain('<!-- SECTION:DESCRIPTION:END -->');
    });

    it('should handle task file without frontmatter', async () => {
      const content = `# TASK-1 - No Frontmatter Task

## Description

Just a plain markdown file
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      // Parser can find task by extracting title from heading
      // The update should succeed and add frontmatter
      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // Should write the updated content (frontmatter may be added)
      expect(fs.writeFileSync).toHaveBeenCalled();
      // The file content should still contain the description
      expect(writtenContent).toContain('Just a plain markdown file');
    });

    it('should handle file with malformed frontmatter', async () => {
      const content = `---
id: TASK-1
title: Test
status: {malformed: yaml:
---

## Description
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      // Should handle gracefully - parser might return undefined for malformed YAML
      await expect(writer.updateTask('TASK-1', { status: 'Done' }, mockParser)).rejects.toThrow(); // Will throw because parser returns undefined for malformed YAML
    });
  });
  describe('Edge Cases: toggleChecklistItem', () => {
    it('should handle toggle of non-existent item ID gracefully', async () => {
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

      // Toggle non-existent #999 - should not throw, just not change anything
      await writer.toggleChecklistItem('TASK-1', 'acceptanceCriteria', 999, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // Original items should be unchanged
      expect(writtenContent).toContain('- [ ] #1 First item');
      expect(writtenContent).toContain('- [ ] #2 Second item');
    });

    it('should handle checklist item with special regex characters', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria

- [ ] #1 Fix $100.00 bug (urgent!)
- [ ] #2 Test [link](url) and *bold*
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.toggleChecklistItem('TASK-1', 'acceptanceCriteria', 1, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('- [x] #1 Fix $100.00 bug (urgent!)');
    });

    it('should toggle definition of done items', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Definition of Done

- [ ] #1 Code reviewed
- [ ] #2 Tests passing
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.toggleChecklistItem('TASK-1', 'definitionOfDone', 2, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('- [ ] #1 Code reviewed');
      expect(writtenContent).toContain('- [x] #2 Tests passing');
    });

    it('should handle multiple items with same ID gracefully', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria

- [ ] #1 First with ID 1
- [ ] #1 Second with same ID 1
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.toggleChecklistItem('TASK-1', 'acceptanceCriteria', 1, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // Both should be toggled since they have the same ID
      expect(writtenContent).toContain('- [x] #1 First with ID 1');
      expect(writtenContent).toContain('- [x] #1 Second with same ID 1');
    });
  });
  describe('Edge Cases: Description Updates', () => {
    it('should handle updating description with nested markers', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Old content with <!-- nested comment -->
<!-- SECTION:DESCRIPTION:END -->
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { description: 'New clean description' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('New clean description');
      expect(writtenContent).not.toContain('Old content');
    });

    it('should handle description with code blocks containing markers', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Here is some code:
\`\`\`html
<!-- SECTION:DESCRIPTION:BEGIN -->
This is inside a code block
<!-- SECTION:DESCRIPTION:END -->
\`\`\`
<!-- SECTION:DESCRIPTION:END -->
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { description: 'Updated description' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('Updated description');
    });

    it('should add description section when file has no description header', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria

- [ ] #1 Test
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { description: 'Added description' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('## Description');
      expect(writtenContent).toContain('Added description');
    });

    it('should handle description with multiline content', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Old
<!-- SECTION:DESCRIPTION:END -->
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      const multilineDesc = `Line 1
Line 2
Line 3

With blank line above`;

      await writer.updateTask('TASK-1', { description: multilineDesc }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('Line 1');
      expect(writtenContent).toContain('Line 2');
      expect(writtenContent).toContain('With blank line above');
    });
  });
  describe('New Fields: references, documentation, type', () => {
    it('should update references array', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask(
        'TASK-1',
        { references: ['https://github.com/issue/1', 'docs/spec.md'] },
        mockParser
      );

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.references).toEqual(['https://github.com/issue/1', 'docs/spec.md']);
    });

    it('should update documentation array', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask(
        'TASK-1',
        { documentation: ['https://docs.example.com', 'README.md'] },
        mockParser
      );

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.documentation).toEqual(['https://docs.example.com', 'README.md']);
    });

    it('should update type field', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { type: 'feature' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.type).toBe('feature');
    });

    it('should preserve existing references when updating other fields', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
references:
  - existing-ref.md
documentation:
  - existing-doc.md
type: bug
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.references).toEqual(['existing-ref.md']);
      expect(frontmatter.documentation).toEqual(['existing-doc.md']);
      expect(frontmatter.type).toBe('bug');
    });

    it('should omit empty references array to match canonical format', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
references:
  - old-ref.md
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { references: [] }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // Upstream omits empty optional arrays (references, documentation, etc.)
      // entirely rather than emitting `references: []`.
      expect(writtenContent).not.toMatch(/^references:/m);
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.references).toBeUndefined();
    });
  });
  describe('Canonical Format Compatibility', () => {
    it('should output arrays in block-style (upstream canonical format)', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
labels: [feature, ui]
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // Canonical backlog.md format uses block-style arrays with leading dash.
      expect(writtenContent).toMatch(/labels:\n {2}- feature\n {2}- ui/);
      expect(writtenContent).not.toMatch(/labels: \[/);
    });

    it('should preserve date strings without converting to timestamps', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
created: 2026-02-01
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // Must not convert to ISO timestamp. Canonical format single-quotes dates
      // to prevent YAML from parsing them as timestamps.
      expect(writtenContent).not.toContain('T00:00:00');
      expect(writtenContent).toContain("created: '2026-02-01'");
    });

    it('should have newline between closing --- and body content', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

# Test

Description here.
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // Should have newline after closing ---, not ---# or ---\n#
      expect(writtenContent).toMatch(/---\n\n/);
      expect(writtenContent).not.toMatch(/---#/);
    });

    it('should format empty arrays as []', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
labels: []
dependencies: []
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('labels: []');
      expect(writtenContent).toContain('dependencies: []');
    });
  });
  describe('Edge Cases: YAML Serialization', () => {
    it('should handle empty arrays properly', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
labels: []
assignee: []
dependencies: []
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;

      expect(frontmatter.labels).toEqual([]);
      expect(frontmatter.assignee).toEqual([]);
    });

    it('should handle special characters in string fields', async () => {
      const content = `---
id: TASK-1
title: "Test: with special chars (urgent!) & more"
status: To Do
milestone: "v1.0-beta.1"
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // Should preserve the special characters
      expect(writtenContent).toContain('Test: with special chars (urgent!) & more');
      expect(writtenContent).toContain('v1.0-beta.1');
    });
  });
});
