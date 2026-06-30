---
id: TASK-11
title: Polish the Taskwright MCP task-CRUD tools
status: To Do
assignee: []
created_date: '2026-06-30 12:59'
labels:
  - mcp
  - polish
dependencies: []
priority: low
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up polish for the native MCP task CRUD tools (TASK-8), surfaced by the final whole-branch review. None are correctness bugs; all are minor coverage or cosmetic items deferred so the feature could merge.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 assertValidPriority is case-insensitive like assertValidStatus, or the asymmetry is documented
- [ ] #2 A test pins renderChecklist text trimming
- [ ] #3 edit_task definitionOfDone is verified (echo DoD in TaskSummary, or assert the write by reading the file back)
- [ ] #4 The restore test asserts the file is not under /archive/, and archive_task and restore_task have not-found tests
- [ ] #5 promote_draft and demote_task tool descriptions document their return shape
- [ ] #6 create_subtask has a handler-level test for the no-opts (Untitled) path
- [ ] #7 Consider wrapping the four read tools (get_active_task, claim_task, release_task, attach_plan) in the runTool error envelope for a uniform isError contract
<!-- AC:END -->
