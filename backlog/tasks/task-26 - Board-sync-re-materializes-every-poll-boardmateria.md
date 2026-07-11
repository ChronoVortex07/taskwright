---
id: TASK-26
title: >-
  Board sync re-materializes every poll — board.materialized frozen (unforced
  prune rmSync throws)
type: bug
status: Done
assignee: []
created_date: '2026-07-03 13:32'
updated_date: '2026-07-04 00:42'
labels: []
milestone: 'Worktree Safety, Merge Queue & Synced Board'
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Residual of the GitHub-synced-board engine, distinct from TASK-24's FETCH_HEAD fix. `.taskwright/board.materialized` is frozen at sha 10fdb770 since 2026-07-01 21:59 while the local board ref tip advanced (216d8b7), so refreshBoard re-materializes on every ~20s poll.

Mechanism: materializeRefToWorktree (src/core/boardRef.ts:153-200) throws between checkout-index (:190) and the return (:199), so writeMaterialized (boardSyncEngine.ts:346) never runs and the marker stays frozen. Prime suspect: the prune loop's unforced `fs.rmSync(...)` at boardRef.ts:195 (no { force: true }) throwing on an already-absent / dir / path-separator case. The refuse-guard (dd5e4e2) is ruled out — the board ref tree is all backlog/{tasks,drafts,completed,archive}/ paths. BoardSyncController.tick (src/providers/BoardSyncController.ts:115-117) catches, sets degraded=true + console.error, but skips setStatus — so the failure is effectively invisible; the board also re-writes all files every poll (churn) and widens the write-clobber window.

Fix (P5 branch, plan Task 9): live systematic-debugging repro to capture the real throw → force the prune rmSync + handle the real cause → surface the degraded state instead of an invisible console.error → TDD regression (unforced-prune no longer throws; a materialize failure is surfaced, marker not advanced on failure).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed on the P5 branch (Task 9, commit 3b15cde; landed via ec635f8). Root cause (reproduced, not guessed): the board prune loop's UNFORCED `fs.rmSync` in `materializeRefToWorktree` (boardRef.ts) threw ENOENT via a list→unlink RACE — a concurrent sibling materialize on the shared root working tree unlinks a stale board file between our readdir and our unlink; proved this is the only ENOENT source (the prune list is live-disk-derived, so a single call can't list an absent file). The throw landed between checkout-index and writeMaterialized, so `.taskwright/board.materialized` froze at 10fdb770 (Jul 1) while the ref advanced, and refreshBoard re-materialized every ~20s. Fix: `fs.rmSync(..., { force: true })` (force only — no recursive, since walkFiles yields files only so EISDIR is impossible), extracted into a testable `pruneStaleBoardFiles`. Also SURFACED the previously-invisible failure: BoardSyncController.tick now sets a degraded status bar (`$(warning) Board: sync degraded`) in the catch (incl. a fallback when config resolution itself throws — fix-wave LOW) with a de-duplicated log, instead of a silent ext-host console.error. TDD regressions: unforced-prune-race no longer throws; a materialize failure is surfaced and the marker is not advanced on failure. Reviewed LGTM (per-task + whole-branch + fix-wave re-review).
<!-- SECTION:FINAL_SUMMARY:END -->
