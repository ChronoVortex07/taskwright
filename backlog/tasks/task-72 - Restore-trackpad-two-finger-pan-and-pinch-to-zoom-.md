---
id: TASK-72
title: Restore trackpad two-finger pan and pinch-to-zoom on the tree canvas
type: bug
status: Done
assignee: []
created_date: '2026-07-08 05:24'
updated_date: '2026-07-08 06:16'
labels: []
milestone: Orchestration & UX Polish
dependencies: []
priority: high
category: Tree
caused_by: TASK-57
plan: docs/superpowers/plans/2026-07-08-tree-canvas-trackpad-pan-zoom.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The tree-canvas "mouse fix" (commit 08d8ba4 / TASK-57) swapped the onWheel branches so plain wheel now zooms and ctrl/meta+wheel now pans (TechTreeCanvas.svelte:651-663). That inverts trackpad gestures: a two-finger scroll (plain wheel with deltaX/deltaY) now ZOOMS instead of panning, and a pinch (which the browser reports as wheel + ctrlKey) now PANS instead of zooming.

Rework onWheel so all three input styles work together:
- ctrl/meta + wheel (pinch, or ctrl+scroll) → zoom at cursor.
- two-finger trackpad scroll (plain wheel, pixel deltaMode, deltaX often ≠ 0, fractional deltas) → pan.
- mouse wheel (plain wheel, line deltaMode / large integer deltaY, deltaX === 0) → zoom (keep the current mouse behavior).
This needs a trackpad-vs-mouse-wheel heuristic (deltaMode, |deltaX|, fractional deltas, event cadence). Keep the pointer-drag pan (:346-487) and the zoom buttons (:665-668) intact, and the clampScale/clampViewport bounds in treeGeometry.ts.

Acceptance criteria:
- Trackpad two-finger scroll pans; pinch zooms; mouse wheel still zooms at cursor.
- No text-selection regression from the pointer-drag pan (the other half of TASK-57).
- Update e2e/tree-canvas.spec.ts (:152-235 lock in the current mouse-only mapping) and add trackpad-gesture coverage.
- clampScale / clampViewport bounds still respected at zoom extremes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented by DeepSeek-pro worker per plan. Added classifyWheel(e) heuristic in TechTreeCanvas.svelte and routed onWheel on it: ctrl/meta+wheel→zoom (pinch), trackpad two-finger scroll (deltaMode 0 + deltaX/fractional/sub-notch)→pan, mouse wheel (line/coarse-integer)→zoom (preserves TASK-57). Pan/zoom arithmetic + clampScale/clampViewport unchanged. Verified: 1607 vitest, lint/typecheck clean, 27/27 playwright tree-canvas incl. 3 new wheel tests + drag-pan text-selection regression tests. Merged to integration branch.
<!-- SECTION:FINAL_SUMMARY:END -->
