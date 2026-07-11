---
id: TASK-79
title: >-
  Broaden Set-Up-Claude-Integration scaffolding (AGENTS.md, project .mcp.json,
  orchestrate skill)
status: Done
assignee: []
created_date: '2026-07-08 05:26'
updated_date: '2026-07-08 06:58'
labels: []
milestone: Orchestration & UX Polish
dependencies:
  - TASK-76
  - TASK-78
priority: medium
category: Core Board
plan: docs/superpowers/plans/2026-07-08-broaden-claude-integration-scaffolding.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend setupClaudeIntegration (extension.ts:1754-1844) beyond today's behavior (3 skills + a CLAUDE.md block + user-scope MCP registration) so a fresh repo is fully wired for Taskwright:
- Inject an AGENTS.md convention block (reuse an injectConvention-style writer like agentConvention.ts; today nothing writes AGENTS.md — AgentIntegrationDetector only reads it at :91-97/:119-121).
- Optionally write a project-local `.mcp.json` and ship + copy scripts/taskwright-mcp.cjs (both currently excluded by .vscodeignore:17/:45) for repos that want project-scoped MCP alongside / instead of the user-scope registration.
- Add the new /orchestrate-board skill to TASKWRIGHT_SKILL_NAMES (skillInstaller.ts:10) so it installs too.

Explicitly do NOT include visual-proof (or agent-browser) — those are internal UI-testing tools for this extension, not user-facing.

Depends on the packaging fix (so anything bundled actually ships) and on the orchestrate-board skill existing.

Acceptance criteria:
- Running Set-Up on a fresh repo installs the 4 user-facing skills (create-task, execute-task, index-codebase, orchestrate-board), injects CLAUDE.md + AGENTS.md blocks, and wires MCP.
- Project-local .mcp.json + taskwright-mcp.cjs option works (opt-in), packaged and copied.
- visual-proof / agent-browser excluded.
- Unit coverage for the new writers/paths (AGENTS.md injection, .mcp.json templating, expanded skill set).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented by DeepSeek-pro per plan. (1) AGENTS.md injector: injectAgentsConvention in agentConvention.ts (reuses upsertMarkerBlock/TASKWRIGHT_MARKERS), consent-gated + idempotent, wired into setUpClaudeIntegration (+4 tests). (2) orchestrate-board added to TASKWRIGHT_SKILL_NAMES (4 skills installed; explicit visual-proof/agent-browser exclusion test). (3) Opt-in project-local .mcp.json: new mcpProjectConfig.ts (extract/upsertTaskwrightMcpServer, +9 tests), setting taskwright.setupWritesProjectMcpJson (default false), .vscodeignore un-ignores scripts/taskwright-mcp.cjs + .mcp.json so both ship. (4) CLAUDE.md bullet. Verified: 1654 vitest, lint/typecheck/build clean; vsce ls confirms dist/skills has all 4 (no visual-proof) + launcher ships. Merged to integration (fast-forward).
<!-- SECTION:FINAL_SUMMARY:END -->
