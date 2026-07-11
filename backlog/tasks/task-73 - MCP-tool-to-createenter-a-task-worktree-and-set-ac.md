---
id: TASK-73
title: MCP tool to create/enter a task worktree and set active task from any session
status: Done
assignee: []
created_date: '2026-07-08 05:24'
updated_date: '2026-07-08 06:18'
labels: []
milestone: Orchestration & UX Polish
dependencies: []
priority: high
category: Orchestration
plan: docs/superpowers/plans/2026-07-08-start-task-worktree-bootstrap-tool.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today only the board's Dispatch action (src/providers/dispatchActions.ts) creates a worktree and seeds the active task; an arbitrary Claude session can't bootstrap one, so /execute-task STOPs when it isn't worktree-rooted. Add a vscode-free core + MCP tool (e.g. `start_task` / `enter_worktree`) that, given a task ID, creates `.worktrees/<branch>` (reusing WorktreeService.createWorktree — WorktreeService.ts:65-80 / worktreePathFor), writes `<worktree>/.taskwright/active-task.json` (activeTask.ts writeActiveTask), and clears any stale cancellation marker. The dispatch bootstrap sequence at dispatchActions.ts:117-146 is the reference — mirror it from the MCP/core layer without duplicating it.

Because the MCP server roots itself at the launch directory and cannot re-root mid-session (server.ts:82), the tool returns the worktree path + branch and a relaunch/spawn instruction so the caller (a human, /execute-task, or the orchestrator) can continue rooted in the worktree.

Acceptance criteria:
- New MCP tool creates the worktree and seeds active-task.json for a given task from a primary-rooted session.
- Idempotent when the worktree already exists (createWorktree reuses the dir); clears stale cancellation marker.
- Core is vscode-free (callable from src/mcp), unit-tested; reuses the dispatch bootstrap rather than duplicating it.
- Returns enough for the caller to relaunch/spawn a session rooted in the worktree.
- Registered in src/mcp/server.ts + handler in src/mcp/handlers.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented by DeepSeek-pro per plan. New vscode-free core src/core/startTask.ts (bootstrapTaskWorktree) reuses createWorktree/writeActiveTask/clearCancellationMarker/dispatchBranchName to create-or-reuse .worktrees/<branch> and seed active-task.json, returning {created,taskId,branch,worktree,worktreeAbs,relaunchHint}; the relaunchHint documents the MCP-root-fixed-at-launch constraint. startTaskHandler + start_task registration in handlers.ts/server.ts. 7 new unit tests. Verified: 1614 vitest, lint/typecheck/build (dist/mcp/server.js) clean. Merged to integration branch.
<!-- SECTION:FINAL_SUMMARY:END -->
