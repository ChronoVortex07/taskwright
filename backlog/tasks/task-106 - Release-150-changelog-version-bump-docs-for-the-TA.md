---
id: TASK-106
title: 'Release 1.5.0 — changelog, version bump & docs for the TASK-98–103 wave'
status: In Progress
assignee: []
created_date: '2026-07-11 10:58'
updated_date: '2026-07-11 10:59'
labels: []
dependencies: []
priority: medium
category: Docs & Branding
claimed_by: '@agent/main'
worktree: main
claimed_at: '2026-07-11 19:02'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The TASK-98–103 wave merged to main undocumented: native cross-agent skills + .codex-plugin bundle (TASK-98), dependency-audit triage + churn-resilient CI audit gate (TASK-100), centralized Markdown URL sanitization (TASK-99), cross-platform automation + Windows/Linux CI matrix (TASK-101), documentation/release-metadata drift reconciliation (TASK-102), and repository formatting + webview accessibility debt (TASK-103). Cut a 1.5.0 release documenting the wave, verified by the existing `releaseMetadata` gate (CHANGELOG newest == package.json == MCP server version == reconciled keywords).

Note on current state: `package.json` is at 1.4.0; the CHANGELOG's newest section is [1.4.0] (the git-auto board-home release). TASK-102's "Documentation & release-metadata drift reconciled" entry currently sits inside that 1.4.0 `### Fixed` section even though it merged after 1.4.0 was cut — prefer relocating it into the new 1.5.0 section so the wave is documented together, leaving 1.4.0 accurate for the git-auto release only. Follow the same Keep a Changelog style and prose depth as the existing 1.3.0/1.4.0 entries. Version choice: minor bump (new user-facing feature = native cross-agent skills / Codex plugin, plus two security fixes), matching the per-wave precedent (TASK-94→1.3.0, TASK-95→1.4.0).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 package.json version bumped 1.4.0 → 1.5.0; the build inlines 1.5.0 into dist/mcp/server.js (MCP server reports 1.5.0); no stale 1.4.0 version strings left where the current version is asserted.
- [ ] #2 CHANGELOG.md gains a `## [1.5.0] — 2026-07-11` section (Keep a Changelog style, prose depth matching 1.3.0/1.4.0) documenting the whole wave: native cross-agent skills + .codex-plugin (TASK-98) under Added; the dependency-audit CI gate (TASK-100) and Markdown URL sanitization (TASK-99) under Security; cross-platform automation + Win/Linux CI matrix (TASK-101) under Changed/Added; formatting + webview a11y (TASK-103) under Fixed/Changed. TASK-102's drift-reconciliation entry is relocated from the 1.4.0 Fixed section into 1.5.0, leaving 1.4.0 accurate for the git-auto release only.
- [ ] #3 README and any user-facing docs reflect the new user-visible capabilities (native cross-agent skills / Codex plugin, security audit gate) where features are enumerated, keeping the agent-agnostic framing TASK-102 established. Version references consistent with 1.5.0.
- [ ] #4 The `releaseMetadata` unit test passes (CHANGELOG newest == package.json == MCP server version == reconciled keywords); full verify gate (bun run test + lint + typecheck) green; changes committed in the worktree and merged via request_merge.
<!-- AC:END -->
