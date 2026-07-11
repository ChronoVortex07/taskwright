---
id: TASK-11
title: Polish the Taskwright MCP task-CRUD tools
status: Done
assignee: []
created_date: '2026-06-30 12:59'
updated_date: '2026-07-04 13:39'
labels:
  - mcp
  - polish
milestone: Agentic Board Core (Phases 1-5)
dependencies: []
priority: low
ordinal: 9000
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up polish for the native MCP task CRUD tools (TASK-8), surfaced by the final whole-branch review. None are correctness bugs; all are minor coverage or cosmetic items deferred so the feature could merge.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 assertValidPriority is case-insensitive like assertValidStatus, or the asymmetry is documented
- [x] #2 A test pins renderChecklist text trimming
- [x] #3 edit_task definitionOfDone is verified (echo DoD in TaskSummary, or assert the write by reading the file back)
- [x] #4 The restore test asserts the file is not under /archive/, and archive_task and restore_task have not-found tests
- [x] #5 promote_draft and demote_task tool descriptions document their return shape
- [x] #6 create_subtask has a handler-level test for the no-opts (Untitled) path
- [x] #7 Consider wrapping the four read tools (get_active_task, claim_task, release_task, attach_plan) in the runTool error envelope for a uniform isError contract
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC-3: Added `definitionOfDone?: ChecklistItem[]` to `TaskSummary` interface and `toSummary()` return. Test added in mcpWriteHandlers.test.ts (round-trip: write → re-read → summary echo) and toSummary.test.ts (surfaces DoD when present, negative control). Also confirmed `renderChecklist` text trimming already tested (AC-2 was pre-checked).

AC-4: Added `not.toMatch(/\/archive\//)` assertion to restore test. Added not-found tests for both archiveTaskHandler and restoreTaskHandler.

AC-5: Updated `promote_draft` and `demote_task` tool descriptions in server.ts to document they return the task summary.

AC-6: Added handler-level test for createSubtaskHandler with no title/opts, asserting default title "Untitled".

AC-7: Wrapped `get_active_task`, `claim_task`, `release_task`, and `attach_plan` in `runTool()` error envelope for a uniform `isError` contract. All write tools already used runTool; this makes the session-scoped read tools consistent.
<!-- SECTION:NOTES:END -->
