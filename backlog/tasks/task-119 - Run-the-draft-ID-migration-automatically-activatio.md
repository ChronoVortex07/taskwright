---
id: TASK-119
title: 'Run the draft-ID migration automatically (activation, MCP startup, doctor)'
status: In Progress
assignee: []
created_date: '2026-07-12 16:42'
updated_date: '2026-07-12 23:46'
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
category: Core Board
claimed_by: '@agent/task-119-run-the-draft-id-migration-automatically-activation-mcp-startup-doctor'
worktree: task-119-run-the-draft-id-migration-automatically-activation-mcp-startup-doctor
claimed_at: '2026-07-13 07:31'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Wired `runDraftIdMigration` (TASK-118) into all three surfaces, behind ONE new locked entry point.

**The core decision: a locked wrapper, not three lock-wrapped call sites.**
`peekNextTaskId` is lock-free by design, so the plan+execute pair is the critical section — a lock
around the writes alone would still let two processes plan against the same stale `nextId`. New
`runDraftIdMigrationLocked(deps, backlogPath, opts?)` in `src/core/draftIdMigration.ts` is what every
automatic caller uses; the bare `runDraftIdMigration` stays lock-free as the pure, directly-testable
core. A source-contract test fails the build if any call site reaches for the unguarded one.

- **Lock**: reused `acquireSyncLock` (autoSync.ts), generalized with an optional third `lockName`
  param (back-compat default unchanged). The migration passes its OWN name — deliberately NOT sharing
  board-sync's mutex, or a slow network push would routinely skip the migration and vice-versa; they
  guard different things.
- **Lock home**: `<backlogPath>/.locks/draft-id-migration.lock` — already the id-allocator's transient
  lock dir (excluded from `BOARD_SUBDIRS`, never committed/staged; asserted by an existing test).
  Keying on `backlogPath` is what makes it work cross-process: every process resolves the ONE physical
  board to the same path, so two of them always contend for the same lock, from any worktree.
- **Contention is a bounded WAIT (15s default), not an instant skip**: the loser waits, then runs an
  idempotent second pass against the converged board and honestly reports `migrated: 0`. Only if the
  window expires does it return `skipped: 'locked'`. It invalidates the parser cache after acquiring
  (its caches predate the peer's writes). Lock released in `finally` — a crashed migration cannot wedge
  the board, and `acquireSyncLock` steals a stale lock after 60s anyway.

**Call sites**
- `src/extension.ts`: new `migrateDraftIds()`, APPENDED as the last step of the existing
  `startupBootstrap` deferred runner (after `bootstrapGitAuto`, so in git-auto it runs against the board
  home that bootstrap just resolved). Ordering of the pre-existing steps untouched. Swallows its own
  errors (logs) — never rejects into `activate()`. Constructs a fresh `BacklogWriter`/`TreeFieldService`
  rather than closing over the module's `const writer` (declared ~850 lines LATER — a TDZ landmine).
- `src/mcp/server.ts`: after `resolveWorkspaceBacklogRoot` + deps construction, before `server.connect`.
  Logs to stderr only. try/catch — a failure must never stop the server serving tools.
- `src/providers/doctorActions.ts`: `migrate-draft-ids` repair routes to the SAME locked core, so the
  manual repair and the automatic passes cannot diverge; a repair fired while a peer is mid-migration
  contends instead of racing, and surfaces a warning if it is locked out.

**Doctor**: `legacy-draft-ids` finding + `migrate-draft-ids` repair. `BoardDoctorInput` gained
`drafts?` + `taskPrefix?`; `runBoardDoctor` already loaded drafts/config, so it just feeds them through.
The check is gated on BOTH being supplied (facts unknown ⇒ silent, never guess). Legacy = "lacks the
configured task_prefix" via the shared `idHasPrefix`, never a literal `DRAFT-` match, so a
`task_prefix: STORY` board is not flagged for its own STORY-4. Adding the repair to the union made the
compiler force the two exhaustive switches in doctorActions — nothing silently unhandled.

**Notification (AC5)**: pure `formatMigrationMessage(mapping, max=6)` — names the ids
(`DRAFT-3 → TASK-111`), truncates past 6, returns '' for an empty mapping so callers say NOTHING when 0.
Shared by the extension notification and the doctor repair.

**CONCURRENCY PROVEN, not assumed (AC3).** Two tests run two migrations concurrently (separate
parser/writer/treeFieldService dep sets = two processes) against one temp board and assert a single
coherent outcome: exactly one reports migrated>0, drafts/ holds exactly one file per draft, no id lands
on a live task, and every inbound edge (dependencies/parent_task_id/subtasks/references) points at the
one new id. I then VERIFIED THE TEST BITES: neutering the lock makes both fail with
`ENOENT: rename 'draft-1 - A.md'` — the exact double-rename race. Plus: skip-while-held does zero
writes, a released lock is not a permanent skip, and a throwing migration still releases the lock.

**AC6** guarded by a source-contract test in `activationEvents.test.ts`: `migrateDraftIds()` is called
exactly once and only from inside the deferred-bootstrap callback. If someone hoists it back into
`activate()`, the build fails.

**End-to-end verified against the BUILT server** (not just unit tests): a throwaway git repo with
`drafts/draft-3` + `TASK-9 depends on DRAFT-3`, run through `dist/mcp/server.js` with TASKWRIGHT_ROOT →
file became `task-10 - Legacy-draft.md` with `id: TASK-10`, STILL in drafts/ (never promoted), TASK-9's
dependency remapped to TASK-10, migration logged on stderr with **stdout at 0 bytes** (JSON-RPC channel
intact), `.locks` released, server still reached `ready`.

**FOR TASK-121 (the acceptance test):** (1) the migration is now automatic on BOTH activation and MCP
startup — a test that opens a legacy board via either surface will find it already converged, so seed
and assert accordingly rather than expecting DRAFT-N to survive. (2) `runDraftIdMigrationLocked` is the
entry point to call, never the bare core. (3) It is idempotent and silent on a clean board (zero writes,
`{migrated: 0, mapping: []}`), so it is safe to call in a test setup. (4) The board doctor's
`legacy-draft-ids` finding is the observable "not yet converged" signal. (5) `formatMigrationMessage` is
the notification text if you assert on user-visible output.

Verify: bun run test (2233 pass, 153 files), bun run lint, bun run typecheck — all green. Build clean;
MCP bundle still vscode-free.
<!-- SECTION:NOTES:END -->
