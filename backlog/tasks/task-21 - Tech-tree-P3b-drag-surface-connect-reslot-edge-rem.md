---
id: TASK-21
title: 'Tech-tree P3b — drag surface (connect, reslot, edge removal, navigator debt)'
status: Done
assignee: []
created_date: '2026-07-03 01:34'
updated_date: '2026-07-03 05:36'
labels:
  - tech-tree
dependencies:
  - TASK-20
priority: high
category: Features
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Drag-surface half of tech-tree P3 (spec: docs/superpowers/specs/2026-07-02-tech-tree-p3-create-edit-design.md §5–6; directives: .superpowers/tech-tree-run/p3-architecture-directives.md §P3b dirs 6–11; plan: docs/superpowers/plans/2026-07-03-tech-tree-p3b-drag-surface.md, 10 tasks; adjudications Q1 taskType, Q2 minimap threshold).

Ships: treeGeometry inverse core (screenToWorld/laneAtY/bandAtX/cellAt/reslotTargets incl. empty lanes/bands, DRAG_THRESHOLD); locked reslotTask/addDependency/removeDependency/navigatorMinimapPan messages + controller cases with extension-side wouldCreateCycle re-validation; DragLayer.svelte + pointer-event gesture state machine (connect-handle drag, node-body reslot vs click-popover, empty-canvas pan vs click-in-place create via P3a onCreateInPlace); drag-to-connect with client-side cycle refusal + drop-on-empty pre-linked create (createTask.linkTo); drag-to-reslot (reorderTasks vs reslotTask routing, band expand-on-hover emphasis, bugs reorder-only incl. cross-band refusal, prereq-inversion amber warning); edge removal ✕ (EdgeLayer hover group + popover prereq chips); P2b carry-in debt (minimap drag-to-pan w/ click/drag threshold, filter-aware Promote-all, cross-branch empty-state test); Playwright tree-drag.spec.ts; CDP tree-reslot.test.ts (reslot→category/milestone on disk); CLAUDE.md P3b bullet + visual proof.

Being implemented autonomously in worktree tech-tree-p3b (orchestrated run, 2026-07-03).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
P3b (tech-tree drag surface) landed on main at 0b00e9f — 16 commits fast-forwarded from .worktrees/tech-tree-p3b. Deliverables: treeGeometry inverse core (screenToWorld/laneAtY/bandAtX/cellAt/reslotTargets covering empty lanes/bands, DRAG_THRESHOLD); locked reslotTask/addDependency/removeDependency/navigatorMinimapPan messages + TasksController write cases with extension-side wouldCreateCycle re-validation; DragLayer.svelte + pointer-event gesture state machine (pan vs click-in-place create on empty canvas, node reslot-drag vs click-popover, connect-handle drags; in-node buttons excluded); drag-to-connect (left=needs/right=unlocks handles, client-side cycle green/red feedback, drop-on-node addDependency, drop-on-empty pre-linked create via linkTo); drag-to-reslot (in-cell reorder via ordinalUtils vs reslotTask category/milestone with Misc/Backburner clearing, band-expand emphasis, bugs reorder-only incl. cross-band + Bugs-lane symmetric guards); edge removal ✕ (EdgeLayer hover group + popover prereq chips); P2b carry-in debt cleared (minimap drag-to-pan with Q2 click/drag threshold + m7 guard, filter-aware Promote-all, cross-branch empty-state test); connect handles unclipped. Tests: Playwright e2e/tree-drag.spec.ts (12 cases incl. positive-control no-write tests), CDP tree-reslot.test.ts (real drag → category on disk) + pointer-driven CDP selection helper. Two mid-build regressions from the gesture refactor caught by widening spec nets and fixed with falsification (promote-button click hijack; CDP bare-click selection). Gates at 0b00e9f: unit 1379 passed/1 skipped; Playwright 359; CDP 17/17 real VS Code; lint zero-warning; typecheck clean; visual proof 7 verified screenshots. Whole-branch review READY WITH FIXES (0 blockers) → polish 0b00e9f → re-review LAND. Accepted debt to P4+: edge-click opens create form, refused-reslot red visual, self-connect e2e coverage, cosmetic handle overlaps, P3a trivials.
<!-- SECTION:FINAL_SUMMARY:END -->
