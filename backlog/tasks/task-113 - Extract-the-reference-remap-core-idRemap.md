---
id: TASK-113
title: Extract the reference-remap core (idRemap)
status: In Progress
assignee: []
created_date: '2026-07-12 16:41'
updated_date: '2026-07-12 21:38'
labels:
  - stable-task-ids
milestone: Stable Task IDs
dependencies: []
references:
  - docs/superpowers/plans/2026-07-12-stable-task-ids.md
  - docs/superpowers/specs/2026-07-12-stable-task-ids-design.md
  - src/core/promoteDrafts.ts
priority: high
category: Core Board
claimed_by: '@agent/task-113-extract-the-reference-remap-core-idremap'
worktree: task-113-extract-the-reference-remap-core-idremap
claimed_at: '2026-07-13 05:29'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Task 1 of the Stable Task IDs plan** — `docs/superpowers/plans/2026-07-12-stable-task-ids.md` (read that task's section for the full step-by-step, exact code, and test cases).

Create a pure `src/core/idRemap.ts` that rewrites every inbound reference to a set of renamed IDs, and repoint `promoteDrafts`' remap pass (`src/core/promoteDrafts.ts:96-125`) at it.

`promoteDrafts` today rewrites only `dependencies` and bug `caused_by`. It **silently dangles `parent_task_id`, `subtasks`, and `references[]`** — three real gaps. The migration (Task 6) would reintroduce all three if it rolled its own pass, so extract one core and fix them once.

Produces:
```ts
export interface IdRemapDeps { parser: BacklogParser; writer: BacklogWriter; treeFieldService: TreeFieldService; }
export function remapIds(deps: IdRemapDeps, oldToNew: Map<string, string>): Promise<string[]>;
```
Returns the IDs of every task whose references were rewritten. `oldToNew` keys are **uppercased**. Task 6 calls this.

No dependency on the other tasks — this can start immediately, in parallel with Task 2.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `src/core/idRemap.ts` exists as a pure, vscode-free core exporting `remapIds(deps, oldToNew)` with the signature above.
- [x] #2 It rewrites ALL five reference kinds: `dependencies`, bug `caused_by`, `parent_task_id`, `subtasks`, and `references[]` — the last three are the gaps `promoteDrafts` silently dangles today.
- [x] #3 `src/core/promoteDrafts.ts` delegates its remap pass to `remapIds` rather than duplicating it; its existing behavior is unchanged (its tests still pass).
- [x] #4 Unit tests in `src/test/unit/idRemap.test.ts` cover each reference kind, uppercase key handling, and a no-op remap performing zero writes.
- [x] #5 Writes preserve frontmatter byte-compatibility and CRLF/LF (go through BacklogWriter's reconstructFile / atomicWriteFileSync; follow the detectCRLF / normalizeToLF / restoreLineEndings sandwich).
- [x] #6 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Extracted the reference-remap pass into a pure, vscode-free core `src/core/idRemap.ts` exporting `IdRemapDeps` + `remapIds(deps, oldToNew): Promise<string[]>`, and repointed `promoteDrafts` at it. TDD: 15 tests written first (failed on the missing module), then implementation.

Key findings and decisions:

1. **`BacklogWriter.updateTask` did NOT support two of the three gap fields.** The plan flagged this as a thing to verify, and it was real: `updateTask` mapped `references` but had no branch for `parentTaskId` or `subtasks`, so the remap would have silently no-op'd on exactly two of the gaps it exists to close. Extended `updateTask` to write `frontmatter.parent_task_id` / `frontmatter.subtasks`. No serializer change was needed — both keys were already in `FRONTMATTER_FIELD_ORDER` and `FRONTMATTER_OMIT_IF_EMPTY`, so byte-compatible field order and empty-omission come for free.

2. **Whole-id comparison, never substring.** Ids are matched by `id.trim().toUpperCase()` lookup in the map — no regex/substring replace anywhere. Covered by a dedicated test: remapping DRAFT-1 on a task depending on `[DRAFT-1, DRAFT-11]` must not corrupt DRAFT-11.

3. **`references[]` holds non-id values** (paths, URLs — e.g. this very task references `docs/...` files). The shared `mapList` helper leaves any entry that is not a map key verbatim; test-covered.

4. **`causedBy` stays surgical.** It is a Taskwright tree field written via `TreeFieldService.setCausedBy`, not through `updateTask` — preserved that split. A task whose deps AND caused_by both change gets one `updateTask` + one `setCausedBy` and is reported in `remapped` exactly ONCE (test-covered).

5. **Surgical frontmatter survives an `updateTask` rewrite.** Verified `orderFrontmatter` appends non-ordered keys (`category`, `claimed_by`, `caused_by`) after the canonical ones rather than dropping them. Test asserts this. Note js-yaml re-emits `category: 'Core Board'` unquoted as `category: Core Board` (minimal valid YAML form) — pre-existing `updateTask` behavior, not introduced here, so the test asserts on the value, not the quoting.

6. **CRLF preserved** — writes go through `BacklogWriter.updateTask`'s existing detectCRLF/normalizeToLF/restoreLineEndings sandwich + `atomicWriteFileSync`. Explicit CRLF round-trip test added.

7. **`promoteDrafts` delegation** filters the map to entries where `from !== to` before calling `remapIds`, per the plan — a forward-compatible no-op today (legacy DRAFT-N → TASK-M always changes the id), but it is what makes a stable-id draft promote in place without a pointless rewrite pass once Task 3 lands. `PromoteDraftsDeps` is structurally identical to `IdRemapDeps`, so `deps` passes straight through. `remapIds` returns `[]` immediately on an empty map, so a no-op promote does zero board reads and zero writes.

For Task 6 (the migration): call `remapIds` AFTER all file moves are complete — it re-reads the board from disk, so callers must have finished renaming before invoking it.

Verification: `bun run test` 2114/2114 pass (147 files), `bun run lint` exit 0, `bun run typecheck` exit 0, prettier clean.
<!-- SECTION:NOTES:END -->
