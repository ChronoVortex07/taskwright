---
id: TASK-115
title: 'createDraft mints a task ID (TASK-N, not DRAFT-N)'
status: To Do
assignee: []
created_date: '2026-07-12 16:41'
updated_date: '2026-07-12 22:48'
labels:
  - stable-task-ids
milestone: Stable Task IDs
dependencies:
  - TASK-114
references:
  - .taskwright/docs/HANDOFF.md
priority: high
category: Core Board
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
- [ ] #1 `createDraft` mints a `TASK-N` id and writes to `drafts/task-N - Title.md`; the frontmatter `id:` matches.
- [ ] #2 Drafts and tasks share ONE counter: createTask → createDraft → createTask yields three distinct, strictly increasing ids.
- [ ] #3 A `TASK-N` draft is still parsed as a draft — `parser.getDrafts()` contains it, and `folder === 'drafts'` is the marker (no `draft: true` field, no id-prefix branch).
- [ ] #4 `getNextDraftId` is deleted, not merely unused.
- [ ] #5 Status-carrying drafts (P6/D2) still work: a draft can carry any real status, including Done.
- [ ] #6 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Carry-over from the TASK-114 merge (READ BEFORE IMPLEMENTING): TASK-114 moved `allocateAndWrite` onto one shared `backlog/.locks/` namespace but deliberately left `createDraft` on `getNextDraftId` + `.draft-N.lock` — only the lock's LOCATION moved. When this task repoints `createDraft` at the task counter it must ALSO switch the lock name to `.${lowerPrefix}-${id}.lock`, identical to `createTask`'s. Sharing the lock directory without sharing the lock NAME leaves the two writers non-contending and re-opens the TASK-48 ID-clobber race.

Also note: the lock only guards an OVERLAPPING writer (it is rmdir'd the instant the file is written), so any test that claims to prove the race must nest the second allocation inside the first's `buildFile` while the lock is still held; a sequential test passes for the test's reason, not the code's.

Session handoff with the full chain context: .taskwright/docs/HANDOFF.md
<!-- SECTION:NOTES:END -->
