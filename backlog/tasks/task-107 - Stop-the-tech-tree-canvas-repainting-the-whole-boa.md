---
id: TASK-107
title: Stop the tech-tree canvas repainting the whole board on node hover
status: In Progress
assignee: []
created_date: '2026-07-12 06:20'
updated_date: '2026-07-12 06:20'
labels:
  - performance
  - bug
  - tree
milestone: Performance & Startup Cost
dependencies: []
priority: high
category: Tree
claimed_by: '@agent/task-107-stop-the-tech-tree-canvas-repainting-the-whole-board-on-node-hover'
worktree: task-107-stop-the-tech-tree-canvas-repainting-the-whole-board-on-node-hover
claimed_at: '2026-07-12 14:21'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On a large board, moving the pointer onto and off a tree node visibly flickers the ENTIRE canvas — every node and edge, not just the hovered one.

Root cause (two amplifying halves):

1. `EdgeLayer.svelte` takes `hoveredId` as a prop and every edge in the `{#each edges}` block reads it: `visible(e)` calls `incident(e, hoveredId)`, and `class:incident` / `class:faded` both derive from `activeId = hoveredId ?? selectedId`. So ONE `pointerenter` invalidates and rewrites classes on O(E) edge paths — every edge on the board. Each of those paths carries `transition: opacity 0.12s ease` (`.tree-edge`), so the whole edge set animates its opacity on every hover in AND out.

2. `.tree-surface` in `TechTreeCanvas.svelte` declares `will-change: transform`, which promotes the entire board (all nodes + the full edge SVG) into a SINGLE composited layer. Any paint invalidation inside that layer re-rasterizes the whole layer. So the O(E) edge restyle from (1) does not just repaint the edges — it repaints every node too. That is the "whole board re-renders" the user sees, and it only becomes visible once the task count (and therefore the layer) is large.

The fix is to make hover a local, bounded update: the highlight/dim decision must not write to O(E) DOM elements per hover, and the edge opacity transition must not run across the whole board. Prefer driving the dim state from a single class/attribute on the SVG root (one DOM write) with CSS selecting the incident edges, so hover costs O(1) DOM writes instead of O(E).

Measured baseline: the board is 98 tasks. Board parsing is NOT implicated (40ms cold / 2ms warm) — this is purely a webview paint problem.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Hovering a node performs O(1) DOM writes on the edge layer, not one class update per edge — verified by a test that counts mutations/attribute writes on hover with a large (100+ node) synthetic board.
- [ ] #2 The all-edges `transition: opacity` no longer runs on every hover in/out across the board; only the highlight of edges incident to the hovered node changes.
- [ ] #3 Hover highlight behavior is preserved: edges incident to the hovered (or selected) node are emphasized, non-incident edges are dimmed, and bug edges are still revealed only on hover/select of an incident node.
- [ ] #4 Existing tree hover/edge coverage still passes (`bun run test`, `e2e/tree-canvas.spec.ts`, `e2e/tree-drag.spec.ts` edge-removal paths) — the edge ✕ hover hit-path and removal still work.
- [ ] #5 Visual proof captured on a large board showing no whole-board flicker on hover in/out.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## File Structure

- `src/webview/components/tree/EdgeLayer.svelte` — replace per-edge reactive reads of `hoveredId`/`selectedId` with a single root-level state, and scope/remove the blanket opacity transition.
- `src/webview/components/tree/TechTreeCanvas.svelte` — how `hoveredId`/`selectedId` are handed to the edge layer (may no longer need to be a reactive prop read by every edge).
- `src/test/unit/` — new failing test asserting bounded DOM work on hover.
- `e2e/tree-canvas.spec.ts` — behavior regression coverage for the highlight/dim semantics.

## Steps

1. Write the failing test first: render a synthetic 100+ node / many-edge board, hover a node, and assert the number of mutated edge elements is bounded (not O(E)).
2. Restructure `EdgeLayer` so the hovered/selected identity is expressed as ONE attribute/class on the `<svg>` root plus static per-edge `data-from`/`data-to`, letting CSS do the incident/faded selection.
3. Remove the board-wide `transition: opacity` from `.tree-edge` (or scope it so it cannot fire across every edge at once).
4. Re-verify the bug-edge visibility rule and the edge ✕ hover/removal path still behave identically.
5. Capture visual proof (`/visual-proof`) on a large board.

Note: the `will-change: transform` layer promotion on `.tree-surface` is the amplifier here but is fixed in its own task (the zoom-blur one), which depends on this one. Do not remove it here.
<!-- SECTION:PLAN:END -->
