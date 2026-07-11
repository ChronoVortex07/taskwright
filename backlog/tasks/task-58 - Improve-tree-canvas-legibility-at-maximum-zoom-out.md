---
id: TASK-58
title: Improve tree canvas legibility at maximum zoom-out (LOD "far" tier)
type: bug
status: Done
assignee: []
created_date: '2026-07-04 11:33'
updated_date: '2026-07-04 12:09'
labels:
  - ui
  - tree-canvas
dependencies: []
priority: medium
category: Tree
caused_by: TASK-18
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Below `LOD_MID` (0.4, out of `MIN_SCALE` 0.2 – `MAX_SCALE` 2 in `treeGeometry.ts:24-29`) — i.e. across the bottom half of the zoom range — `TreeNode.svelte`'s `lodTier() === 'far'` branch collapses every node to a bare 24px status-glyph pill with no title text (`TreeNode.svelte:140-143` for the markup, `:421-428` for the `.tree-node.lod-far` CSS). Task identity is only available via the native `title` hover tooltip, so at the fully-zoomed-out view — which is exactly the view a user lands on for board-wide orientation — the tree is effectively illegible: every node looks like an identical dot distinguishable only by color/icon.

Rework the "far" LOD tier's rendering so nodes stay identifiable at maximum zoom-out — e.g. an abbreviated/truncated label, a legible minimum font size that doesn't scale below a readable floor, or denser but still-labeled node chips — instead of icon-only pills.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 At MIN_SCALE (fully zoomed out), individual task nodes are visually distinguishable by more than color/icon alone (e.g. a readable abbreviated title or truncated label), without requiring hover.
- [ ] #2 The fix does not regress rendering performance/density when many nodes are visible at once at low zoom.
- [ ] #3 Mid/near LOD tiers (LOD_MID/LOD_NEAR) are visually unaffected.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added a truncated title label alongside the status glyph in the "far" LOD tier (TreeNode.svelte):
- Added `span.tree-node-far-title` with `{task.title}` after the `statusGlyph()` in the `lod === 'far'` branch
- Added CSS: `.tree-node-far-title` with `font-size: 11px`, `text-overflow: ellipsis`, `white-space: nowrap`, `max-width: 140px` for compact single-line truncation
- Updated `.tree-node-pill` with `gap: 4px` and `min-width: 0` to accommodate the title text
- Playwright test verifies all far-tier nodes show non-empty title text
- Mid/near LOD tiers are structurally untouched
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Reworked the "far" LOD tier (scale < 0.4) rendering: the previously icon-only 24px pill now also shows a truncated title label alongside the status glyph. At max zoom-out (MIN_SCALE 0.2), nodes remain visually distinguishable by title text rather than status color/icon alone. The truncation uses CSS `text-overflow: ellipsis` with `max-width: 140px` to keep pills compact. No rendering changes to mid or near LOD tiers.
<!-- SECTION:FINAL_SUMMARY:END -->
