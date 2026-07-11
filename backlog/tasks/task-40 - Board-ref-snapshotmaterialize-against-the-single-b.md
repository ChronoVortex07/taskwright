---
id: TASK-40
title: >-
  Board-ref snapshot/materialize against the single board root (incl.
  milestones)
status: Done
assignee: []
created_date: '2026-07-04 04:37'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Board Sync v2 — Single Shared Board
dependencies:
  - TASK-37
priority: high
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The versioning layer's plumbing (spec §2.2). Repurpose the reused boardRef.ts isolated-index primitives so they snapshot FROM / materialize INTO the one board root (task A = DRAFT-15), for the discrete push/pull layer — not a live loop.

Scope:
- snapshotBoardRoot(): stage the one board dir (git add --force, byte-exact core.autocrlf=false/core.eol=lf) into an isolated index and commit onto the `taskwright-board` ref.
- materializeToBoardRoot(): write the ref's tree back into the one board root via checkout-index --force. KEEP the "refuse non-board-path ref" guard (it prevented the v1 mass-revert-the-root scare).
- Add `backlog/milestones/` to BOARD_SUBDIRS so milestones round-trip. Subsumes TASK-36 — close as superseded on promotion.
- No fetch/push/merge here (that is task F); no live poll (removed in task C).

Acceptance:
- snapshot→materialize round-trips tasks/drafts/completed/archive AND milestones byte-for-byte.
- Materialize refuses a ref whose tree contains non-board paths.
- The user's real HEAD/index/branch are untouched by snapshot (isolated index), asserted in tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
