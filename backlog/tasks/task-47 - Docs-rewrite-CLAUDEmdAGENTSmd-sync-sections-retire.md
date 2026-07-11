---
id: TASK-47
title: >-
  Docs — rewrite CLAUDE.md/AGENTS.md sync sections + retire old synced-board
  specs
status: Done
assignee: []
created_date: '2026-07-04 04:39'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Board Sync v2 — Single Shared Board
dependencies:
  - TASK-39
  - TASK-43
  - TASK-44
priority: low
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Land the documentation once the v2 architecture is in place (spec §1). Do this last so docs match shipped behavior.

Scope:
- Rewrite the "Synced board" sections of CLAUDE.md and AGENTS.md to describe the v2 single-shared-board model: one physical board (primary backlog/), no per-worktree copies/CAS/poll; discrete push/pull versioning with union-merge; new off|git config; opt-in hooks. Remove the v1 CAS/mode-trichotomy prose.
- Mark the v1 specs/plans superseded: add a superseded-by banner to docs/superpowers/specs/2026-07-01-github-synced-board-design.md and the 2026-07-01 synced-board phase plans, pointing to docs/superpowers/specs/2026-07-04-board-sync-v2-single-shared-board-design.md.
- Update the memory-worthy caveats (autocrlf, shared tree) references if any doc points at removed code paths.

Acceptance:
- CLAUDE.md/AGENTS.md describe only the v2 model; no dangling references to boardSyncEngine CAS / off-local-github modes.
- v1 specs carry a visible superseded-by pointer.
- A reader following the docs can enable sync, push, and pull without hitting removed features.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Rewrote the "Synced board" sections of CLAUDE.md and AGENTS.md to the v2 model: one physical board (resolveBoardRoot()), off|git config with legacy local/github migration, push_board/pull_board + mergeBoards() union-merge, the status-bar/command-palette UX, and opt-in Windows-safe hooks. Fixed two dangling CrossBranchTaskLoader references left over from Task C's deletion. Added superseded-by banners to the v1 spec (2026-07-01-github-synced-board-design.md) and its four phase plans, pointing at the v2 spec. Also fixed the stale To Do board status on DRAFT-17/18/20/21/22/23 (verified against real merged commit shas) — the inconsistency Task G's notes flagged, which was actually blocking claim_task on this task itself. Docs-only; full suite (1505 tests)/lint/typecheck all green. Commits: 8c6c827, 7f0b6e7. This was the last task in the Board Sync v2 relay (docs/superpowers/plans/2026-07-04-board-sync-v2-execution-handoff.md).
<!-- SECTION:FINAL_SUMMARY:END -->
