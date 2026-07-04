---
id: TASK-23
title: >-
  Switching to the Tree tab does not refresh — pre-existing drafts stay hidden
  until a file event
type: bug
status: To Do
assignee: []
created_date: '2026-07-03 10:51'
updated_date: '2026-07-03 10:51'
labels:
  - tech-tree
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
