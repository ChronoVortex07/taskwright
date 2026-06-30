---
id: TASK-4
title: Make unit tests path-separator-agnostic so they pass on Windows
status: To Do
assignee: []
created_date: '2026-06-30 11:39'
labels:
  - test
dependencies: []
priority: medium
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
About 21 unit tests hardcode POSIX paths such as /repo/backlog and fail on Windows where path methods produce backslashes. The production code is already cross-platform-correct and must not change. Normalize separators in the test assertions for BacklogParser, BacklogWriter, CrossBranchIntegration, and openWorkspaceFile so the suite is green on both Linux and Windows.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 bun run test passes on Windows with zero failures
- [ ] #2 Assertions compare path.sep-normalized paths rather than hardcoded forward slashes
- [ ] #3 Tests still pass on Linux and CI
- [ ] #4 No production source files are modified
<!-- AC:END -->
