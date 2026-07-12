---
id: TASK-107
title: Stop the tech-tree canvas repainting the whole board on node hover
status: In Progress
assignee: []
created_date: '2026-07-12 06:20'
updated_date: '2026-07-12 06:34'
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
- [x] #1 Hovering a node performs O(1) DOM writes on the edge layer, not one class update per edge — verified by a test that counts mutations/attribute writes on hover with a large (100+ node) synthetic board.
- [x] #2 The all-edges `transition: opacity` no longer runs on every hover in/out across the board; only the highlight of edges incident to the hovered node changes.
- [x] #3 Hover highlight behavior is preserved: edges incident to the hovered (or selected) node are emphasized, non-incident edges are dimmed, and bug edges are still revealed only on hover/select of an incident node.
- [x] #4 Existing tree hover/edge coverage still passes (`bun run test`, `e2e/tree-canvas.spec.ts`, `e2e/tree-drag.spec.ts` edge-removal paths) — the edge ✕ hover hit-path and removal still work.
- [x] #5 Repaint proof on a large board: flicker is a TEMPORAL artifact a static screenshot cannot show, so the proof is the measured repaint trigger — `e2e/tree-hover-perf.spec.ts` records 117 mutated edge elements per hover before the fix and 2 after, on a 120-node/117-edge board, with the board-wide opacity transition asserted gone.
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Measured, not assumed

A new Playwright spec (`e2e/tree-hover-perf.spec.ts`) builds a 120-node / 117-edge synthetic board and
counts, with a `MutationObserver` on the edge-layer subtree, the distinct elements Svelte mutates during
one `pointerenter`:

| | elements mutated per hover |
|---|---|
| before | **117** (one per edge — every single one) |
| after | **2** |

That 117 was the bug, exactly as diagnosed: `class:incident` / `class:faded` on every `<path>` both read
`activeId`, so one pointer enter (and one leave) rewrote the whole edge set. Because `.tree-surface` carries
`will-change: transform` — promoting the entire board into ONE composited layer — that per-edge restyle
re-rasterized the whole canvas, nodes included. Plus `.tree-edge` had `transition: opacity 0.12s`, so all 117
paths *animated* their opacity on each hover in and out: a sustained whole-board repaint, i.e. the flicker.

## Shape of the fix

The edge layer is now two layers:

- **Base group** (`.tree-edges`, `data-testid="tree-edge-group"`) — every dependency edge, rendered once.
  Nothing inside reads hover/selection state, so a hover *cannot* rewrite it. The dim is a single
  `.has-active` class on the group; CSS (`.tree-edges.has-active .tree-edge { opacity: .15 }`) fades the
  rest with **zero per-edge DOM writes**.
- **Highlight overlay** (`.tree-edges-highlight`) — only the active node's incident edges, drawn opaque on
  top of the dimmed base. O(degree), not O(edges).

A bug→cause edge has no base path (it only ever exists while incident), so the overlay *is* its single
incarnation and it keeps the canonical `tree-edge-{from}-{to}` test id; a dependency edge's overlay stroke
is the `-hl-` twin of a base path that already owns that id. The board-wide `transition: opacity` is gone —
the dim is now an instant state change.

## Notes for TASK-108

The `will-change: transform` on `.tree-surface` is the *amplifier* here (it is what turns an edge-only
restyle into a whole-board repaint) and is deliberately left in place — removing it is TASK-108, which
depends on this task.

## Verification

- `bun run test` — 2054 passed / 142 files. `bun run lint`, `bun run typecheck` — clean.
- Tree Playwright suites (canvas + hover-perf + drag + popover): **56 passed**.
- 3 failures in `tree-canvas.spec.ts` (`trackpad two-finger scroll`, `fills available panel height`,
  `reflows on viewport resize`) are **pre-existing** — reproduced on a clean stashed HEAD build before any
  of this change, and untouched by it. They are viewport/height concerns, unrelated to the edge layer.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The tech tree no longer repaints the whole board when you hover a node.

**Root cause (measured, not guessed).** `EdgeLayer.svelte` gave every edge path a `class:incident` and a
`class:faded` derived from the hovered node, so a single `pointerenter` rewrote *every* edge on the board —
a `MutationObserver` on a 120-node / 117-edge synthetic board counted **117 mutated elements per hover**.
Each path also carried `transition: opacity 0.12s`, so all 117 animated their opacity on every hover in AND
out. And because `.tree-surface` sets `will-change: transform`, the entire board is a single composited
layer: that edge-only restyle re-rasterized every node too. Hence "the whole board flickers", and hence why
it only showed up once the board got big.

**Fix.** The edge layer is now a base group (every dependency edge, rendered once, never touched by hover)
plus a small highlight overlay (only the active node's incident edges, drawn opaque on top). Fading the rest
is a single `.has-active` class on the base group with CSS doing the dimming — zero per-edge DOM writes. The
board-wide opacity transition is gone.

**Result: 117 → 2 mutated elements per hover**, with the highlight/dim semantics and the bug→cause edge
reveal behaving exactly as before.

Coverage: new `e2e/tree-hover-perf.spec.ts` (mutation budget, ancestor-driven dim, no board-wide transition)
plus the updated `tree-canvas.spec.ts` hover assertions. `bun run test` 2054 passed, lint and typecheck clean,
56 tree Playwright tests green. Three `tree-canvas.spec.ts` failures (trackpad pan, panel height, resize
reflow) are pre-existing — reproduced on a clean HEAD build and untouched by this change.

The `will-change: transform` amplifier is deliberately left in place; removing it is TASK-108, which depends
on this task.
<!-- SECTION:FINAL_SUMMARY:END -->
