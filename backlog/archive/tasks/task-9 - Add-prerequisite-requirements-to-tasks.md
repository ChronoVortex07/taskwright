---
id: TASK-9
title: Add prerequisite requirements to tasks
status: To Do
assignee: []
created_date: '2026-06-30 12:25'
updated_date: '2026-07-04 00:43'
labels: []
dependencies: []
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Certain tasks can be follow-up works or expansions of other tasks, thus these tasks require other tasks to be completed before they can be started. Thus, there should be an option to include prerequistes in task creation that block the starting of tasks before its prerequisites have been marked as completed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Superseded by TASK-17 (Tech-tree P1 — task model & dependency gating), landed 2026-07-02. TASK-17 shipped exactly this: a `dependencies` field per task plus pure gating (locked/blockedBy via src/core/treeGate.ts), cycle-safe traversal (wouldCreateCycle), and MCP enforcement (claim_task hard-refuses locked tasks; dispatch refuses locked tasks; human-only force-claim override). Archived during the 2026-07-04 /index-codebase tree bootstrap as a duplicate of already-shipped work.
<!-- SECTION:NOTES:END -->
