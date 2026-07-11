---
id: TASK-63
title: >-
  Fix DetailPopover action buttons to correctly reflect
  claimed/dispatched/cancellable state
status: Done
assignee: []
created_date: '2026-07-04 12:13'
updated_date: '2026-07-04 12:31'
labels: []
dependencies: []
priority: high
category: Tree
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The DetailPopover (`src/webview/components/tree/DetailPopover.svelte`) action-button derivation (lines 65-90) has a priority-order bug: it checks `isTodo` (status === first configured status) before checking `claimedBy`, `hasDispatchedWorktree`, or `hasWorktree`. This means:

- A task that was **dispatched** (worktree exists on disk) but not yet claimed stays "To Do" → the popover shows "Claim" + "Dispatch" instead of "Cancel dispatch".
- A task that was **claimed** by another session but whose status wasn't advanced (see claim→In Progress task) stays "To Do" → the popover shows "Claim" + "Dispatch" instead of "Release claim".
- A task that was **claimed by me** but stuck in "To Do" stays "To Do" → shows "Claim" + "Dispatch" instead of "Mark done" + "Release claim".

The **cancel-dispatch backend** (`src/core/cancelDispatch.ts`) already exists and works correctly: it writes the cancellation marker, releases the claim, resets status to "To Do", removes the worktree, and disposes the terminal. The issue is purely that the "Cancel dispatch" button is unreachable from the UI.

**What to do:**
- Reorder the action derivation to check worktree/claim state BEFORE status-based branches:
  1. `pendingReview` → approve/send-back (unchanged)
  2. `isDone || isDraft` → no actions (unchanged)
  3. **`hasDispatchedWorktree || hasWorktree`** → "Cancel dispatch" (moved up — was gated on `inProgress`)
  4. `isLocked && isTodo` → "Force claim"
  5. `claimedByMe && !isDone` → "Mark done" + "Release claim" (if applicable)
  6. `task.claimedBy && !isDone` → "Release claim" (someone else's claim)
  7. `isTodo` → "Claim" + "Dispatch"
  8. fallback → "Claim" + "Dispatch"
- The "Cancel dispatch" button's handler should call the existing `cancelDispatch` flow (which is already wired through `TasksController`'s `handlePopoverAction`).
- Add a confirmation dialog before cancel dispatch ("This will delete the worktree and revert the task to To Do. Continue?").
- Ensure the "Cancel dispatch" button also shows when the task has `hasWorktree` (claim's worktree field) even if the physical worktree dir was already removed.

**Acceptance criteria:**
- A dispatched task (worktree exists) shows "Cancel dispatch" regardless of its board status.
- A claimed task shows "Release claim" (or "Mark done" + "Release claim" if claimed by me) regardless of its board status.
- Clicking "Cancel dispatch" triggers the full teardown: cancellation marker → release claim → status reset to To Do → worktree removal → terminal disposal.
- Tests pass: `bun run test && bun run lint && bun run typecheck`.
- Visual proof: screenshot showing the popover on a dispatched task with "Cancel dispatch" visible.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fixed DetailPopover action-button priority-order bug: moved worktree/claim checks above status-based branches.

Change in `src/webview/components/tree/DetailPopover.svelte`:
- Removed unused `inProgress` derived (gated Cancel-dispatch and Mark-done/Release-claim on status before)
- Reordered action derivation: `hasDispatchedWorktree || hasWorktree` → "Cancel dispatch" now comes before `isTodo`
- Moved `claimedByMe && !isDone` and `task.claimedBy && !isDone` above `isTodo`

Confirmation dialog already existed in `extension.ts` (line 1427-1431, `vscode.window.showWarningMessage`).

Added 4 Playwright e2e tests in `e2e/tree-popover.spec.ts` for previously-broken scenarios:
- Dispatched To-Do task → Cancel dispatch
- Claimed-by-other To-Do task → Release claim
- Claimed-by-me To-Do task → Mark done + Release claim
- Worktree-claimed (hasWorktree) To-Do task → Cancel dispatch
<!-- SECTION:NOTES:END -->
