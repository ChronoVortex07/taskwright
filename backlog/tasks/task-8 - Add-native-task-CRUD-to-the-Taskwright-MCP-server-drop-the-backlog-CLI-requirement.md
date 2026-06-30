---
id: TASK-8
title: >-
  Add native task CRUD to the Taskwright MCP server (drop the backlog CLI
  requirement)
status: In Progress
assignee: []
created_date: '2026-06-30 11:39'
updated_date: '2026-06-30 12:07'
labels:
  - feature
  - mcp
dependencies: []
priority: high
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today Taskwright reads task files directly but delegates all writes to the external backlog CLI, and .mcp.json registers a separate backlog MCP server (backlog mcp start). This forces users to install Backlog.md as a prerequisite just to create or edit tasks. Move task CRUD into the Taskwright MCP server so the extension is self-sufficient: expose create/edit/move/complete/archive tools that produce Backlog.md-compatible task files, and remove the hard dependency on the external backlog CLI and its MCP server. Generated files must stay byte-for-byte compatible with Backlog.md frontmatter and section markers (see AGENTS.md serialization rules) so the data remains interoperable. Open design decision to settle in brainstorming and planning: reuse the backlog.md npm package as a bundled library, extend the existing BacklogWriter to own writes, or bundle the CLI binary.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Taskwright MCP server exposes task CRUD tools (at minimum create and edit) that write Backlog.md-compatible files
- [ ] #2 Creating and editing tasks no longer requires the external backlog CLI to be installed
- [ ] #3 Generated task files remain byte-for-byte compatible with Backlog.md frontmatter and section markers
- [ ] #4 .mcp.json and the docs no longer require the separate backlog MCP server for core task management
- [ ] #5 CLAUDE.md coupling rules are updated to reflect Taskwright-owned writes
- [ ] #6 Unit tests cover the new write paths
<!-- AC:END -->
