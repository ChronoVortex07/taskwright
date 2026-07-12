# Tree find bar — design

**Date:** 2026-07-12
**Status:** Approved (brainstorm)
**Scope:** Tree tab only. Kanban search parity is explicitly out of scope for this pass.

## Problem

The Tree tab is the default board view and has no way to locate a task by name or
content. The only in-board search is the List tab's box
(`src/webview/components/list/ListView.svelte:399-409`), which matches `id + title +
description`. The Tree's only narrowing affordance lives in a *separate webview view* —
the navigator sidebar (`src/webview/components/navigator/TreeNavigator.svelte`), which
matches `id + title` only, dims non-matches on the canvas, and is unavailable when the
sidebar view is closed.

Separately, an empty-canvas **left-click** opens the create-task form
(`TechTreeCanvas.svelte:481`, the P3b "click-in-place" affordance). This makes it
impossible to click the Tree panel to focus it without creating a task.

## Goals

1. Find a task on the Tree by name or details, highlight every match, and cycle through
   matches with Enter, centering each one.
2. Left-click on empty canvas stops creating tasks. Right-click remains the create path.

## Non-goals

- Kanban search. (Named as a parity gap; deferred.)
- Replacing or merging the navigator sidebar's filter.
- Persisting find state across reloads.

## Design

### Find is a distinct verb from filter

The navigator sidebar's search is a **filter**: it narrows the board by dimming
non-matches. What this spec adds is a **find**: it locates within the board by
highlighting matches and walking them.

The two coexist and compose. A find operates over whatever the filter left visible; a
node dimmed by the navigator filter is not a find candidate. Neither control writes to
the other, and there is no message sync between them.

Rationale for a new in-canvas control rather than upgrading the navigator: find must
work when the sidebar view is closed, and conflating "narrow the board" with "walk to a
node" into one text box makes both harder to reason about.

### Pure core — `src/webview/lib/treeFind.ts`

New vscode-free, unit-testable module. Two functions:

```ts
export function findMatches(
  tasks: Task[],
  query: string,
  geometry: TreeGeometry
): string[];

export function cycleIndex(current: number, total: number, dir: 1 | -1): number;
```

**`findMatches`** returns matching task IDs. The predicate is the same one the List tab
already uses — case-insensitive substring over `id`, `title`, and `description`:

```ts
const q = query.trim().toLowerCase();
t.id.toLowerCase().includes(q) ||
  t.title.toLowerCase().includes(q) ||
  (t.description ?? '').toLowerCase().includes(q);
```

Matching the List predicate exactly is deliberate — search behaving identically on every
tab is the parity principle that motivated this work. `Task.description` is already
present on the webview's task objects for every tab (`TasksController` spreads the full
task at `TasksController.ts:357-375`), so no extension-host payload change is needed.

An empty or whitespace-only query returns `[]`.

**Result order is spatial, not array order.** Results are sorted by each node's geometry
box — band (x) first, then lane (y) — so Enter walks the tree left-to-right, top-to-bottom,
the way the board is read. Array order would make cycling feel random on a wide board.
Tasks with no geometry box (not laid out) are excluded from results; they aren't
reachable by centering.

**`cycleIndex`** wraps: `(current + dir + total) % total`. Advancing past the last match
returns to the first.

### Canvas state — `TechTreeCanvas.svelte`

Three new `$state` values: `findQuery`, `matchIds` (a `Set<string>`, derived from
`findMatches`), and `currentMatchIdx`.

Highlighting reuses the existing mechanisms rather than adding new ones:

- `TreeNode` gains two boolean props, `matched` and `currentMatch`. `matched` renders an
  accent ring; `currentMatch` renders a stronger/thicker ring. Both must read correctly
  in light and dark themes and must not collide with the existing claim / merge / active
  / readonly badges.
- Non-matches fold into the existing `dimmedIds` set (`TechTreeCanvas.svelte:140-145`),
  which already drives node and edge fading. While a find is active with ≥1 result,
  `dimmedIds` is the union of the navigator-filter dim set and the set of non-matching
  nodes.
- A query with **zero results** dims nothing (dimming the whole board conveys nothing)
  and the bar reads "No results".

