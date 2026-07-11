---
id: TASK-51
title: Intake — "Categorize with Claude"
status: Done
assignee: []
created_date: '2026-07-04 00:40'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Agentic Board Core (Phases 1-5)
dependencies:
  - TASK-49
priority: medium
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3: backlog.categorizeWithClaude captures raw notes in the active editor (selection, else whole doc), renders a paste-ready prompt constrained by the board's labels/statuses/priorities, and copies it to the clipboard for a session to create tasks via the Taskwright MCP. Pure core src/core/intakePrompt.ts (+ shared src/core/templateRender.ts); glue in src/providers/intakeActions.ts. Subscription-safe.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
