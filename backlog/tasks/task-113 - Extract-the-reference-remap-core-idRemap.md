---
id: TASK-113
title: Extract the reference-remap core (idRemap)
status: In Progress
assignee: []
created_date: '2026-07-12 16:41'
updated_date: '2026-07-12 16:41'
labels:
  - stable-task-ids
milestone: Stable Task IDs
dependencies: []
references:
  - docs/superpowers/plans/2026-07-12-stable-task-ids.md
  - docs/superpowers/specs/2026-07-12-stable-task-ids-design.md
  - src/core/promoteDrafts.ts
priority: high
category: 'Core Board'
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
- [ ] #1 `src/core/idRemap.ts` exists as a pure, vscode-free core exporting `remapIds(deps, oldToNew)` with the signature above.
- [ ] #2 It rewrites ALL five reference kinds: `dependencies`, bug `caused_by`, `parent_task_id`, `subtasks`, and `references[]` — the last three are the gaps `promoteDrafts` silently dangles today.
- [ ] #3 `src/core/promoteDrafts.ts` delegates its remap pass to `remapIds` rather than duplicating it; its existing behavior is unchanged (its tests still pass).
- [ ] #4 Unit tests in `src/test/unit/idRemap.test.ts` cover each reference kind, uppercase key handling, and a no-op remap performing zero writes.
- [ ] #5 Writes preserve frontmatter byte-compatibility and CRLF/LF (go through BacklogWriter's reconstructFile / atomicWriteFileSync; follow the detectCRLF / normalizeToLF / restoreLineEndings sandwich).
- [ ] #6 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->
