---
id: TASK-50
title: Subscription-safe dispatch
status: Done
assignee: []
created_date: '2026-07-04 00:40'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Agentic Board Core (Phases 1-5)
dependencies:
  - TASK-49
priority: high
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3: backlog.dispatchTask renders a paste-ready prompt and copies it to the clipboard — never spawns claude -p. Pure cores: src/core/dispatchPrompt.ts (configurable template + {{placeholder}} substitution), src/core/WorktreeService.ts (.worktrees/<branch> isolation), src/core/handoff.ts (.taskwright/handoff/<id>.md). Orchestration in src/providers/dispatchActions.ts; "Dispatch" control in the tree-node popover.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
