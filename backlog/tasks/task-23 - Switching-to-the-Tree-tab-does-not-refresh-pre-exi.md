---
id: TASK-23
title: >-
  Switching to the Tree tab does not refresh — pre-existing drafts stay hidden
  until a file event
type: bug
status: Done
assignee: []
created_date: '2026-07-03 10:51'
updated_date: '2026-07-04 13:48'
labels:
  - tech-tree
milestone: Tech-Tree P4 — AI Authoring
dependencies: []
priority: low
caused_by: TASK-22
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
P4-latent UX gap found by the Task-8 branch review. TasksController.setViewMode's needsRefresh set ('drafts','archived','dashboard','docs','decisions') excludes 'tree', but P4 made the tree's task set differ from other tabs (it unions backlog/drafts/ into the payload only when viewMode==='tree', TasksController.ts ~:263). So drafts that already exist when the user is on another tab (e.g. the /create-task skill committed proposals while the board sat on kanban) do not appear when the user clicks the Tree tab — no refresh runs and no file event fires — until a watcher event or manual refresh. The FileWatcher covers drafts created while already on the tree tab; only the switch-to-tree path is stale.

Fix options: add 'tree' to the refresh-triggering specialModes in setViewMode (TasksController.ts ~:1241), or explicitly refresh() when switching to/from 'tree'. Repro: on kanban, create a draft file in backlog/drafts/ out-of-band (or via MCP from another session), click the Tree tab — the proposed node is missing; press refresh — it appears.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Root cause: TasksController.setViewMode's `specialModes` array (line 1256) included 'drafts', 'archived', 'dashboard', 'docs', 'decisions' but was missing 'tree'. Since P4 made the tree tab union drafts into the payload only when viewMode==='tree' (line 260), switching to the tree tab without a refresh meant pre-existing drafts stayed hidden until a file-watcher event or manual refresh triggered a reload.

Fix: Added 'tree' to the specialModes array. This ensures refresh() is called both when switching TO the tree tab (so drafts appear) and when switching AWAY from it (so the kanban/list view discards draft-only payload entries).

Tests added (TDD):
- TasksController.test.ts: setViewMode(tree) triggers refresh, setViewMode(kanban from tree) triggers refresh
- TasksViewProvider.test.ts: same two scenarios verified via postMessage assertions
- Also added missing getCategories/getBacklogPath/resolveMilestone to TasksViewProvider mock (needed for loadTreeBoardFromParser)
<!-- SECTION:NOTES:END -->
