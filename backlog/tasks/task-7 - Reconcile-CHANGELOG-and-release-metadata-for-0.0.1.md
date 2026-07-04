---
id: TASK-7
title: Reconcile CHANGELOG and release metadata for 0.0.1
status: To Do
assignee: []
created_date: '2026-06-30 11:39'
labels:
  - docs
dependencies: []
priority: low
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
package.json is at version 0.0.1 and a vsix is already built, but CHANGELOG only has an Unreleased section. Move the initial entry under a dated 0.0.1 heading or adopt the release-it flow so the changelog matches shipped versions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CHANGELOG has a dated 0.0.1 section matching package.json
- [ ] #2 An Unreleased section is retained for future work
- [ ] #3 The format is consistent with .release-it.json conventions
<!-- AC:END -->
