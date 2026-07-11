---
id: TASK-87
title: >-
  Skip redundant queue-head re-verify when base didn't move + relax
  primary-dirty check to real collisions
status: Done
assignee: []
created_date: '2026-07-10 11:43'
updated_date: '2026-07-10 13:43'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies: []
priority: medium
category: Worktrees & Merge
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two friction fixes in the requestMerge core (src/core/finishTask.ts), responsible for a large share of the 34 observed aborts:

1. The verify suite runs TWICE per merge — pre-enqueue (finishTask.ts:299) and again at queue head (:344) — even when main never advanced during the wait. Record the base SHA at pre-verify; at queue head, skip re-verify when the post-wait rebase is a no-op (same base SHA). Halves merge wall-time in the common single-agent case; strictly correct.

2. ffMergeToBase aborts on ANY porcelain entry outside backlog/ (finishTask.ts:149-156) — including unrelated untracked files in the repo root. 16 of 77 request_merge calls aborted on "uncommitted changes"; agents resorted to adding .worktrees/ to .git/info/exclude and stashing unrelated WIP. Relax to block only tracked modifications and untracked files that actually collide with paths the fast-forward would update (git diff --name-only base..branch intersect porcelain paths). Keep the abort message specific about WHICH files block.

Use the machine-readable abort codes (dirty_primary etc.) if that draft lands first.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Both fixes land in src/core/finishTask.ts, TDD (10 new/updated tests written first, watched fail, then implemented).

Fix 1 — skip redundant queue-head re-verify: after the pre-enqueue verify passes, requestMerge records the worktree HEAD SHA (new resolveHeadSha helper, null on failure). At queue head, after the post-wait rebase, HEAD is re-resolved; if unchanged (rebase was a no-op — base didn't move) the re-verify is skipped. Deviation from the task text's "record the base SHA": comparing HEAD is strictly stronger and race-free — it proves verified tree == merged tree by construction, avoiding the record-after-base-advanced TOCTOU where verify ran against an older base but the recorded/compared base SHAs match. Unresolvable HEAD on either side ⇒ fail-safe re-verify.

Fix 2 — collision-only primary-dirty check: ffMergeToBase now computes the merge footprint (git diff --name-only base..branch in the primary) and blocks only porcelain entries outside backlog/ that intersect it (new pure collidingWipPaths, sharing a porcelainTargets helper with hasCodeWip). The abort reason names the exact blocking files. Unrelated untracked files / tracked mods no longer abort — an ff leaves them untouched. If the footprint diff fails, falls back to the old strict hasCodeWip check (fail-safe). backlog/ stays excluded, preserving the resetTaskFile contract.

Tests: src/test/unit/finishTaskActions.test.ts (collidingWipPaths unit tests + 5 ffMergeToBase collision/fallback cases), src/test/unit/requestMerge.test.ts (verify runs once on no-op rebase, twice when HEAD moved, twice on unresolvable HEAD; dirty_primary only on real collision + names the file; merges despite unrelated primary WIP). Full suite 1767/1767, lint + typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Both requestMerge friction fixes shipped in src/core/finishTask.ts (commit e7025df, TDD-first). (1) The queue-head re-verify is now skipped when the post-wait rebase is a no-op: the pre-enqueue verify records the worktree HEAD SHA and the queue-head pass compares it after the rebase — identical HEAD means the verified tree is byte-identical to the tree being merged, so the second verify run is redundant; any unresolvable HEAD fail-safes to re-verify. This halves merge wall-time in the common case where main didn't advance during the wait. (2) ffMergeToBase's primary-dirty abort is relaxed to real collisions only: the merge footprint (git diff --name-only base..branch) is intersected with the primary's porcelain paths outside backlog/ (new pure collidingWipPaths), the abort message names exactly which files block, and unrelated untracked files / tracked modifications no longer abort the merge. A failed footprint diff falls back to the previous strict hasCodeWip behavior. Coverage: 10 new/updated tests across finishTaskActions.test.ts and requestMerge.test.ts; full suite 1767/1767 green, lint + typecheck clean.
<!-- SECTION:FINAL_SUMMARY:END -->
