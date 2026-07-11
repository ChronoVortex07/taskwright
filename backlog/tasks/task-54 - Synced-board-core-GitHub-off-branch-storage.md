---
id: TASK-54
title: Synced board core (GitHub off-branch storage)
status: Done
assignee: []
created_date: '2026-07-04 00:40'
updated_date: '2026-07-04 09:36'
labels: []
milestone: 'Worktree Safety, Merge Queue & Synced Board'
dependencies:
  - TASK-49
  - TASK-15
priority: high
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
taskwright.sync.mode (github/local, off default) moves the board off code branches onto a dedicated taskwright-board ref, killing the read-only cross-branch "ghost" cards. Pure cores: src/core/boardRef.ts (isolated-index snapshotBoardToRef/materializeRefToWorktree), src/core/boardSyncEngine.ts (fetch→materialize→check→snapshot→ff-only push CAS loop: claimTaskSynced/releaseTaskSynced/refreshBoard), src/core/boardLifecycle.ts (reconcileBoardRef auto setup/heal + compactBoardRef), src/core/syncConfig.ts (shared sync-config.json). BoardSyncController (reconcile/poll/status bar), publishSyncConfig + taskwright.enableSync command, MCP claim_task/release_task and UI claimActions route through the engine when mode !== 'off'.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
