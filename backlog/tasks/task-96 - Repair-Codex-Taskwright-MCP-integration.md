---
id: TASK-96
title: Repair Codex Taskwright MCP integration
type: bug
status: Done
assignee: []
created_date: '2026-07-11 02:19'
updated_date: '2026-07-11 02:32'
labels: []
dependencies: []
priority: high
category: Orchestration
caused_by: TASK-92
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Fix the release-blocking Codex integration defects found in the repository audit: register the packaged MCP server so it starts in ordinary consumer repositories, stop treating the legacy Backlog MCP as equivalent to Taskwright, dogfood the correct project-scoped Taskwright MCP configuration, and expose server workflow instructions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Codex setup registers the packaged MCP server directly and the server starts from a normal consumer Git repository
- [x] #2 Legacy backlog MCP configuration no longer suppresses the Taskwright Codex setup prompt
- [x] #3 The repository project-scoped Codex config exposes the taskwright MCP after restart
- [x] #4 The Taskwright MCP initialization response includes concise cross-tool workflow instructions
- [x] #5 Unit tests cover consumer-repository startup, detection, configuration, and server instructions
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add failing tests for the Codex setup server target, legacy detection semantics, and MCP instructions.
2. Refactor Codex integration helpers so consumer setup targets the packaged server while preserving the worktree launcher for project-local development.
3. Update the repo-scoped Codex MCP configuration and agent convention text.
4. Build and exercise the server from a disposable consumer repository.
5. Run the full required verification suite and merge through Taskwright.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added regression tests first. Codex setup now rewrites the repository MCP template to the absolute packaged dist/mcp/server.js path instead of the cwd-dependent development launcher. Codex detection accepts only the Taskwright server name. The project config now registers taskwright. The MCP initialization handshake carries a compact workflow contract whose critical sequence is within the first 512 characters. A compiled server was started successfully from a disposable consumer Git repository and returned its instructions, full tool list, and no-active-task response.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Repaired Codex-to-Taskwright MCP discovery and startup. Verified 1,934 unit tests, lint, typecheck, compilation, and a real consumer-repository MCP handshake.
<!-- SECTION:FINAL_SUMMARY:END -->
