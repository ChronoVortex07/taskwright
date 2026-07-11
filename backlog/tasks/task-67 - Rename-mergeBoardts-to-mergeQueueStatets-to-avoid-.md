---
id: TASK-67
title: >-
  Rename mergeBoard.ts to mergeQueueState.ts to avoid confusion with
  boardMerge.ts
status: Done
assignee: []
created_date: '2026-07-04 14:19'
updated_date: '2026-07-04 14:41'
labels: []
dependencies: []
priority: low
category: Polish
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two files have deceptively similar names: src/core/mergeBoard.ts (derives merge-queue state for the board UI, 957 B) and src/core/boardMerge.ts (union-merges per-file board data during sync push/pull, 7.2 KB). Rename mergeBoard.ts to mergeQueueState.ts and update all imports.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Renamed src/core/mergeBoard.ts → src/core/mergeQueueState.ts via git mv.

Updated 4 import/export sites:
- src/core/types.ts (import + re-export)
- src/providers/TaskDetailProvider.ts (import)
- src/providers/TasksController.ts (import)
- src/test/unit/mergeBoard.test.ts (import)

All tests pass (1604/1604), typecheck clean, lint clean.
<!-- SECTION:NOTES:END -->
