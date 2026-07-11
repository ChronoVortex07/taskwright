---
id: TASK-74
title: >-
  Let request_merge target an explicit worktree (root-override) so the close can
  run from a primary-rooted session
status: Done
assignee: []
created_date: '2026-07-08 05:25'
updated_date: '2026-07-08 06:31'
labels: []
milestone: Orchestration & UX Polish
dependencies: []
priority: high
category: Orchestration
plan: docs/superpowers/plans/2026-07-08-request-merge-worktree-target.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`request_merge` hard-aborts unless called from inside a linked worktree: the `isPrimaryTree` guard at handlers.ts:259-265, plus `requestMergeHandler` deriving all git facts + the rebase/verify cwd from `deps.root` (the session cwd). finishTask.ts runs rebase (:291,:335) and verify (:299,:344) in `root` and ff-merges in `primaryRoot` (:368-369); the worktree path is hard-coded to `.worktrees/<branch>` (handlers.ts:283).

Per the "Both" decision, add an optional target (worktree branch or path) to request_merge: when supplied, resolve git facts, rebase, verify, ff-merge and cleanup against that worktree instead of the session cwd — keeping the existing primary-tree guard as the default when no target is given. This lets one primary-rooted session drive the whole close.

Must stay safe: validate the target is a real linked worktree of THIS repo (`git worktree list`), refuse a dirty/detached/foreign target, and keep the merge-queue right-of-way + cleanup (removeWorktree / deleteBranch) semantics identical.

Acceptance criteria:
- request_merge with an explicit worktree target completes rebase→verify→queue→ff-merge→cleanup without being run from that worktree's cwd.
- Without a target, behavior is unchanged (primary-tree guard still aborts a bare primary-tree call).
- Target validated against `git worktree list`; dirty/detached/foreign targets refused with a clear reason.
- Unit tests mirror requestMerge.test.ts / mcpMergeHandlers.test.ts for the new targeted path.

Note: request_merge is safety-critical (it rebases + merges) — worth a short design spec before implementation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented by DeepSeek-pro per plan. Added parseWorktreeEntries (porcelain parser) + resolveWorktreeTarget (4 gates: containment under primaryRoot/.worktrees before any git call, real linked worktree, non-detached, clean) to handlers.ts; requestMergeHandler takes optional worktree arg and overrides root/branch/worktreeRel only on the targeted path (primaryRoot unchanged, isPrimaryTree guard skipped only when a target is given); server.ts request_merge schema gains worktree. +10 tests. Verified 1628 vitest, lint/typecheck/build clean. Merged to integration (import-block conflict with TASK-75 resolved by keeping both).
<!-- SECTION:FINAL_SUMMARY:END -->
