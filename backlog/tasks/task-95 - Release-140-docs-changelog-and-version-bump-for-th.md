---
id: TASK-95
title: 'Release 1.4.0 — docs, changelog, and version bump for the git-auto board home'
status: Done
assignee: []
created_date: '2026-07-11 01:46'
updated_date: '2026-07-11 01:55'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies:
  - TASK-91
priority: medium
category: Docs & Branding
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Reflect TASK-91 (hidden-worktree board home, sync.mode 'git-auto') in the user-facing release surface: add a 1.4.0 CHANGELOG entry (new sync mode, enableSync mode picker + S0-S6 migration, event-driven auto-sync engine, board-doctor repairs, status-bar/quick-pick UX, push_board/pull_board escape hatch, Backlog.md-CLI root-layout divergence note), bump package.json to 1.4.0, and refresh README's Board Sync section to describe the three modes. CLAUDE.md/AGENTS.md were already updated in TASK-91.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 package.json version bumped to 1.4.0
- [x] #2 CHANGELOG gains a 1.4.0 entry covering git-auto: hidden-worktree home, event-driven engine, guarded S0-S6 migration via the enableSync picker, fresh-clone bootstrap + doctor repairs, status-bar/quick-pick UX, push/pull escape hatch, milestones language-provider coverage, Backlog.md-CLI divergence note
- [x] #3 README Board Sync section describes the three modes (off | git | git-auto) and links both design docs
- [x] #4 bun run test && lint && typecheck green (1930/1930)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Released 1.4.0 (the Hidden-Worktree Board Home release): package.json bumped from 1.3.0, CHANGELOG entry added for TASK-91's git-auto mode (Added: hidden-worktree home, event-driven auto-sync engine, guarded migration via the Enable Board Sync mode picker, fresh-clone bootstrap + three board-doctor repairs, status-bar/quick-pick UX and push/pull escape hatch; Changed: milestones language-provider coverage, documented Backlog.md-CLI divergence), and the README Board Sync section rewritten to describe all three sync modes with links to both design docs. CLAUDE.md/AGENTS.md were already updated in TASK-91.
<!-- SECTION:FINAL_SUMMARY:END -->
