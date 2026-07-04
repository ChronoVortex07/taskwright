import { describe, it, expect, vi } from 'vitest';
import { BacklogParser } from '../../core/BacklogParser';

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
  describe('Edge Cases: Empty/Malformed Files', () => {
    it('should return undefined for empty file', () => {
      const parser = new BacklogParser('/fake/path');
      const task = parser.parseTaskContent('', '/fake/path/task-1.md');
      expect(task).toBeUndefined();
    });

    it('should return undefined for file with only whitespace', () => {
      const parser = new BacklogParser('/fake/path');
      const task = parser.parseTaskContent('   \n\n  \t  \n', '/fake/path/task-1.md');
      expect(task).toBeUndefined();
    });

    it('should return undefined for file with empty frontmatter (---\\n---)', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      // No title, so should be undefined
      expect(task).toBeUndefined();
    });

    it('should handle frontmatter with missing closing delimiter gracefully', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Missing closing delimiter
status: To Do
`;
      // Parser should handle this gracefully - it may try to parse the whole file as frontmatter
      // Behavior depends on implementation - either finds title or returns undefined
      // The important thing is it doesn't crash
      expect(() => parser.parseTaskContent(content, '/fake/path/task-1.md')).not.toThrow();
    });

    it('should handle malformed YAML in frontmatter gracefully', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: [unclosed bracket
labels: {bad: yaml:
---

# Task Title
`;
      // Should not throw, should fall back to extracting ID from filename
      expect(() => parser.parseTaskContent(content, '/fake/path/task-1.md')).not.toThrow();
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      // Should at least extract ID from filename and title from heading
      expect(task?.id).toBe('TASK-1');
    });

    it('should handle unquoted @-prefixed reporter value', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: BACK-91
title: 'Fix Windows issues: empty task list'
status: Done
reporter: @MrLesk
assignee: @MrLesk
created_date: '2025-06-19'
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/back-91.md');
      expect(task).toBeDefined();
      expect(task?.title).toBe('Fix Windows issues: empty task list');
      expect(task?.reporter).toBe('@MrLesk');
      expect(task?.assignee).toEqual(['@MrLesk']);
    });

    it('should handle unquoted @-prefixed values in inline arrays', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Team task
status: To Do
assignee: [@alice, @bob]
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task).toBeDefined();
      expect(task?.assignee).toEqual(['@alice', '@bob']);
    });

    it('should not double-quote already-quoted @-prefixed values', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Already quoted
status: To Do
reporter: '@quoted'
assignee: ["@alice", '@bob']
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task).toBeDefined();
      expect(task?.reporter).toBe('@quoted');
      expect(task?.assignee).toEqual(['@alice', '@bob']);
    });

    it('should parse Taskwright claim fields from frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Claimed task
status: In Progress
claimed_by: '@alice'
worktree: feature/login
claimed_at: '2026-06-30 14:05'
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task).toBeDefined();
      expect(task?.claimedBy).toBe('@alice');
      expect(task?.worktree).toBe('feature/login');
      expect(task?.claimedAt).toBe('2026-06-30 14:05');
    });

    it('should leave claim fields undefined when absent', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Unclaimed task
status: To Do
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task).toBeDefined();
      expect(task?.claimedBy).toBeUndefined();
      expect(task?.worktree).toBeUndefined();
      expect(task?.claimedAt).toBeUndefined();
    });

    it('should handle file with only frontmatter delimiters and no content', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
---`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task).toBeUndefined();
    });
  });

  describe('Edge Cases: Unicode and Special Characters', () => {
    it('should parse task with emoji in title', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: "🚀 Feature launch with 🎉 celebration"
status: To Do
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.title).toBe('🚀 Feature launch with 🎉 celebration');
    });

    it('should parse task with multi-byte characters in description', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: International Task
status: To Do
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Café in München, 日本語テスト, Привет мир, مرحبا بالعالم
<!-- SECTION:DESCRIPTION:END -->
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.description).toContain('Café');
      expect(task?.description).toContain('München');
      expect(task?.description).toContain('日本語テスト');
    });

    it('should parse labels with special characters', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
labels:
  - "feature/new-ui"
  - "bug:critical"
  - "v2.0"
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.labels).toEqual(['feature/new-ui', 'bug:critical', 'v2.0']);
    });

    it('should handle description with special regex characters', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Regex Test
status: To Do
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Test regex chars: $100.00 ^start end$ *bold* [link](url) {braces} (parens) \\backslash
<!-- SECTION:DESCRIPTION:END -->
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.description).toContain('$100.00');
      expect(task?.description).toContain('^start');
      expect(task?.description).toContain('\\backslash');
    });

    it('should handle CRLF line endings', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---\r\nid: TASK-1\r\ntitle: CRLF Test\r\nstatus: To Do\r\n---\r\n\r\n## Description\r\n\r\n<!-- SECTION:DESCRIPTION:BEGIN -->\r\nWindows line endings\r\n<!-- SECTION:DESCRIPTION:END -->\r\n`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.title).toBe('CRLF Test');
    });
  });

  describe('Edge Cases: Checklist Parsing', () => {
    it('should handle malformed checklist item without space after bracket', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria

- [ ] #1 Valid item
- [x]#2 Missing space after bracket
- [ ]No id item
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      // Should at least parse the valid item
      expect(task?.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
      expect(task?.acceptanceCriteria[0].text).toBe('Valid item');
    });

    it('should parse checklist item with special characters in text', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria

- [ ] #1 Fix: bug #123 (urgent!) [link](url) @mention
- [x] #2 Test \`code\` and **bold**
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.acceptanceCriteria).toHaveLength(2);
      expect(task?.acceptanceCriteria[0].text).toBe('Fix: bug #123 (urgent!) [link](url) @mention');
      expect(task?.acceptanceCriteria[1].text).toContain('code');
    });

    it('should handle very long checklist item text', () => {
      const parser = new BacklogParser('/fake/path');
      const longText = 'A'.repeat(500);
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria

- [ ] #1 ${longText}
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.acceptanceCriteria[0].text).toBe(longText);
    });

    it('should parse checklist items without #id prefix', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria

- [ ] Item without id prefix
- [x] Another item without id
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.acceptanceCriteria).toHaveLength(2);
      expect(task?.acceptanceCriteria[0].text).toBe('Item without id prefix');
      expect(task?.acceptanceCriteria[1].checked).toBe(true);
    });

    it('should handle uppercase X in checkbox', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria

- [X] #1 Uppercase X checked
- [x] #2 Lowercase x checked
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.acceptanceCriteria[0].checked).toBe(true);
      expect(task?.acceptanceCriteria[1].checked).toBe(true);
    });

    it('should parse mixed acceptance criteria and definition of done', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria

- [ ] #1 AC item 1
- [x] #2 AC item 2

## Definition of Done

- [ ] #1 DoD item 1
- [x] #2 DoD item 2
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.acceptanceCriteria).toHaveLength(2);
      expect(task?.definitionOfDone).toHaveLength(2);
      expect(task?.acceptanceCriteria[0].text).toBe('AC item 1');
      expect(task?.definitionOfDone[0].text).toBe('DoD item 1');
    });
  });

  describe('Edge Cases: Field Type Validation', () => {
    it('should handle labels as single string instead of array', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
labels: "single-label"
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.labels).toEqual(['single-label']);
    });

    it('should handle labels: null gracefully', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
labels: null
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.labels).toEqual([]);
    });

    it('should handle empty string title', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: ""
status: To Do
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      // Empty title means task is invalid
      expect(task).toBeUndefined();
    });

    it('should handle very long title', () => {
      const parser = new BacklogParser('/fake/path');
      const longTitle = 'Very Long Task Title '.repeat(30);
      const content = `---
id: TASK-1
title: "${longTitle}"
status: To Do
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.title).toBe(longTitle);
    });

    it('should handle assignee as single string instead of array', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
assignee: single-person
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.assignee).toEqual(['single-person']);
    });

    it('should handle dependencies as single string instead of array', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
dependencies: TASK-2
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.dependencies).toEqual(['TASK-2']);
    });

    it('should parse numeric ID in frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: 123
title: Numeric ID
status: To Do
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-123.md');
      // ID should be converted to uppercase string
      expect(task?.id).toBe('123');
    });

    it('should handle status with unicode symbol prefix', () => {
      const parser = new BacklogParser('/fake/path');
      const testCases = [
        { status: '○ To Do', expected: 'To Do' },
        { status: '◒ In Progress', expected: 'In Progress' },
        { status: '● Done', expected: 'Done' },
      ];

      for (const { status, expected } of testCases) {
        const content = `---
id: TASK-1
title: Test
status: ${status}
---
`;
        const task = parser.parseTaskContent(content, '/fake/task-1.md');
        expect(task?.status).toBe(expected);
      }
    });
  });
});
