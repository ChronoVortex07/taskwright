---
id: TASK-3
title: Disambiguate the two agent-setup commands
status: Done
assignee: []
created_date: '2026-06-30 11:39'
updated_date: '2026-06-30 15:14'
labels:
  - ux
dependencies: []
priority: medium
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Set Up Agent Integration (runs backlog init) and Set Up Claude Code Integration (registers the Taskwright MCP server and injects the CLAUDE.md convention) have confusingly similar titles, so users cannot tell which to run. Retitle for clarity, for example Set Up Backlog.md CLI versus Set Up Claude Code Integration, and document when to use each.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The two commands have clearly distinct titles describing what each does
- [x] #2 README or command descriptions explain when to use each
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Retitled the two confusingly-similar setup commands and documented when to use each.

- package.json: "Set Up Agent Integration" -> "Set Up Backlog.md CLI" (installs/initializes the optional Backlog.md CLI via `backlog init`); "Set Up Claude Code Integration" -> "Set Up Claude Code Integration (MCP + CLAUDE.md)" (registers the Taskwright MCP server + injects the CLAUDE.md convention). Command IDs unchanged so the banner postMessage wiring is unaffected.
- README.md: added a "Setup commands" table explaining what each does and when to run it.
- src/test/unit/commandTitles.test.ts: TDD guard (mirrors configDefaults.test.ts) asserting the two titles stay distinct, the CLI command names Backlog.md (not the old "Agent Integration"), the Claude command names Claude Code, and neither bleeds into the other's domain.
- src/extension.ts has a one-line message-sync to the new Claude title, but that file is concurrently being rewritten by TASK-2 (branding), so it is intentionally left out of the TASK-3 commit and will land with TASK-2.

Scope: left AgentSetupBanner.svelte / AgentIntegrationDetector untouched (TASK-14 owns the banner/flow + backlog->taskwright MCP-naming/detection).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Disambiguated the two agent-setup commands: "Set Up Backlog.md CLI" (optional upstream CLI) vs "Set Up Claude Code Integration (MCP + CLAUDE.md)". Added a README "Setup commands" table explaining when to use each, plus a unit test guarding the titles stay distinct and on-topic.
<!-- SECTION:FINAL_SUMMARY:END -->
