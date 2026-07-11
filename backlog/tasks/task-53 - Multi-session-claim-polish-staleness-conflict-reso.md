---
id: TASK-53
title: Multi-session claim polish (staleness + conflict resolution)
status: Done
assignee: []
created_date: '2026-07-04 00:40'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Agentic Board Core (Phases 1-5)
dependencies:
  - TASK-42
priority: medium
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5: src/core/claimResolution.ts (resolveClaimAction) drives claim-conflict surfacing (confirm before overriding a live foreign claim) and stale-claim expiry (claims older than backlog.claimStalenessHours, default 12h, reclaimable without a prompt). Kanban cards show an active-task indicator and a stale-claim badge (amber), enriched in TasksController (isActiveTask/claimStale).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
