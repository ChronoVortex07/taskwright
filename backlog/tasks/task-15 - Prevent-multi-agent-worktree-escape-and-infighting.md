---
id: TASK-15
title: >-
  Prevent multi-agent worktree escape and infighting (isolation + auto-merge +
  merge right-of-way)
status: In Progress
assignee: []
created_date: '2026-06-30 17:24'
updated_date: '2026-07-01 07:10'
labels:
  - bug
  - agent-orchestration
dependencies: []
references:
  - >-
    docs/superpowers/specs/2026-07-01-safe-concurrent-agents-merge-queue-design.md
  - docs/superpowers/plans/2026-07-01-worktree-isolation-guard.md
priority: high
plan: docs/superpowers/plans/2026-07-01-merge-queue-request-merge.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Running multiple agents concurrently caused them to fight over changes in git. Root-cause investigation of the main working tree's HEAD reflog shows the agents did NOT operate inside their assigned worktrees. Even though 4 worktrees existed, the agents ran `git checkout` / `git commit` from the SHARED main working tree, so they all shared one HEAD. Commits landed on whatever branch HEAD happened to point at when the command ran.

### Evidence (HEAD reflog, newest first)
- `checkout: task-4 -> task-14`, then `commit: "Make unit tests path-separator-agnostic"` — task-4's work committed onto task-14's branch.
- `reset -> 5264efc` — clawed back.
- `commit: "Detect taskwright naming"` — task-14's real work.
- `commit: "Release TASK-2 claim"` — TASK-2's work committed onto task-14's branch too.
- `reset -> 251e37e` — clawed back again.
- `checkout task-14 -> main`, re-commit "Release TASK-2 claim" on main (duplicate hash), merge task-4.

The reset/re-commit churn is the observed "infighting": commits misfiled onto sibling branches, then reverted and redone. `git worktree list` later showed only the single main tree; the 4 worktrees were cleaned up manually after the fact.

### Root cause
Worktree creation alone does not constrain where an agent runs git. Nothing forced each agent's shell/session to stay inside its `.worktrees/<branch>` directory, and nothing serialized merges. So agents shared the main tree's HEAD and merged concurrently.

## Goal / required mechanisms
1. Worktree isolation enforcement — an agent must operate only inside its assigned `.worktrees/<branch>` and must never run git in the shared main tree.
2. Auto-merge + cleanup at task end — when an agent finishes, it merges its branch and removes stray files / its worktree automatically.
3. Merge right-of-way — only one agent merges at a time (a serialization lock) to prevent concurrent-merge collisions.

## Status
Design TBD — implementation plan to be attached after a design brainstorm. This task captures the bug + the three required prevention mechanisms.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Worktree isolation enforced: agents cannot commit a dispatched task branch from the primary tree (pre-commit guard + hardened dispatch prompt/AGENTS.md)
- [x] #2 Auto-merge + cleanup at task end via a blocking request_merge MCP tool (rebase -> verify -> integrate -> cleanup)
- [x] #3 Merge right-of-way: a shared FIFO merge queue whose head is the only one that may integrate to main (one at a time)
- [ ] #4 Review-gated modes with a mode-named intermediate status: Pending Review (default) / Awaiting Merge / Awaiting PR, plus approval UI (Component C)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Component A (worktree isolation guard) shipped to main (2a5f36a..081e03f): src/core/worktreeGuard.ts, hookInstaller.ts, src/hooks/worktree-guard.ts (bundled), extension wiring + taskwright.enforceWorktreeIsolation, dispatch/AGENTS hardening. Deferred: advisory post-checkout warn-hook (spec 4.2).

Component B (merge queue + request_merge) shipped to main (6dca086..946d006), built subagent-driven per docs/superpowers/plans/2026-07-01-merge-queue-request-merge.md (8 tasks, each spec+quality reviewed; opus whole-branch review + fixes). New cores: src/core/mergeQueue.ts (shared FIFO queue at <git-common-dir>/taskwright/merge-queue.json, atomic writes, right-of-way head, stale-head reclaim), mergeConfig.ts (modes -> intermediate status names + shared merge-config.json), finishTask.ts (the request_merge lifecycle: clean-check -> rebase -> verify -> enqueue+status -> long-poll until head AND (auto OR approved) -> re-rebase+re-verify -> ff-merge or open-PR -> complete/cleanup -> dequeue). MCP request_merge tool + queuePosition in get_active_task (src/mcp). Extension publishes merge settings to the shared config for the out-of-process MCP. Three settings: taskwright.mergeMode / mergeVerifyCommands / mergeQueueStaleMinutes. Dispatch/AGENTS closing step now request_merge.

Critical fix from the final review: the intermediate-status write to the primary tree's task file collided with git merge --ff-only (dirty file); fixed with BoardOps.resetTaskFile discarding that one file's uncommitted edit before merge, proven by a real-git integration test. Full suite 1175 pass / 1 skip, lint + typecheck clean, MCP bundle builds.

Remaining: Component C (mode-named board status column in config.yml with rename+migrate on mode change, kanban Approve/Send-back controls writing approved/removal to the shared queue, mergeMode plumbing) — meets B only at the shared queue file. Until C ships, manual-review approval is granted by writing approved:true into the queue file (or selecting auto-merge/auto-pr).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Not final — Component C (board status column + Approve/Send-back UI + mode plumbing) remains. Components A (worktree isolation guard) and B (merge queue + request_merge) are shipped to main and green.
<!-- SECTION:FINAL_SUMMARY:END -->
