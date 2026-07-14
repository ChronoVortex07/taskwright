---
id: TASK-127
title: >-
  Add a task-less merge path so dev-worktree sessions can close through the
  merge queue
status: In Progress
assignee: []
created_date: '2026-07-14 05:25'
updated_date: '2026-07-14 09:21'
labels:
  - friction
  - merge-queue
milestone: Workflow Friction Hardening
dependencies:
  - TASK-126
references:
  - .taskwright/docs/friction-report-2026-07-14.md
  - src/core/finishTask.ts
  - src/mcp/handlers.ts
priority: medium
category: Worktrees & Merge
claimed_by: '@agent/task-127-add-a-task-less-merge-path-so-dev-worktree-sessions-can-close-through-the-merge-queue'
worktree: task-127-add-a-task-less-merge-path-so-dev-worktree-sessions-can-close-through-the-merge-queue
claimed_at: '2026-07-14 17:16'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Multi-phase development sessions working in ad-hoc worktrees (e.g. a `tech-tree-p5` dev branch) don't fit the claim→execute→request_merge model because request_merge requires a taskId. Mined evidence (friction report 2026-07-14): such a session fell back to a manual `git merge --ff-only` in the repo root, hit the merge-without-review guardrail, and needed ~4 turns of block → explanation → AskUserQuestion → user override to land work the queue should have handled.

Fix direction: let request_merge (or a sibling MCP tool, e.g. `request_branch_merge`) accept an arbitrary branch/worktree without a task id, running the same rebase → verify → queue → ff-merge pipeline and the same manual-review gate — so orchestrator-style dev flows get queue safety instead of guardrail collisions. Board effects (marking Done, worktree removal semantics) must be cleanly skipped or made optional when there is no task.

Sequenced after TASK-126 because both change the requestMerge core in src/core/finishTask.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A merge can be requested for a named branch/worktree with no taskId and goes through rebase, verify, queue ordering, and (in manual-review mode) human approval identically to task merges
- [ ] #2 No board mutation occurs for task-less merges (no Done marking, no claim release), and worktree removal is opt-in
- [ ] #3 wrong_root and abort-code semantics match the task path; abort codes are reused, not re-invented
- [ ] #4 Agent-facing docs (AGENTS.md, CLAUDE.md, orchestrate/execute skills) tell agents to use this path instead of manual merges in the repo root
- [ ] #5 Unit tests cover the task-less path including verify failure and queue ordering with a concurrent task merge
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. mergeQueue.ts — namespaced queue keys: `branch:<name>` for task-less merges (branchMergeKey/isBranchMergeKey/branchFromMergeKey). QueueEntry.taskId becomes "queue key" (task ID or branch key); no schema change, so legacy entries and the board's per-task lookup are untouched.
2. finishTask.ts — NOOP_BOARD_OPS (no board mutation) + RequestMergeOptions.removeWorktreeOnSuccess (default true; false keeps the dev worktree AND its branch after the ff-merge). The rebase/verify/queue/ff-merge pipeline and every abort code stay shared, unmodified.
3. handlers.ts — extract the shared merge context (target resolution + gates + config + verify slot) out of requestMergeHandler; add requestBranchMergeHandler using it with NOOP_BOARD_OPS and the branch key. Same wrong_root semantics, same MergeAbortCode set; extra guard: refuse to merge the base branch into itself.
4. server.ts — register `request_branch_merge { worktree?, removeWorktree?, waitMinutes?, ticket?, verifyTimeoutMinutes? }`.
5. mergeActions.ts + extension.ts + package.json — `pendingBranchMerges()` and a `taskwright.reviewBranchMerge` palette command (QuickPick → Approve / Send back), so the manual-review gate is grantable for an entry that has no task card.
6. Docs (AC4): AGENTS.md, CLAUDE.md, execute-task + orchestrate-board SKILL.md, the injected AGENTS convention, and the MCP tool description — all say: dev-worktree work closes with request_branch_merge, never a manual merge in the repo root. Enforced by branchMergeContract.test.ts.
7. Tests (AC5): branchMerge core (no board writes, worktree kept by default / removed on opt-in, verify failure, FIFO ordering with a concurrent task merge), handler gates (wrong_root, base-branch refusal, dirty/detached target), queue-key helpers, and the doc contract.
<!-- SECTION:PLAN:END -->
