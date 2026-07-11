---
id: TASK-69
title: Split large test files by feature area
status: Done
assignee: []
created_date: '2026-07-04 14:19'
updated_date: '2026-07-04 14:59'
labels: []
dependencies: []
priority: low
ordinal: 1000
category: Polish
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Several test files are approaching or exceeding 2,000 lines:
- BacklogParser.test.ts (3,728 lines)
- BacklogWriter.test.ts (3,410 lines)
- TasksViewProvider.test.ts (1,726 lines)
- TaskDetailProvider.test.ts (1,681 lines)

Split by feature area for maintainability (e.g., BacklogParser.parseTask.test.ts, BacklogParser.parseConfig.test.ts, etc.).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Split 4 large test files (10,545 total lines) into 23 focused files by feature area:

- **BacklogParser.test.ts** (3,728 lines → 9 files): parseTask, taskEdgeCases, taskFields, config, configFields, multiFolder, documents, caching, aggregation
- **BacklogWriter.test.ts** (3,410 lines → 7 files): taskCrud, drafts, edgeCases, archiveRestore, roundTrip, updateTaskAdvanced, otherEntities
- **TasksViewProvider.test.ts** (1,726 lines → 4 files): viewMode, dashboard, messageHandling, crossBranchAndDeps
- **TaskDetailProvider.test.ts** (1,681 lines → 3 files): lifecycle, sendTaskData, messageHandling

All 1604 tests pass, lint clean, typecheck clean. Imports in each split file are minimal (only the dependencies actually used by that feature area).
<!-- SECTION:FINAL_SUMMARY:END -->
