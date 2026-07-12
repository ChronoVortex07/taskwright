---
id: TASK-118
title: The draft-ID migration core (legacy DRAFT-N boards)
status: In Progress
assignee: []
created_date: '2026-07-12 16:42'
updated_date: '2026-07-12 16:42'
labels:
  - stable-task-ids
milestone: Stable Task IDs
dependencies:
  - TASK-113
  - TASK-116
references:
  - docs/superpowers/plans/2026-07-12-stable-task-ids.md
priority: high
category: 'Core Board'
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
- [ ] #1 `planDraftIdMigration` is pure and yields an EMPTY plan for a board with no legacy drafts (zero renames, zero relocations).
- [ ] #2 It plans a legacy `DRAFT-3` onto a fresh id above the current max across all folders.
- [ ] #3 It plans relocations for legacy archived drafts sitting in `archive/tasks/` → `archive/drafts/`.
- [ ] #4 `runDraftIdMigration` re-ids legacy drafts IN PLACE — they stay in `drafts/`, it never promotes.
- [ ] #5 Inbound references are remapped via the shared `remapIds` core (TASK-113), so `parent_task_id` / `subtasks` / `references[]` are covered, not just dependencies.
- [ ] #6 IDEMPOTENT: running it twice, or on a clean board, performs zero writes (assert on file mtimes or a write spy, not just on the return value).
- [ ] #7 Frontmatter byte-compatibility and CRLF/LF are preserved across every rename.
- [ ] #8 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->
