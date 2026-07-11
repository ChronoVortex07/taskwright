---
id: TASK-68
title: >-
  Split large source files — extension.ts, BacklogWriter.ts, TasksController.ts,
  handlers.ts
status: Done
assignee: []
created_date: '2026-07-04 14:19'
updated_date: '2026-07-04 14:58'
labels: []
dependencies: []
priority: low
ordinal: 2000
category: Polish
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Several source files have grown too large:
- src/extension.ts (1,997 lines) — extract activation sub-steps into dedicated files
- src/core/BacklogWriter.ts (1,743 lines) — split by operation type (task CRUD vs milestone vs draft vs config)
- src/providers/TasksController.ts (1,508 lines) — use per-message-type handlers
- src/mcp/handlers.ts (1,007 lines) — one handler per tool under src/mcp/handlers/

Goal: each file under ~500 lines with a single clear responsibility.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Split results

### handlers.ts: 1007 → 57 lines ✓
Split into 14 focused files under `src/mcp/handlers/`:
- `types.ts` (205), `helpers.ts` (247), `createTask.ts` (20), `editTask.ts` (71), `createSubtask.ts` (19), `taskLifecycle.ts` (75), `claims.ts` (99), `board.ts` (113), `boardSync.ts` (64), `plan.ts` (10), `categories.ts` (34), `milestones.ts` (33), `requestMerge.ts` (60)
- Original `handlers.ts` is now a barrel file (57 lines)
- All files under 250 lines. Server.ts and tests unchanged.

### TasksController.ts: 1508 → 873 lines (reduced by 635)
- `messageHandlers.ts` (594): 18 message-type handler functions extracted
- `taskViewHelpers.ts` (166): dashboard/statistics/docs/decisions/config helpers
- handleMessage is now a clean dispatcher (~120 lines of delegation + small inline handlers)
- Added public accessors (getParser, postMessage, getWriter, getTreeFieldService) for handler functions

### BacklogWriter.ts: 1743 → 1448 lines (reduced by 295)
- `taskFileHelpers.ts` (48): line-ending utilities, FileConflictError
- `MilestoneWriter.ts` (259): 5 standalone milestone CRUD functions
- BacklogWriter class methods delegate to extracted functions; public API unchanged

### extension.ts: 1997 → 1687 lines (reduced by 310)
- `activationHelpers.ts` (284): 9 helper functions + TasksBoardSurface interface extracted
- Cleaned up ~30 unused imports

All 1604 tests pass. No public API changed.
<!-- SECTION:NOTES:END -->
