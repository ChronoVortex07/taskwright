---
id: TASK-6
title: Add group-by-label swimlanes to the board
status: Done
assignee: []
created_date: '2026-06-30 11:39'
updated_date: '2026-07-04 13:47'
labels:
  - feature
milestone: Foundation & Rebrand
dependencies: []
priority: medium
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
idea.md envisions many user-created categories such as frontend and backend as a primary board axis, but the kanban only groups by status while categories live as filterable labels. Add an optional group-by toggle so the board can lane tasks by label as well as status, better matching the original vision.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The board offers a group-by toggle between status and label
- [ ] #2 Label grouping renders tasks under their labels with a defined rule for multi-label and unlabeled tasks
- [ ] #3 Drag-and-drop and filtering still work under the new grouping
- [ ] #4 DOM interactions are covered by Playwright webview tests
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation Notes

### Architecture
- Changed `milestoneGrouping` (boolean) to `groupingMode` ('status' | 'milestone' | 'label') across the webview and extension host
- Added "By Label" as third option in the kanban grouping toggle
- Label grouping reuses the same `KanbanColumn` components and `handleDrop` logic as milestone grouping

### Label grouping rules
- Multi-label tasks appear in each of their label groups (card is rendered once per group)
- Unlabeled tasks appear in an "Unlabeled" group at the end
- Label groups are sorted alphabetically (case-insensitive), with "Unlabeled" always last

### Files changed
- `src/webview/components/tasks/Tasks.svelte` — groupingMode state, 3-button toggle, message handling
- `src/webview/components/kanban/KanbanBoard.svelte` — groupingMode prop, labelGroups derived, label section rendering
- `src/webview/styles.css` — label section styling (mirrors milestone-section for visual consistency)
- `src/providers/TasksController.ts` — groupingMode state, toggleGroupingMode handler, legacy migration
- `src/core/types.ts` — toggleGroupingMode and groupingModeChanged message types
- `e2e/tasks.spec.ts` — 11 new Playwright tests for label grouping

### Backward compatibility
- `toggleMilestoneGrouping` / `milestoneGroupingChanged` messages still handled
- Legacy `backlog.milestoneGrouping` boolean state auto-migrated to `groupingMode`
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added a "By Label" grouping option to the kanban board toggle, allowing tasks to be grouped by their labels instead of just by status or milestone. Multi-label tasks appear in each label group, unlabeled tasks are collected under "Unlabeled". The grouping toggle now has three buttons: All Tasks (status), By Milestone, and By Label. All existing drag-and-drop, filtering, and card interactions continue to work across all grouping modes. 11 new Playwright tests cover toggle behavior, label section rendering, multi-label/unlabeled handling, and mode switching.
<!-- SECTION:FINAL_SUMMARY:END -->
