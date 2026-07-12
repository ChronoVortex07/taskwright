---
id: TASK-119
title: 'Run the draft-ID migration automatically (activation, MCP startup, doctor)'
status: To Do
assignee: []
created_date: '2026-07-12 16:42'
updated_date: '2026-07-12 16:42'
labels:
  - stable-task-ids
milestone: Stable Task IDs
dependencies:
  - TASK-118
references:
  - docs/superpowers/plans/2026-07-12-stable-task-ids.md
  - src/extension.ts
  - src/mcp/server.ts
  - src/core/boardDoctor.ts
priority: high
category: 'Core Board'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Task 7 of the Stable Task IDs plan** — `docs/superpowers/plans/2026-07-12-stable-task-ids.md`.

⚠️ **The plan calls this the riskiest step in either plan.** An extension host and an MCP server can start **simultaneously** and both migrate the same board. A test that actually runs two migrations concurrently against one temp board is required — not assumed safe.

Wire `runDraftIdMigration` (TASK-118) into three places:
- `src/extension.ts` — inside the existing `createDeferredRunner` callback (`:962`). **Append** to the block; do not insert into the middle — the git-auto engine depends on the ordering of the existing steps. Migration must **never block activation**: the deferred runner never rejects into `activate()` by contract, and TASK-109 deliberately moved every git/fs burst out of the activation path. Do not regress that.
- `src/mcp/server.ts` — after board-root resolution (`resolveWorkspaceBacklogRoot`), so a dispatched or headless agent session converges too.
- `src/core/boardDoctor.ts` (`:30-53` finding + repair types, `:216` `diagnoseBoard`) — a `legacy-draft-ids` finding with a `migrate-draft-ids` repair.

Confirm the real names of `parser.getBacklogPath()`, the output channel, and the `treeFieldService` instance in scope — read the block, do not assume.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The migration runs from the deferred bootstrap in `src/extension.ts` (appended, not inserted mid-block) and from `src/mcp/server.ts` after board-root resolution.
- [ ] #2 A migration failure LOGS and surfaces as a doctor finding — it never rejects into `activate()` and never blocks activation or a board write.
- [ ] #3 CONCURRENCY PROVEN: a test runs two migrations concurrently against one temp board and asserts a single coherent outcome (no double-rename, no lost reference, no id collision). This is the riskiest step — do not assume, demonstrate.
- [ ] #4 `boardDoctor` gains a `legacy-draft-ids` finding with a `migrate-draft-ids` repair; a clean board reports nothing (silent when clean).
- [ ] #5 A user-visible notification names the migrated ids (e.g. `DRAFT-3 → TASK-111`) when migrated > 0, and says nothing when 0.
- [ ] #6 Activation cost does not regress (TASK-109): no new git/fs burst inline in `activate()`.
- [ ] #7 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->
