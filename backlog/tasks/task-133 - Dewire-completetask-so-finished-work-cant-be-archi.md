---
id: TASK-133
title: Dewire complete_task so finished work can't be archived off the board
status: To Do
assignee: []
created_date: '2026-07-14 08:51'
updated_date: '2026-07-14 08:51'
labels: []
milestone: Workflow Friction Hardening
dependencies: []
references:
  - src/mcp/server.ts
  - src/mcp/handlers.ts
  - src/providers/TasksController.ts
  - src/core/BacklogWriter.ts
  - src/mcp/instructions.ts
priority: high
category: 'Core Board'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`complete_task` is exposed on two surfaces — the Taskwright MCP tool registered in `src/mcp/server.ts` (→ `completeTaskHandler` in `src/mcp/handlers.ts`) and the webview `completeTask` message handled in `src/providers/TasksController.ts` — and both land in `BacklogWriter.completeTask()`, which moves the task file into `backlog/completed/`. That takes the task out of the board's records entirely.

Today that is pure downside. `request_merge` already marks a merged task **Done** and leaves it in `tasks/`, where it stays visible on the board — so completion is fully served without `complete_task`. The only thing `complete_task` actually does is make finished work vanish, and it sits one tool call (or one click) away from any agent or human. The agent-facing instructions already have to carry a "do not call complete_task" warning to defend against it, which is a sign the surface shouldn't be there.

Dewire it — disconnect the surfaces, keep the machinery — until the Done-vs-Completed (archival) semantics are actually decided. That decision is TASK-131's job; this task is the interim safety measure so nothing else gets archived off the board in the meantime. Re-wiring later must be a registration change, not a rewrite: `BacklogWriter.completeTask()` and its unit tests stay exactly where they are.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The `complete_task` MCP tool is no longer registered on the Taskwright MCP server (`src/mcp/server.ts`), so no agent can call it; a call to it fails as an unknown tool.
- [ ] #2 No UI surface dispatches the webview `completeTask` message any more — the action is gone from the board/detail/tree surfaces that offered it.
- [ ] #3 `BacklogWriter.completeTask()` and its existing unit tests are left intact and passing. Only the surfaces are dewired, so re-wiring is a re-registration, not a rewrite.
- [ ] #4 The `TasksController` `completeTask` message case is either removed or made unreachable-and-inert, with no silent path left that still moves a task into `backlog/completed/`.
- [ ] #5 Agent-facing text is corrected: `src/mcp/instructions.ts` no longer needs to warn 'Do not call complete_task' about a tool that no longer exists, and `src/test/unit/mcpInstructions.test.ts` is updated to match rather than left asserting the stale warning.
- [ ] #6 Tasks already sitting in `backlog/completed/` still parse and still render; `restore_task` still brings them back. Dewiring the entry point does not orphan anything already archived.
- [ ] #7 Full gate green in the worktree: `bun run test && bun run lint && bun run typecheck`.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 A grep for `complete_task` / `completeTask` shows no reachable caller from an MCP tool registration or a UI event handler.
- [ ] #2 AGENTS.md / CLAUDE.md guidance no longer instructs agents around a tool that is not exposed.
<!-- DOD:END -->
