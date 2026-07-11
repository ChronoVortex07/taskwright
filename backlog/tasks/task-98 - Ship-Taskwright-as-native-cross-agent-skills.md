---
id: TASK-98
title: Ship Taskwright as native cross-agent skills
status: In Progress
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 02:36'
labels: []
dependencies:
  - TASK-96
priority: high
category: Orchestration
claimed_by: '@agent/main'
worktree: main
claimed_at: '2026-07-11 16:20'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the Codex custom-prompt approximation with native skills and a plugin-compatible distribution model. Follow Codex's canonical .agents/skills progressive-disclosure format, keep MCP/tool workflow instructions concise, preserve Claude support from the same source of truth, repair the unusable visual-proof skill reference, and document install/update behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Taskwright skills install as native SKILL.md packages under Codex's canonical .agents/skills discovery surface
- [ ] #2 Claude and Codex integrations are rendered from one versioned source of truth without reducing either agent's capabilities
- [ ] #3 A valid Codex plugin manifest can distribute the skills and Taskwright MCP together with documented install and update flows
- [ ] #4 AGENTS.md stays within Codex instruction limits by moving detailed workflows into progressively disclosed skills
- [ ] #5 The visual-proof capability is a real readable skill or is removed from required workflow instructions
- [ ] #6 Automated tests cover installation, idempotent upgrades, discovery, and clean uninstall behavior
<!-- AC:END -->
