---
id: TASK-15
title: >-
  Prevent multi-agent worktree escape and infighting (isolation + auto-merge +
  merge right-of-way)
status: Done
assignee: []
created_date: '2026-06-30 17:24'
updated_date: '2026-07-01 10:03'
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
- [x] #4 Review-gated modes with a mode-named intermediate status: Pending Review (default) / Awaiting Merge / Awaiting PR, plus approval UI (Component C)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Component A (worktree isolation guard) shipped to main (2a5f36a..081e03f): src/core/worktreeGuard.ts, hookInstaller.ts, src/hooks/worktree-guard.ts (bundled), extension wiring + taskwright.enforceWorktreeIsolation, dispatch/AGENTS hardening. Deferred: advisory post-checkout warn-hook (spec 4.2).

Component B (merge queue + request_merge) shipped to main (6dca086..946d006), built subagent-driven per docs/superpowers/plans/2026-07-01-merge-queue-request-merge.md. New cores: src/core/mergeQueue.ts (shared FIFO queue at <git-common-dir>/taskwright/merge-queue.json, atomic writes, right-of-way head, stale-head reclaim), mergeConfig.ts (modes -> intermediate status names + shared merge-config.json), finishTask.ts (the request_merge lifecycle: clean-check -> rebase -> verify -> enqueue+status -> long-poll until head AND (auto OR approved) -> re-rebase+re-verify -> ff-merge or open-PR -> complete/cleanup -> dequeue). MCP request_merge tool + queuePosition in get_active_task. Extension publishes merge settings. Settings: taskwright.mergeMode / mergeVerifyCommands / mergeQueueStaleMinutes. Dispatch/AGENTS closing step now request_merge. Critical fix: the intermediate-status write collided with git merge --ff-only (dirty file); fixed with BoardOps.resetTaskFile, proven by a real-git integration test.

Component C (merge-review board status + approval UI) shipped to main (b8b6c21..f350cd8), built subagent-driven per docs/superpowers/plans/2026-07-01-merge-review-board-ui.md (6 tasks, each spec+quality reviewed; opus whole-branch review + fixes). New cores: src/core/mergeStatusConfig.ts (compute the mode's canonical statuses list + surgical config.yml statuses-line rewrite + rename/migrate plan; guarded to only auto-edit boards ending in "Done" so a custom board is never silently mutated), src/core/mergeBoard.ts (mergeStateForTask -> per-task MergeTaskState from the queue). src/providers/mergeActions.ts + taskwright.approveMerge / taskwright.sendBackMerge commands (write approved:true / remove entry + best-effort status reset to In Progress). Extension: syncMergeStatus renames the intermediate status in config.yml to match mergeMode (idempotent, best-effort, never throws into activation) + migrates in-flight tasks on a mode change; injects a cached queue reader into both board hosts; fs.watchFile on the queue file (inside .git, so vscode.createFileSystemWatcher can't observe it) refreshes the board on out-of-process request_merge mutations. TasksController enriches cards with mergeState; kanban card badge (Lucide, theme-aware) + task-detail merge-review banner offering Approve & merge / Send back (manual-review) or read-only queued/merging text (auto modes). Component C meets Component B only at the shared queue file. Verified: full unit suite 1204 pass/1 skip, Playwright merge-review 6/6, lint+typecheck clean, all esbuild bundles + webview build. Non-blocking follow-ups from the whole-branch review: inject the board's cached common-dir into TaskDetailProvider so the detail panel doesn't spawn git rev-parse per open; share the IN_PROGRESS constant between mergeActions.ts and finishTask.ts; re-point the queue watcher/reader on a backlog-root switch.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
All three prevention mechanisms for the original bug (multi-agent worktree escape + merge infighting) are shipped to main and green:

(A) Worktree isolation guard — a managed pre-commit hook + hardened dispatch/AGENTS prompt block committing a dispatched task branch from the shared primary tree.
(B) A blocking request_merge MCP tool that rebases -> verifies -> integrates -> cleans up, serialized by (C's peer) a shared FIFO merge queue whose head holds the sole right-of-way (one agent merges at a time), with stale-head reclaim so a crashed agent can't wedge the queue.
(C) Review-gated modes with a mode-named intermediate board status (Pending Review / Awaiting Merge / Awaiting PR) and an Approve & merge / Send back approval UI, coordinating with the queue purely through the shared merge-queue.json file (no IPC). Default mode is manual-review.

To arm the new MCP tool + board status in a repo, reload the extension — activation republishes the merge config and syncs the intermediate status into backlog/config.yml. Until then, manual-review approval can be granted by writing approved:true into the queue file (or by selecting auto-merge / auto-pr).
<!-- SECTION:FINAL_SUMMARY:END -->
