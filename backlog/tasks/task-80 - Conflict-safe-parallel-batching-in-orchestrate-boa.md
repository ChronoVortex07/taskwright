---
id: TASK-80
title: >-
  Conflict-safe parallel batching in /orchestrate-board (avoid co-scheduling
  file-overlapping tasks)
status: Done
assignee: []
created_date: '2026-07-08 07:44'
updated_date: '2026-07-08 08:11'
labels: []
milestone: Orchestration & UX Polish
dependencies: []
priority: high
category: Orchestration
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up to TASK-78: the orchestrator should AVOID co-scheduling tasks that touch the same files in one parallel batch (merge-conflict avoidance at the orchestrator level). For automatic dispatch, task agents still resolve any unavoidable conflict themselves during request_merge's rebase — but the orchestrator should minimize that.

Scope:
- New pure core src/core/planFiles.ts:
  - extractPlanFiles(planMarkdown): string[] — parse a plan's "## File Structure" section (Create/Modify/Test bullet paths, stripping ranges like ":123-145") into a repo-path set.
  - selectDisjointBatch(orderedIds, filesById, cap): string[] — greedily select a pairwise-file-disjoint batch from the priority-ordered ready ids, capped; a task with unknown footprint (no plan) is only returned as a solo batch (never co-scheduled), since it can't be proven disjoint.
- Extend next_ready_tasks with parallelSafe?: boolean (default false). When true, load each ready task's attached plan footprint and return selectDisjointBatch(...) instead of the full ordered ready set. Keep the default (all ready, ordered) unchanged for sequential mode.
- Update .claude/skills/orchestrate-board/SKILL.md: in PARALLEL mode, pull the batch via next_ready_tasks { parallelSafe: true, limit: cap } so co-dispatched tasks are file-disjoint; defer overlaps to the next round (freed once the first merges); state that unavoidable conflicts are the dispatched agent's to resolve during request_merge rebase (agents handle conflicts; the orchestrator avoids them).
- Fold in a doc fix: CLAUDE.md "Build & test" still says ~22 unit tests fail on Windows (POSIX paths) — TASK-4 made them path-agnostic; the current Windows baseline is 0 failures. Correct that line (and AGENTS.md if duplicated).

Acceptance criteria:
- extractPlanFiles + selectDisjointBatch pure-core unit tests (disjoint selection, overlap deferral, unknown-footprint solo, cap).
- next_ready_tasks parallelSafe returns a pairwise-disjoint batch; default behavior unchanged (handler test).
- orchestrate-board SKILL.md parallel mode uses parallelSafe and documents the agent-resolves-unavoidable contract.
- CLAUDE.md Windows-test note corrected.
- bun run test && lint && typecheck && build all green.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built via the exec-anywhere flow (start_task from this primary session → work in worktree → gate). Two commits on branch task-80-…: (1) conflict-safe batching — src/core/planFiles.ts (extractPlanFiles + selectDisjointBatch), next_ready_tasks gains parallelSafe, /orchestrate-board SKILL.md parallel mode pulls the disjoint batch, CLAUDE.md note + stale-Windows-note fix; (2) FOLDED FIX: request_merge{worktree} aborted "not a linked worktree" from a primary-rooted session because gitFacts did path.resolve(gitOutput) — git returns a RELATIVE ".git" from the primary tree, so it resolved against the MCP process cwd instead of deps.root, yielding a wrong primaryRoot. Fixed all 3 sites to path.resolve(deps.root/cwd, output); regression test added. Bug is in TASK-74's worktree-target path (only surfaces from the primary tree, which prior tests never exercised — they mocked absolute git-dir). Verified: 1668 vitest, lint/typecheck/build green in the worktree. NOT yet integrated — the running MCP server has the stale (buggy) build, so request_merge can't close this task itself; needs FF main → branch + primary rebuild + reload.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Conflict-safe parallel batching for /orchestrate-board: next_ready_tasks gains parallelSafe (returns a pairwise-file-disjoint batch via src/core/planFiles.ts extractPlanFiles/selectDisjointBatch; unknown-footprint tasks run solo); the skill's parallel mode pulls it so the orchestrator avoids file collisions and agents rebase away any that slip through. Folded a fix discovered while dogfooding: request_merge{worktree} from a primary-rooted session aborted "not a linked worktree" because gitFacts resolved git's RELATIVE .git output against the MCP process cwd instead of deps.root — fixed all 3 sites + regression test. Doc: corrected the stale ~22-Windows-failures note (now 0). Built via the exec-anywhere flow (start_task → work → gate); 1668 vitest + lint/typecheck/build green. Released as 1.2.0, fast-forwarded to main (318d8cb).
<!-- SECTION:FINAL_SUMMARY:END -->
