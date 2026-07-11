---
id: TASK-52
title: Superpowers bridge — plan linking
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
Phase 4: link a task to its implementation plan/spec and surface checkbox progress. Taskwright-only plan frontmatter field written surgically (src/core/PlanService.ts + generic src/core/frontmatterEdit.ts); src/core/planProgress.ts parses - [ ]/- [x] steps; src/core/loadPlanProgress.ts reads the linked file. MCP attach_plan tool + plan/planProgress in get_active_task. Detail-panel plan banner (progress bar, Open/Detach/Attach) via src/providers/planActions.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
