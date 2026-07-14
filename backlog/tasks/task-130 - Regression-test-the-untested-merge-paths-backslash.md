---
id: TASK-130
title: >-
  Regression-test the untested merge paths: backslash worktree validation and
  pending/ticket resume
status: To Do
assignee: []
created_date: '2026-07-14 05:25'
updated_date: '2026-07-14 08:21'
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
- [ ] #1 A regression test feeds backslash-separated and case-differing drive-letter worktree paths into resolveWorktreeTarget/parseWorktreeEntries against git-style forward-slash worktree list output and asserts a match
- [ ] #2 An acceptance test drives a real waitMinutes expiry to pending (queuePosition + ticket), resumes with taskId + ticket, and reaches merged
- [ ] #3 The sent_back resume branch is exercised by a test (reviewer sends task back while parked)
- [ ] #4 Tests are load-order and platform independent (pass on Windows and Linux CI)
<!-- AC:END -->
