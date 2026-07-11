---
id: TASK-78
title: >-
  Add an /orchestrate-board skill that runs the full task cycle for many tasks
  (self-driven or parallel subagents)
status: Done
assignee: []
created_date: '2026-07-08 05:25'
updated_date: '2026-07-08 06:45'
labels: []
milestone: Orchestration & UX Polish
dependencies:
  - TASK-77
  - TASK-75
priority: high
category: Orchestration
plan: docs/superpowers/plans/2026-07-08-orchestrate-board-skill.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
New skill (working name /orchestrate-board — chosen to avoid clashing with the claude-harness `/orchestrate` deepseek-worker skill) that lets any agent session act as an orchestrator over the whole board.

Behavior: pull ready tasks (next_ready_tasks, DRAFT-5), then for each either (a) do it itself sequentially — bootstrap worktree (DRAFT-3), execute, close via request_merge (DRAFT-4/DRAFT-7) — or (b) dispatch parallel IN-SESSION subagents (one per independent task), each bootstrapping its own worktree and running /execute-task to Done. Respect advisory claims (claim_task) so two agents never take the same task, and rely on the shared merge queue to serialize the actual merges. Subscription-safe: parallel subagents via the Agent/Task tool, NEVER `claude -p`.

Design questions worth a short spec first: degree of parallelism, failure/retry handling, how the orchestrator monitors subagent completion + merge-queue turns, and stop conditions (queue empty / budget / all-blocked).

Acceptance criteria:
- Skill runs N ready tasks to Done end-to-end, self-driven sequentially.
- Skill dispatches parallel subagents on independent tasks in separate worktrees — no claim collisions, merges serialized by the queue.
- Never spawns `claude -p`; honors claims + dependency gating; skips tasks with unmet deps.
- SKILL.md authored under .claude/skills/orchestrate-board/ (and added to the installer set — see the broaden-scaffolding task).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented by DeepSeek-pro per plan. New .claude/skills/orchestrate-board/SKILL.md: round loop (next_ready_tasks → mode → batch → reconcile → refresh → stop) with self-driven-sequential and parallel-Task-subagent modes (cap 3), a self-contained subagent prompt template (start_task → claim → /execute-task → cancellation/failure handling → JSON), claim-before-work anti-collision, and four stop conditions (drained/all-blocked/budget/no-progress). Relies on the ready set being provably mutually independent + the merge queue serializing merges. Composes TASK-75/73/77/74. Subscription-safe (Task tool, never claude -p). CLAUDE.md bullet added. Verified 1640 vitest, lint/typecheck/build clean. Merged to integration (fast-forward).
<!-- SECTION:FINAL_SUMMARY:END -->
