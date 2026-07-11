---
id: TASK-28
title: Sync-mode create_task → claim_task race silently deletes the just-created task
status: Done
assignee: []
created_date: '2026-07-03 20:31'
updated_date: '2026-07-04 00:42'
labels:
  - bug
  - sync
milestone: 'Worktree Safety, Merge Queue & Synced Board'
dependencies: []
priority: high
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Bug in the synced-board sync engine (taskwright.sync.mode = local/github).

Repro (sync.mode=github): call MCP `create_task`, then `claim_task` within one poll interval.
- `create_task` writes the task file only to the LOCAL materialized `backlog/tasks/` — it does NOT snapshot+push to the `taskwright-board` ref.
- The following `claim_task` runs the engine's fetch→materialize, which PRUNES local board files that are absent from the ref — silently deleting the just-created (unpushed) task file.

Expected: in sync mode, `create_task` should snapshot+push the new file to the board ref (like claim/release do), OR the materialize/prune step should first snapshot local-only files rather than deleting them. Either way, a create immediately followed by a claim must not lose the task.

Cause: the synced-board sync engine work (`src/core/boardSyncEngine.ts` / `boardRef.ts` materialize-prunes-absent-files behavior); `create_task`/`edit_task` are documented as local-only writes while only claim/release route through the engine — so a created-but-unpushed task is vulnerable to the next poll's prune. Discovered during the tech-tree autonomous run (run-notes item 1). Related: TASK-24 (stale origin/main materialize), TASK-26 (re-materialize every poll) — both fixed; this create/claim race is distinct and still open.

Workaround used during the run: after MCP create_task/edit_task, immediately isolated-index sha-push the changed file to `refs/heads/taskwright-board` and re-heal `.taskwright/board.materialized`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