### Centering — shared with the navigator jump

The center-on-node math currently inlined in the `jumpTaskId` effect
(`TechTreeCanvas.svelte:184-196`) is extracted into a `centerOn(taskId)` function. Both
the navigator's `navigatorJumpToTask` and the find bar's Enter call it. Behavior is
unchanged: it sets `tx`/`ty` to center the node's box at the current scale, through the
existing clamped `setViewport`.

**Enter does not open the node's popover.** Opening a popover fires
`popoverActiveChanged`, which sets the ephemeral active task — cycling through ten
matches would rewrite the active task ten times. Enter centers and marks; the human
clicks the node to open it.

### Find bar — `TreeFindBar.svelte`

New component, floating over the canvas (not in the toolbar, so it can overlay without
reflowing the board). Contents:

- a text input, `data-testid="tree-search-input"`
- a match counter, `3 / 12`, or `No results`
- prev / next buttons (mouse equivalents of Shift-Enter / Enter)
- a close button

Keyboard contract:

| Key | Action |
| --- | --- |
| `/` or `Ctrl/Cmd-F` | Open the bar and focus the input |
| `Enter` | Next match; center it; wrap at the end |
| `Shift-Enter` | Previous match; center it; wrap at the start |
| `Escape` | Close the bar, clear the query, clear all highlight and dim state |

`/` is **already** bound in the global handler (`Tasks.svelte:446-451`) to focus
`[data-testid="search-input"]` — a selector only `ListView` provides, making `/` a no-op
on the Tree today. That handler is widened to a union selector
(`[data-testid="tree-search-input"], [data-testid="search-input"]`). The two never
coexist: the find bar renders only on the Tree tab, `ListView` only on
list/drafts/archived. `Ctrl/Cmd-F` is added alongside.

The global keydown handler already returns early when the event target is an
`INPUT`/`TEXTAREA`/contenteditable (`Tasks.svelte:387-390`), so typing in the find bar
will not trigger the single-key tab shortcuts. Enter/Shift-Enter/Escape are handled on
the input itself.

### Left-click unbind

The empty-canvas `pointerup` path that opens the create form with an inferred lane/band
(`TechTreeCanvas.svelte:481`) is removed. A plain left-click on empty canvas now closes
any open popover/milestone popover and focuses the canvas — nothing else.

Right-click is unchanged and already does the job: `onContextMenu`
(`TechTreeCanvas.svelte:655-673`) infers lane/band from the click point via `cellAt` and
opens the context menu with the create action.

This retires the P3b "click-in-place" affordance. Its tests and its description in
`CLAUDE.md` are updated in the same change — not left stale.

Drag-to-connect, drag-to-reslot, and the `DRAG_THRESHOLD` gesture disambiguation are
untouched; only the *click* (sub-threshold pointerup on empty canvas) branch changes.

## Testing

**Unit (`src/test/unit/treeFind.test.ts`)** — the pure core:

- matches on id, on title, on description, case-insensitively
- empty / whitespace query returns no matches
- results are ordered by geometry (band, then lane), not by input array order
- nodes absent from geometry are excluded
- `cycleIndex` wraps forward past the last and backward past the first
- a single match cycles to itself

**E2E (`e2e/tree-find.spec.ts`)** — the canvas:

- `/` opens the bar and focuses it; `Ctrl/Cmd-F` does too
- typing a query rings the matching nodes and dims the rest
- the counter reads `1 / N`; Enter advances it and re-centers the viewport
- Enter past the last match wraps to the first
- Enter does **not** open a popover (assert no `popoverActiveChanged` is posted)
- a zero-result query dims nothing and reads "No results"
- Escape clears highlight, dim, and query
- **left-click on empty canvas does not open the create form**; right-click still does

**Existing tests to update:** the specs covering P3b click-in-place
(`e2e/tree-drag.spec.ts`, `e2e/tree-authoring.spec.ts`, `src/test/cdp/tree-authoring.test.ts`)
must be repointed from left-click to right-click, not deleted.

Visual proof (`/visual-proof`) for the find bar — highlight, current-match ring, and the
dim treatment are all visual claims.
