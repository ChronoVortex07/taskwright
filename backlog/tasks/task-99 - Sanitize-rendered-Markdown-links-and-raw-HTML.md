---
id: TASK-99
title: Sanitize rendered Markdown links and raw HTML
type: bug
status: To Do
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 02:36'
labels: []
dependencies: []
priority: high
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Harden all rendered task/document Markdown against unsafe URL schemes such as javascript: and dangerous raw HTML. Centralize the policy, preserve expected safe links, and add adversarial unit plus webview coverage.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 javascript:, data:, vbscript:, encoded, and mixed-case unsafe link targets cannot execute from any rendered Markdown surface
- [ ] #2 Raw HTML is disabled or sanitized with a documented allowlist
- [ ] #3 Safe http, https, mailto, workspace-relative, and task-reference links retain expected behavior
- [ ] #4 Unit and Playwright tests cover adversarial payloads and link activation
<!-- AC:END -->
