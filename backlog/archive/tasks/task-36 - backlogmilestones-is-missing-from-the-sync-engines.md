---
id: TASK-36
title: >-
  backlog/milestones/ is missing from the sync engine's board paths — milestones
  never round-trip through the synced-board ref
type: bug
status: To Do
assignee: []
created_date: '2026-07-04 01:01'
updated_date: '2026-07-04 09:36'
labels: []
dependencies: []
priority: medium
caused_by: TASK-27
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during the 2026-07-04 /index-codebase tree bootstrap. `BOARD_SUBDIRS` (src/core/boardRef.ts:19) and `SUBDIRS` (src/core/boardMigration.ts:7) both hardcode `['tasks', 'drafts', 'completed', 'archive']` — `milestones` was never added, even though P6 (TASK-27) introduced `backlog/milestones/*.md` as real board-data files via `create_milestone`.

Consequences on a `taskwright.sync.mode: github` board: (1) `git status` shows `backlog/milestones/` as untracked and NOT gitignored (the TASK-30 migration block only lists tasks/drafts/completed/archive), so it's noise against the clean-tree gate the same way TASK-30 already fixed for the other four dirs. (2) More importantly, `materializeRefToWorktree`'s non-board-path guard (boardRef.ts ~195-203) and whatever snapshot step feeds `snapshotBoardToRef` are scoped to `BOARD_SUBDIRS` — so milestone files created via `create_milestone` are written locally (correct, since BacklogWriter writes straight to disk) but likely never get committed+pushed to the `taskwright-board` ref, meaning they don't propagate to other clones/sessions and are at risk of being treated as foreign/untracked cruft on the next materialize.

Fix: add `'milestones'` to both `BOARD_SUBDIRS` and `SUBDIRS`, extend the .gitignore migration block (boardMigration.ts) to include it, and add regression coverage that a `create_milestone` call while sync mode is on round-trips through fetch→materialize→push like `create_task` already does (mirroring TASK-28's regression test for the create/claim race).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
