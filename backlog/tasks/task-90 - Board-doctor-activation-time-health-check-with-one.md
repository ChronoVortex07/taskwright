---
id: TASK-90
title: Board doctor — activation-time health check with one-click repairs
status: Done
assignee: []
created_date: '2026-07-10 11:43'
updated_date: '2026-07-10 15:53'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies: []
priority: medium
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The cross-repo scan found accumulated drift everywhere: a dangling .taskwright/active-task.json pointing at a nonexistent task (fate-atlas, from June 30), leftover handoff files on all-Done boards (taskwright: TASK-1, TASK-13), an orphaned worktree with no claim frontmatter (stock-trading task-61), tasks stuck In Progress with no claim and no worktree (task-32), and a mangled category name polluting the lane list ('Orchestration task-80-conflict-safe-...'). Nothing detects or repairs any of this today.

Scope:
- A pure core (src/core/boardDoctor.ts) that, given the board + git worktree list + .taskwright contents, returns a typed findings list: dangling active-task pointer, stale handoff files for Done tasks, worktree dir with no claiming task, In Progress task with no claim/worktree, claim whose worktree no longer exists, malformed category values in task frontmatter.
- Run idempotently on activation; surface findings as a notification/quick-pick with per-finding one-click repairs (delete pointer, GC handoff, release claim, prompt for worktree teardown via the existing cancelDispatch path).
- Never auto-delete without confirmation; repairs route through existing writers (ClaimService, cancelDispatch, activeTask.ts).
- Also expose as a command (taskwright.doctor) and consider an MCP read tool so /orchestrate-board can pre-flight the board.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Pure core src/core/boardDoctor.ts diagnoses a board snapshot into typed findings: dangling active-task pointer, stale handoff for Done/missing task, orphaned worktree dir, in-flight task with no claim and no worktree, claim whose worktree vanished, malformed category value, and dangling folded frontmatter continuation lines
- [x] #2 Doctor runs idempotently on activation; findings surface as a notification + quick-pick with per-finding one-click repairs routed through existing writers (activeTask.ts, claimActions/ClaimService, cancelDispatch/removeWorktree, TreeFieldService); nothing is auto-deleted without user confirmation
- [x] #3 taskwright.doctor command runs the same check on demand and reports a healthy board when clean
- [x] #4 MCP read tool board_doctor returns the findings read-only so /orchestrate-board can pre-flight the board
- [x] #5 Unit tests cover every finding type plus the clean-board case; bun run test, lint, and typecheck pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented TDD (no plan/subtasks). Pure core `src/core/boardDoctor.ts`: `diagnoseBoard(input)` returns typed findings (dangling-active-task, stale-handoff, orphaned-worktree, in-flight-no-claim, claim-worktree-vanished, malformed-category, dangling-continuation), each carrying a declared repair kind; `findDanglingContinuations`/`stripDanglingContinuations` handle the historical folded-continuation corruption (TASK-89 writer fix stops new cases; old data may carry it); `gatherDoctorFacts(repoRoot)` reads active-task.json/handoff/.worktrees facts; `runBoardDoctor(parser, repoRoot)` is the one shared assembly used by both the extension and the MCP tool (parity).

Key decisions:
- Claim-worktree-vanished only fires for MANAGED worktree names (dispatchBranchName match or `<id-slug>-` prefix) so a human claim recording `worktree: main` never false-positives.
- Free-form discovered categories are legal; malformed-category needs corruption signals (embedded task-NN- branch token, `key: value` fragment, newline, >64 chars) and never fires on config membership alone. Suggestion = longest configured category prefixing the mangled value ('' = clear).
- A worktree dir owned by any non-Done task (incl. To Do = fresh dispatch) is healthy; only dirs mapping to a Done task or to no task are orphaned.
- In-flight-no-claim is suppressed when the task's dispatch worktree exists on disk (dispatched-but-unclaimed).

Glue `src/providers/doctorActions.ts` (`runBoardDoctorFlow`): activation run is silent when clean, warns + Review→multi-select quick-pick otherwise; `taskwright.doctor` command goes straight to the picker and reports a healthy board. Repairs route through existing writers: clearActiveTask, fs.rm(handoffPath), releaseTaskClaim, writer.updateTask(status), TreeFieldService set/clearCategory, cancellation-marker-then-removeWorktree (same load-bearing order as cancelDispatch; extra modal confirm), CRLF-safe atomic rewrite for strip-continuations. MCP read tool `board_doctor` (handlers.ts boardDoctorHandler + server.ts registration) returns { healthy, findings } and never mutates.

Coverage: src/test/unit/boardDoctor.test.ts (23 tests: every finding type, clean board, strip idempotence, facts gathering, end-to-end via BacklogParser fixture) + boardDoctorHandler tests in mcpReadHandlers.test.ts. Full suite 1872 passed; lint + typecheck clean. Visual proof skipped: the UI surface is native VS Code notifications/quick-pick (no webview change).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Board doctor shipped: pure core `src/core/boardDoctor.ts` (diagnoseBoard with 7 typed finding kinds + declared repairs; findDanglingContinuations/stripDanglingContinuations for the historical folded-continuation corruption; gatherDoctorFacts; shared runBoardDoctor assembly), extension glue `src/providers/doctorActions.ts` (silent-when-clean activation check, notification → multi-select quick-pick, repairs routed through activeTask/claimActions/TreeFieldService/marker-first removeWorktree with modal confirm/CRLF-safe surgical rewrite), new `taskwright.doctor` command, and read-only MCP tool `board_doctor` for /orchestrate-board pre-flight. Coverage: boardDoctor.test.ts (23 tests) + boardDoctorHandler tests; full suite 1872 green, lint + typecheck clean. Also deflaked the git-heavy Board Sync suites (boardRef/boardSyncHook/mcpBoardPushPullHandlers) with a 30s file-level testTimeout — they were blowing vitest's 5s default under parallel merge-queue verify load and flaking every runner's merge gate. Merged to main via the merge queue (commits f9efe06 + 6bf38e2).
<!-- SECTION:FINAL_SUMMARY:END -->
