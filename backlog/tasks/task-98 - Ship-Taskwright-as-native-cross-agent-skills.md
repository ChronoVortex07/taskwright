---
id: TASK-98
title: Ship Taskwright as native cross-agent skills
status: Done
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 08:53'
labels: []
dependencies:
  - TASK-96
priority: high
category: Orchestration
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the Codex custom-prompt approximation with native skills and a plugin-compatible distribution model. Follow Codex's canonical .agents/skills progressive-disclosure format, keep MCP/tool workflow instructions concise, preserve Claude support from the same source of truth, repair the unusable visual-proof skill reference, and document install/update behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Taskwright skills install as native SKILL.md packages under Codex's canonical .agents/skills discovery surface
- [x] #2 Claude and Codex integrations are rendered from one versioned source of truth without reducing either agent's capabilities
- [x] #3 A valid Codex plugin manifest can distribute the skills and Taskwright MCP together with documented install and update flows
- [x] #4 AGENTS.md stays within Codex instruction limits by moving detailed workflows into progressively disclosed skills
- [x] #5 The visual-proof capability is a real readable skill or is removed from required workflow instructions
- [x] #6 Automated tests cover installation, idempotent upgrades, discovery, and clean uninstall behavior
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Researched Codex's canonical format (developers.openai.com/codex/skills + plugin-system reference): skills discover under .agents/skills/<name>/SKILL.md (repo/cwd/$HOME), frontmatter requires only name+description, plugins distribute via .codex-plugin/plugin.json (skills:'./skills/', mcpServers:'./.mcp.json'), version bump = reinstall cache key.

Implementation:
- src/core/agentSkills.ts (NEW): installAgentSkills copies the 4 full skill packages from dist/skills into <root>/.agents/skills/<name> (native, progressive-disclosure preserved), plus discoverAgentSkills (scans for SKILL.md) and uninstallAgentSkills (scoped clean removal, leaves unrelated skills). Reuses skillInstaller.installSkill.
- src/core/codexPlugin.ts (NEW): renders a valid .codex-plugin/plugin.json (name/version/description/skills/mcpServers + metadata), the plugin's bare-map .mcp.json (drops Claude-only type/url), a repo-scoped .agents/plugins/marketplace.json, and codexPluginBundleFiles().
- scripts/build.ts: bundleCodexPlugin() assembles dist/codex-plugin/ (manifest + .mcp.json + marketplace + mcp/server.js + skills/) after esbuild. Excluded from the VSIX (.vscodeignore) as a separate distribution artifact.
- extension.ts setUpCodexIntegration: now calls installAgentSkills(dist/skills, root) instead of installCodexPrompts; command title -> (MCP + skills). Removed src/core/codexPrompts.ts + its test (the reducing prompt approximation).
- agentConvention.ts: TASKWRIGHT_AGENTS_CONVENTION now points at the progressively-disclosed native skills; added TASKWRIGHT_AGENTS_CONVENTION_MAX_CHARS budget + test.
- AC#5: .claude/skills/agent-browser is a broken 34-byte text pseudo-symlink (git-on-Windows didn't materialize it), so visual-proof/SKILL.md's reference to .claude/skills/agent-browser/SKILL.md was unusable; repointed to the real .agents/skills/agent-browser/SKILL.md. Guard test in visualProofSkill.test.ts.
- Docs: docs/codex-plugin.md (install/update/uninstall) + README/CLAUDE.md updates.

Verify gate: bun run test (1987 passing, 138 files), lint, typecheck all green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped Taskwright as native cross-agent skills. Codex now gets the four workflow skills as native SKILL.md packages under its canonical .agents/skills discovery surface (progressive disclosure), from the same single source of truth Claude Code uses (dist/skills) — replacing the capability-reducing ~/.codex/prompts custom-prompt approximation (codexPrompts.ts removed). Added a valid Codex plugin (.codex-plugin/plugin.json) that distributes the skills and the Taskwright MCP server together, assembled into dist/codex-plugin/ by the build, with documented install/update/uninstall flows (docs/codex-plugin.md). Kept the injected AGENTS.md convention concise under a documented budget by deferring detail to the skills, and repaired the unusable visual-proof -> agent-browser reference (broken .claude/skills pseudo-symlink -> real .agents/skills path). New unit coverage for install/idempotent-upgrade/discovery/clean-uninstall, plugin-manifest validity, the convention budget, and the visual-proof reference. Full gate green: 1987 unit tests, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
