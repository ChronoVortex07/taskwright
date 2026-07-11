---
id: TASK-41
title: Union-merge core — last-writer-wins per task file + surfaced conflict list
status: Done
assignee: []
created_date: '2026-07-04 04:35'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Board Sync v2 — Single Shared Board
dependencies:
  - TASK-40
priority: high
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The conflict model for the versioning layer (spec §2.3). A pure core that merges two board trees at task-file granularity and reports conflicts — the single point where divergence is resolved (replacing v1's live CAS races).

Scope:
- Pure function mergeBoards(base?, ours, theirs) → { merged, conflicts }. Rules:
  - File on only one side → keep it (add/add of different tasks unions cleanly).
  - File edited on only one side → keep the edit.
  - File edited on BOTH → newer frontmatter `updated_date` wins; record the task ID in `conflicts`.
  - Tie / unparseable date → keep incoming ("theirs") + record conflict.
  - Delete-vs-edit → keep the edit + record conflict (deletion never silently beats a live edit).
- Operate on in-memory tree/file maps so it is unit-tested with no git.
- Return the conflict list for the UI to surface (never silently drop).

Acceptance:
- add/add, edit-one-side, edit-both (newer wins), tie, delete-vs-edit each covered by a unit test.
- The conflicted task IDs are returned, not swallowed.
- Deterministic given equal inputs (no reliance on Date.now()).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
