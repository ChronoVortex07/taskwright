---
id: TASK-15
title: >-
  Prevent multi-agent worktree escape and infighting (isolation + auto-merge +
  merge right-of-way)
status: To Do
assignee: []
created_date: '2026-06-30 17:24'
updated_date: '2026-06-30 17:24'
labels:
  - bug
  - agent-orchestration
dependencies: []
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
<!-- AC:END -->
