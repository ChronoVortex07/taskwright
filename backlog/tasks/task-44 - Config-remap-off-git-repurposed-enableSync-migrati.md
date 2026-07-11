---
id: TASK-44
title: Config remap (off | git) + repurposed enableSync migration command
status: Done
assignee: []
created_date: '2026-07-04 04:37'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Board Sync v2 — Single Shared Board
dependencies:
  - TASK-38
  - TASK-40
priority: medium
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the v1 three-mode config with the v2 two-mode model (spec §5, §8) and repurpose the one-consent migration.

Scope:
- taskwright.sync.mode: `off` (board is local git-ignored working files, no versioning) | `git` (versioning layer on: push/pull enabled + optional hooks). Drop off/local/github trichotomy. Migrate existing settings on read: local → off, github → git.
- taskwright.sync.remote (default origin). taskwright.sync.installHooks (opt-in, consumed by task H).
- syncConfig.ts repurposed to the new mode set (readSyncConfig/resolveSyncConfigFromSettings updated; keep it MCP-readable at <commonDir>/taskwright/sync-config.json).
- Repurpose taskwright.enableSync: idempotently ensure the boardMigration gitignore block (reuse boardMigration.ts — board stays git-ignored, so no fresh untrack needed if already migrated), remap the mode, and SEED the `taskwright-board` ref from the current board via snapshotBoardRoot (D=DRAFT-19).
- check_active_branches treated as effectively off in the single-board model (belt-and-suspenders with task C).

Acceptance:
- A repo with legacy sync.mode=github reads as `git`; local reads as `off`; unit-tested coercion.
- enableSync is idempotent (re-running is a no-op when already migrated + seeded).
- sync-config.json round-trips and is readable by the MCP server.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
