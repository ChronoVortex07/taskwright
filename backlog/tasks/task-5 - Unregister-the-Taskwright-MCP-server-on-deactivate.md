---
id: TASK-5
title: Unregister the Taskwright MCP server on deactivate
status: Done
assignee: []
created_date: '2026-06-30 11:39'
updated_date: '2026-07-04 00:41'
labels:
  - bug
milestone: Foundation & Rebrand
dependencies: []
priority: low
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
setUpClaudeIntegration registers the MCP server at user scope via claude mcp add, but nothing ever removes it. After the extension is disabled or its install directory changes, a stale taskwright entry can point at a deleted dist/mcp/server.js. Add best-effort, non-throwing cleanup on deactivate and document the limits - VS Code deactivate runs on disable or reload, not on uninstall, so also document the manual claude mcp remove.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A best-effort, non-throwing code path removes the user-scope registration on deactivate
- [ ] #2 The behavior and its uninstall limitation are documented
- [ ] #3 buildRemoveArgs usage is covered by a unit test
<!-- AC:END -->
