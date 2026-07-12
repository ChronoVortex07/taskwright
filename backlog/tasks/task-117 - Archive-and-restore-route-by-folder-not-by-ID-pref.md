---
id: TASK-117
title: 'Archive and restore route by folder, not by ID prefix'
status: To Do
assignee: []
created_date: '2026-07-12 16:42'
updated_date: '2026-07-12 16:42'
labels:
  - stable-task-ids
milestone: Stable Task IDs
dependencies:
  - TASK-115
references:
  - docs/superpowers/plans/2026-07-12-stable-task-ids.md
  - src/core/BacklogWriter.ts
  - src/core/BacklogParser.ts
priority: high
category: 'Core Board'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Task 5 of the Stable Task IDs plan** — `docs/superpowers/plans/2026-07-12-stable-task-ids.md`.

Modify `src/core/BacklogWriter.ts:371-386` (`archiveTask`, `restoreArchivedTask`).

`restoreArchivedTask:384` is the **last runtime branch on an ID prefix in the codebase**: `taskId.startsWith('DRAFT-') ? 'drafts' : 'tasks'`. With a draft named `TASK-112` it can no longer work — a restored draft would land in `tasks/`. Route by **folder**, the invariant that already holds everywhere else. This task deletes that branch.

`archiveTask` sends a draft to `archive/drafts/`; `restoreArchivedTask` returns it to `drafts/`. No signature change.

⚠️ **Confirm, do not assume:** the plan flags that `BacklogParser` **may not enumerate `archive/drafts/` at all** (it reads `archive/tasks` today). If it doesn't, an archived draft becomes invisible to `getTask` — that is **data loss**, not cosmetics. A test for exactly this is required.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `archiveTask` sends a draft to `archive/drafts/` and a task to `archive/tasks/`.
- [ ] #2 `restoreArchivedTask` returns a draft to `drafts/` and a task to `tasks/` — routed by FOLDER, never by ID prefix.
- [ ] #3 A `TASK-N` draft survives an archive → restore round-trip with its id and draftness intact (the regression the old `startsWith('DRAFT-')` branch could not survive).
- [ ] #4 CONFIRMED (with a test): `BacklogParser` enumerates `archive/drafts/` so an archived draft is visible to `getTask`. If it did not before, it does now — an invisible archived draft is data loss.
- [ ] #5 The `taskId.startsWith('DRAFT-')` branch is deleted — no runtime branch on an ID prefix remains in the codebase.
- [ ] #6 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->
