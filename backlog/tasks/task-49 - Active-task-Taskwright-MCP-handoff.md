---
id: TASK-49
title: Active task + Taskwright MCP handoff
status: Done
assignee: []
created_date: '2026-07-04 00:39'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Agentic Board Core (Phases 1-5)
dependencies:
  - TASK-42
priority: high
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2c: pull-based handoff via <root>/.taskwright/active-task.json (src/core/activeTask.ts, git-ignored, per-worktree). MCP server src/mcp/server.ts (stdio, bundled to dist/mcp/server.js, registered in .mcp.json) exposes get_active_task / claim_task / release_task; handlers in src/mcp/handlers.ts. Active is ephemeral via tree-node popover open/close at this stage of the fork (the popover mechanism itself lands later in P2b).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
