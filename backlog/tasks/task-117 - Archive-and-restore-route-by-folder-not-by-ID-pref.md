---
id: TASK-117
title: 'Archive and restore route by folder, not by ID prefix'
status: In Progress
assignee: []
created_date: '2026-07-12 16:42'
updated_date: '2026-07-12 23:19'
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
category: Core Board
claimed_by: '@agent/task-117-archive-and-restore-route-by-folder-not-by-id-prefix'
worktree: task-117-archive-and-restore-route-by-folder-not-by-id-prefix
claimed_at: '2026-07-13 07:11'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed (TASK-117 — archive/restore route by folder)

**`src/core/BacklogWriter.ts`**
- `archiveTask` now loads the task and routes by SOURCE FOLDER: `task.folder === 'drafts'` → `archive/drafts/`, else → `archive/tasks/`. (It also now throws `Task <id> not found` up front instead of relying on `moveTaskToFolder` to throw — same message, same contract.)
- `restoreArchivedTask` no longer branches on `taskId.startsWith('DRAFT-')` — **that branch is deleted**. It reads the archived file's PATH and returns it to the folder it came from (`archive/drafts/` → `drafts/`, `archive/tasks/` → `tasks/`).
- Two new exported pure helpers next to `idHasPrefix`: **`isArchivedDraftPath(filePath)`** and **`isArchivedPath(filePath)`** (path→posix, substring test). `moveTaskToFolder`'s backlog-root derivation used `filePath.includes('archive/tasks')` to decide "3 levels deep vs 2"; it now uses `isArchivedPath`, otherwise a restore out of `archive/drafts/` computed the backlog root as `backlog/archive` and would have moved the file to `backlog/archive/drafts/` (a no-op that silently loses the restore).

**`src/core/BacklogParser.ts` — the data-loss half (AC #4 CONFIRMED: it did NOT enumerate `archive/drafts/`)**
- `getTask` scanned `['tasks','drafts','completed','archive/tasks']`. An archived draft would have been **invisible** — unrestorable, unfindable. It now also scans `archive/drafts`.
- `getArchivedTasks()` now unions BOTH archive subfolders, so an archived draft shows in the board's Archive view (and in `createTaskCore`/`treeDerived`/`TaskDetailProvider`, which all read it) and can actually be restored by a human.
- `getTasksFromFolder` flattened only the literal `'archive/tasks'` to `folder: 'archive'`; it now flattens any `archive/*`. **Invariant for the chain: both archive subfolders report `folder: 'archive'` — the FILE PATH is the only record of which side a task was archived from, and that is what restore routes on.**

**Docs/descriptions:** the `archive_task` / `restore_task` MCP tool descriptions and the `archiveTaskHandler`/`restoreTaskHandler` doc comments said "or drafts/ for DRAFT- ids" — corrected to folder-routing language. (TASK-120 still owns the wider agent-facing description sweep, e.g. `create_task`'s `draft:` flag still says "DRAFT-N in drafts/".)

## Decisions
- **Folder wins in BOTH directions.** A legacy `DRAFT-N` file that happens to live in `tasks/` archives to `archive/tasks/` and restores to `tasks/`; a `TASK-N` draft archives to `archive/drafts/` and restores to `drafts/`. There is no id inspection anywhere on this path — no reuse of `idHasPrefix` was needed here (it stays the single legacy-draft predicate for promote/demote/migration).
- `archive/drafts/` has been scaffolded by `initBacklog` since day one and nothing had ever written to it; this is the first writer, so there is no legacy on-disk content to migrate for archives.

## For the downstream chain
- **TASK-118 (migration core):** a legacy board can have `DRAFT-N` files in **`archive/drafts/`** now, and `getArchivedTasks()`/`getTask()` see them. The plan's `plans/2026-07-12-stable-task-ids.md` §Task 6 already lists "legacy archived drafts to relocate from `archive/tasks/` to `archive/drafts/`" — that relocation is still TASK-118's, and it is now *safe*: the parser can see both sides. Reuse `isArchivedDraftPath` rather than writing a third path test.
- **TASK-121 (acceptance test):** the archive→restore round-trip of a `TASK-N` draft is covered in `src/test/unit/BacklogWriter.archiveFolder.test.ts`; the acceptance test can assert the end-to-end board invariant instead of re-proving it.
- A guard test in that same file walks all of `src/` (excluding `test/`), strips comments, and fails if any source file reintroduces `startsWith('DRAFT-')` — **the "no runtime branch on an id prefix" invariant is now enforced by the build** (AC #5).

## Tests
- New `src/test/unit/BacklogWriter.archiveFolder.test.ts` (11 tests, real temp board like the sibling pureMove/idAllocation suites): draft/task round-trips, the TASK-N-draft regression, status preservation, legacy `DRAFT-N` draft, the folder-beats-id case (a `DRAFT-9` file in `tasks/`), not-found throws, parser visibility (`getTask`, `getArchivedTasks`, and that an archived draft is NOT a live draft), and the id-prefix-branch guard. Written first — 6 of 11 failed RED.
- `src/test/unit/BacklogParser.multiFolder.test.ts`: its `getArchivedTasks` fs mock returned the same files for every folder, so the union doubled them — the mock is now path-aware (`onlyIn(subfolder, files)`), plus a new test that `archive/drafts/` is enumerated.
- Full suite: **2196 passed / 152 files**, lint + typecheck clean, prettier clean.
<!-- SECTION:NOTES:END -->
