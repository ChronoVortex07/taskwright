---
id: TASK-45
title: Push/Pull board UX — status-bar button + command palette
status: Done
assignee: []
created_date: '2026-07-04 04:37'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Board Sync v2 — Single Shared Board
dependencies:
  - TASK-43
priority: medium
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The human-facing surface for the versioning backbone (spec §2.2, §3). Make push/pull board discoverable and legible.

Scope:
- Status-bar item showing board-sync state: mode (off/git), last successful push/pull, and a conflict count when the last sync surfaced conflicts. Click → push or pull (or a quick-pick with both).
- Command-palette entries for taskwright.pushBoard / taskwright.pullBoard (contributes.commands), gated to when a backlog board is present.
- On a surfaced conflict, show a VS Code notification listing the conflicted task IDs (from the union-merge conflict list) with an action to open them — never silent.
- Lucide inline SVG icons, theme-aware (no emojis), per repo UI conventions.

Acceptance:
- Status bar reflects mode and updates after a push/pull.
- Conflicts from a pull are surfaced with the task IDs, not swallowed.
- Commands appear only for a backlog workspace; run the same core as the MCP tools (parity).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
