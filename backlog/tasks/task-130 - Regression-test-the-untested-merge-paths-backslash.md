---
id: TASK-130
title: >-
  Regression-test the untested merge paths: backslash worktree validation and
  pending/ticket resume
status: In Progress
assignee: []
created_date: '2026-07-14 05:25'
updated_date: '2026-07-14 10:16'
labels:
  - friction
  - testing
  - windows
milestone: Workflow Friction Hardening
dependencies:
  - TASK-127
references:
  - .taskwright/docs/friction-report-2026-07-14.md
  - src/mcp/handlers.ts
  - src/core/finishTask.ts
  - src/test/unit/requestMerge.test.ts
priority: medium
category: Worktrees & Merge
claimed_by: '@agent/.worktrees/task-130-regression-test-the-untested-merge-paths-backslash-worktree-validation-and-pending-ticket-resume'
worktree: .worktrees/task-130-regression-test-the-untested-merge-paths-backslash-worktree-validation-and-pending-ticket-resume
claimed_at: '2026-07-14 17:45'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two merge-path behaviors have shipped fixes or protocols with no wild-type coverage (friction report 2026-07-14, item 7):

1. The Windows path-separator false negative — request_merge { worktree } claimed a registered worktree "is not a linked worktree of this repository" because git prints forward slashes while path.resolve yields backslashes (derailed TASK-80 and TASK-81 closes into live MCP debugging). Fixed in-flight, but resolveWorktreeTarget/parseWorktreeEntries have no regression test asserting backslash + drive-letter-case inputs match git's forward-slash worktree list output.

2. The pending/ticket resumable-merge protocol (waitMinutes expiry → { status: "pending", queuePosition, ticket } → resume with same taskId + ticket, including the sent_back branch) has never fired outside its unit tests. An acceptance-level test should walk the full park-and-resume cycle against a real repo fixture.

Sequenced after TASK-127 since both touch the same requestMerge core and its tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A regression test feeds backslash-separated and case-differing drive-letter worktree paths into resolveWorktreeTarget/parseWorktreeEntries against git-style forward-slash worktree list output and asserts a match
- [x] #2 An acceptance test drives a real waitMinutes expiry to pending (queuePosition + ticket), resumes with taskId + ticket, and reaches merged
- [x] #3 The sent_back resume branch is exercised by a test (reviewer sends task back while parked)
- [x] #4 Tests are load-order and platform independent (pass on Windows and Linux CI)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Covered both untested merge paths, and found a real latent bug while doing it.

**AC#1 — backslash / drive-case worktree validation.**
Writing the cross-platform regression test surfaced a genuine defect in `isSamePath`
(src/mcp/handlers.ts): it resolved both paths with the AMBIENT `path.resolve`, so the `winLike`
flag only switched the case rule, not the path FLAVOR. Consequences: on Linux CI `winLike=true`
did not treat a backslash as a separator (so the win32 rule was untestable there), and on Windows
`winLike=false` still split on backslashes (so the POSIX rule was untestable here). A failing test
(`does NOT treat a backslash as a separator on POSIX`) pinned it from the Windows side. Fix:
select the flavor from the flag — `winLike ? path.win32 : path.posix`. Production behavior is
byte-identical on both real platforms (`path.win32 === path` on Windows, `path.posix === path` on
POSIX); what changes is that BOTH rule sets are now assertable from EITHER platform, which is what
makes AC#4 achievable at all.

Coverage added, three layers:
- `isSamePath` — git-style forward-slash vs backslash `path.resolve()` output, with and without a
  drive-letter case difference; plus negative cases (different paths / different drives must NOT
  match) so the normalization is not a blanket true.
- `parseWorktreeEntries` — verbatim Windows `git worktree list --porcelain` (forward slashes,
  lowercase drive, CRLF), asserting the parsed path then MATCHES the backslash-resolved target.
- `requestMergeHandler` end-to-end through the private `resolveWorktreeTarget` Gate 2, via a new
  `gitStylePaths` exec option that prints paths the way real git does. On POSIX that transform is a
  no-op, so the same bodies are valid on Linux CI. A genuinely backslash-separated *arg* is only a
  path on Windows (POSIX treats `\` as a filename char), so that one assertion is `it.runIf(win32)`
  — it runs for real on the windows-latest CI leg and is skipped, never failed, on Linux.

**AC#2/#3 — pending/ticket resume (new file: requestMergeResumeIntegration.test.ts).**
Acceptance-level, against a REAL repo: real git (init/worktree add/commit/rebase/ff-merge/remove),
the real on-disk MergeQueueStore, the real makePrimaryBoard task-markdown writes, and the real
reviewer actions the board UI fires (`approveMergeInQueue`, `sendBackMerge`) rather than poking
queue internals. Only `run` (verify shell — counts invocations) and `sleep` are stubbed.
- AC#2: manual-review + waitMinutes:0 -> pending(queuePosition 1, ticket, verifiedHeadSha recorded,
  entry KEPT, board parked at 'Pending Review', worktree intact) -> reviewer approves -> resume with
  ticket -> merged. Asserts verify ran exactly ONCE across both calls, proving the resume reused the
  parked entry and skipped the re-verify because the base never moved.
- AC#3: park -> reviewer `sendBackMerge` -> ticketed resume returns `sent_back`, with the work
  intact (nothing merged to main, worktree still there, no silent re-enqueue).
- Contrast test: resuming WITHOUT the ticket returns `pending`, not `sent_back` — it re-verifies and
  silently re-queues. This documents exactly why the protocol hands back a ticket.

**Mutation-tested** (tests that cannot fail are worthless): disabling the ticketed sent_back branch
breaks AC#3; making `pending` dequeue instead of park (`keepQueued = false`) breaks AC#2 on the
`entries).toHaveLength(1)` assertion. Both reverted; `finishTask.ts` is unmodified by this task.

Gate: 2383/2383 unit tests pass, lint + typecheck clean.
<!-- SECTION:NOTES:END -->
