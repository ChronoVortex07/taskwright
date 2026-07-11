---
id: TASK-32
title: 'Address deferred TASK-15 follow-ups (post-checkout warn-hook, review polish)'
status: Done
assignee: []
created_date: '2026-07-04 00:40'
updated_date: '2026-07-04 13:52'
labels: []
milestone: 'Worktree Safety, Merge Queue & Synced Board'
dependencies:
  - TASK-15
priority: low
category: Worktrees & Merge
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Non-blocking items explicitly deferred out of TASK-15's three components, never separately tracked: (A) an advisory post-checkout warn-hook for worktree isolation (spec 2026-07-01-safe-concurrent-agents-merge-queue-design.md §4.2); (C, whole-branch review) inject the board's cached common-dir into TaskDetailProvider so the detail panel doesn't spawn `git rev-parse` per open, share the IN_PROGRESS constant between mergeActions.ts and finishTask.ts, and re-point the queue watcher/reader on a backlog-root switch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Advisory post-checkout warn-hook installed alongside the existing pre-commit worktree guard (spec §4.2)
- [ ] #2 TaskDetailProvider reuses the board's cached common-dir instead of spawning git rev-parse per panel open
- [ ] #3 IN_PROGRESS status constant shared between mergeActions.ts and finishTask.ts instead of duplicated
- [ ] #4 Merge-queue file watcher/reader re-points correctly on a backlog-root switch
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## (A) Post-checkout warn-hook
- Created `src/hooks/worktree-warn.ts` entrypoint: warns (stderr) when a dispatched branch is checked out in the primary tree; always exits 0 (advisory only)
- Added `warnGuardBlock`, `installPostCheckoutWarn`, `uninstallPostCheckoutWarn` to `src/core/hookInstaller.ts`, reusing the labeled-fence pattern
- Added `syncPostCheckoutWarn` to `src/extension.ts`, gated by `enforceWorktreeIsolation` (same as pre-commit guard)
- Updated `scripts/build.ts` to bundle the new hook entrypoint
- Tests: 6 new cases in `hookInstaller.test.ts`

## (C1) TaskDetailProvider cached common-dir
- Added `setCommonDir(commonDir)` method and `commonDir` field to `TaskDetailProvider`
- Modified `resolveMergeState` to prefer cached value over spawning `git rev-parse --git-common-dir` per panel open
- Wired in `extension.ts`: initial injection after provider creation + re-injection on backlog root switch in `switchActiveBacklog`

## (C2) Shared IN_PROGRESS constant
- Extracted `IN_PROGRESS = 'In Progress'` into `src/core/mergeConfig.ts`
- Updated `mergeActions.ts` and `finishTask.ts` to import from the shared location
- Tests: 1 new case in `mergeConfig.test.ts`

## (C3) Merge-queue watcher/reader re-point on backlog root switch
- Extracted merge-queue setup to use a tracked `mergeQueueWatcherDispose` disposible
- Added re-setup logic in `switchActiveBacklog`: disposes old watcher, resolves new common dir via `resolveCommonDir`, creates new store/reader/watcher, injects common-dir into detail provider
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented all four deferred TASK-15 follow-ups: (A) advisory post-checkout warn-hook alongside the existing pre-commit guard, (C1) TaskDetailProvider reuses cached common-dir instead of spawning git rev-parse per open, (C2) IN_PROGRESS constant shared between mergeActions.ts and finishTask.ts, (C3) merge-queue watcher/reader correctly re-points on backlog root switch. All 1535 tests pass, lint and typecheck clean.
<!-- SECTION:FINAL_SUMMARY:END -->
