---
id: TASK-37
title: Board-root resolution core — resolveBoardRoot() → primary worktree's backlog/
status: Done
assignee: []
created_date: '2026-07-04 04:34'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Board Sync v2 — Single Shared Board
dependencies: []
priority: high
category: Sync
plan: docs/superpowers/specs/2026-07-04-board-sync-v2-single-shared-board-design.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Foundation for Board Sync v2 (see docs/superpowers/specs/2026-07-04-board-sync-v2-single-shared-board-design.md §2.1). Add a pure helper that resolves the ONE physical board directory — the primary worktree's `backlog/` — from any worktree.

Scope:
- New pure core (e.g. src/core/boardRoot.ts) `resolveBoardRoot(gitOutput|repoRoot)`: parse `git worktree list --porcelain`; the FIRST `worktree ` entry is the primary working tree; board root = `<primary>/backlog`. Handle: run from primary, run from a `.worktrees/<branch>` worktree, and a plain non-worktree repo (returns its own backlog/).
- Keep the git invocation thin and injectable so the parsing is unit-tested against captured porcelain output (no live git in the unit test).
- Do NOT wire consumers yet — that is task B. This task ships the helper + tests only.

Acceptance:
- Given porcelain output from a worktree, returns the primary's backlog path (not the worktree's).
- Given a single-worktree repo, returns that repo's backlog path.
- Cross-platform path handling (path.*), covered by tests that pass on Linux/CI.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
