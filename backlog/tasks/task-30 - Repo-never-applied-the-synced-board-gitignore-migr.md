---
id: TASK-30
title: Repo never applied the synced-board .gitignore migration block
status: Done
assignee: []
created_date: '2026-07-04 00:12'
updated_date: '2026-07-04 00:42'
labels:
  - bug
  - sync
milestone: 'Worktree Safety, Merge Queue & Synced Board'
dependencies: []
priority: medium
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Discovered while closing TASK-28/29: this repo has `taskwright.sync.mode: github` configured, but `.gitignore` never received the fenced sync-migration block that `src/core/boardMigration.ts`'s `applyBoardIgnore`/`boardTrackedPaths` exist to add (normally applied once via the `taskwright.enableSync` command). As a result every `claim_task`/`create_task` that materializes the board leaves `backlog/{tasks,drafts,completed,archive}/` as **untracked** files instead of silently ignored, which repeatedly tripped `request_merge`'s clean-worktree gate (`isWorktreeClean` in `src/core/finishTask.ts` requires `git status --porcelain` to be fully empty) during TASK-28/29's close-out — three separate times, each requiring a fresh manual `rm -rf backlog/tasks/` and explicit re-authorization.

Fix: add the fenced block to `.gitignore`:
```
# >>> taskwright synced board >>>
# Board tasks live on the taskwright-board ref, not on code branches.
backlog/tasks/
backlog/drafts/
backlog/completed/
backlog/archive/
# <<< taskwright synced board <<<
```
Nothing is currently git-tracked at these paths (`git ls-files backlog/` shows only `config.yml`), so this is a pure addition — no `git rm --cached` needed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Confirmed nothing was git-tracked at backlog/{tasks,drafts,completed,archive} before this change (`git ls-files backlog/` showed only config.yml). Added the fenced block matching exactly what `boardMigration.ts`'s `applyBoardIgnore`/`boardIgnoreBlock` already generate. Verified with `git check-ignore -v` that all four subdirs are now ignored, and that `git status --porcelain` no longer lists the materialized backlog/tasks/ directory as untracked even with 27 real task files present on disk. Full suite/lint/typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the missing synced-board .gitignore fenced block (backlog/{tasks,drafts,completed,archive}/) to this repo's .gitignore, matching what boardMigration.ts's one-time migration was always meant to apply. Materialized board files no longer show as untracked, which had repeatedly blocked request_merge's clean-worktree gate during TASK-28/29's close-out. Pure addition, no tracked files affected.
<!-- SECTION:FINAL_SUMMARY:END -->
