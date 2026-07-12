---
id: TASK-118
title: The draft-ID migration core (legacy DRAFT-N boards)
status: In Progress
assignee: []
created_date: '2026-07-12 16:42'
updated_date: '2026-07-12 23:29'
labels:
  - stable-task-ids
milestone: Stable Task IDs
dependencies:
  - TASK-113
  - TASK-116
references:
  - docs/superpowers/plans/2026-07-12-stable-task-ids.md
priority: high
category: Core Board
claimed_by: '@agent/task-118-the-draft-id-migration-core-legacy-draft-n-boards'
worktree: task-118-the-draft-id-migration-core-legacy-draft-n-boards
claimed_at: '2026-07-13 07:22'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Task 6 of the Stable Task IDs plan** — `docs/superpowers/plans/2026-07-12-stable-task-ids.md`.

Create `src/core/draftIdMigration.ts` — a pure planner + executor that converges a legacy `DRAFT-N` board onto stable task IDs.

**The migration must NOT promote.** A legacy draft must stay a draft, so the migration does its own rename **within `drafts/`**. It re-IDs in place and remaps inbound references through `remapIds` (TASK-113).

```ts
export interface DraftIdMigrationPlan {
  renames: Array<{ oldId: string; newId: string; fromPath: string; toPath: string }>;
  /** Legacy archived drafts to relocate from archive/tasks/ to archive/drafts/. */
  relocations: Array<{ id: string; fromPath: string; toPath: string }>;
}
export function planDraftIdMigration(drafts, archived, config, nextId, backlogPath): DraftIdMigrationPlan;
export function isLegacyDraftBoard(plan: DraftIdMigrationPlan): boolean;
export async function runDraftIdMigration(deps: IdRemapDeps, backlogPath: string): Promise<{ migrated: number; mapping: Array<{ from: string; to: string }> }>;
```

**Must be idempotent: a board with no legacy drafts performs ZERO writes.** TASK-118 calls `runDraftIdMigration`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `planDraftIdMigration` is pure and yields an EMPTY plan for a board with no legacy drafts (zero renames, zero relocations).
- [x] #2 It plans a legacy `DRAFT-3` onto a fresh id above the current max across all folders.
- [x] #3 It plans relocations for legacy archived drafts sitting in `archive/tasks/` → `archive/drafts/`.
- [x] #4 `runDraftIdMigration` re-ids legacy drafts IN PLACE — they stay in `drafts/`, it never promotes.
- [x] #5 Inbound references are remapped via the shared `remapIds` core (TASK-113), so `parent_task_id` / `subtasks` / `references[]` are covered, not just dependencies.
- [x] #6 IDEMPOTENT: running it twice, or on a clean board, performs zero writes (assert on file mtimes or a write spy, not just on the return value).
- [x] #7 Frontmatter byte-compatibility and CRLF/LF are preserved across every rename.
- [x] #8 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Task 6 of the Stable Task IDs plan. New pure core `src/core/draftIdMigration.ts` + 20 tests in `src/test/unit/draftIdMigration.test.ts`; two supporting methods added to `BacklogWriter`.

## What shipped

**`src/core/draftIdMigration.ts`** (vscode-free), exactly the plan's three exports:
- `planDraftIdMigration(drafts, archived, config, nextId, backlogPath) → DraftIdMigrationPlan` — **pure**, no fs at all. `renames` (legacy drafts → fresh ids, dependency-first via a cycle-safe `topoOrder`, so prerequisites take lower ids) + `relocations` (legacy archived drafts → `archive/drafts/`).
- `isLegacyDraftBoard(plan)` — the zero-write gate.
- `runDraftIdMigration(deps: IdRemapDeps, backlogPath)` — the executor. Returns `{ migrated, mapping }`.

**`BacklogWriter`** gained two methods (both used only by the migration today):
- `peekNextTaskId(backlogPath, prefix)` — public wrapper on the private global next-id scan. Peeks WITHOUT claiming, because the migration plans a whole batch off one scan. It therefore takes **no lock**, so it is only safe when nothing else is minting ids concurrently — TASK-119's contract is to run it under the board lock.
- `reidTaskFile(fromPath, toPath, newId, parser)` — rename + rewrite the frontmatter `id` **in place**, no folder move. Preserves status (a Done draft stays Done), every other field, and CRLF/LF via the existing `detectCRLF`/`normalizeToLF`/`restoreLineEndings` sandwich + `atomicWriteFileSync`. It is a no-op-rename when `from === to` (resolved-path compare), so it can be called defensively.

