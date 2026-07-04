---
id: TASK-6
title: Add group-by-label swimlanes to the board
status: To Do
assignee: []
created_date: '2026-06-30 11:39'
labels:
  - feature
dependencies: []
priority: medium
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
idea.md envisions many user-created categories such as frontend and backend as a primary board axis, but the kanban only groups by status while categories live as filterable labels. Add an optional group-by toggle so the board can lane tasks by label as well as status, better matching the original vision.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The board offers a group-by toggle between status and label
- [ ] #2 Label grouping renders tasks under their labels with a defined rule for multi-label and unlabeled tasks
- [ ] #3 Drag-and-drop and filtering still work under the new grouping
- [ ] #4 DOM interactions are covered by Playwright webview tests
<!-- AC:END -->
