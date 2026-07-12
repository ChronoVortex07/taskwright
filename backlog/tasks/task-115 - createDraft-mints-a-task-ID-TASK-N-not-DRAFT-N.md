---
id: TASK-115
title: 'createDraft mints a task ID (TASK-N, not DRAFT-N)'
status: In Progress
assignee: []
created_date: '2026-07-12 16:41'
updated_date: '2026-07-12 23:00'
labels:
  - stable-task-ids
milestone: Stable Task IDs
dependencies:
  - TASK-114
references:
  - .taskwright/docs/HANDOFF.md
priority: high
category: Core Board
claimed_by: '@agent/task-115-createdraft-mints-a-task-id-task-n-not-draft-n'
worktree: task-115-createdraft-mints-a-task-id-task-n-not-draft-n
claimed_at: '2026-07-13 06:49'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Task 3 of the Stable Task IDs plan** — `docs/superpowers/plans/2026-07-12-stable-task-ids.md`.

⚠️ **Blocked on TASK-114 by design.** If this lands before the shared allocation lock, a concurrent `create_task` and draft-create will both claim the same number — the TASK-48 clobber, re-armed by the shared counter. Do not reorder.

Modify `src/core/BacklogWriter.ts:818-875` (`createDraft`) and **delete** `getNextDraftId` (`:931-949`).

`createDraft` now returns `{ id: 'TASK-112', filePath: '<backlog>/drafts/task-112 - Title.md' }` — it mints from the *task* counter via the Task-2 `getNextTaskId` / shared-lock `allocateAndWrite`. The draft still parses as a draft because **`folder === 'drafts'` is the sole draftness marker** — which it already is, everywhere in the codebase. Do not introduce a `draft: true` frontmatter field.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `createDraft` mints a `TASK-N` id and writes to `drafts/task-N - Title.md`; the frontmatter `id:` matches.
- [x] #2 Drafts and tasks share ONE counter: createTask → createDraft → createTask yields three distinct, strictly increasing ids.
- [x] #3 A `TASK-N` draft is still parsed as a draft — `parser.getDrafts()` contains it, and `folder === 'drafts'` is the marker (no `draft: true` field, no id-prefix branch).
- [x] #4 `getNextDraftId` is deleted, not merely unused.
- [x] #5 Status-carrying drafts (P6/D2) still work: a draft can carry any real status, including Done.
- [x] #6 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
DONE (Task 3 of the Stable Task IDs plan). `createDraft` now mints from the TASK counter.

WHAT CHANGED (src/core/BacklogWriter.ts):
- `createDraft(backlogPath, parser?, opts?, crossBranchIds?)` — new 4th arg, mirroring `createTask`.
  It reads `task_prefix` / `zero_padded_ids` from config, calls `getNextTaskId(backlogPath, taskPrefix, crossBranchIds)` (the TASK-114 global scan), and writes `drafts/<lowerPrefix>-<paddedId> - Title.md` with `id: TASK-N`. A custom `task_prefix: STORY` + `zero_padded_ids: 3` board yields `STORY-004` in `drafts/story-004 - ….md`.
- THE CARRY-OVER, HONOURED: the lock name is now `.${lowerPrefix}-${id}.lock` — byte-identical to `createTask`'s — in the shared `backlog/.locks/` dir. TASK-114 moved only the lock's LOCATION; sharing the directory without sharing the NAME leaves the two writers non-contending and re-arms the TASK-48 clobber (each wins its own private lock, both write id N).
- `getNextDraftId` is DELETED (not merely unused). Its one other caller, `demoteTask`, now allocates its legacy DRAFT-N via `getNextTaskId(backlogPath, 'draft')` — the general scanner run over the legacy namespace, which is a strict superset of the old drafts/-only scan (it also sees a stray `draft-N` in archive/). No logic was copy-pasted out.
- No `draft:` frontmatter field, no id-prefix branch: `folder === 'drafts'` remains the sole draftness marker.

