---
id: TASK-55
title: Route extension-UI board writes (create/edit/drag) through sync snapshot+push
status: To Do
assignee: []
created_date: '2026-07-04 00:40'
updated_date: '2026-07-04 09:36'
labels: []
milestone: 'Worktree Safety, Merge Queue & Synced Board'
dependencies:
  - TASK-54
priority: high
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Known gap documented in CLAUDE.md's synced-board section: every MCP board write tool routes through applyBoardWriteSynced/withSyncedBoardWrite when sync mode != off (fixed for the MCP surface by TASK-28), but extension-UI writes — TasksController create/edit/drag — still land only in the materialized local copy without snapshot+push. The next poll's materialize can silently prune or overwrite a UI-originated write, the same failure class TASK-28 fixed for the MCP path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 TasksController create/edit/drag routes through applyBoardWriteSynced (or an equivalent snapshot+push CAS loop) when taskwright.sync.mode !== 'off'
- [ ] #2 A regression test proves a UI-originated create/edit/reorder survives the next board poll's materialize instead of being silently pruned or overwritten
- [ ] #3 Manual verification: two clones/sessions with sync on, one edits via the UI, the other's next poll reflects the change instead of clobbering it
<!-- AC:END -->
