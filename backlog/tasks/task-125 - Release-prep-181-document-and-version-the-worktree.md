---
id: TASK-125
title: >-
  Release prep 1.8.1: document and version the worktree-entry, board-sync and
  tree-band fixes
status: In Progress
assignee: []
created_date: '2026-07-12 17:34'
updated_date: '2026-07-12 17:34'
labels: []
dependencies:
  - TASK-122
  - TASK-123
  - TASK-124
priority: medium
category: 'Docs & Branding'
claimed_by: '@agent/task-125-release-prep-1-8-1-document-and-version-the-worktree-entry-board-sync-and-tree-band-fixes'
worktree: task-125-release-prep-1-8-1-document-and-version-the-worktree-entry-board-sync-and-tree-band-fixes
claimed_at: '2026-07-13 01:34'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
TASK-122, TASK-123 and TASK-124 landed on main as three bug fixes. Ship them: bump the version to 1.8.1 (patch — all three are bug fixes, no new features), add a CHANGELOG section, and record the architectural facts in CLAUDE.md so future agents do not reintroduce them.

Facts worth carrying forward:
- Taskwright worktrees are plain git worktrees; the harness worktree-switch tool (EnterWorktree) can never open one, and every instruction surface now says so. A start_task-bootstrapped session is still MCP-rooted in the primary tree and closes with request_merge { taskId, worktree }; a bare call returns the new `wrong_root` abort code, which is a misuse, NOT a cancellation.
- git-auto migration verification classifies failures (absent | eol-only | content-drift), tolerates git's own text=auto EOL normalization, and folds a drifted board worktree instead of wedging the repo forever.
- Backburner is a RESERVED tree band: it must appear exactly once and last in bandOrder, because the webview keys the band {#each} by name and a duplicate name throws each_key_duplicate, which renders the entire tree canvas blank.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 package.json version is 1.8.1.
- [ ] #2 CHANGELOG.md has a [1.8.1] section dated 2026-07-13 with a Fixed entry for each of TASK-122, TASK-123 and TASK-124, each naming the root cause.
- [ ] #3 CLAUDE.md records the three invariants (worktree entry mechanism + wrong_root, migration EOL/drift tolerance, reserved Backburner band) so they are not reintroduced.
- [ ] #4 bun run test && bun run lint && bun run typecheck all pass.
<!-- AC:END -->