PROVING THE RACE (this is the part that matters):
`allocateAndWrite` is fully synchronous, so `Promise.all([createTask, createDraft])` does NOT overlap them — the first completes before the second starts and such a test passes on the scan alone, for the test's reason and not the code's. Two tests reproduce genuine contention in `src/test/unit/BacklogWriter.idAllocation.test.ts`:
1. "createDraft honours a lock held under the TASK name" — an externally held `.locks/.task-1.lock` (a concurrent createTask mid-write) must make createDraft skip to TASK-2.
2. "a REAL createDraft OVERLAPPING a REAL createTask gets a distinct id" — spies `reconstructFile` (called from inside createTask's `buildFile`, i.e. while the outer lock is still held) and, from there, calls `writer.createDraft(backlogPath, undefined, …)`. With no parser there is no `await` before its `allocateAndWrite`, so the inner allocation runs SYNCHRONOUSLY inside the outer's lock window. Outer gets TASK-1, inner must get TASK-2.
Both were confirmed FALSIFYING: reverting only the lock name to `.draft-${id}.lock` (keeping the shared counter and dir) turns exactly these two red.

FOR THE DOWNSTREAM CHAIN:
- TASK-116 (promote/demote as pure moves): `promoteDraft` still re-ids — a stable-id draft TASK-1 promotes to a FRESH TASK-2 today, because `getNextTaskId` now counts the draft itself. That interim is harmless only because `promoteDrafts` remaps inbound refs when `from !== to`. Make promote a pure move and this disappears. `demoteTask` still re-ids TASK-N → DRAFT-N and remaps NOTHING (pre-existing bug) — delete its `getNextTaskId(backlogPath, 'draft')` call when you rewrite it, and grep for the "LEGACY (TASK-115)" comment I left there.
- TASK-117 (archive/restore by folder): `restoreArchivedTask` still branches on `taskId.startsWith('DRAFT-')` (BacklogWriter ~:397). It is now provably wrong — a TASK-N draft archives to `archive/tasks/` and restores to `tasks/`. Untouched here by design; it is your task.
- TASK-118 (migration): the id you migrate a legacy DRAFT-N onto must come from `getNextTaskId`, which already scans drafts/ — so a stable-id draft cannot be clobbered by the migration.
- TASK-120 (descriptions): `src/mcp/server.ts` still says "Create as a draft (DRAFT-N in drafts/)" and the promote/demote tool descriptions still promise DRAFT-N. Deliberately left for you — it is now a lie.

TESTS UPDATED TO THE NEW CONTRACT (not weakened): `BacklogWriter.drafts.test.ts` (createDraft → TASK-N, plus a new "ignores a legacy draft-N filename when minting"), `BacklogWriter.idAllocation.test.ts` (+6 stable-id tests incl. the two contention proofs), `mcpWriteHandlers.test.ts`, `mcpReadHandlers.test.ts` (draft flag asserted from the FOLDER, on a TASK-N id), `nextReadyTasks.test.ts`. The bulk-promote test now asserts the INVARIANT ("the inbound dep points at Base's promoted id", read from `res.promoted`) rather than a literal id, so it survives TASK-116 unchanged.

Verify: bun run test (2168 passed / 150 files), bun run lint, bun run typecheck — all green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
`createDraft` mints a stable `TASK-N` id from the shared task counter and writes `drafts/task-N - Title.md`; a draft is now `TASK-112`, not `DRAFT-3`, and `folder === 'drafts'` remains the sole draftness marker (no `draft:` field, no id-prefix branch). Critically, the allocation lock NAME was switched to `.${lowerPrefix}-${id}.lock` — identical to `createTask`'s — because TASK-114 shared only the lock DIRECTORY, and a shared counter with unshared lock names would have re-armed the TASK-48 ID-clobber race; two tests reproduce genuine writer overlap (one allocating inside the other's held lock window) and were confirmed to go red if the name diverges. `getNextDraftId` is deleted, with `demoteTask`'s legacy DRAFT-N path reusing the general `getNextTaskId` scanner until TASK-116 makes demote a pure move.
<!-- SECTION:FINAL_SUMMARY:END -->
