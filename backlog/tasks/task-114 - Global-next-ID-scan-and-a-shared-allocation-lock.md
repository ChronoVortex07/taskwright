---
id: TASK-114
title: Global next-ID scan and a shared allocation lock
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
  - src/core/BacklogWriter.ts
priority: high
category: 'Core Board'
claimed_by: '@agent/task-114-global-next-id-scan-and-a-shared-allocation-lock'
worktree: task-114-global-next-id-scan-and-a-shared-allocation-lock
claimed_at: '2026-07-13 05:41'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Task 2 of the Stable Task IDs plan** — `docs/superpowers/plans/2026-07-12-stable-task-ids.md`.

⚠️ **This MUST land before TASK-115 (`createDraft` mints a task ID).** Order is load-bearing — see below.

Modify `src/core/BacklogWriter.ts`:
- `getNextTaskId` (`:1041-1075`) — **signature changes**: it now takes the **backlog root**, not `tasksDir`, and scans `tasks/`, `drafts/`, `completed/`, `archive/tasks/`, `archive/drafts/`. Today it scans only `tasks/`, so a restored archived task can collide with a live one.
- `allocateAndWrite` (`:891-929`) — **signature changes**: it takes the backlog root so the lock lives in ONE shared `backlog/.locks/` directory regardless of which subfolder the file lands in.

**Why the lock must move.** `allocateAndWrite` is the mutex that fixed the TASK-48 concurrent-create clobber. It works by `mkdir`-ing a lock dir keyed on the numeric ID — but *inside the target directory*: `tasks/.task-N.lock` vs `drafts/.draft-N.lock`. **Two directories, two lock namespaces that cannot see each other.** That is harmless while the counters are separate, and a **live clobber race** the moment they share one. So this lands first, or a concurrent `create_task` and draft-create will both claim the same number — TASK-48, re-armed.

Confirm while implementing: `backlog/.locks/` is a NEW directory inside the board root — verify `BacklogParser` ignores it and the board-sync pathspec never commits it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `getNextTaskId` takes the backlog root and returns the max across `tasks/`, `drafts/`, `completed/`, `archive/tasks/`, and `archive/drafts/` — not `tasks/` alone.
- [ ] #2 A restored archived task cannot collide with a live task (seed archive/tasks/task-12 with only task-2 live → next id is TASK-13).
- [ ] #3 A legacy `draft-99` filename in drafts/ is ignored by the task-prefix scan (it does not carry the task prefix).
- [ ] #4 `allocateAndWrite` locks in ONE shared `backlog/.locks/` namespace, so a concurrent createTask and createDraft cannot claim the same number.
- [ ] #5 A concurrency test actually runs a create_task and a draft-create concurrently against one temp board and asserts distinct IDs (this is the TASK-48 clobber, re-armed by the shared counter — prove it, don't assume).
- [ ] #6 `backlog/.locks/` is ignored by BacklogParser and never committed by the board-sync pathspec — verified, not assumed.
- [ ] #7 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->
