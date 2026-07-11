---
id: TASK-65
title: Add sort controls to kanban board — by priority and by task number
status: Done
assignee: []
created_date: '2026-07-04 13:27'
updated_date: '2026-07-04 13:51'
labels:
  - feature
  - kanban
  - ui
dependencies: []
priority: medium
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The kanban board currently renders tasks in a fixed order (by ordinal / creation order). There is no way to reorder tasks within a status column for triage or review.

Add a sort control (dropdown or toggle) to the kanban header with at least these modes:
- **Default** — current ordering (ordinal, or as returned by the parser)
- **Priority** — high → medium → low (then by task number within same priority)
- **Task number** — numeric sort by TASK-N ID (ascending)

The sort should apply within each status column (and within each label group if TASK-6 swimlanes are active). Sort preference should persist at least for the session.

This is independent of TASK-6 (group-by-label swimlanes) — both touch the kanban view but operate on different axes (grouping vs ordering). They should compose gracefully when both are implemented.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation Notes

### Approach
Added sort controls to the kanban board toolbar as a segmented button group (matching the existing milestone grouping toggle pattern). Three sort modes: Default (ordinal-based, existing behavior), Priority (high→medium→low then by task number), and Task Number (ascending numeric ID).

### Files changed
- **`src/core/ordinalUtils.ts`**: Added `extractTaskNumber()`, `compareByPriority()`, `sortCardsByPriority()`, `compareByTaskNumber()`, `sortCardsByTaskNumber()` — pure sorting utilities working on CardData
- **`src/test/unit/ordinalUtils.test.ts`**: 17 new test cases covering extractTaskNumber (5), sortCardsByPriority (5), sortCardsByTaskNumber (5), plus edge cases for invalid IDs and mixed prefixes
- **`src/webview/lib/types.ts`**: Added `SortMode` type (`'default' | 'priority' | 'task-number'`)
- **`src/webview/components/kanban/KanbanColumn.svelte`**: Added `sortMode` prop; `sortedTasks` derived now branches on sort mode (done columns remain sorted by updatedAt DESC regardless)
- **`src/webview/components/kanban/KanbanBoard.svelte`**: Added `sortMode` prop; passed through to KanbanColumn and MilestoneSection
- **`src/webview/components/kanban/MilestoneSection.svelte`**: Added `sortMode` prop; passed through to nested KanbanColumn
- **`src/webview/components/tasks/Tasks.svelte`**: Added `sortMode` state + sort control UI in kanban toolbar; passed to KanbanBoard
- **`src/webview/styles.css`**: Added `.sort-toggle`, `.sort-label`, `.sort-btn` styles matching the existing grouping button pattern
- **`e2e/tasks.spec.ts`**: 6 new Playwright tests verifying sort buttons render, toggle correctly, and produce expected task order

### Design decisions
- Sort is view-only (client-side); it doesn't modify entries or ordinals
- Drag-and-drop still works in any sort mode — it modifies ordinals which become visible when switching back to default
- Sort preference persists for the session (Svelte component state); not persisted to VS Code settings
- Sort composes gracefully with milestone grouping — it applies within each column regardless of grouping mode
- Done columns always sort by updatedAt DESC regardless of sort mode (preserving existing UX)
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added sort controls to the kanban board with three modes: Default (ordinal), Priority (high→medium→low), and Task Number (ascending). Sort applies within each status column and composes with milestone grouping. Pure sorting utilities in ordinalUtils.ts with 17 new unit tests. 6 new Playwright tests verify UI interaction and sort ordering. All 1542 unit tests + 388 Playwright tests pass.
<!-- SECTION:FINAL_SUMMARY:END -->
