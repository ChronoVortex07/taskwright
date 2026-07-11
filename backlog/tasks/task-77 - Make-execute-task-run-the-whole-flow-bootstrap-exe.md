---
id: TASK-77
title: >-
  Make /execute-task run the whole flow (bootstrap → execute → request_merge)
  from any session
status: Done
assignee: []
created_date: '2026-07-08 05:25'
updated_date: '2026-07-08 06:38'
labels: []
milestone: Orchestration & UX Polish
dependencies:
  - TASK-73
  - TASK-74
priority: high
category: Orchestration
plan: docs/superpowers/plans/2026-07-08-execute-task-from-any-session.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wire the new worktree-bootstrap tool (DRAFT-3) and the request_merge worktree-target override (DRAFT-4) into the /execute-task skill so it no longer requires a board Dispatch.

Update .claude/skills/execute-task/SKILL.md step 2 (today: if not worktree-rooted, STOP — SKILL.md:38-52). Instead, when the session is primary-rooted and a task is chosen, create/enter the worktree via the bootstrap tool, then either continue rooted there (relaunch/spawn) or close via request_merge with the explicit worktree target. Preserve the subscription-safe rule (in-session; never `claude -p`) and the mandatory cancellation checkpoint. Keep the dispatched-flow path working unchanged.

Acceptance criteria:
- From an arbitrary (non-dispatched) session, /execute-task can pick a task, bootstrap its worktree, do the work, and reach Done via request_merge — matching the dispatched flow.
- Still STOPs gracefully with clear guidance if git/worktree bootstrap fails or no task is chosen.
- SKILL.md updated; DEFAULT_DISPATCH_TEMPLATE and the dispatched path remain valid.
- Relevant unit tests updated (get_active_task/toSummary/dispatchPrompt as touched).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented by DeepSeek-pro per plan. Rewired .claude/skills/execute-task/SKILL.md: step 2 now branches on linked (dispatched, unchanged) vs primary (call start_task → relaunch preferred, or single-session cd+work), step 7 pairs each with the right close (bare request_merge vs request_merge{taskId,worktree}), step 1 accepts a user-named task via get_board, cancellation contract covers the worktree-target abort. CLAUDE.md P5 bullet updated. handlers.ts getActiveTask no-active-task message repointed + test. Composes TASK-73 (start_task) + TASK-74 (request_merge worktree target). Verified 1640 vitest, lint/typecheck clean. Merged to integration (fast-forward).
<!-- SECTION:FINAL_SUMMARY:END -->
