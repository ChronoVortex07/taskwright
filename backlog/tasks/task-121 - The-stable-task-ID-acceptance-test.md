---
id: TASK-121
title: The stable-task-ID acceptance test
status: To Do
assignee: []
created_date: '2026-07-12 16:43'
updated_date: '2026-07-12 16:43'
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
category: 'Core Board'
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
- [ ] #1 Case 1 passes: a draft referenced structurally (dependencies) AND in prose (a description) keeps both references valid across promotion; the promoted id equals the draft id.
- [ ] #2 Case 2 passes: a seeded legacy board (drafts/draft-3 + TASK-9 depending on DRAFT-3) migrates so the draft stays a draft with a stable id and TASK-9's dependency is remapped.
- [ ] #3 Case 2 also asserts the invariant holds POST-migration: promoting the migrated draft does not change its id, and the inbound reference still resolves.
- [ ] #4 The prose-reference assertion is present and meaningful — it is the case a remap pass could never fix, and the reason the feature exists.
- [ ] #5 bun run test, bun run lint, bun run typecheck all pass — whole suite green.
<!-- AC:END -->
