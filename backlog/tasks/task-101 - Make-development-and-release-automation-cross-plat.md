---
id: TASK-101
title: Make development and release automation cross-platform
status: To Do
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 02:36'
labels: []
dependencies: []
priority: medium
category: Misc
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Remove the Windows-hostile assumptions in package scripts and helper tooling, add Windows CI coverage alongside the existing platform, and ensure build, license, screenshot, Playwright, CDP, e2e, packaging, and release entry points either run portably or fail with explicit supported-platform guidance.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Core build, test, lint, typecheck, license, package, and release scripts have cross-platform entry points
- [ ] #2 Bash-only e2e and screenshot helpers are ported or wrapped with explicit platform detection and actionable errors
- [ ] #3 CI runs the supported verification matrix on Windows and Linux
- [ ] #4 Developer documentation lists any unavoidable platform prerequisites
<!-- AC:END -->
