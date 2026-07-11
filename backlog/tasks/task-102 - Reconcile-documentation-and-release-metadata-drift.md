---
id: TASK-102
title: Reconcile documentation and release metadata drift
status: In Progress
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 10:08'
labels: []
dependencies: []
priority: medium
category: Docs & Branding
claimed_by: '@agent/main'
worktree: main
claimed_at: '2026-07-11 17:49'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Audit README, setup guidance, command descriptions, package metadata, configuration examples, and generated artifacts against the current Taskwright behavior. Remove stale Claude-only or Backlog-era language and add automated checks where metadata can be derived.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README and setup docs accurately describe Claude, Codex, MCP, skills, worktrees, board sync, and merge behavior
- [x] #2 Package command/configuration descriptions match their current implementation and defaults
- [x] #3 Backlog-era names and stale generated examples are removed or clearly marked as compatibility aliases
- [x] #4 Derivable documentation or metadata is checked automatically to prevent recurrence
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Audited README, package.json (release metadata + all command/config descriptions), setup docs, and generated artifacts against current behavior (Explore agent + manual cross-check). Concrete drift fixed:
- Codex "custom prompt" language was stale everywhere (code now installs native .agents/skills SKILL.md packages via installAgentSkills): fixed README skills section, package.json taskwright.dispatchAgent codex enumDescription, the Codex setup dialog + comment in src/extension.ts, and the comment + CODEX_DISPATCH_TEMPLATE in src/core/dispatchProfiles.ts.
- package.json Marketplace `description` was Claude-only despite first-class Codex dispatch: now "Claude Code or Codex"; added "codex" keyword.
- MCP server advertised a stale hardcoded version 0.0.1 while the package is 1.4.0: added src/mcp/serverMeta.ts deriving MCP_SERVER_NAME/MCP_SERVER_VERSION from package.json (esbuild inlines the JSON named import; verified dist/mcp/server.js now carries 1.4.0, 0.0.1 gone), server.ts uses them.
AC#4 automated check: new src/test/unit/releaseMetadata.test.ts asserts CHANGELOG newest version == package.json version, MCP server version == package.json version (and != the retired 0.0.1), server.ts derives rather than hardcodes, and keywords name every taskwright.dispatchAgent enum value — so this metadata reconciles automatically instead of by hand.
Deliberately left intentional/guarded items: "Set Up Backlog.md CLI" command title (guarded by commandTitles.test.ts), "Initialize Backlog" (backlog/ folder), historical design docs referencing vscode-backlog-md, illustrative version examples in README/building-and-publishing.
Verified: typecheck clean, 2038 unit tests pass (incl. new suite + unchanged dispatchProfiles contract test), lint clean, build succeeds.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Reconciled documentation and release-metadata drift: removed stale Codex "custom prompt" language (Codex installs native .agents/skills packages) across README, package.json, and dispatch/setup code; made the Marketplace description + keywords agent-agnostic (Claude Code + Codex); fixed the MCP server's stale 0.0.1 version by deriving it from package.json; and added a releaseMetadata unit test that keeps CHANGELOG version, MCP server version, and dispatch-agent keywords automatically reconciled with package.json.
<!-- SECTION:FINAL_SUMMARY:END -->
