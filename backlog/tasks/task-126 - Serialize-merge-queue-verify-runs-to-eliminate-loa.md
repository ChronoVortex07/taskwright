---
id: TASK-126
title: >-
  Serialize merge-queue verify runs to eliminate load-induced flakes under
  parallel orchestration
status: Done
assignee: []
created_date: '2026-07-14 05:24'
updated_date: '2026-07-14 08:49'
labels:
  - friction
  - merge-queue
milestone: Workflow Friction Hardening
dependencies: []
references:
  - .taskwright/docs/friction-report-2026-07-14.md
  - src/core/finishTask.ts
priority: high
category: Worktrees & Merge
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When several /orchestrate-board subagents hit the merge queue concurrently, each runs the full verify suite (`bun run test` etc.) in parallel. Under that load the git-subprocess-heavy suites (boardRef.test.ts, boardSyncHook.test.ts, mcpBoardPushPullHandlers.test.ts) blow their 5000ms testTimeouts, plus Windows-only EPERM on temp-dir cleanup (tempGitRepo.ts). Mined evidence (friction report 2026-07-14): TASK-90's agent needed 4 consecutive request_merge calls (~11 min of retries); one orchestration run racked up 5+ verify_failed aborts — all load-induced, every test passing in isolation. A later session learned the scar and passes verifyTimeoutMinutes: 15 on every call, which masks rather than fixes the contention.

Fix direction: run pre-enqueue verifies through a shared execution slot (serialize verify runs across concurrent request_merge calls, the same way the queue already serializes the merge itself), or provide an equivalent isolation mode. Also consider raising the default verify timeout so a single slow suite is not an instant abort.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Concurrent request_merge calls never run their verify suites simultaneously (a shared verify slot/lock serializes them), or an equivalent isolation mechanism prevents cross-run resource contention
- [x] #2 A regression test simulates two overlapping request_merge verifies and proves serialization (second waits for first)
- [x] #3 Queue wait while holding no verify slot does not deadlock: verify slot is released before the merge-queue wait begins
- [x] #4 Default verify timeout is reviewed and raised if the current default cannot accommodate the repo's own suite on a loaded machine; rationale documented
- [x] #5 The verify_failed abort message distinguishes 'suite failed' from 'suite timed out' so agents stop blind-retrying flakes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Root cause

The merge queue serialized the *merge* but not the *verify*: `requestMerge` ran its verify commands
**before** enqueuing, so N concurrent `/orchestrate-board` subagents each launched a full
`bun run test` at once. Vitest already saturates every core with its own worker pool, so N runs
oversubscribe the machine ~N×; git-subprocess-heavy tests then exceeded vitest's **5000ms per-test**
default and the suite went red → `verify_failed`, with every test green in isolation.

Key finding: the aborts were mostly *red suites*, not killed commands — so raising
`verifyTimeoutMinutes` (what scarred sessions had learned to do) could never have fixed them.

## Fix

- **`src/core/verifySlot.ts` (new)** — a shared, cross-process verify slot. O_EXCL (`wx`) lock file at
  `<commonDir>/taskwright/verify-slot.lock`, so it serializes across every worktree *and* every MCP
  server process (in-session subagents may share one server; separate sessions do not — an
  in-process mutex would only have covered the first case). Stealable on a dead pid, an expired lease
  (worst-case verify duration + 2min grace), or a torn write, so a crashed holder cannot wedge every
  future merge. Release only removes the lock if we still own it (owner+pid+acquiredAt), so a holder
  that was legitimately stolen from can't evict its successor.
- **`finishTask.ts`** — both verify sites (pre-enqueue and post-wait re-verify) run inside
  `withVerifySlot`. The slot is held ONLY for the run and released in a `finally` **before** the
  merge-queue wait — that is what makes AC3 true: no slot-holder → queue-waiter → slot-waiter cycle
  can form. New `verify-wait` progress phase names the task holding the slot.
- **`handlers.ts`** — wires the real `FileVerifySlot` by default (injectable for tests).

## Measurements (AC4)

Windows dev machine, this repo: `bun run test` 21s / `lint` 4s / `typecheck` 3s unloaded. Three
suites concurrently: **57s each** (~2.7× inflation). Serialization is nearly free: 3×21s = 63s
serialized vs 57s wall concurrent — because vitest already uses every core, running them in parallel
buys ~nothing and costs correctness.

- `mergeVerifyTimeoutMinutes` **10 → 20**. 10 was not *provably* too small, but the margin under
  heavy load was only ~2-3× and the failure is asymmetric: a premature kill costs an agent a whole
  retry cycle (TASK-90 burned ~11 min over 4 calls), a late kill only delays aborting a hung command.
- **vitest `testTimeout` 5s → 20s** — the timeout the flakes *actually* hit. This is the real fix for
  the mined evidence; the harness cap was a red herring.

## AC5

`verify_timeout` vs `verify_failed` already differed by abort code; the prose now makes them
unmistakable: a red suite says it exited non-zero, that a bare retry fails the same way, and (when
the slot serialized it) that no other merge was competing with it — killing the blind-retry loop at
its source. A timeout says it was KILLED and names the setting to raise.

## Tests (+22)

`verifySlot.test.ts` (15: exclusion, stale/dead-pid/torn-write steal, release safety, create race),
`requestMergeVerifySlot.test.ts` (4: two overlapping requestMerge calls prove serialization via a
`peakConcurrency` counter + event order; verify-wait progress; slot free while parked in the queue
(AC3); crashed-holder recovery), plus AC5 message-distinctness tests and an `mcpMergeHandlers` test
asserting the real lock file exists during verify and is gone after. Verified the regression tests
genuinely fail without the slot (peakConcurrency 2, both verifies overlapping).

Full gate green: 2286 tests / 157 files, lint, typecheck.
<!-- SECTION:NOTES:END -->
