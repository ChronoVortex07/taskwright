---
id: TASK-102
title: Reconcile documentation and release metadata drift
status: In Progress
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 02:36'
labels: []
dependencies: []
priority: medium
category: Docs & Branding
claimed_by: '@agent/main'
worktree: main
claimed_at: '2026-07-11 17:49'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Audit README, setup guidance, command descriptions, package metadata, configuration examples, and generated artifacts against the current Taskwright behavior. Remove stale Claude-only or Backlog-era language and add automated checks where metadata can be derived.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 README and setup docs accurately describe Claude, Codex, MCP, skills, worktrees, board sync, and merge behavior
- [ ] #2 Package command/configuration descriptions match their current implementation and defaults
- [ ] #3 Backlog-era names and stale generated examples are removed or clearly marked as compatibility aliases
- [ ] #4 Derivable documentation or metadata is checked automatically to prevent recurrence
<!-- AC:END -->
