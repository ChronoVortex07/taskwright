---
id: TASK-57
title: Fix tree canvas drag-to-pan text-selection bug and make wheel zoom by default
type: bug
status: Done
assignee: []
created_date: '2026-07-04 11:33'
updated_date: '2026-07-04 12:27'
labels:
  - ui
  - tree-canvas
dependencies: []
priority: high
category: Tree
caused_by: TASK-18
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two related defects in the tree canvas's pointer/wheel gesture handling (`TechTreeCanvas.svelte`):

1. **Drag-to-pan breaks after the first drag.** `onPointerDown`/`onPointerMove`/`onPointerUp` (lines 324-464) never call `preventDefault()` on the pan path, and no element in the canvas (`.tree-viewport`, `.tree-surface`, lane/band labels in `LaneBand.svelte`/`AgeBandHeader.svelte`) sets `user-select: none` (`.tree-viewport` only has `touch-action: none`, which suppresses touch panning, not mouse text-selection). The first drag pans correctly but also selects any text it passes over (e.g. axis/lane labels). A second press-drag that starts on or near that stale selection gets captured by the browser's native "drag the selection" behavior instead of reaching the custom `onPointerMove` handler, so panning stops working and a text drag/copy happens instead.
2. **Wheel currently pans by default, not zooms.** `onWheel` (lines 607-617) only zooms when `ctrlKey`/`metaKey` is held; a plain wheel scroll pans (`ty -= deltaY`, `tx -= deltaX`). Desired: plain wheel zooms (centered on the cursor) by default.

Fix: suppress native text selection during canvas panning (e.g. `user-select: none` on the canvas surface while a pan is active, and/or `preventDefault()` in the pointer handlers so no selection is ever created), and repoint the default (no-modifier) wheel behavior to zoom at the cursor position instead of panning.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Click-dragging the tree canvas pans it repeatedly, any number of times in a row, without ever selecting text or triggering a native text-drag.
- [x] #2 No visible text-selection highlight appears anywhere on the canvas (nodes, lane labels, band headers) during a pan drag.
- [x] #3 Scrolling the mouse wheel with no modifier held zooms the canvas in/out centered on the cursor, instead of scrolling/panning.
- [x] #4 Zoom stays clamped within MIN_SCALE/MAX_SCALE (treeGeometry.ts) regardless of which gesture drives it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
### Changes made

**Fix 1 — Drag-to-pan text-selection suppression (Acceptance Criteria #1, #2):**
- Added `user-select: none` to `.tree-viewport` CSS in `TechTreeCanvas.svelte` (line 903) — prevents native browser text selection from forming anywhere in the canvas during mouse drags.
- Added `e.preventDefault()` in the pan path of `onPointerMove` (line 375) — suppresses native "drag the selection" behavior that hijacks subsequent pointer events.
- Both lane labels (`LaneBand.svelte`) and band headers (`AgeBandHeader.svelte`) are children of `.tree-viewport`, so `user-select` inherits to them — no selection highlight can appear during a pan drag.

**Fix 2 — Wheel zoom by default (Acceptance Criteria #3):**
- Swapped the `onWheel` handler logic (lines 610-617): plain wheel (no modifier) now zooms centered on cursor via `zoomAt()`, and ctrl/meta + wheel pans via `tx -= deltaX, ty -= deltaY`.
- `zoomAt` already uses `clampScale` → zoom stays clamped within MIN_SCALE/MAX_SCALE (Acceptance Criteria #4 was already satisfied).

**Tests:**
- Added Playwright tests for the new wheel behavior: `plain wheel (no modifier) zooms centered on cursor instead of panning` and `ctrl-wheel pans the surface without changing zoom`.
- Added Playwright tests for text-selection prevention: `drag-to-pan does not create text selection` and `repeated drag-to-pan works multiple times without text-selection interference`.
- All 24 tree-canvas Playwright tests pass; all 1505 unit tests pass; ESLint and typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed two related tree canvas gesture bugs:

1. **Text selection during panning** — Added `user-select: none` to the viewport CSS and `preventDefault()` in the pan pointer-move handler so drag-to-pan never creates text selections that would hijack subsequent pointer events.

2. **Wheel zoom by default** — Swapped `onWheel` logic so plain wheel (no modifier) zooms at the cursor position, and ctrl/meta + wheel pans. Zoom clamping (MIN_SCALE/MAX_SCALE) was already handled by `zoomAt` → `clampScale`.
<!-- SECTION:FINAL_SUMMARY:END -->
