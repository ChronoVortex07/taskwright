---
id: TASK-75
title: Add a next-ready-tasks selection core + MCP tool for orchestration
status: Done
assignee: []
created_date: '2026-07-08 05:25'
updated_date: '2026-07-08 06:31'
labels: []
milestone: Orchestration & UX Polish
dependencies: []
priority: high
category: Orchestration
plan: docs/superpowers/plans/2026-07-08-next-ready-tasks-tool.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The orchestrator needs to pull the next executable tasks off the board. Add a vscode-free core + MCP tool (e.g. `next_ready_tasks`) that returns tasks ready to run: all dependencies Done (dependency-gated per the tree model), not claimed by a live session, not locked/blocked, and not already active in the merge queue — ordered by priority then ordinal. Build on the existing board load (loadTreeBoardFromParser / the get_board fields dependencies / blockedBy / locked) so readiness matches the canvas gating exactly.

Acceptance criteria:
- Tool returns only runnable tasks (deps Done, unclaimed, unblocked, not in the merge queue).
- Respects stale-claim rules (claimResolution / isClaimStale) so dead claims don't block a task forever.
- vscode-free core, unit-tested; registered in server.ts + handlers.ts.
- Bounded / filterable output (like get_board) so it stays usable on a large board.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented by DeepSeek-pro per plan. New vscode-free core src/core/readyTasks.ts (selectReadyTasks): READY = not Done, not completed/archive, not locked (board.states), no live/non-stale claim, not in merge queue; sorted priority→ordinal→id; category/milestone/limit filters; reuses laneOf/priorityRank/isClaimStale. nextReadyTasksHandler + next_ready_tasks registration. +11 tests. Verified 1629 vitest, lint/typecheck clean. Merged to integration.
<!-- SECTION:FINAL_SUMMARY:END -->
