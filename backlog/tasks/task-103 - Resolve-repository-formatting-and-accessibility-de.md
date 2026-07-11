---
id: TASK-103
title: Resolve repository formatting and accessibility debt
status: To Do
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 02:36'
labels: []
dependencies: []
priority: medium
category: Polish
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Bring committed source and documentation back under the format check, then address the webview accessibility oversights found by static review: semantic controls, keyboard/focus behavior, accessible names, and appropriate automated coverage without changing intended visuals.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 bun run format:check passes on the committed repository
- [ ] #2 Clickable webview controls use appropriate semantic elements and accessible names
- [ ] #3 Keyboard navigation, visible focus, dialogs, menus, and drag/drop alternatives meet documented accessibility expectations
- [ ] #4 Automated accessibility and interaction coverage protects the corrected behavior
<!-- AC:END -->
