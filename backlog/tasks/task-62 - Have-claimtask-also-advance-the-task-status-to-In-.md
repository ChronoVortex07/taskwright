---
id: TASK-62
title: Have claim_task also advance the task status to "In Progress"
status: Done
assignee: []
created_date: '2026-07-04 12:13'
updated_date: '2026-07-04 12:36'
labels: []
dependencies: []
priority: high
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When an agent (or human) claims a task via `claim_task`, the task's status should advance from the board's first status (typically "To Do") to its second status (typically "In Progress"). Currently `claimTaskHandler` in `src/mcp/handlers.ts` only writes the advisory claim fields (`claimed_by`, `worktree`, `claimed_at`) via `ClaimService` — it never touches `status`.

This is the root cause of two observable problems:
1. Agents who claim a task leave it in "To Do" on the board, making it look like nobody is working on it.
2. The DetailPopover's action-button derivation checks `isTodo` (status === first configured status) first — so a claimed task stuck in "To Do" always shows "Claim" + "Dispatch" instead of "Release claim" / "Cancel dispatch" (see follow-up task for the popover fix).

**What to do:**
- In `claimTaskHandler` (or `ClaimService.claimTask`), after writing the claim fields, also update the task status to the board's second configured status (typically "In Progress") — but only if the task is currently in the first status ("To Do"). If the task is already "In Progress" or beyond, leave the status unchanged.
- Read the board config to resolve the "In Progress" status (second entry in `statuses`). If the config has fewer than 2 statuses, default to "In Progress".
- Update the `/execute-task` skill (`.claude/skills/execute-task/SKILL.md`) to remove any implication that claim alone sets status — the handler does it automatically now.
- Ensure parity: this status transition also applies when a human clicks "Claim" in the popover (the UI passes through the same MCP tool or an equivalent code path).

**Acceptance criteria:**
- Calling `claim_task` on a task with status "To Do" changes its status to "In Progress" (or the board's second configured status).
- Calling `claim_task` on a task already "In Progress" leaves the status unchanged.
- Calling `claim_task` on a "Done" task leaves the status unchanged.
- The claim is still advisory — status change + claim write are done atomically (best-effort: claim write then status update).
- Tests pass: `bun run test && bun run lint && bun run typecheck`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Modified `ClaimService.claimTask()` to transition status from the board's first configured status (typically "To Do") to its second (typically "In Progress") after writing advisory claim fields. Uses existing `setStatusField()` from frontmatterEdit.ts for the surgical status edit — unquoted status scalar preserves byte-for-byte frontmatter compatibility.

Implementation:
- `src/core/ClaimService.ts`: claimTask() now reads the board config statuses, checks if the task is in the first status, and if so, surgically edits status to the second status in the same atomic rewrite.
- If config has fewer than 2 statuses, defaults inProgressStatus to "In Progress" (but only transitions when task.status matches statuses[0]).
- Both MCP path (claimTaskHandler) and UI path (claimTaskForCurrentUser) get this automatically since both go through ClaimService.

Tests: 6 new status transition tests in ClaimService.test.ts + 1 handler-level test in mcpHandlers.test.ts. All 1514 tests pass, lint clean, typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
claim_task now transitions the task status from "To Do" (or the board's first configured status) to "In Progress" (or the board's second configured status) automatically. The transition only fires when the task is in the first status — tasks already "In Progress" or beyond are left unchanged. Both MCP and UI claim paths go through ClaimService so parity is automatic. The /execute-task skill was updated to document this behavior.
<!-- SECTION:FINAL_SUMMARY:END -->
