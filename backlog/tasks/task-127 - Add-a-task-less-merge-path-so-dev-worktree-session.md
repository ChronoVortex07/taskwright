---
id: TASK-127
title: >-
  Add a task-less merge path so dev-worktree sessions can close through the
  merge queue
status: Done
assignee: []
created_date: '2026-07-14 05:25'
updated_date: '2026-07-14 09:41'
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
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Multi-phase development sessions working in ad-hoc worktrees (e.g. a `tech-tree-p5` dev branch) don't fit the claim→execute→request_merge model because request_merge requires a taskId. Mined evidence (friction report 2026-07-14): such a session fell back to a manual `git merge --ff-only` in the repo root, hit the merge-without-review guardrail, and needed ~4 turns of block → explanation → AskUserQuestion → user override to land work the queue should have handled.

Fix direction: let request_merge (or a sibling MCP tool, e.g. `request_branch_merge`) accept an arbitrary branch/worktree without a task id, running the same rebase → verify → queue → ff-merge pipeline and the same manual-review gate — so orchestrator-style dev flows get queue safety instead of guardrail collisions. Board effects (marking Done, worktree removal semantics) must be cleanly skipped or made optional when there is no task.

Sequenced after TASK-126 because both change the requestMerge core in src/core/finishTask.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A merge can be requested for a named branch/worktree with no taskId and goes through rebase, verify, queue ordering, and (in manual-review mode) human approval identically to task merges
- [x] #2 No board mutation occurs for task-less merges (no Done marking, no claim release), and worktree removal is opt-in
- [x] #3 wrong_root and abort-code semantics match the task path; abort codes are reused, not re-invented
- [x] #4 Agent-facing docs (AGENTS.md, CLAUDE.md, orchestrate/execute skills) tell agents to use this path instead of manual merges in the repo root
- [x] #5 Unit tests cover the task-less path including verify failure and queue ordering with a concurrent task merge
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented as a sibling MCP tool, `request_branch_merge`, rather than by making `request_merge`'s taskId optional — the two have genuinely different return shapes (branch vs task) and different cleanup defaults, and an optional-id `request_merge` would have made the board-mutation question a runtime branch on every call.

Key design decision: **the two task-less invariants are derived in the merge core from the queue key, not from the caller.** `requestMerge` computes `taskless = isBranchMergeKey(key)` and from that (a) swaps in `NOOP_BOARD_OPS`, so a caller that hands it a real board along with a branch key still cannot write to the board, and (b) defaults `removeWorktreeOnSuccess` to `false`. The unit test for "zero board mutations" therefore deliberately injects a REAL recording board and asserts it stays untouched. Everything downstream (rebase, verify slot, queue, manual-review gate, ff-merge, abort codes) is literally the same code path — no forked pipeline to drift.

Queue keys: task-less entries are `branch:<name>` (`BRANCH_MERGE_KEY_PREFIX`). `QueueEntry.taskId` keeps its name (persisted schema, legacy entries) but is now documented as "the queue key". Task IDs are `<PREFIX>-<N>`, so the spaces cannot collide, and the board's per-task queue lookup (`mergeStateForTask(queue, task.id)`) simply never matches a branch key — task-less merges are invisible on the board by construction, which is what AC2 wants.

Handler-level, `prepareMerge()` was extracted out of `requestMergeHandler`: target resolution (the four `.worktrees/` gates), merge config + per-call verifyTimeoutMinutes, the shared verify slot, and the git-auto boundary sync now build once for both tools. That is what makes AC3 structural rather than a promise — `wrong_root` and every other abort comes from the same code, with only the wrong_root *advice string* parameterized so each tool points the caller back at itself. Added one guard the task path never needed: refuse to merge when the target's branch IS the base branch.

The gap I had to close for AC1: in manual-review mode (the default), the approval gate is granted by writing `approved:true` on the queue entry — and the board's Approve control is keyed to a task card, which a task-less entry does not have. Without an affordance, a branch merge in the default mode would have blocked forever. Added `pendingBranchMerges()` (mergeActions) plus a `taskwright.reviewBranchMerge` palette command: a QuickPick of queued branch merges → Approve / Send back. Send-back does no board write (there is no task to reset to In Progress).

Docs (AC4) are held by a new `branchMergeContract.test.ts`, in the style of `worktreeEntryContract`/`idSpaceContract`: every surface that forbids merging in the repo root must, in the same breath, name `request_branch_merge`. The mined failure was not that the manual merge was allowed — it is blocked — but that the agent had no sanctioned alternative to reach for, so forbidding without offering now fails the build. The injected AGENTS convention is under its 2000-char budget (trimmed two clauses to fit the new sentence).

Verification: full suite 2341 passed (162 files), lint clean, typecheck clean, `bun run compile` succeeds and `request_branch_merge` is present in `dist/mcp/server.js`. The 7 prettier warnings in the tree are pre-existing files this task never touched.
<!-- SECTION:NOTES:END -->
