---
id: TASK-88
title: >-
  Unpin request_merge from the agent process — MCP progress notifications +
  re-entrant waitMinutes
status: Done
assignee: []
created_date: '2026-07-10 11:43'
updated_date: '2026-07-10 14:25'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies:
  - TASK-87
priority: medium
category: Worktrees & Merge
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
requestMerge is one blocking MCP call with an UNBOUNDED long-poll (waitForTurn, src/core/finishTask.ts:390-413) for queue turn and — in manual-review mode — human approval, and the server never emits progress. In manual-review the merge physically cannot happen unless the agent process outlives the human's review latency; any client-side tool timeout kills the call while server-side machinery continues.

Scope:
- Emit MCP progress notifications during verify (command name + elapsed) and the queue wait (position, approval state) so clients that reset timeouts on progress stay alive and the human sees liveness.
- Add an optional waitMinutes parameter: when the wait exceeds it, return { status: 'pending', queuePosition, ticket } instead of blocking forever; a subsequent request_merge call for the same task resumes the existing queue entry idempotently (no re-enqueue, no duplicate verify if base unchanged — builds on the base-SHA skip).
- Update the /execute-task and /orchestrate-board skill docs to handle the 'pending' status (poll or park).
- Keep the fully-blocking default for backward compatibility.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. mergeQueue.ts: QueueEntry gains optional verifiedHeadSha; exported recordVerifiedHead helper.
2. finishTask.ts: new MergeProgress type; FinishDeps gains onProgress + progressIntervalMs; RequestMergeResult gains { status:'pending', taskId, queuePosition, ticket, message }; requestMerge(deps, taskId, opts { waitMinutes, ticket }) — resume detection via existing queue entry (idempotent re-enqueue), pre-verify skipped when entry.verifiedHeadSha == post-rebase HEAD (extends TASK-87 base-SHA skip), waitForTurn deadline -> 'wait_timeout' -> pending WITHOUT dequeue/status reset; ticket + missing entry -> sent_back (reviewer send-back while parked); verify progress ticker (command name, i/n, elapsed) gated on onProgress so it never perturbs deps.sleep when unobserved; queue-wait progress (position, approved) on change or heartbeat.
3. handlers.ts: requestMergeHandler accepts waitMinutes/ticket args + onProgress param, threads into requestMerge.
4. server.ts: request_merge handler uses (args, extra) — when the client sent a progressToken, forward MergeProgress as notifications/progress (monotonic counter); schema gains waitMinutes + ticket.
5. Skills: execute-task + orchestrate-board SKILL.md document the 'pending' status (poll by re-calling request_merge with the same taskId + ticket, or park); blocking default unchanged.
TDD: extend requestMerge.test.ts (pending/resume/progress), mergeQueue.test.ts (verifiedHeadSha), mcpMergeHandlers.test.ts (args passthrough).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented TASK-88 in the task worktree (TDD — tests written first in requestMerge/mergeQueue/mcpMergeHandlers test files).

Core (src/core):
- mergeQueue.ts: QueueEntry gains optional verifiedHeadSha (the HEAD the verify passed against, persisted so a resume can skip re-verifying); new recordVerifiedHead() transform. Backwards compatible — legacy entries lack the field and always re-verify.
- finishTask.ts: new MergeProgress type + FinishDeps.onProgress/progressIntervalMs; RequestMergeResult gains { status:'pending', taskId, queuePosition, ticket, message }; requestMerge(deps, taskId, opts { waitMinutes, ticket }). Resume = existing queue entry for the task: enqueue stays idempotent (original slot + submittedAt kept), the intermediate-status write is skipped on resume (avoids updated_date churn), and pre-verify is skipped when post-rebase HEAD == entry.verifiedHeadSha (extends TASK-87's in-memory base-SHA skip across calls/processes). waitForTurn takes a deadline: expiry returns 'wait_timeout' -> pending, which is the ONLY exit that keeps the queue entry (keepQueued flag around the finally-dequeue) and does not reset board status. ticket = `${taskId}@${submittedAt}`; presenting a ticket when the entry vanished returns sent_back (reviewer Send back while parked — board's sendBackMerge already reset the status). Verify progress: runVerifyObserved emits command/index/count/elapsed, with elapsed ticks emitted by racing the running command against progressIntervalMs sleeps — STRICTLY gated on onProgress being set, so with no observer the code path is byte-identical to runVerifyCommands (no extra deps.sleep calls; existing tests that count sleep() calls stay valid). Queue-wait progress emits position + approved on change or heartbeat. safeEmit swallows observer errors.
- Gotcha found while testing: a one-shot sleep fake that flips approval "on first sleep call" is consumed by the verify ticker when onProgress is set, hanging the poll as a pure-microtask loop (immediate fake sleeps starve timers, so vitest's testTimeout never fires). Test now uses verifyCommands: [] for the queue-wait progress case.

MCP (src/mcp):
- handlers.ts: requestMergeHandler(deps, args, onProgress?) accepts waitMinutes (finite >= 0; 0 = check once) + ticket, threads both into requestMerge and onProgress into FinishDeps.
- server.ts: request_merge registration now uses (args, extra); when the client sent _meta.progressToken it forwards each MergeProgress as notifications/progress with a monotonic progress counter (no total), errors swallowed. Schema + description document waitMinutes/ticket/pending. Fully-blocking default unchanged (no waitMinutes ⇒ behavior identical to before).

Skills: execute-task SKILL.md step 7 documents the bounded wait + poll-or-park handling of 'pending' (never an error, never repo-root merge); orchestrate-board SKILL.md reconcile step + subagent prompt template + rules of thumb handle 'pending' (keep ticket, no release/re-dispatch, resume via request_merge { taskId, worktree, ticket }, sent_back on resume = reviewer send-back; pending counts as in-flight for stop conditions).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
request_merge is no longer pinned to the agent process. (1) Liveness: the MCP server forwards core progress as notifications/progress (monotonic counter) whenever the client sends a progressToken — during verify (command name, i/n, elapsed ticks every progressIntervalMs while a command runs) and during the queue wait (position + approval state, on change or heartbeat) — so clients that reset tool timeouts on progress survive long verifies and reviews. (2) Bounded wait: request_merge accepts waitMinutes (0 = check once); on expiry it returns { status:'pending', queuePosition, ticket } while KEEPING the queue entry and the intermediate board status. A later request_merge for the same task resumes that entry idempotently: no re-enqueue (original slot/submittedAt kept), no duplicate verify when the post-rebase HEAD still equals the verifiedHeadSha now persisted on the queue entry (extends TASK-87's skip across calls/processes), and presenting the ticket detects a reviewer's Send back that happened while parked (returns sent_back instead of silently re-submitting). (3) /execute-task and /orchestrate-board SKILL.md document poll-or-park handling of 'pending' (never a failure; never release/re-dispatch; resume with taskId+ticket). (4) The fully-blocking default is unchanged — no waitMinutes and no observer means the exact pre-TASK-88 code path. Gate: 1782 unit tests, lint, typecheck all green on Windows.
<!-- SECTION:FINAL_SUMMARY:END -->
