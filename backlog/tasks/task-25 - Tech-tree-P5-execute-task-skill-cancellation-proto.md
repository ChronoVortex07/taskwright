---
id: TASK-25
title: Tech-tree P5 — /execute-task skill & cancellation protocol
status: Done
assignee: []
created_date: '2026-07-03 13:32'
updated_date: '2026-07-03 15:48'
labels: []
dependencies:
  - TASK-22
priority: high
category: Features
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tech-tree P5 (execution counterpart to P4's authoring): a `/execute-task` skill that takes one dispatched task, verifies it is worktree-rooted, claims it, executes with the right superpowers strategy (precedence plan > independent-subtasks > TDD), records progress, and closes via request_merge — subscription-safe, honoring worktree isolation, identically whether dispatched or launched by hand. P5 also owns the Cancel-dispatch cancellation protocol: a task/worktree-scoped marker (src/core/cancellationMarker.ts, presence-only) written FIRST in cancelDispatch so a `git worktree remove --force` can't resurrect the worktree dir and silently defeat isolation on the next dispatch. Closes the landed-code gaps (GAP-1..9): marker-first order, dispatch clears a stale marker on seed, get_active_task surfaces subtasks/parentTaskId (so the SDD branch can fire), Cancel-dispatch affordance gated on worktree-dir existence, dispatch template repointed at /execute-task. Central invariant: the MCP server roots once at launch, so the skill VERIFIES worktree-rooting rather than self-creating a worktree.

Spec: docs/superpowers/specs/2026-07-02-tech-tree-p5-execute-task-skill-design.md
Plan: docs/superpowers/plans/2026-07-03-tech-tree-p5-execute-task-skill.md (9 tasks incl. folded Task 9 board.materialized fix; adversarial review READY-WITH-FIXES, fixes folded)
Directives: .superpowers/tech-tree-run/p5-architecture-directives.md
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
P5 landed on main (ff-merge, branch tip ec635f8). Delivered the `/execute-task` skill + the Cancel-dispatch cancellation protocol, closing landed-code gaps GAP-1..9. Shipped: `src/core/cancellationMarker.ts` (presence-only, mirrors activeTask); cancelDispatch writes the marker FIRST (marker→release→status→removeWorktree→terminal) so a `--force` worktree removal can't resurrect the dir and defeat isolation; dispatch clears a stale marker on seed; `DEFAULT_DISPATCH_TEMPLATE` repointed to launch-in-worktree + `/execute-task` (guardrails kept); `get_active_task` surfaces subtasks/parentTaskId; Cancel-dispatch affordance gated on worktree-dir existence; `.claude/skills/execute-task/SKILL.md` (VERIFY-not-create, presence-only-OR-vanished cancellation contract, ordered plan>subtasks>TDD selector). Build via 8-task SDD loop (Opus/Haiku), each per-task-reviewed LGTM. Whole-branch adversarial review caught a MAJOR cross-task bug: get_active_task never DERIVED a parent's subtasks on the MCP path (create_subtask writes only child parent_task_id; computeSubtasks ran only on vscode providers) so the SDD branch was dead end-to-end — fixed by deriving subtasks in getActiveTask (commit 5146e8e) + an end-to-end test. Fix wave also folded a MINOR no-worktree-dispatch coherence fix + 2 review NITs/LOWs (ec635f8). Gate at close: unit 1462/1skip/0fail, lint+typecheck clean, full Playwright 362, full CDP 18/18.
<!-- SECTION:FINAL_SUMMARY:END -->
