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
  describe('New Fields: references, documentation, type, plan', () => {
    it('should parse references array from frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test with references
status: To Do
references:
  - https://github.com/org/repo/issues/123
  - docs/design.md
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.references).toEqual([
        'https://github.com/org/repo/issues/123',
        'docs/design.md',
      ]);
    });

    it('should parse documentation array from frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test with documentation
status: To Do
documentation:
  - https://docs.example.com/api
  - README.md
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.documentation).toEqual(['https://docs.example.com/api', 'README.md']);
    });

    it('should parse type field from frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test with type
status: To Do
type: feature
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.type).toBe('feature');
    });

    it('should parse ## Plan section content', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test with plan
status: To Do
---

## Plan

1. First step
2. Second step
3. Third step

## Acceptance Criteria

- [ ] #1 Test
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.implementationPlan).toBe('1. First step\n2. Second step\n3. Third step');
    });

    it('should parse ## Implementation Plan section as plan', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test with implementation plan
status: To Do
---

## Implementation Plan

- Step A
- Step B

## Description

Some description
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.implementationPlan).toBe('- Step A\n- Step B');
    });

    it('should preserve markdown headings inside structured section markers', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test headings in plan
status: To Do
---

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. First step
2. Second step

## Some heading inside plan

More content here
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Note text

## Subheading in notes

More notes
<!-- SECTION:NOTES:END -->
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.implementationPlan).toBe(
        '1. First step\n2. Second step\n\n## Some heading inside plan\n\nMore content here'
      );
      expect(task?.implementationNotes).toBe('Note text\n\n## Subheading in notes\n\nMore notes');
    });

    it('should handle missing new fields gracefully', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Minimal task
status: To Do
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.references).toBeUndefined();
      expect(task?.documentation).toBeUndefined();
      expect(task?.type).toBeUndefined();
      expect(task?.implementationPlan).toBeUndefined();
    });

    it('should handle references as single string', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
references: https://example.com/single
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.references).toEqual(['https://example.com/single']);
    });

    it('should handle documentation as single string', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
documentation: docs/README.md
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.documentation).toEqual(['docs/README.md']);
    });

    it('should not confuse ## Plan with ## Implementation Notes', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Plan

This is the plan content.

## Implementation Notes

These are implementation notes.
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.implementationPlan).toBe('This is the plan content.');
      expect(task?.implementationNotes).toBe('These are implementation notes.');
    });
  });

  describe('Edge Cases: Section Parsing', () => {
    it('should handle description without markers', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

This is a plain description without markers.

## Acceptance Criteria

- [ ] #1 Test
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.description).toBe('This is a plain description without markers.');
    });

    it('should handle nested markdown in description', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
### Subsection

- List item 1
- List item 2

\`\`\`javascript
const code = "example";
\`\`\`
<!-- SECTION:DESCRIPTION:END -->
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.description).toContain('### Subsection');
      expect(task?.description).toContain('- List item 1');
      expect(task?.description).toContain('const code = "example"');
    });

    it('should handle title extracted from heading when not in frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
status: To Do
---

# TASK-1 - My Task Title From Heading

## Description

Some content
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.title).toBe('My Task Title From Heading');
    });
  });

  describe('blank line preservation', () => {
    it('should preserve blank lines between paragraphs in description with markers', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
First paragraph.

Second paragraph.

Third paragraph.
<!-- SECTION:DESCRIPTION:END -->
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.description).toBe('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
    });

    it('should preserve blank lines between paragraphs in description without markers', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

First paragraph.

Second paragraph.

## Acceptance Criteria
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.description).toBe('First paragraph.\n\nSecond paragraph.');
    });

    it('should preserve blank lines in implementation notes', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Implementation Notes

First note.

Second note.
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.implementationNotes).toBe('First note.\n\nSecond note.');
    });

    it('should preserve blank lines in plan', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Implementation Plan

Step 1.

Step 2.
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.implementationPlan).toBe('Step 1.\n\nStep 2.');
    });

    it('should preserve blank lines in final summary', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Final Summary

Para one.

Para two.
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.finalSummary).toBe('Para one.\n\nPara two.');
    });

    it('should not start collecting blank lines before first content line', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Actual content starts here.
<!-- SECTION:DESCRIPTION:END -->
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.description).toBe('Actual content starts here.');
    });

    describe('category / caused_by parsing (tech-tree P1)', () => {
      it('parses category and caused_by from frontmatter', () => {
        const parser = new BacklogParser('/fake/path');
        const md = `---
id: TASK-1
title: A task
status: To Do
assignee: []
dependencies: []
category: Backend
type: bug
caused_by: TASK-9
---

## Description

Body.
`;
        const task = parser.parseTaskContent(md, '/fake/path/tasks/task-1 - A-task.md');
        expect(task?.category).toBe('Backend');
        expect(task?.type).toBe('bug');
        expect(task?.causedBy).toBe('TASK-9');
      });

      it('leaves category/causedBy undefined when absent', () => {
        const parser = new BacklogParser('/fake/path');
        const md = `---
id: TASK-2
title: B task
status: To Do
assignee: []
dependencies: []
---

## Description

Body.
`;
        const task = parser.parseTaskContent(md, '/fake/path/tasks/task-2 - B-task.md');
        expect(task?.category).toBeUndefined();
        expect(task?.causedBy).toBeUndefined();
      });
    });
  });
  describe('Parent-child task parsing', () => {
    it('should parse parent_task_id from frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-2.1
title: Subtask
status: To Do
parent_task_id: TASK-2
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-2.1.md');
      expect(task?.parentTaskId).toBe('TASK-2');
    });

    it('should parse parent field as alias for parent_task_id', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-3.1
title: Subtask with parent alias
status: To Do
parent: TASK-3
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-3.1.md');
      expect(task?.parentTaskId).toBe('TASK-3');
    });

    it('should parse subtasks array from frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-2
title: Parent Task
status: In Progress
subtasks: [TASK-2.1, TASK-2.2]
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-2.md');
      expect(task?.subtasks).toEqual(['TASK-2.1', 'TASK-2.2']);
    });

    it('should parse subtasks as multi-line array', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-2
title: Parent Task
status: In Progress
subtasks:
  - TASK-2.1
  - TASK-2.2
  - TASK-2.3
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-2.md');
      expect(task?.subtasks).toEqual(['TASK-2.1', 'TASK-2.2', 'TASK-2.3']);
    });

    it('should handle subtasks as single string', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-2
title: Parent Task
status: In Progress
subtasks: TASK-2.1
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-2.md');
      expect(task?.subtasks).toEqual(['TASK-2.1']);
    });

    it('should not have subtasks when field is absent', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: TASK-1
title: Regular Task
status: To Do
---
`;
      const task = parser.parseTaskContent(content, '/fake/path/task-1.md');
      expect(task?.subtasks).toBeUndefined();
    });
  });
});
