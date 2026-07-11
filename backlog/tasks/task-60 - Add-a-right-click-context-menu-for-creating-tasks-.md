---
id: TASK-60
title: Add a right-click context menu for creating tasks on the tree canvas
status: Done
assignee: []
created_date: '2026-07-04 11:34'
updated_date: '2026-07-04 13:23'
labels:
  - ui
  - tree-canvas
dependencies:
  - TASK-57
priority: medium
category: Tree
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Task creation today has no right-click entry point at all (`grep -rn "contextmenu" src/webview` returns zero matches anywhere in the codebase). The only existing ways to create a task are the TabBar `+` button (`TabBar.svelte:217-226`), keyboard shortcuts (`Ctrl/Cmd-N` full, `Ctrl/Cmd-Shift-N` quick — `Tasks.svelte:379-407`, `package.json:338-349`), and empty-canvas left-click-in-place on the tree (`TechTreeCanvas.svelte:427-438`, via `onCreateInPlace`, which infers lane/milestone from the clicked cell). The current left-click-to-create gesture doesn't feel natural; replace/supplement it with a right-click context menu.

Add a right-click (`contextmenu`) handler on the tree canvas that suppresses the browser's native menu and opens a small dropdown anchored at the cursor, with at least a "Create task here" action reusing the existing `onCreateInPlace` lane/band inference (`cellAt`/`reslotTargets` in `treeGeometry.ts`).

This depends on the pan/wheel gesture fix task (drag-to-pan text-selection + wheel-to-zoom), since both add/modify handling in the same pointer-event gesture machine in `TechTreeCanvas.svelte` (`onPointerDown`/`onPointerMove`/`onPointerUp`, lines 324-464) — build the context-menu gesture on top of the corrected pan/selection behavior rather than the current buggy one.

Open design question for the reviewing human: should the right-click menu *replace* the existing empty-canvas left-click-to-create, or supplement it (keep left-click as-is, add right-click as an additional path)? Default assumption below is "supplement" — adjust before promoting if you want it to replace instead.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Right-clicking empty space on the tree canvas opens a small context menu at the cursor position instead of the browser's native menu.
- [x] #2 The menu offers at least a "Create task here" action, pre-filled with the lane/milestone inferred from the clicked cell (parity with the existing left-click-in-place behavior).
- [x] #3 The menu dismisses on click-outside, Escape, or after selecting an action.
- [x] #4 Existing create-task entry points (TabBar +, keyboard shortcuts, and left-click-in-place unless the reviewer opts to remove it) continue to work unchanged.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation notes:

- Created `ContextMenu.svelte` — a small right-click dropdown anchored at the cursor position, rendered inside the tree-canvas alongside the existing DetailPopover/MilestonePopover.
- Added `oncontextmenu` handler (`onContextMenu`) on the tree-viewport div in `TechTreeCanvas.svelte`. It suppresses the browser's native context menu via `e.preventDefault()`, infers lane/band from the clicked cell using `screenToWorld` + `cellAt` (same geometry inverse as left-click-in-place), and opens the context menu.
- The context menu only appears on empty canvas (not on tree nodes, toolbar, or band headers — guarded via `target.closest()`).
- Dismissal: Escape key (via `svelte:window onkeydown`), click-outside (via `svelte:window onmousedown` checking `menuEl.contains()`), or after selecting "Create task here".
- The backdrop uses `pointer-events: none` so clicks pass through to canvas elements; only the menu itself captures clicks (`pointer-events: auto`).
- Supplement mode: existing left-click-in-place, TabBar +, and keyboard shortcuts all remain unchanged.
- Uses VS Code theme CSS variables for consistent theming (menu-background, menu-foreground, menu-selectionBackground).

Decision: Supplement, not replace — the right-click menu is an additional path; left-click-in-place still works.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented a right-click context menu for creating tasks on the tree canvas.

**Changes:**
- `src/webview/components/tree/ContextMenu.svelte` (new): A VS Code-themed dropdown menu anchored at the cursor position. Features a "Create task here" button, dismisses on Escape/click-outside/action-select. Backdrop uses pointer-events:none to avoid blocking canvas interactions.
- `src/webview/components/tree/TechTreeCanvas.svelte`: Added `oncontextmenu` handler on the tree-viewport div that suppresses the browser native menu, infers lane/band from the clicked cell (via screenToWorld + cellAt), and opens the context menu. Added state management (contextMenu) and closeContextMenu.
- `e2e/tree-authoring.spec.ts`: 5 new Playwright tests covering: menu opens on right-click, "Create task here" opens create form, Escape dismisses, click-outside dismisses, and left-click-in-place is preserved.

**Verification:** 1527 unit tests pass, 43 Playwright tests pass (5 new + 38 existing), ESLint and TypeScript typecheck clean.
<!-- SECTION:FINAL_SUMMARY:END -->
