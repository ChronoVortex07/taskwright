---
id: TASK-2
title: Replace leftover Backlog.md branding in user-facing strings
status: To Do
assignee: []
created_date: '2026-06-30 11:39'
labels:
  - polish
dependencies: []
priority: low
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Some user-visible strings still say Backlog.md after the rebrand: the agent-setup terminal is named Backlog Agent Setup (extension.ts around line 645) and activation logs use the [Backlog.md] prefix (extension.ts around line 1028). Audit user-facing strings and log prefixes and align them to Taskwright, while preserving genuine references to the Backlog.md backbone and CLI.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Terminal names and notification strings reflect Taskwright branding
- [ ] #2 Console log prefixes use a consistent Taskwright tag
- [ ] #3 Factual references to the Backlog.md backbone and CLI are preserved
<!-- AC:END -->
