---
id: TASK-105
title: Recover safely from orphaned Windows worktree directories
type: bug
status: In Progress
assignee: []
created_date: '2026-07-11 07:38'
updated_date: '2026-07-11 07:40'
labels: []
dependencies: []
priority: high
category: Worktrees & Merge
claimed_by: '@agent/task-105-recover-safely-from-orphaned-windows-worktree-directories'
worktree: task-105-recover-safely-from-orphaned-windows-worktree-directories
claimed_at: '2026-07-11 15:40'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Fix the retry hazard observed after TASK-97 and TASK-104 merged on Windows. request_merge unregisters the worktree but the server process cwd can keep the now-empty top-level directory alive; createWorktree currently treats any existing directory as a reusable Git worktree, which can relaunch an agent into an empty folder.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 createWorktree reuses an existing directory only when git worktree list confirms it is registered
- [ ] #2 An empty unregistered directory left by Windows cleanup is removed and recreated as a valid worktree
- [ ] #3 A non-empty unregistered directory is never deleted or reused and produces an actionable error
- [ ] #4 Path comparison handles platform normalization and Windows case differences
- [ ] #5 Unit tests cover registered, empty-orphan, and non-empty-orphan behavior
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add failing WorktreeService tests for empty and non-empty orphan directories.
2. Validate existing paths against git worktree list --porcelain before reuse.
3. Remove only verified-empty orphan directories; fail closed otherwise.
4. Run all required gates and merge through Taskwright.
<!-- SECTION:PLAN:END -->
