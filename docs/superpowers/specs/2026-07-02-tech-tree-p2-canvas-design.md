# Design: Tech-tree P2 — the canvas board

**Date:** 2026-07-02
**Status:** Approved (brainstorm) — pending implementation plan
**Umbrella:** `docs/superpowers/specs/2026-07-01-tech-tree-overhaul-vision.md`
**Builds on:** P1 model (`docs/superpowers/specs/2026-07-01-tech-tree-p1-model-and-gating-design.md`), with two amendments folded back into P1 (§12).

P2 is the visible board: a pannable, zoomable **tech-tree canvas** that renders the P1 model
spatially, plus the popover, reworked details page, milestone view, in-flight panel, and navigator.
It is a **rendering layer** over the existing data bus — not a storage or model rewrite.

## 1. Problem & goal

The status-column kanban stacks every task vertically with no sense of category, flow, or readiness
(see the umbrella §1). P2 makes the **new default view** a tech tree where a task is a node, its
category is a lane, its milestone is an age band, and its dependencies are edges that visibly lock
it. The kanban and list stay as alternate tabs on the same data.

## 2. Decisions locked during brainstorming

- **View:** tech tree = new default, opened as an **editor tab** (full-bleed canvas). Kanban/list
  remain tabs on the same `TasksController` data bus.
- **Window layout "A":** navigator in the VS Code **sidebar** (~260px); canvas fills the editor tab;
  **in-flight panel** is a collapsible overlay on the canvas's right edge.
- **Node encoding:** colored **left edge + faint tint + SVG icon** (never color alone).
- **Priority is text, user-defined** (config list) — see §12.
- **Lanes are bands** that grow vertically to pack **branching** parallel chains into sub-rows (§12).
- **Popover = quick view + quick edits**; opening it makes the task **active (ephemeral**, clears on
  close); actions are **state-aware and minimal**; Claim ⟂ Dispatch; the agent owns Request merge.
- **Details page reworked:** AC is the primary checklist; **DoD leaves the task** for the milestone;
  long-form text becomes **attachment chips**.
- **Filter dims** non-matches in place; **lanes collapse**; a minimap aids navigation.
- **Principles:** human/agent **parity** (every MCP action has a one-click human equivalent) and a
  **self-evident UI** (no explanatory captions); Lucide SVG icons; all themes.

## 3. Window layout (A)

Two cooperating webviews, mirroring today's split (`TasksPanelProvider` editor board +
`TasksViewProvider` sidebar board), both driven by `TasksController`:

- **Canvas** — a `WebviewPanel` editor tab (evolves `TasksPanelProvider`) hosting a new
  `TechTreeCanvas` view. Full-bleed.
- **Navigator** — a sidebar `WebviewView`: search, priority filter chips, **lane toggles + counts**,
  **age jump-bars**, and a **minimap**. Selecting a lane toggles its visibility; an age jump scrolls
  the canvas; the minimap shows/moves the viewport.
- **In-flight panel** — drawn inside the canvas webview, docked collapsible to the right edge:
  **Active** tasks and **pending review/merge** entries with inline **Approve / Send-back** (reuses
  the existing merge-review actions).

## 4. Spatial model & layout

Derived by extending P1's pure `treeLayout` module — no stored coordinates:

- **Row = lane** = `type:bug` → **Bugs**; else `category`; else **Misc**. A lane is a **band** whose
  height grows to fit parallel chains.
- **Column = age band** = `milestone` in config order; no milestone → **Backburner** (rightmost).
- **X within a band** = dependency depth (longest same-band prerequisite chain).
- **Y within a lane** = **sub-row packing**: when a chain forks, branches occupy parallel sub-rows so
  nodes never overlap; the band’s height = max concurrent sub-rows. `ordinal` breaks ties.

## 5. Node rendering

- **Encoding:** left color bar + faint background tint of the status color + a status **SVG** icon.
- **Contents (near zoom):** id, title, **text priority**, label chips, **plan progress bar**, worker
  badge (bot/user SVG), **lock** (locked), **active-bug** badge + count (with a colored halo).
- **Level of detail:** near = full card → mid = title + status + glyphs → far = status **pill**
  (color = status, shape hints priority). Lane and age are conveyed by position, not on the card.
- **States:** To Do, In Progress, Pending Review (queue position), Done (dimmed + check), Locked
  (dashed + lock), has-active-bug (halo), bug node (Bug-lane styling).

## 6. Edges

- **Prerequisite edges:** **solid** = satisfied (source Done); **dashed (amber)** = still blocking
  (source not Done → target renders locked). Arrowheads point prerequisite → dependent.
- **Bug→cause reference edges:** a distinct, subtle style (dotted), surfaced on hover/selection of a
  bug or an active-bug node, to connect a bug to its `caused_by` task without cluttering the tree.
- **Routing:** SVG overlay beneath the nodes; curved connectors; hovering a node highlights its
  incident edges and fades the rest.

## 7. Detail popover & focus = active (Task 12)

- Click a node → a popover anchors to it: id/lane/age chips, title, **status/priority ▾ quick-edit**,
  **description preview** (expand), prereqs/unlocks, plan bar, worker/claim line.
- **Active = ephemeral.** Opening the popover writes the task as the active context (like the active
  editor doc); **closing it clears active**. No "Set active" button. The agent persists its own
  memory thereafter — active is only a convenience for injecting "what I'm looking at."
- **State-aware actions** (minimal — see the state→action table):

  | State | Actions |
  |-------|---------|
  | To Do · unlocked | Claim · Dispatch |
  | To Do · locked | Force claim *(human-only override)* |
  | In Progress · yours | **Request merge / Mark done** *(one smart button)* · Release Claim |
  | In Progress · agent | **Cancel dispatch** |
  | Pending Review | Approve · Send back |

