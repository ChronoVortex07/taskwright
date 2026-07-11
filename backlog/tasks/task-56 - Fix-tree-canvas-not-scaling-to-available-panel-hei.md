---
id: TASK-56
title: Fix tree canvas not scaling to available panel height/width
type: bug
status: Done
assignee: []
created_date: '2026-07-04 11:32'
updated_date: '2026-07-04 11:54'
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
The Tree tab's canvas renders at a fixed ~400px tall regardless of the actual VS Code panel size, and doesn't reflow when the panel is resized.

Root cause: the height chain from `html`/`body` down through `#app` (`src/providers/tasksWebviewHtml.ts:38-39`) → `.tasks-page`/`.view-content` (`Tasks.svelte:606`, `src/webview/styles.css:188-195`) has no explicit height set anywhere, so every ancestor computes to `auto`. `.tree-canvas`'s `height: 100%` (`TechTreeCanvas.svelte:887-893`) therefore resolves against an auto-height parent and collapses down to its `min-height: 400px` fallback, which becomes the de-facto fixed size instead of filling the panel.

Fix the ancestor chain (html/body/#app/.view-content) so the canvas panel fills all available height and width of the webview and resizes responsively (e.g. VS Code split-editor drag, sidebar resize) without a reload. Keep `min-height: 400px` only as a sane floor, not the real constraint.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Tree canvas fills 100% of the available webview panel height and width on load, not a fixed ~400px.
- [x] #2 Resizing the VS Code panel (e.g. dragging the editor split) reflows the canvas to the new size without a page reload.
- [x] #3 min-height: 400px (or similar) remains only as a sane minimum-size guard, not the de-facto rendered size under normal conditions.
- [x] #4 No regression to the List/Kanban tab layouts, which share the same .view-content/#app ancestor chain.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed the tree canvas height chain by establishing explicit heights from html → body → #app → .view-content in styles.css:

1. Added `height: 100%` to `html` and `body` (global, benign for all webviews).
2. Scoped flexbox column layout to `body.tasks-page`:
   - `body.tasks-page` → `display: flex; flex-direction: column; overflow: hidden;`
   - `body.tasks-page #app` → `flex: 1; min-height: 0; display: flex; flex-direction: column;`
   - `body.tasks-page .view-content` → `flex: 1; min-height: 0;`
3. This establishes the missing height chain so `.tree-canvas`'s `height: 100%` resolves against a real computed height instead of `auto` (which collapsed to `min-height: 400px`).

The fix correctly scopes to the Tasks webview only (`.tasks-page` body class), leaving other webviews (task-detail, task-preview, tree-navigator, content-detail) unaffected.

Updated two existing Playwright tests that relied on the old collapsed viewport:
- `plain wheel pans`: Added zoom-in before panning (surface now fits in the larger viewport, so clamping prevents panning at 1x zoom).
- `clicking empty canvas opens the create form`: Adjusted click target to centre-right of viewport.

Added two new Playwright tests to verify the fix:
- `tree canvas fills available panel height, not collapsed to min-height` — confirms canvas height > 500px (was 400px).
- `tree canvas reflows on viewport resize` — confirms canvas shrinks/grows with the viewport.
<!-- SECTION:FINAL_SUMMARY:END -->
