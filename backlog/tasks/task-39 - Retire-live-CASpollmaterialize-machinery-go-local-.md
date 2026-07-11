---
id: TASK-39
title: Retire live CAS/poll/materialize machinery + go local-only cross-branch
status: Done
assignee: []
created_date: '2026-07-04 04:35'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Board Sync v2 — Single Shared Board
dependencies:
  - TASK-38
priority: high
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Delete the v1 multi-copy live-sync machinery now that all board I/O routes to one physical board (task B, spec §4). This is a removal/simplification PR — nothing should still depend on these paths after task B.

Scope (remove):
- boardSyncEngine.ts CAS loop (applyBoardWriteSynced, claimTaskSynced/releaseTaskSynced/setStatusSynced, refreshBoard).
- BoardSyncController poll timer + compaction poll; keep only what the versioning layer/status bar still needs (or delete outright if superseded by task G).
- The `board.materialized` marker logic.
- MCP handlers.ts synced-write gating (withSyncedBoardWrite / makeSyncedBoard / synced claim routing) — claim_task/release_task become direct surgical writes to the one board via ClaimService.
- boardLifecycle live reconcile/poll usage.

Also: cross-branch loader goes LOCAL-ONLY unconditionally. In the single off-branch board model there is nothing to cross-scan, so BacklogParser.getTasksWithCrossBranch never re-hydrates task files from code branches. Subsumes TASK-35 (blank Tree tab when check_active_branches is true) — close as superseded on promotion.

Acceptance:
- Full test suite green after removal (no dangling refs to deleted symbols).
- claim/release still work (direct writes) with no CAS.
- Tree/Kanban/List render with check_active_branches true OR false (no blank Tree tab); no ghost cards.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