## Key decisions (things the downstream chain must honor)

1. **Order is load-bearing and is asserted by the tests.** The executor does relocations → re-ids → `remapIds`, in that order, because `remapIds` re-reads the board from disk. Remapping first would rewrite references to ids that do not exist yet. TASK-119 must not reorder or interleave.
2. **A migrated draft STAYS a draft.** The migration re-ids within `drafts/`; it never calls `promoteDraft`. `folder === 'drafts'` remains the sole draftness marker.
3. **Legacy detection reuses `idHasPrefix` (TASK-116)** — no second predicate, no literal `DRAFT-` test. A `STORY`-prefixed board classifies `STORY-4` as its own and performs zero writes (covered).
4. **Relocation reuses `isArchivedDraftPath` (TASK-117)** — `archived.filter(t => !isArchivedDraftPath(t.filePath) && !idHasPrefix(t.id, prefix))`. No third path test was written. Requires TASK-117's parser change (`getArchivedTasks()` enumerates BOTH archive subfolders) — it does.
5. **Archived legacy drafts are relocated but NOT re-id'd.** They are not on the board. If restored, one lands in `drafts/` as a legacy draft and the next migration pass converges it. Convergence by design, not an unhandled case.
6. **Idempotence is asserted with teeth** (AC #6): mtime + byte-content snapshot of the whole board AND `vi.spyOn` over every write path (`writer.reidTaskFile`, `writer.updateTask`, `treeFieldService.setCausedBy`) — never merely the return value. A clean board, a converged board, and a custom-prefix board all perform zero writes.

## Known limitation TASK-121 (acceptance test) should be aware of

`remapIds` (TASK-113) scans `getTasks()` + `getDrafts()` only. A **completed** or **archived** task holding `dependencies: [DRAFT-3]` is therefore NOT remapped by the migration. This is inherited from the shared core (AC #5 says to delegate to it), not introduced here — but if the acceptance test seeds an inbound reference from `completed/`, it will fail. Widening `remapIds`' scan is the fix, and it belongs in `idRemap.ts`, not in a second pass here.

## TASK-119 wiring notes

- Call `runDraftIdMigration({ parser, writer, treeFieldService }, backlogRoot)`. Deps type is `IdRemapDeps` — structurally identical to what `promoteDrafts` already takes.
- It is safe to call unconditionally at activation/MCP-startup: an empty plan short-circuits before touching the filesystem.
- `peekNextTaskId` is lock-free — take the cross-process board lock around the whole call, as the plan's Task 7 Step 2 requires, or two concurrent migrations (extension host + MCP server) can both scan the same `nextId`.

Verified: `bun run test` 2216/2216 across 153 files, `bun run lint`, `bun run typecheck` all clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added `src/core/draftIdMigration.ts` — the pure planner + executor that converges a legacy `DRAFT-N` board onto stable task IDs. A legacy draft is re-ID'd **in place** to a fresh `TASK-N` (it stays a draft — a re-ID is not a promotion), legacy archived drafts relocate from `archive/tasks/` to `archive/drafts/` so the folder-routed restore finds them, and every inbound reference is rewritten through the shared `remapIds` core (so `parent_task_id`/`subtasks`/`references[]` move with dependencies and `caused_by`). Legacy detection reuses the one `idHasPrefix` predicate, so a custom-prefix board does not churn its own drafts. Idempotent: a clean or converged board performs zero writes, asserted on mtimes and write spies. Backed by two new `BacklogWriter` methods — `peekNextTaskId` (lock-free global next-ID scan) and `reidTaskFile` (rename + rewrite the frontmatter ID, preserving status, all other fields, and CRLF/LF). 20 new tests; full suite (2216), lint and typecheck green.
<!-- SECTION:FINAL_SUMMARY:END -->
