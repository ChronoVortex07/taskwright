---
id: TASK-108
title: Fix blurry tree node text when zoomed in (stale composited raster)
status: In Progress
assignee: []
created_date: '2026-07-12 06:20'
updated_date: '2026-07-12 06:20'
labels:
  - performance
  - bug
  - tree
milestone: Performance & Startup Cost
dependencies:
  - TASK-107
priority: medium
category: Tree
claimed_by: '@agent/task-108-fix-blurry-tree-node-text-when-zoomed-in-stale-composited-raster'
worktree: task-108-fix-blurry-tree-node-text-when-zoomed-in-stale-composited-raster
claimed_at: '2026-07-12 14:35'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Zooming the tech tree in makes node text render slightly blurry instead of crisp.

Root cause: `.tree-surface` in `TechTreeCanvas.svelte` sets `will-change: transform` while also carrying the pan/zoom `transform: translate(...) scale(...)`. `will-change: transform` promotes the surface to its own composited layer and tells the compositor to expect the transform to keep animating, so Chromium rasterizes the layer's contents ONCE and then scales that existing bitmap for subsequent transforms rather than re-rasterizing text at the new scale. Zooming in therefore magnifies a texture rasterized at the previous (smaller) scale — the classic blurry-text-on-a-promoted-layer symptom. Non-integer `translate()` offsets add subpixel softness on top.

The fix is to stop keeping the surface permanently promoted: apply `will-change: transform` only for the duration of an active pan/zoom gesture (where the compositor hint actually pays for itself) and drop it once the viewport settles, so the browser re-rasterizes text crisply at the settled scale. Any approach that yields crisp text at zoom without regressing pan/zoom smoothness is acceptable.

This is the same layer promotion that amplifies the hover repaint storm in TASK-107, which is why this task depends on it — TASK-107 lands the bounded-hover edge layer first, then this task removes the permanent promotion without reintroducing a whole-board repaint on hover.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Node title text is crisply rasterized at zoom levels above 100% — no upscaled/blurry glyphs — verified by a screenshot comparison at a zoomed-in scale before and after.
- [ ] #2 `will-change: transform` is no longer permanently applied to `.tree-surface`; if used at all it is applied only during an active pan/zoom gesture and removed when the viewport settles.
- [ ] #3 Pan and zoom remain smooth (no new jank introduced by dropping the permanent layer promotion) on a 100+ node board.
- [ ] #4 Hovering still does not repaint the whole board (the TASK-107 guarantee is not regressed by the layer change).
- [ ] #5 `bun run test`, `bun run lint`, `bun run typecheck` pass; tree canvas e2e coverage still green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## File Structure

- `src/webview/components/tree/TechTreeCanvas.svelte` — the `.tree-surface` style rule (`will-change: transform`) and the pan/zoom gesture state (`panning`, `setViewport`, `onWheel`) that would drive a gesture-scoped promotion.
- `e2e/tree-canvas.spec.ts` — zoom crispness / regression coverage.

## Steps

1. Capture a "before" screenshot of the canvas zoomed in (e.g. 200%) as the blur baseline.
2. Drop the permanent `will-change: transform` from `.tree-surface`.
3. If pan/zoom smoothness regresses, reintroduce the hint as a gesture-scoped class (added on pointerdown/wheel, removed on a settle timeout) rather than a permanent declaration.
4. Capture the "after" screenshot at the same zoom and confirm crisp glyphs.
5. Re-run the tree suites and confirm the TASK-107 hover guarantee still holds.
<!-- SECTION:PLAN:END -->
