---
id: TASK-29
title: >-
  Board-ref pushes skip --no-verify, so local pre-push hooks time out
  synced-board writes
status: Done
assignee: []
created_date: '2026-07-04 00:10'
updated_date: '2026-07-04 00:42'
labels:
  - bug
  - sync
milestone: 'Worktree Safety, Merge Queue & Synced Board'
dependencies: []
priority: medium
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Discovered while closing TASK-28: `request_merge`'s internal `setStatusSynced` push failed because this repo's `.husky/pre-push` hook (`bun run depcheck && bun run licenses:check`) takes ~98 seconds to run, while `src/core/boardRef.ts`'s `defaultBoardExec` hardcodes a 15-second exec timeout for all board-ref git operations (fetch/snapshot/push). Any synced-board push (claim/release/setStatus, and every MCP board-write handler after TASK-28's fix) that actually triggers a real local pre-push hook gets killed mid-hook and surfaces as a generic "push failed" with the hook's partial stdout as the reason.

Root cause + fix: `pushRef`/`pushRefForceWithLease` in `src/core/boardRef.ts` were plain `git push` calls, so they ran the repo's local hooks. A board-ref push only ever carries a snapshot of `backlog/{tasks,drafts,completed,archive}` — never code (enforced by the non-board-path guard in `materializeRefToWorktree`) — so gating it on code-quality hooks (lint, depcheck, license checks) is pure overhead with nothing to check. Added `--no-verify` to both push calls.

This task's own board record was lost once already: it was originally created and marked Done before this fix (and TASK-28's routing fix) were live in the running MCP server process — the server only loads code once at startup, so a mere `bun run build` doesn't take effect until the MCP connection is restarted. The pre-fix `create_task` call wrote the file locally only, never pushed it, and a subsequent materialize silently pruned it (TASK-28's own bug, biting before the fix went live). Recreating this record now that the server has been restarted with the real fix.

Note: the actual code fix (`--no-verify` on both push calls in src/core/boardRef.ts) is already committed and merged to main at commit 6eccac8 — this task record is being recreated after the fact for board bookkeeping.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reproduced: timed this repo's `.husky/pre-push` hook (`bun run depcheck && bun run licenses:check`) at a consistent ~98s across two runs, vs. `defaultBoardExec`'s 15s exec timeout in boardRef.ts. Added a failing test (temp clone + a stub `.git/hooks/pre-push` that unconditionally exits 1) proving `pushRef` currently runs local hooks, then added `--no-verify` to both `pushRef` and `pushRefForceWithLease` (compaction path, same data-not-code rationale) and confirmed both tests go green.

This task's board record was itself lost once to TASK-28's own bug: it was first created/completed before either fix was live in the running MCP server (a persistent process that only loads code at startup — rebuilding dist/mcp/server.js on disk doesn't take effect until the MCP connection restarts), so the pre-fix create_task wrote it locally-only and a later materialize pruned it. Recreated after the user restarted the MCP connection with the real fix live; verified this recreation correctly allocated TASK-29 (no ID collision) and landed on the shared taskwright-board ref.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Board-ref pushes (`pushRef`, `pushRefForceWithLease` in src/core/boardRef.ts) now pass `--no-verify`, since they only ever carry backlog board-file snapshots, never code — local pre-push hooks gating code quality have nothing to check and were spuriously timing out synced-board writes in repos with slow hooks (this one: ~98s). Code landed in commit 6eccac8, merged to main alongside TASK-28's fix.
<!-- SECTION:FINAL_SUMMARY:END -->
