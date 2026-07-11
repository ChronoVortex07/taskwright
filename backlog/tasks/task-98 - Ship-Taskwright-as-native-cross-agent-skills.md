---
id: TASK-98
title: Ship Taskwright as native cross-agent skills
status: In Progress
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 08:35'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. agentSkills.ts (new pure core): install the 4 user-facing skills as native SKILL.md packages into <root>/.agents/skills/<name> (Codex canonical discovery surface), plus idempotent upgrade, discovery, and clean uninstall. Reuses installSkill/TASKWRIGHT_SKILL_NAMES from skillInstaller. Tests mirror skillInstaller.test.ts.
2. codexPlugin.ts (new pure core): render a valid .codex-plugin/plugin.json (name/version/description/skills:'./skills/'/mcpServers:'./.mcp.json'), the plugin's .mcp.json, and .agents/plugins/marketplace.json; codexPluginBundleFiles() returns the full bundle file map. Tests assert validity + version wiring + skills+MCP both declared.
3. agentConvention.ts: keep TASKWRIGHT_AGENTS_CONVENTION concise, point at progressively-disclosed native skills; add a character-budget test (AC#4).
4. Repair visual-proof SKILL.md's broken agent-browser reference (.claude/skills/agent-browser is a broken text pseudo-symlink) -> point at real .agents/skills/agent-browser/SKILL.md; add a guard test (AC#5).
5. extension.ts setUpCodexIntegration: replace installCodexPrompts with installAgentSkills (native); remove codexPrompts.ts + its test; update command title MCP+skills.
6. build.ts: assemble dist/codex-plugin bundle so it ships in the VSIX.
7. docs/codex-plugin.md: documented install/update/uninstall flows.
8. Verify gate: bun run test && bun run lint && bun run typecheck; commit --no-verify; request_merge { worktree }.
<!-- SECTION:PLAN:END -->