- **Claim ⟂ Dispatch:** a claimed task offers no Dispatch; a dispatched task offers no Claim/Request
  merge (the agent owns `request_merge`). **⤢** opens the full details page.
- **Cancel dispatch:** remove the worktree · release the claim · return to To Do · terminate the
  agent's terminal if we launched it, else signal cancellation the agent observes on its next MCP
  check and cleans up. The cancellation-signal plumbing is a **P5 dependency** (§13).

## 8. Reworked details page (the ⤢ full panel)

Evolves `TaskDetailProvider` + `TaskDetail.svelte`. No claim/dispatch/active buttons (popover
concerns). Order:

1. **Header** — id/lane/milestone chips, editable title, status/priority/labels inline.
2. **Relationships bar** — Prereqs (✓ satisfied), Unlocks, active-bug count, `+ link`.
3. **Description** — inline markdown (no redundant heading).
4. **Acceptance Criteria** — the primary checklist (add/edit/toggle).
5. **Attachments** — Implementation Plan / Spec / Notes / Final Summary as **chips** that expand to
   an inline **markdown preview** with "open in editor"; empty ones show as `+ Add`.

**Definition of Done is removed from the task** (§9).

## 9. Milestones / ages & the new DoD home

- Age **band headers** show milestone progress. Clicking a band header (or a milestone in the
  navigator) opens a **milestone popover**: overall progress, per-lane breakdown, and a **Release
  checklist** — the single home for manual **Definition of Done** items (docs, changelog, smoke test).
- The automated "done bar" (tests · lint · typecheck) is **not** duplicated as a manual list; it is
  enforced per task by `request_merge`'s verify commands, and the milestone popover notes that.
- **Rationale:** per-task DoD was redundant (identical on every task; hard parts already enforced on
  merge). Manual release-readiness belongs once, on the milestone.

## 10. In-flight panel

- **Active** — the task(s) whose popover is open / recently active for you.
- **Pending review/merge** — merge-queue entries (Pending Review / Awaiting Merge / Awaiting PR) with
  queue position and inline **Approve / Send-back**, reusing the existing merge-review controls.
- Collapsible to reclaim canvas width.

## 11. Navigation & scale

- **Pan** by dragging empty canvas or scrolling; **zoom** with ⌘/Ctrl-scroll, pinch, or a toolbar
  (− % + · fit-to-view); **minimap** with a draggable viewport.
- **Filter dims** non-matching nodes **in place** (preserves spatial memory); edges to filtered
  nodes fade. **Lanes collapse** to a summary strip (counts). Age jump + lane toggles live in the
  navigator.

## 12. Amendments folded back into P1

Two brainstorm outcomes change the committed P1 model; P1 is updated to match:

- **Priority is a user-defined, ordered list.** Priority stops being the fixed `high|medium|low`
  enum and becomes the config `priorities: string[]` (already present but unused), ordered
  highest-first, shown as **text**. **Bug severity reuses priority**, so it inherits the configured
  set. Sort tie-breaks use config order.
- **Lane layout is band-with-sub-rows.** P1 §4's "lane = row" becomes "lane = band"; the layout adds
  a within-lane vertical **sub-row packing** step so branching parallel chains don't overlap and the
  band grows to fit them.

## 13. Architecture, rendering & testing

- **Rendering:** HTML nodes (reusing card components + theme tokens) positioned by CSS transform for
  pan/zoom, with an **SVG overlay** for edges. This keeps VS Code theming, accessibility, and CSP
  (no inline scripts) intact, and scales to the hundreds-of-nodes range; a canvas/WebGL renderer is
  out of scope unless profiling demands it.
- **New/changed components:** `TechTreeCanvas.svelte` (+ node, edge-layer, age-band, lane,
  in-flight, minimap subcomponents); navigator `WebviewView`; reworked `TaskDetail.svelte`; milestone
  popover. New webview↔extension messages for viewport/collapse/filter state and milestone open.
  Node placement consumes the pure P1 `treeLayout` (extended per §12).
- **Testing:** unit tests for the extended layout (sub-row packing, band ordering) live with P1;
  **Playwright** for canvas interactions (pan/zoom, click→popover, quick-edit, collapse, filter
  dimming); **CDP** for cross-view coordination (popover↔active, board↔details); `visual-proof` for
  PR artifacts.

## 14. Scope boundary & dependencies

**In P2:** the canvas view + navigator + in-flight panel + node/edge rendering + pan/zoom/scale +
detail popover + reworked details page + milestone popover, and the P1 layout extension (§12).

**Depends on:** P1 (model + gating), including the §12 amendments.

**Deferred:** creating/editing on the canvas — inline creation, **drag-to-connect** dependencies,
bug/one-off intake (**P3**); `/create-task`, `/execute-task`, tree-traversal tools, indexing
(**P4–P6**). **Cancel-dispatch's** worktree-removal + agent-cancellation signal is a **P5** dependency
that P2 only triggers.

## 15. Amendment (P4): draft / proposed nodes

The P4 `/create-task` skill applies its proposal as **Draft-status nodes** the user reviews on the
canvas, which adds two requirements here:

- **Draft/proposed rendering** — Draft-status nodes get a distinct "proposed" style (e.g.,
  dashed/ghosted) and participate in layout, filtering, and all P3 gestures (reslot, connect, edit).
- **Promote action** — a per-node **Promote** and a canvas-level **Promote all proposed**, backed by
  the `promote_draft` / `promote_drafts` MCP tools.

See `docs/superpowers/specs/2026-07-02-tech-tree-p4-create-task-skill-design.md` §6–§7.
