---
id: TASK-61
title: Install the 3 Taskwright skills during Claude Code integration setup
status: Done
assignee: []
created_date: '2026-07-04 12:12'
updated_date: '2026-07-04 12:30'
labels: []
dependencies: []
priority: medium
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The `taskwright.setupClaudeIntegration` command (in `src/extension.ts`) registers the Taskwright MCP server with Claude Code and writes agent instructions to CLAUDE.md, but does **not** install the three Taskwright skills (`create-task`, `execute-task`, `index-codebase`) that live at `.claude/skills/*/SKILL.md`. Agents dispatched after setup need these skills to function — without them, `/create-task`, `/execute-task`, and `/index-codebase` are unavailable.

**What to do:**
- During `setUpClaudeIntegration` (or as a separate step offered to the user), copy/install the three skill directories from the extension's `.claude/skills/` into the user's Claude skills directory (typically `~/.claude/skills/` or the project's `.claude/skills/`).
- Handle the case where skills may already exist (skip or offer to overwrite).
- Consider whether this should be per-project (`.claude/skills/`) or user-global (`~/.claude/skills/`). Per-project is likely correct since these skills are tightly coupled to the Taskwright MCP tools which are also registered per-project via `.mcp.json`.
- The `injectConvention` function in `src/core/agentConvention.ts` already handles CLAUDE.md injection — the skill installation should follow a similar idempotent pattern.

**Acceptance criteria:**
- Running "Taskwright: Set Up Claude Code Integration" also installs the three skills into the project's `.claude/skills/` directory.
- Re-running setup does not duplicate or corrupt existing skill files.
- The skills are functional after setup (an agent can invoke `/create-task`, `/execute-task`, `/index-codebase`).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added `src/core/skillInstaller.ts` with:
- `TASKWRIGHT_SKILL_NAMES` constant: `['create-task', 'execute-task', 'index-codebase']`
- `SkillInstallResult` interface: `{ name, action: 'created' | 'skipped' | 'overwritten' }`
- `installSkill()` — copies one skill directory recursively; idempotent (skips if exists unless overwrite=true)
- `installTaskwrightSkills()` — installs all 3 skills from extension source to project destination

Integrated into `setUpClaudeIntegration` in `src/extension.ts` as step 3 (after MCP registration and CLAUDE.md injection):
- Source: `{extensionPath}/.claude/skills/`
- Destination: `{projectRoot}/.claude/skills/`
- Uses `overwrite=false` (idempotent — skips already-installed skills)
- Reports results via information message (installed X, Y already present)
- Restructured CLAUDE.md step to not early-return so skills installation always runs

Unit tests (`src/test/unit/skillInstaller.test.ts`, 9 tests) cover: create, skip-existing, overwrite, multi-file copy, batch install, partial skip, batch overwrite, idempotency.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added `src/core/skillInstaller.ts` with idempotent skill copy logic and integrated it as step 3 of `setUpClaudeIntegration` in `src/extension.ts`. Running "Taskwright: Set Up Claude Code Integration" now copies `create-task`, `execute-task`, and `index-codebase` from the extension's `.claude/skills/` into the project's `.claude/skills/`. Re-running setup skips already-installed skills (idempotent). Nine unit tests cover all paths: create, skip-existing, overwrite, multi-file copy, batch install, partial skip, batch overwrite, and idempotency. All tests pass; lint and typecheck are clean.
<!-- SECTION:FINAL_SUMMARY:END -->
