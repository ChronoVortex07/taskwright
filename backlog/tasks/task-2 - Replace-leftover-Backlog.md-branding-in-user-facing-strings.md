---
id: TASK-2
title: Replace leftover Backlog.md branding in user-facing strings
status: Done
assignee: []
created_date: '2026-06-30 11:39'
updated_date: '2026-06-30 15:13'
labels:
  - polish
dependencies: []
priority: low
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Some user-visible strings still say Backlog.md after the rebrand: the agent-setup terminal is named Backlog Agent Setup (extension.ts around line 645) and activation logs use the [Backlog.md] prefix (extension.ts around line 1028). Audit user-facing strings and log prefixes and align them to Taskwright, while preserving genuine references to the Backlog.md backbone and CLI.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Terminal names and notification strings reflect Taskwright branding
- [x] #2 Console log prefixes use a consistent Taskwright tag
- [x] #3 Factual references to the Backlog.md backbone and CLI are preserved
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Audited all user-facing strings and log prefixes across src/.

Changed (Taskwright branding):
- Agent-setup terminal name "Backlog Agent Setup" → "Taskwright Agent Setup" (both occurrences in extension.ts).
- Console log prefixes unified to the Taskwright tag: `[Backlog.md]` → `[Taskwright]` (extension.ts, BaseViewProvider.ts, TaskDetailProvider.ts, TasksController.ts, StatusCallbackRunner.ts) and `[Backlog.md Parser]` → `[Taskwright Parser]` (BacklogParser.ts). TasksViewProvider.ts and agentConvention.ts already used `[Taskwright]`, so the tag is now consistent everywhere.
- Intake template (intakePrompt.ts DEFAULT_INTAKE_TEMPLATE): "into a Backlog.md task board" → "into a Taskwright task board" (file already referenced "the Taskwright MCP"; this was the last leftover).
- Webview empty-state command hint (Tasks.svelte): "Backlog: Initialize" → "Taskwright: Initialize Backlog" — this was also factually wrong; it must match the registered command title (taskwright.init) shown in the Command Palette.

Preserved (genuine Backlog.md backbone/CLI references, per AC#3):
- package.json description "git-native Backlog.md backbone".
- "Install Backlog.md CLI manually..." notification (extension.ts) and "Install Backlog.md CLI to enable AI agent integration" (AgentSetupBanner.svelte) — real CLI install instructions (npm/bun install -g backlog.md).
- The MrLesk/Backlog.md documentation URL; BacklogCli warning "...require the backlog CLI".
- Code comments / type docs / MCP tool descriptions describing the Backlog.md format and byte-for-byte frontmatter compatibility.
- "No Backlog Found" empty-state heading and "Backlog initialized in <path>" notification — these refer to the backlog/ folder (the data-structure backbone), kept consistent with "No backlog folder found".

TDD: added a regression test in intakePrompt.test.ts asserting the default template references a "Taskwright task board" and not a "Backlog.md task board".

Verification: typecheck clean (exit 0); ESLint clean on the changed files (exit 0); focused intakePrompt test 4/4 pass. Full Vitest run shows the 22 documented Windows POSIX-path failures only — confirmed identical to the pre-change baseline (no new regressions). Changes are string-only with no behavioral impact, so the log-prefix/terminal/webview edits are cosmetic per the project's TDD-exemption for UI/string changes.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Rebranded leftover Backlog.md product strings to Taskwright in user-facing surfaces: agent-setup terminal name, all console log prefixes (now a consistent `[Taskwright]` / `[Taskwright Parser]` tag), the intake prompt template, and the webview's Command-Palette hint (also a correctness fix). Genuine references to the Backlog.md backbone format and CLI were deliberately preserved.
<!-- SECTION:FINAL_SUMMARY:END -->
