---
id: TASK-126
title: >-
  Serialize merge-queue verify runs to eliminate load-induced flakes under
  parallel orchestration
status: In Progress
assignee: []
created_date: '2026-07-14 05:24'
updated_date: '2026-07-14 08:21'
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
claimed_by: '@agent/task-126-serialize-merge-queue-verify-runs-to-eliminate-load-induced-flakes-under-parallel-orchestration'
worktree: task-126-serialize-merge-queue-verify-runs-to-eliminate-load-induced-flakes-under-parallel-orchestration
claimed_at: '2026-07-14 16:23'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When several /orchestrate-board subagents hit the merge queue concurrently, each runs the full verify suite (`bun run test` etc.) in parallel. Under that load the git-subprocess-heavy suites (boardRef.test.ts, boardSyncHook.test.ts, mcpBoardPushPullHandlers.test.ts) blow their 5000ms testTimeouts, plus Windows-only EPERM on temp-dir cleanup (tempGitRepo.ts). Mined evidence (friction report 2026-07-14): TASK-90's agent needed 4 consecutive request_merge calls (~11 min of retries); one orchestration run racked up 5+ verify_failed aborts — all load-induced, every test passing in isolation. A later session learned the scar and passes verifyTimeoutMinutes: 15 on every call, which masks rather than fixes the contention.

Fix direction: run pre-enqueue verifies through a shared execution slot (serialize verify runs across concurrent request_merge calls, the same way the queue already serializes the merge itself), or provide an equivalent isolation mode. Also consider raising the default verify timeout so a single slow suite is not an instant abort.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Concurrent request_merge calls never run their verify suites simultaneously (a shared verify slot/lock serializes them), or an equivalent isolation mechanism prevents cross-run resource contention
- [ ] #2 A regression test simulates two overlapping request_merge verifies and proves serialization (second waits for first)
- [ ] #3 Queue wait while holding no verify slot does not deadlock: verify slot is released before the merge-queue wait begins
- [ ] #4 Default verify timeout is reviewed and raised if the current default cannot accommodate the repo's own suite on a loaded machine; rationale documented
- [ ] #5 The verify_failed abort message distinguishes 'suite failed' from 'suite timed out' so agents stop blind-retrying flakes
<!-- AC:END -->
