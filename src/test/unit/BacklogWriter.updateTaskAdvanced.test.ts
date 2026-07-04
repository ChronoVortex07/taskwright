import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BacklogWriter } from '../../core/BacklogWriter';
import { BacklogParser } from '../../core/BacklogParser';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { posixPath } from '../helpers/paths';

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

  describe('cache invalidation', () => {
    it('should invalidate cache after updateTask', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      const invalidateSpy = vi.spyOn(mockParser, 'invalidateTaskCache');

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      expect(invalidateSpy).toHaveBeenCalledWith(expect.stringContaining('task-1.md'));
    });

    it('should invalidate cache after deleteTask', async () => {
      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-1',
        title: 'Test',
        status: 'Done',
        filePath: '/fake/backlog/tasks/task-1.md',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      const invalidateSpy = vi.spyOn(mockParser, 'invalidateTaskCache');

      await writer.deleteTask('TASK-1', mockParser);

      expect(invalidateSpy).toHaveBeenCalledWith('/fake/backlog/tasks/task-1.md');
    });

    it('should invalidate cache for both old and new paths after completeTask', async () => {
      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-1',
        title: 'Test',
        status: 'Done',
        filePath: '/fake/backlog/tasks/task-1.md',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      const invalidateSpy = vi.spyOn(mockParser, 'invalidateTaskCache');

      await writer.completeTask('TASK-1', mockParser);

      expect(invalidateSpy).toHaveBeenCalledWith(posixPath('/fake/backlog/tasks/task-1.md'));
      expect(invalidateSpy).toHaveBeenCalledWith(posixPath('/fake/backlog/completed/task-1.md'));
    });

    it('should invalidate cache for both old and new paths after promoteDraft', async () => {
      mockReaddirSync([]);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'DRAFT-1',
        title: 'My Draft',
        status: 'Draft',
        folder: 'drafts',
        filePath: '/fake/backlog/drafts/draft-1 - My-Draft.md',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      vi.spyOn(mockParser, 'getConfig').mockResolvedValue({});

      vi.mocked(fs.readFileSync).mockReturnValue(`---
id: DRAFT-1
title: My Draft
status: Draft
---
`);

      const invalidateSpy = vi.spyOn(mockParser, 'invalidateTaskCache');

      await writer.promoteDraft('DRAFT-1', mockParser);

      expect(invalidateSpy).toHaveBeenCalledWith(
        posixPath('/fake/backlog/drafts/draft-1 - My-Draft.md')
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        posixPath('/fake/backlog/tasks/task-1 - My-Draft.md')
      );
    });

    it('should invalidate cache after toggleChecklistItem', async () => {
      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'TASK-1',
        title: 'Test',
        status: 'To Do',
        filePath: '/fake/backlog/tasks/task-1.md',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [{ id: 1, text: 'Test criterion', checked: false }],
        definitionOfDone: [],
      });

      vi.mocked(fs.readFileSync).mockReturnValue(`---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria
- [ ] #1 Test criterion
`);

      const invalidateSpy = vi.spyOn(mockParser, 'invalidateTaskCache');

      await writer.toggleChecklistItem('TASK-1', 'acceptanceCriteria', 1, mockParser);

      expect(invalidateSpy).toHaveBeenCalledWith('/fake/backlog/tasks/task-1.md');
    });
  });
  describe('updateTask: checklist text updates', () => {
    it('should update acceptance criteria content between markers', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Old criterion
- [x] #2 Old done criterion
<!-- AC:END -->
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask(
        'TASK-1',
        {
          acceptanceCriteria: '- [ ] #1 New first\n- [ ] #2 New second\n- [ ] #3 Added third',
        } as never,
        mockParser
      );

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('<!-- AC:BEGIN -->');
      expect(writtenContent).toContain('- [ ] #1 New first');
      expect(writtenContent).toContain('- [ ] #2 New second');
      expect(writtenContent).toContain('- [ ] #3 Added third');
      expect(writtenContent).toContain('<!-- AC:END -->');
      expect(writtenContent).not.toContain('Old criterion');
    });

    it('should update definition of done content between markers', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Old DoD item
<!-- DOD:END -->
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask(
        'TASK-1',
        { definitionOfDone: '- [x] #1 Code reviewed\n- [ ] #2 Tests pass' } as never,
        mockParser
      );

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('<!-- DOD:BEGIN -->');
      expect(writtenContent).toContain('- [x] #1 Code reviewed');
      expect(writtenContent).toContain('- [ ] #2 Tests pass');
      expect(writtenContent).toContain('<!-- DOD:END -->');
      expect(writtenContent).not.toContain('Old DoD item');
    });

    it('should add AC section with markers when none exists', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

Some description
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask(
        'TASK-1',
        { acceptanceCriteria: '- [ ] #1 New criterion' } as never,
        mockParser
      );

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('## Acceptance Criteria');
      expect(writtenContent).toContain('<!-- AC:BEGIN -->');
      expect(writtenContent).toContain('- [ ] #1 New criterion');
      expect(writtenContent).toContain('<!-- AC:END -->');
    });

    it('should add markers to existing AC section header without markers', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Acceptance Criteria

- [ ] #1 Old item without markers

## Definition of Done
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask(
        'TASK-1',
        { acceptanceCriteria: '- [ ] #1 Updated item' } as never,
        mockParser
      );

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('<!-- AC:BEGIN -->');
      expect(writtenContent).toContain('- [ ] #1 Updated item');
      expect(writtenContent).toContain('<!-- AC:END -->');
      expect(writtenContent).toContain('## Definition of Done');
    });
  });
  describe('updateTask: reporter field', () => {
    it('should update reporter field', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { reporter: '@new-reporter' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.reporter).toBe('@new-reporter');
    });

    it('should preserve existing reporter when updating other fields', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
reporter: "@original-reporter"
---
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.reporter).toBe('@original-reporter');
    });
  });
  describe('updateTask structured sections', () => {
    it('should update implementationPlan between existing SECTION:PLAN markers', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Old plan content
<!-- SECTION:PLAN:END -->
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { implementationPlan: 'New plan content' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('<!-- SECTION:PLAN:BEGIN -->');
      expect(writtenContent).toContain('New plan content');
      expect(writtenContent).toContain('<!-- SECTION:PLAN:END -->');
      expect(writtenContent).not.toContain('Old plan content');
    });

    it('should add SECTION:PLAN markers when ## Implementation Plan header exists but markers do not', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Implementation Plan

Existing plan text without markers

## Acceptance Criteria
- [ ] #1 First criterion
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { implementationPlan: 'New plan content' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('<!-- SECTION:PLAN:BEGIN -->');
      expect(writtenContent).toContain('New plan content');
      expect(writtenContent).toContain('<!-- SECTION:PLAN:END -->');
      expect(writtenContent).toContain('## Acceptance Criteria');
    });

    it('should create new ## Implementation Plan section when nothing exists', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

Some description
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { implementationPlan: 'Brand new plan' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('## Implementation Plan');
      expect(writtenContent).toContain('<!-- SECTION:PLAN:BEGIN -->');
      expect(writtenContent).toContain('Brand new plan');
      expect(writtenContent).toContain('<!-- SECTION:PLAN:END -->');
    });

    it('should update implementationNotes between existing SECTION:NOTES markers', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Old notes
<!-- SECTION:NOTES:END -->
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { implementationNotes: 'Updated notes' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('<!-- SECTION:NOTES:BEGIN -->');
      expect(writtenContent).toContain('Updated notes');
      expect(writtenContent).toContain('<!-- SECTION:NOTES:END -->');
      expect(writtenContent).not.toContain('Old notes');
    });

    it('should create new ## Implementation Notes section when nothing exists', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

Some description
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { implementationNotes: 'Brand new notes' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('## Implementation Notes');
      expect(writtenContent).toContain('<!-- SECTION:NOTES:BEGIN -->');
      expect(writtenContent).toContain('Brand new notes');
      expect(writtenContent).toContain('<!-- SECTION:NOTES:END -->');
    });

    it('should update finalSummary between existing SECTION:FINAL_SUMMARY markers', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Old summary
<!-- SECTION:FINAL_SUMMARY:END -->
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { finalSummary: 'Updated summary' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('<!-- SECTION:FINAL_SUMMARY:BEGIN -->');
      expect(writtenContent).toContain('Updated summary');
      expect(writtenContent).toContain('<!-- SECTION:FINAL_SUMMARY:END -->');
      expect(writtenContent).not.toContain('Old summary');
    });

    it('should create new ## Final Summary section when nothing exists', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Description

Some description
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { finalSummary: 'Brand new summary' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('## Final Summary');
      expect(writtenContent).toContain('<!-- SECTION:FINAL_SUMMARY:BEGIN -->');
      expect(writtenContent).toContain('Brand new summary');
      expect(writtenContent).toContain('<!-- SECTION:FINAL_SUMMARY:END -->');
    });

    it('should handle ## Notes header variant (legacy)', async () => {
      const content = `---
id: TASK-1
title: Test
status: To Do
---

## Notes

Some legacy notes without markers

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Summary
<!-- SECTION:FINAL_SUMMARY:END -->
`;
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask(
        'TASK-1',
        { implementationNotes: 'Updated legacy notes' },
        mockParser
      );

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('<!-- SECTION:NOTES:BEGIN -->');
      expect(writtenContent).toContain('Updated legacy notes');
      expect(writtenContent).toContain('<!-- SECTION:NOTES:END -->');
      expect(writtenContent).toContain('## Final Summary');
    });
  });
});
