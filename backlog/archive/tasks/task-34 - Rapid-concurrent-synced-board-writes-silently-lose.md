---
id: TASK-34
title: >-
  Rapid concurrent synced-board writes silently lose some edits (new race beyond
  TASK-28's fix)
type: bug
status: To Do
assignee: []
created_date: '2026-07-04 00:53'
updated_date: '2026-07-04 09:36'
labels: []
dependencies: []
priority: high
caused_by: TASK-28
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during the 2026-07-04 /index-codebase tree bootstrap: a burst of ~30 MCP write calls (create_task/edit_task/archive_task), several issued as large parallel batches (up to 18 concurrent calls in one turn) against this repo's `taskwright.sync.mode: github` board, silently lost 3 of the writes — each call returned a normal success response, but the resulting task file on disk reverted to its pre-write state (confirmed via updated_date regressing to the original timestamp, not the session's). Affected: TASK-4's and TASK-13's milestone/category edit_task calls, and TASK-9's archive_task call. All three were re-run individually (one call at a time, each verified against disk afterward) and stuck correctly the second time.

This is the same failure family as TASK-24 (stale FETCH_HEAD materialize), TASK-26 (re-materialize-every-poll), and TASK-28 (create→claim race deletes the just-created task) — all already fixed — but manifests under a NEW load pattern: many concurrent MCP write calls from a single session/process, rather than multiple distinct agent sessions. TASK-28's fix routes create_task/edit_task/archive_task writes through applyBoardWriteSynced's fetch→materialize→check→snapshot→ff-only-push CAS loop; the loss here suggests that when many such CAS loops run concurrently (in-process), some lose the race silently (their ff-only push loses to a concurrent push and the retry/reconciliation either doesn't happen or resolves in favor of the stale local materialize) without surfacing an error to the caller.

Reproduction sketch: fire >5 edit_task/create_task/archive_task calls concurrently (Promise.all-style, as a tool-call batch) against a sync-mode board; check each target file's updated_date against the pre-call value afterward. Expect: all edits land. Observed: some silently revert.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
