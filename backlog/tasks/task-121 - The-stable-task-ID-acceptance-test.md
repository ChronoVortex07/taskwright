---
id: TASK-121
title: The stable-task-ID acceptance test
status: In Progress
assignee: []
created_date: '2026-07-12 16:43'
updated_date: '2026-07-13 00:10'
labels:
  - stable-task-ids
  - testing
milestone: Stable Task IDs
dependencies:
  - TASK-117
  - TASK-119
  - TASK-120
references:
  - docs/superpowers/plans/2026-07-12-stable-task-ids.md
priority: high
category: Core Board
claimed_by: '@agent/.worktrees/task-121-the-stable-task-id-acceptance-test'
worktree: .worktrees/task-121-the-stable-task-id-acceptance-test
claimed_at: '2026-07-13 08:03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Task 9 of the Stable Task IDs plan** — `docs/superpowers/plans/2026-07-12-stable-task-ids.md`. The final task.

Create `src/test/unit/stableTaskIds.integration.test.ts`. **This is the test that proves the *feature*, not its parts.**

Two cases:

1. **A reference written against a draft survives its promotion.** Author a draft, reference it by ID both **structurally** (`dependencies`) *and* **in prose** (in another task's description) — the prose is the case **no remap pass could ever have fixed**, and the whole reason stable IDs matter. Promote. Assert the promoted ID is unchanged and that both references still resolve.

2. **A legacy board reaches the same state after migration.** Seed `drafts/draft-3` (id `DRAFT-3`) with `TASK-9` depending on it. Run `runDraftIdMigration`. Assert the draft is **still a draft** with a stable ID, its inbound reference was remapped, and — critically — that promoting it *now* does not change the ID. The invariant must hold on a migrated board, not just a fresh one.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Case 1 passes: a draft referenced structurally (dependencies) AND in prose (a description) keeps both references valid across promotion; the promoted id equals the draft id.
- [x] #2 Case 2 passes: a seeded legacy board (drafts/draft-3 + TASK-9 depending on DRAFT-3) migrates so the draft stays a draft with a stable id and TASK-9's dependency is remapped.
- [x] #3 Case 2 also asserts the invariant holds POST-migration: promoting the migrated draft does not change its id, and the inbound reference still resolves.
- [x] #4 The prose-reference assertion is present and meaningful — it is the case a remap pass could never fix, and the reason the feature exists.
- [x] #5 bun run test, bun run lint, bun run typecheck all pass — whole suite green.
- [x] #6 The dangling-reference gap TASK-118 flagged is closed: remapIds scans completed/ and both archive/ folders, so an inbound reference held there is remapped, not left pointing at a deleted id.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Created `src/test/unit/stableTaskIds.integration.test.ts` (10 tests) — the acceptance test for the whole Stable Task IDs chain (TASK-113…TASK-120). Structure:

**Case 1 — fresh board.** A draft is minted with a real TASK-N id, referenced both structurally (`dependencies`) and IN PROSE (another task's description), then promoted. Asserts `promoteDraft` returns the same id, the dependency still resolves, and the sentence still names a task that exists. Plus a demote→promote round-trip that keeps one id throughout.

**Case 2 — legacy board.** Seeds `drafts/draft-3` (id `DRAFT-3`) + `TASK-9` depending on it and naming it in prose, runs `runDraftIdMigration`, and asserts: the draft is STILL a draft with a stable id; the structural inbound reference was remapped; the migration is idempotent; and — the AC-3 point — a reference written against the MIGRATED id (structural + prose) survives promoting it, i.e. the invariant holds on a migrated board, not just a fresh one.

Case 2 also **characterizes the unrepairable half deliberately**: after migration `TASK-9`'s description still says `DRAFT-3`, and `DRAFT-3` no longer exists on the board. Asserted, not dodged. No remap pass can rewrite free text, and a heuristic that tried would corrupt real prose — which is exactly why the fix had to be "never change an id" rather than "remap harder". That assertion is the reason the feature exists (AC-4).

**THE GAP TASK-118 FLAGGED — found, reproduced, and FIXED in `idRemap.ts` (not papered over).**
`remapIds` scanned only `getTasks()` + `getDrafts()` — the LIVE board. Case 3 seeds inbound references held by a **completed** task, an **archived** task (`archive/tasks/`, with `dependencies` + `parent_task_id` + `references[]`), and an **archived draft** (`archive/drafts/`, with a bug `caused_by`). All three failed on first run, pointing at a `DRAFT-3` that the migration had just deleted. The fix widens the scan to every folder an id can occupy: `tasks` + `drafts` + `completed` + BOTH archive subfolders.

Widening is the right call, not a convenience: archiving is a documented **soft delete** (`restoreArchivedTask` returns the task to the live board, so a skipped reference comes back dangling), and a completed task's `dependencies` are the real record of what blocked it. A reference the remap cannot see dangles forever — the precise silent breakage this milestone exists to end. It is safe to walk all five folders **by construction**: since TASK-114 the id allocator scans all five, so an id names exactly one file board-wide and `parser.getTask` (which `updateTask`/`setCausedBy` resolve through) cannot land on the wrong file. No second pass in the migration, no new predicate. The "no writes when nothing matches" invariant is preserved and re-asserted for the new folders.

Also added 4 direct regression tests to `src/test/unit/idRemap.test.ts` (`scans every folder an id can occupy`) so the core's own suite guards the fix, not only the acceptance test; and updated the CLAUDE.md "Stable task IDs (one ID space)" bullet — the widened `remapIds` scan, the acceptance test's purpose, and `stableTaskIds.integration` added to the coverage list (TASK-120 deliberately left it out rather than document a file that did not exist).

Verify: `bun run test` 2264 passed / 155 files, `bun run lint`, `bun run typecheck` — all green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
**The Stable Task IDs invariant HOLDS end to end — after this task closed the one real leak in it.**

The milestone's promise is: *a task carries the id it will keep from creation, so a reference written against a draft stays valid forever.* The acceptance test now proves that as a property of the feature, not of its parts, on BOTH a fresh board and a migrated legacy one: a draft is minted `TASK-N`, referenced structurally and in prose, promoted — and the id, the dependency, and the sentence all still resolve. Promote and demote are pure moves; the id never moves under a reference.

**It did not hold when I started.** TASK-118 flagged the suspicion and left it for the acceptance test rather than papering over it, and the suspicion was correct: `remapIds` scanned only the live board (`tasks/` + `drafts/`), so a legacy-board migration left every inbound reference held by a **completed** or **archived** task pointing at an id it had just deleted. Three seeded references — a completed task's `dependencies`, an archived task's `dependencies`/`parent_task_id`/`references[]`, an archived draft's bug `caused_by` — all dangled. That is a genuine data-integrity bug (archive is a soft delete; restore would have returned a task to the board with a broken edge), and it is fixed at the root in `src/core/idRemap.ts`, which now scans every folder an id can occupy. Both callers — the migration and `promoteDrafts`' legacy re-id — get the fix at once, because there is one core.

**Where it still, honestly, leaks — and why that is by design, not an omission.** Prose written against a legacy `DRAFT-N` *before* the migration is unrecoverable. After converging a legacy board, `TASK-9`'s description still says "Blocked on DRAFT-3" and `DRAFT-3` no longer exists. No remap pass can rewrite free text, and a heuristic that tried would corrupt real prose. The test asserts this explicitly rather than hiding it: it is the exact damage the old id space did, and the reason the fix had to be *stable ids at birth* rather than a better remap. Going forward there is no leak — an id written into a spec, a handoff, a commit message, or a sentence is final from the moment `create_task` returns it. The residue is historical only (this repo's own TASK-77 description still cites a DRAFT-3 that never survived promotion), and it stops accruing here.

Net: 6 ACs met, one previously-unknown dangling-reference bug found and closed, `remapIds` now the single reference-rewriting core across all five folders. Whole suite green — 2264 tests, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
