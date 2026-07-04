import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BacklogWriter } from '../../core/BacklogWriter';
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

  describe('Round-trip: parse -> write -> parse preserves fields', () => {
    /**
     * Helper that simulates a round-trip:
     * 1. Parse original content with BacklogParser
     * 2. Write via BacklogWriter.updateTask (making a trivial status change)
     * 3. Parse the written content again
     * 4. Return both parsed tasks for comparison
     */
    async function roundTrip(originalContent: string) {
      const parser = new BacklogParser('/fake/backlog');

      // Step 1: parse original
      const originalTask = parser.parseTaskContent(
        originalContent,
        '/fake/backlog/tasks/task-1.md'
      );
      expect(originalTask).toBeDefined();

      // Step 2: write via updateTask
      vi.mocked(fs.readFileSync).mockReturnValue(originalContent);
      mockReaddirSync(['task-1.md']);
      await writer.updateTask('TASK-1', { status: originalTask!.status }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;

      // Step 3: parse written content
      const roundTrippedTask = parser.parseTaskContent(
        writtenContent,
        '/fake/backlog/tasks/task-1.md'
      );
      expect(roundTrippedTask).toBeDefined();

      return { original: originalTask!, roundTripped: roundTrippedTask!, writtenContent };
    }

    it('should preserve assignee array with @-prefixed values', async () => {
      const content = `---
id: TASK-1
title: Assignee Test
status: To Do
assignee: ["@alice", "@bob"]
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.assignee).toEqual(original.assignee);
      expect(roundTripped.assignee).toEqual(['@alice', '@bob']);
    });

    it('should preserve single assignee as array', async () => {
      const content = `---
id: TASK-1
title: Single Assignee
status: To Do
assignee: "@charlie"
---
`;
      const { roundTripped } = await roundTrip(content);
      expect(roundTripped.assignee).toEqual(['@charlie']);
    });

    it('should preserve references array', async () => {
      const content = `---
id: TASK-1
title: References Test
status: To Do
references: ["https://github.com/org/repo/issues/42", "docs/spec.md"]
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.references).toEqual(original.references);
    });

    it('should preserve documentation array', async () => {
      const content = `---
id: TASK-1
title: Documentation Test
status: To Do
documentation: ["https://docs.example.com/api", "README.md"]
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.documentation).toEqual(original.documentation);
    });

    it('should preserve type field', async () => {
      const content = `---
id: TASK-1
title: Type Test
status: To Do
type: feature
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.type).toBe(original.type);
      expect(roundTripped.type).toBe('feature');
    });

    it('should preserve milestone field', async () => {
      const content = `---
id: TASK-1
title: Milestone Test
status: To Do
milestone: v2.0
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.milestone).toBe(original.milestone);
      expect(roundTripped.milestone).toBe('v2.0');
    });

    it('should preserve ordinal field', async () => {
      const content = `---
id: TASK-1
title: Ordinal Test
status: To Do
ordinal: 42.5
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.ordinal).toBe(original.ordinal);
      expect(roundTripped.ordinal).toBe(42.5);
    });

    it('should preserve subtasks array', async () => {
      const content = `---
id: TASK-1
title: Parent with Subtasks
status: In Progress
subtasks: [TASK-1.1, TASK-1.2, TASK-1.3]
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.subtasks).toEqual(original.subtasks);
      expect(roundTripped.subtasks).toEqual(['TASK-1.1', 'TASK-1.2', 'TASK-1.3']);
    });

    it('should preserve parent_task_id field', async () => {
      const content = `---
id: TASK-1
title: Subtask
status: To Do
parent_task_id: TASK-5
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.parentTaskId).toBe(original.parentTaskId);
      expect(roundTripped.parentTaskId).toBe('TASK-5');
    });

    it('should preserve created_date field', async () => {
      const content = `---
id: TASK-1
title: Date Test
status: To Do
created_date: 2026-01-15
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.createdAt).toBe(original.createdAt);
      expect(roundTripped.createdAt).toBe('2026-01-15');
    });

    it('should preserve updated_date field', async () => {
      const content = `---
id: TASK-1
title: Updated Date Test
status: To Do
created_date: 2026-01-15
updated_date: 2026-01-20
---
`;
      // Note: updateTask always sets updated_date to today, so we check
      // that it survives as a valid date string
      const { roundTripped } = await roundTrip(content);
      expect(roundTripped.updatedAt).toBeDefined();
      expect(roundTripped.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('should preserve reporter field', async () => {
      const content = `---
id: TASK-1
title: Reporter Test
status: To Do
reporter: "@pm-lead"
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.reporter).toBe(original.reporter);
      expect(roundTripped.reporter).toBe('@pm-lead');
    });

    it('should preserve labels array', async () => {
      const content = `---
id: TASK-1
title: Labels Test
status: To Do
labels: [bug, urgent, "feature/new-ui"]
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.labels).toEqual(original.labels);
    });

    it('should preserve dependencies array', async () => {
      const content = `---
id: TASK-1
title: Dependencies Test
status: To Do
dependencies: [TASK-2, TASK-3]
---
`;
      const { original, roundTripped } = await roundTrip(content);
      expect(roundTripped.dependencies).toEqual(original.dependencies);
    });

    it('should preserve dollar-sign numeric strings through parse-write-parse round-trip', async () => {
      const content = `---
id: TASK-1
title: "Budget increase to $15,000 approved"
status: To Do
---
`;
      const { roundTripped } = await roundTrip(content);
      expect(roundTripped.title).toBe('Budget increase to $15,000 approved');
    });

    it('should preserve all fields together on round-trip', async () => {
      const content = `---
id: TASK-1
title: Full Field Test
status: In Progress
priority: high
milestone: v2.0
labels: [bug, critical]
assignee: ["@alice", "@bob"]
reporter: "@pm"
created_date: 2026-01-10
updated_date: 2026-01-15
dependencies: [TASK-2]
references: ["https://github.com/issue/1"]
documentation: ["docs/design.md"]
parent_task_id: TASK-0
subtasks: [TASK-1.1, TASK-1.2]
ordinal: 3.5
type: feature
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Full test description
<!-- SECTION:DESCRIPTION:END -->
`;
      const { original, roundTripped } = await roundTrip(content);

      expect(roundTripped.id).toBe(original.id);
      expect(roundTripped.title).toBe(original.title);
      expect(roundTripped.status).toBe(original.status);
      expect(roundTripped.priority).toBe(original.priority);
      expect(roundTripped.milestone).toBe(original.milestone);
      expect(roundTripped.labels).toEqual(original.labels);
      expect(roundTripped.assignee).toEqual(original.assignee);
      expect(roundTripped.reporter).toBe(original.reporter);
      expect(roundTripped.createdAt).toBe(original.createdAt);
      expect(roundTripped.dependencies).toEqual(original.dependencies);
      expect(roundTripped.references).toEqual(original.references);
      expect(roundTripped.documentation).toEqual(original.documentation);
      expect(roundTripped.parentTaskId).toBe(original.parentTaskId);
      expect(roundTripped.subtasks).toEqual(original.subtasks);
      expect(roundTripped.ordinal).toBe(original.ordinal);
      expect(roundTripped.type).toBe(original.type);
      expect(roundTripped.description).toBe(original.description);
    });

    it('should preserve always-emitted empty arrays and drop optional ones on round-trip', async () => {
      const content = `---
id: TASK-1
title: Empty Arrays Test
status: To Do
labels: []
assignee: []
dependencies: []
references: []
documentation: []
---
`;
      const { roundTripped } = await roundTrip(content);
      // Canonical format always emits labels, assignee, dependencies â€” even when empty.
      expect(roundTripped.labels).toEqual([]);
      expect(roundTripped.assignee).toEqual([]);
      expect(roundTripped.dependencies).toEqual([]);
      // Optional arrays (references, documentation) are omitted when empty to
      // match upstream's "only emit when non-empty" behaviour.
      expect(roundTripped.references).toBeUndefined();
      expect(roundTripped.documentation).toBeUndefined();
    });

    it('should preserve body sections on round-trip', async () => {
      const content = `---
id: TASK-1
title: Body Sections Test
status: To Do
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The description content.
<!-- SECTION:DESCRIPTION:END -->

## Plan

1. Step one
2. Step two

## Implementation Notes

Some notes here.

## Final Summary

Summary text.

## Acceptance Criteria

- [ ] #1 First criterion
- [x] #2 Second criterion done

## Definition of Done

- [ ] #1 Code reviewed
- [x] #2 Tests passing
`;
      const { original, roundTripped } = await roundTrip(content);

      expect(roundTripped.description).toBe(original.description);
      expect(roundTripped.implementationPlan).toBe(original.implementationPlan);
      expect(roundTripped.implementationNotes).toBe(original.implementationNotes);
      expect(roundTripped.finalSummary).toBe(original.finalSummary);
      expect(roundTripped.acceptanceCriteria).toEqual(original.acceptanceCriteria);
      expect(roundTripped.definitionOfDone).toEqual(original.definitionOfDone);
    });
  });
  describe('Canonical byte-for-byte round-trip (TASK-155)', () => {
    /**
     * Freeze Date.now so updated_date auto-bumping in updateTask matches the
     * date embedded in the CLI fixture, letting us assert zero diff.
     */
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should round-trip a CLI-produced task file with zero diff', async () => {
      // Canonical backlog.md CLI output: single-quoted dates, block-style
      // arrays, canonical field order, blank line between frontmatter and body.
      const cliProduced = `---
id: TASK-10
title: Example task
status: In Progress
assignee:
  - '@alice'
created_date: '2026-02-09 10:00'
updated_date: '2026-02-10 12:00'
labels:
  - parser
  - upstream
dependencies:
  - TASK-5
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Canonical example.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 First criterion
<!-- AC:END -->
`;

      vi.mocked(fs.readFileSync).mockReturnValue(cliProduced);
      mockReaddirSync(['task-10.md']);

      // No-op update: write the file back with no field changes.
      await writer.updateTask('TASK-10', {}, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toBe(cliProduced);
    });

    it('should omit optional empty fields just like the CLI does', async () => {
      // Minimal CLI-produced file â€” no references, documentation, reporter,
      // milestone, parent_task_id, subtasks, ordinal, or onStatusChange.
      const cliProduced = `---
id: TASK-11
title: Minimal task
status: To Do
assignee: []
created_date: '2026-02-10 12:00'
updated_date: '2026-02-10 12:00'
labels: []
dependencies: []
---

## Description

Body.
`;

      vi.mocked(fs.readFileSync).mockReturnValue(cliProduced);
      mockReaddirSync(['task-11.md']);

      await writer.updateTask('TASK-11', {}, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toBe(cliProduced);
    });

    it('should write a decision in upstream order (id, title, date, status) with no blank line after frontmatter', async () => {
      // Upstream serializeDecision emits id, title, date, status and does NOT
      // apply the blank-line-after-frontmatter regex.
      const cliProduced = `---
id: DECISION-001
title: Use TypeScript
date: '2026-02-10 12:00'
status: proposed
---
## Context

We need type safety.

## Decision

Adopt TypeScript.

## Consequences

Steeper learning curve.

## Alternatives

`;

      vi.spyOn(mockParser, 'getDecision').mockResolvedValue({
        id: 'DECISION-001',
        title: 'Use TypeScript',
        filePath: '/fake/backlog/decisions/decision-001 - Use-TypeScript.md',
      });
      vi.mocked(fs.readFileSync).mockReturnValue(cliProduced);

      // No-op update to trigger a reserialize pass.
      await writer.updateDecision('DECISION-001', {}, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toBe(cliProduced);
    });

    it('should write a document in upstream order (id, title, type, created_date, ...) with no blank line after frontmatter', async () => {
      // Upstream serializeDocument emits id, title, type, created_date,
      // updated_date?, tags? and does NOT apply the blank-line regex.
      const cliProduced = `---
id: DOC-001
title: API Guide
type: guide
created_date: '2026-02-09 10:00'
updated_date: '2026-02-10 12:00'
tags:
  - api
---
Document body.
`;

      vi.spyOn(mockParser, 'getDocument').mockResolvedValue({
        id: 'DOC-001',
        title: 'API Guide',
        type: 'guide',
        tags: ['api'],
        content: 'Document body.',
        filePath: '/fake/backlog/docs/doc-001 - API-Guide.md',
      });
      vi.mocked(fs.readFileSync).mockReturnValue(cliProduced);

      // updateDocument always bumps updated_date; the frozen clock matches the
      // fixture value so the file round-trips with zero diff.
      await writer.updateDocument('DOC-001', {}, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toBe(cliProduced);
    });
  });
});
