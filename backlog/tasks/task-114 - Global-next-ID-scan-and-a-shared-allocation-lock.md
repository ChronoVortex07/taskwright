---
id: TASK-114
title: Global next-ID scan and a shared allocation lock
status: Done
assignee: []
created_date: '2026-07-12 16:41'
updated_date: '2026-07-12 21:54'
labels:
  - stable-task-ids
milestone: Stable Task IDs
dependencies: []
references:
  - docs/superpowers/plans/2026-07-12-stable-task-ids.md
  - src/core/BacklogWriter.ts
priority: high
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Task 2 of the Stable Task IDs plan** — `docs/superpowers/plans/2026-07-12-stable-task-ids.md`.

⚠️ **This MUST land before TASK-115 (`createDraft` mints a task ID).** Order is load-bearing — see below.

Modify `src/core/BacklogWriter.ts`:
- `getNextTaskId` (`:1041-1075`) — **signature changes**: it now takes the **backlog root**, not `tasksDir`, and scans `tasks/`, `drafts/`, `completed/`, `archive/tasks/`, `archive/drafts/`. Today it scans only `tasks/`, so a restored archived task can collide with a live one.
- `allocateAndWrite` (`:891-929`) — **signature changes**: it takes the backlog root so the lock lives in ONE shared `backlog/.locks/` directory regardless of which subfolder the file lands in.

**Why the lock must move.** `allocateAndWrite` is the mutex that fixed the TASK-48 concurrent-create clobber. It works by `mkdir`-ing a lock dir keyed on the numeric ID — but *inside the target directory*: `tasks/.task-N.lock` vs `drafts/.draft-N.lock`. **Two directories, two lock namespaces that cannot see each other.** That is harmless while the counters are separate, and a **live clobber race** the moment they share one. So this lands first, or a concurrent `create_task` and draft-create will both claim the same number — TASK-48, re-armed.

Confirm while implementing: `backlog/.locks/` is a NEW directory inside the board root — verify `BacklogParser` ignores it and the board-sync pathspec never commits it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `getNextTaskId` takes the backlog root and returns the max across `tasks/`, `drafts/`, `completed/`, `archive/tasks/`, and `archive/drafts/` — not `tasks/` alone.
- [x] #2 A restored archived task cannot collide with a live task (seed archive/tasks/task-12 with only task-2 live → next id is TASK-13).
- [x] #3 A legacy `draft-99` filename in drafts/ is ignored by the task-prefix scan (it does not carry the task prefix).
- [x] #4 `allocateAndWrite` locks in ONE shared `backlog/.locks/` namespace, so a concurrent createTask and createDraft cannot claim the same number.
- [x] #5 A concurrency test actually runs a create_task and a draft-create concurrently against one temp board and asserts distinct IDs (this is the TASK-48 clobber, re-armed by the shared counter — prove it, don't assume).
- [x] #6 `backlog/.locks/` is ignored by BacklogParser and never committed by the board-sync pathspec — verified, not assumed.
- [x] #7 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Both signatures changed in `src/core/BacklogWriter.ts`; new real-fs suite `src/test/unit/BacklogWriter.idAllocation.test.ts` (14 tests).

**1. `getNextTaskId(backlogPath, prefix, crossBranchIds?)`** — was `(tasksDir, ...)`. Scans the new private static `BacklogWriter.ID_SCAN_DIRS` = tasks, drafts, completed, archive/tasks, archive/drafts. The filename regex stays anchored on the configured `task_prefix`, so a legacy `draft-99 - X.md` in drafts/ contributes nothing to the max (and a custom-prefix board ignores a stray foreign-prefix file). `crossBranchIds` handling is unchanged.

**2. `allocateAndWrite(backlogPath, startId, lockDirName, buildFile)`** — was `(dir, ...)`. The lock dir is now `backlog/.locks/<name>` instead of `<targetDir>/<name>`, created lazily. Callers updated: `createTask` (:779/:781), `createDraft` (:874), `promoteDraft` (:439, previously passed `destDir` — that was the archive-collision bug in the promote path too).

**IMPORTANT — how the mutex actually works (TASK-115/116/117 must honor this).** The lock is `rmdir`'d as soon as the file is written, so it only guards an *overlapping* writer, not a later one starting from the same stale `startId`. Two allocators that run strictly sequentially with the same explicit startId will BOTH get that id (the `wx` flag doesn't save you — different titles mean different filenames). This is fine in production only because `scan → allocate` happen back-to-back, so a non-overlapping writer re-scans and sees the file. Consequence: any new code path must scan immediately before allocating; do not cache/reuse a scanned id across an await boundary. The concurrency test reproduces true overlap by nesting the second `allocateAndWrite` inside the first's `buildFile` (the window in which the first still holds the lock) — under the old per-directory lock both returned id 5, now the second sees the held claim and takes 6.

**Deliberately NOT done here (TASK-115's job).** `createDraft` still calls `getNextDraftId(draftsDir)` and still uses the `.draft-N.lock` name — drafts keep their separate DRAFT-N counter for now. Only the lock *location* moved. So TASK-115 must (a) repoint createDraft at `getNextTaskId(backlogPath, taskPrefix, ...)`, and (b) change its lock name to `.${lowerPrefix}-${id}.lock` — **identical to createTask's**. That shared *name*, in the now-shared *directory*, is what completes the mutex. Moving the counter without unifying the lock name would re-open the clobber. `getNextDraftId` is left in place (still used by `demoteTask`) — TASK-116 deletes it.

**AC#6 verified, not assumed.** `BacklogParser` only ever enumerates named subfolders (`getTasksFromFolder('tasks'|'drafts'|'completed'|'archive/tasks')`) and only `.md` files within them, so a `.locks/` dir at the backlog root is unreachable as content. Both sync engines are allow-lists, not deny-lists: `BOARD_SUBDIRS` (boardRef, what the ref snapshots) and `boardTrackedPaths()` (autoSync's staging pathspec) are both exactly `tasks, drafts, completed, archive, milestones`. `.locks` is in neither, so it cannot be staged or committed — no gitignore entry was needed. Regression tests pin both lists.

Note the existing `BacklogWriter.*.test.ts` suites fully mock `fs`; a mocked fs cannot prove a `mkdir`-EEXIST mutex, so the new suite runs against a real `mkdtemp` board (the pattern from `promoteDrafts.test.ts`).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
`getNextTaskId` now takes the backlog root and scans every folder a task id can occupy (tasks, drafts, completed, archive/tasks, archive/drafts), closing the latent bug where a restored archived task could collide with a live one. `allocateAndWrite` now takes the backlog root and locks in one shared `backlog/.locks/` namespace instead of inside the target directory — previously tasks/ and drafts/ had two lock namespaces that could not see each other, which is harmless with separate counters and a live clobber race (TASK-48, re-armed) the moment TASK-115 makes them share one.

Proven, not assumed: a new real-fs suite (14 tests) reproduces genuine writer overlap by nesting one allocation inside the other's held-lock window — under the old per-directory lock both writers claimed id 5; now the second takes 6. `.locks/` is verified inert against BacklogParser and against both sync pathspec allow-lists.

Drafts still mint DRAFT-N from their own counter — only the lock *location* moved. TASK-115 must also unify the lock *name* (`.${prefix}-${id}.lock`) when it repoints createDraft at the task counter, or the clobber re-opens. Full gate green: 2128 tests, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
