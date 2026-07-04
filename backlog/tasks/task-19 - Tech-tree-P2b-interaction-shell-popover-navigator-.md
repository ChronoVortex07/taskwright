---
id: TASK-19
title: >-
  Tech-tree P2b — interaction shell (popover, navigator, in-flight, milestone,
  details rework)
status: Done
assignee: []
created_date: '2026-07-02 15:25'
updated_date: '2026-07-02 21:23'
labels:
  - tech-tree
dependencies:
  - TASK-18
priority: high
category: Features
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Interaction-shell half of the tech-tree P2 canvas (spec: docs/superpowers/specs/2026-07-02-tech-tree-p2-canvas-design.md incl. §15; directives: .superpowers/tech-tree-run/p2-architecture-directives.md §P2b).

Ships: node detail popover with state-aware actions (claim/dispatch/force-claim/release/cancel-dispatch/approve/send-back, status+priority quick-edit); active-task = popover-open via popoverActiveChanged (Set-active buttons removed); cancelDispatch command v1; taskwright.treeNavigator WebviewView (search/priority/lane filters, age jump-bar, minimap) with new tree-navigator.ts bundle entry; filter-dim + lane collapse; in-flight panel (active tasks + merge queue w/ approve/send-back); milestone popover + release checklist (new core src/core/releaseChecklist.ts, RC markers in milestone files, milestoneData/toggleReleaseChecklistItem messages); details-page rework (chips/relationships/attachments, DoD removed from UI); draft promote actions; board-bus planProgress enrichment; CDP cross-view test + visual-proof.

Also folds in P2a review debt: lane-label 24px offset, empty-state wording, tree keyboard nav, persist debounce, bug-edge arrowheads.

Being implemented autonomously in worktree tech-tree-p2b (orchestrated run, 2026-07-02).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
P2b (tech-tree interaction shell) landed on main at b95826c — 17 commits fast-forwarded from .worktrees/tech-tree-p2b. Deliverables: DetailPopover (open/edit/dispatch/release from canvas, ephemeral active-task via popover), MilestonePopover with release checklist (src/core/releaseChecklist.ts + milestoneReleaseChecklist.ts), InFlightPanel (claimed/dispatched tasks, hidden when empty), TreeNavigator sidebar view (TreeNavigatorProvider + navigator entry), draft promote on TreeNodes + canvas button, cancel-dispatch v1 (src/core/cancelDispatch.ts, TODO(P5) completion hook), AttachmentChips on task detail (dedupe-guarded keyed each, read-only gating on all three +Add affordances), keyboard shortcut `t` row, P2a debt fixes, and a major side-fix reconstructing the missing CDP test-workspace fixture + Windows launcher repairs (CDP tier now green on fresh checkouts). Gates at b95826c: unit 1385 passed/1 skipped; Playwright 333; CDP 15/15 in real VS Code; lint zero-warning; typecheck clean; showboat visual proof (8 screenshots) verified. Full adversarial plan review + per-task reviews + whole-branch review + fix wave (b95826c) + focused re-review, verdict LAND. Accepted debt archived in .superpowers/tech-tree-run/p2b-ledger/minor-findings-rollup.md (minimap drag-to-pan → P3, dispatched_at marker → P5, popoverActiveChanged targeted update).
<!-- SECTION:FINAL_SUMMARY:END -->
