---
id: TASK-104
title: Keep start_task worktrees out of the git-auto board checkout
type: bug
status: Done
assignee: []
created_date: '2026-07-11 07:18'
updated_date: '2026-07-11 07:25'
labels: []
dependencies: []
priority: high
category: Orchestration
caused_by: TASK-91
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Fix the urgent orchestration regression exposed while starting TASK-97: in git-auto mode start_task derives the code repository from dirname(backlogPath), so it branches from the hidden taskwright-board checkout and returns a board-only worktree. Resolve the actual primary code root explicitly and prevent future dispatches from targeting board state.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 start_task creates .worktrees under the primary code checkout when the physical board is in .taskwright/board
- [x] #2 The new worktree branches from the primary code branch rather than taskwright-board
- [x] #3 off and git board modes retain their existing start_task behavior
- [x] #4 Regression tests model a git-auto backlog path distinct from the primary repository root
- [x] #5 The MCP server passes the resolved primary root to task bootstrap explicitly
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a failing handler regression for a git-auto board path with a distinct primary code root.
2. Carry resolveWorkspaceBacklogRoot's primaryRoot into MCP handler dependencies and use it for start_task.
3. Run the full verification gate and merge.
4. Remove the clean misplaced TASK-97 worktree/branch and restart TASK-97 through the repaired MCP path.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reproduced the production failure: start_task used dirname(backlogPath), which is .taskwright/board in git-auto mode. Added a regression with a hidden physical board and distinct primary code root. McpHandlerDeps now carries the primary root already resolved during server startup; startTaskHandler uses it for WorktreeService while retaining the legacy fallback for injected/off-mode callers.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Prevented start_task from creating code worktrees beneath the hidden git-auto board checkout. All 1,935 unit tests, lint, and typecheck pass.
<!-- SECTION:FINAL_SUMMARY:END -->
