---
id: TASK-15
title: >-
  Prevent multi-agent worktree escape and infighting (isolation + auto-merge +
  merge right-of-way)
status: In Progress
assignee: []
created_date: '2026-06-30 17:24'
updated_date: '2026-07-01 04:47'
labels:
  - bug
  - agent-orchestration
dependencies: []
references:
  - >-
    docs/superpowers/specs/2026-07-01-safe-concurrent-agents-merge-queue-design.md
  - docs/superpowers/plans/2026-07-01-worktree-isolation-guard.md
priority: high
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
- [ ] #2 Auto-merge + cleanup at task end via a blocking request_merge MCP tool (rebase -> verify -> integrate -> cleanup)
- [ ] #3 Merge right-of-way: a shared FIFO merge queue whose head is the only one that may integrate to main (one at a time)
- [ ] #4 Review-gated modes with a mode-named intermediate status: Pending Review (default) / Awaiting Merge / Awaiting PR, plus approval UI
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Component A (worktree isolation guard) shipped to main (commits 2a5f36a..081e03f). New: src/core/worktreeGuard.ts (pure block/allow decision), src/core/hookInstaller.ts (husky-aware idempotent fenced pre-commit installer), src/hooks/worktree-guard.ts (bundled entrypoint -> dist/hooks/worktree-guard.js), extension activation wiring + taskwright.enforceWorktreeIsolation setting (default true, applied live via onDidChangeConfiguration), and dispatch-prompt/AGENTS.md hardening. The guard fence is committed into .husky/pre-commit (byte-identical to hookInstaller.guardBlock so runtime install is a no-op) and is existence-guarded so linked worktrees skip it. Full suite 1110 pass, lint + typecheck clean. Built subagent-driven per docs/superpowers/plans/2026-07-01-worktree-isolation-guard.md; design in docs/superpowers/specs/2026-07-01-safe-concurrent-agents-merge-queue-design.md.

Deferred follow-up: the advisory post-checkout warn-hook (spec section 4.2) was intentionally out of Component A scope.

Remaining: Component B (merge queue + request_merge) and Component C (board status + approval UI + modes) — plans not yet written.
<!-- SECTION:NOTES:END -->
