# Tree Find Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Tree tab an in-canvas find bar that highlights every task matching a query and cycles through matches with Enter, and stop an empty-canvas left-click from opening the create-task form.

**Architecture:** A new pure, vscode-free core (`src/webview/lib/treeFind.ts`) computes the match set and orders it *spatially* from the existing tree geometry, so Enter walks the board left-to-right the way it reads. A new `TreeFindBar.svelte` owns the input and counter; `TechTreeCanvas.svelte` owns the state, folds non-matches into its existing `dimmedIds` set, and centers the current match through a `centerOn(taskId)` helper extracted from the navigator's existing jump effect. No new dim/highlight machinery, no extension-host payload change — `Task.description` is already on the webview task objects.

**Tech Stack:** Svelte 5 (runes: `$state`, `$derived`, `$props`), TypeScript, Vitest (unit), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-12-tree-find-bar-design.md`

## Global Constraints

- **Find is not filter.** The navigator sidebar's existing `navSearch` filter (`TechTreeCanvas.svelte:128-145`) is untouched. Find composes with it: a node dimmed by the navigator filter is not a find candidate.
- **Enter must never open a popover.** Opening a popover posts `popoverActiveChanged`, which sets the ephemeral active task. Cycling ten matches would rewrite the active task ten times.
- **Icons are Lucide inline SVG, never emojis** (project convention). Copy from https://lucide.dev/.
- **All styling must work in every VS Code theme** — use `var(--vscode-*)` custom properties, never hardcoded colors.
- **TDD**: write the failing test first, watch it fail, then implement.
- Build/verify commands: `bun run test`, `bun run lint`, `bun run typecheck`. All three must pass before a task is done.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/webview/lib/treeFind.ts` | **Create.** Pure core: match predicate, spatial ordering, cycle-index wraparound. |
| `src/test/unit/treeFind.test.ts` | **Create.** Unit tests for the pure core. |
| `src/webview/components/tree/TreeFindBar.svelte` | **Create.** The find bar UI: input, counter, prev/next/close buttons. |
| `src/webview/components/tree/TreeNode.svelte` | **Modify.** Add `matched` / `currentMatch` props + ring styling. |
| `src/webview/components/tree/TechTreeCanvas.svelte` | **Modify.** Find state, `dimmedIds` union, `centerOn()` extraction, keyboard, find-bar host. **Remove** the empty-canvas click-to-create branch. |
| `src/webview/components/tasks/Tasks.svelte` | **Modify.** Widen the `/` binding; add `Ctrl/Cmd-F`. |
| `e2e/tree-find.spec.ts` | **Create.** E2E coverage for highlight, cycle, wrap, Escape, and the left-click unbind. |
| `e2e/tree-drag.spec.ts`, `e2e/tree-authoring.spec.ts`, `src/test/cdp/tree-authoring.test.ts` | **Modify.** Repoint click-in-place assertions from left-click to right-click. |
| `CLAUDE.md` | **Modify.** Correct the P3b bullet's click-in-place claim. |

---

### Task 1: Pure find core — match, order, cycle

**Files:**
- Create: `src/webview/lib/treeFind.ts`
- Test: `src/test/unit/treeFind.test.ts`

**Interfaces:**
- Consumes: `TreeGeometry` and `NodeBox` from `src/webview/lib/treeGeometry.ts` (`TreeGeometry.nodes` is a `Map<string, NodeBox>`; `NodeBox` is `{x, y, width, height}`); `Task` from `src/webview/lib/types.ts`.
- Produces: `findMatches(tasks: Task[], query: string, geometry: TreeGeometry): string[]` and `cycleIndex(current: number, total: number, dir: 1 | -1): number`. Task 4 calls both.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/treeFind.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findMatches, cycleIndex } from '../../webview/lib/treeFind';
import type { TreeGeometry, NodeBox } from '../../webview/lib/treeGeometry';
import type { Task } from '../../webview/lib/types';

function task(id: string, title: string, description?: string): Task {
  return {
    id,
    title,
    status: 'To Do',
    labels: [],
    assignee: [],
    dependencies: [],
    description,
    filePath: `/backlog/tasks/${id}.md`,
  } as unknown as Task;
}

/** Build a geometry whose node boxes place each id at the given (x, y). */
function geom(boxes: Record<string, { x: number; y: number }>): TreeGeometry {
  const nodes = new Map<string, NodeBox>();
  for (const [id, p] of Object.entries(boxes)) {
    nodes.set(id, { x: p.x, y: p.y, width: 208, height: 92 });
  }
  return { nodes, lanes: [], bands: [], width: 1000, height: 1000 };
}

describe('findMatches', () => {
  const g = geom({ 'TASK-1': { x: 0, y: 0 }, 'TASK-2': { x: 0, y: 200 }, 'TASK-3': { x: 300, y: 0 } });

  it('matches on title, case-insensitively', () => {
    const tasks = [task('TASK-1', 'Add Login Form'), task('TASK-2', 'Fix parser')];
    expect(findMatches(tasks, 'login', g)).toEqual(['TASK-1']);
    expect(findMatches(tasks, 'LOGIN', g)).toEqual(['TASK-1']);
  });

  it('matches on description', () => {
    const tasks = [task('TASK-1', 'Alpha', 'uses a redis cache'), task('TASK-2', 'Beta')];
    expect(findMatches(tasks, 'redis', g)).toEqual(['TASK-1']);
  });

  it('matches on id', () => {
    const tasks = [task('TASK-1', 'Alpha'), task('TASK-2', 'Beta')];
    expect(findMatches(tasks, 'task-2', g)).toEqual(['TASK-2']);
  });

  it('returns no matches for an empty or whitespace query', () => {
    const tasks = [task('TASK-1', 'Alpha')];
    expect(findMatches(tasks, '', g)).toEqual([]);
    expect(findMatches(tasks, '   ', g)).toEqual([]);
  });

  it('orders results spatially — band (x) first, then lane (y) — not by input order', () => {
    // Input order is deliberately reversed relative to layout position.
    const tasks = [task('TASK-3', 'hit c'), task('TASK-2', 'hit b'), task('TASK-1', 'hit a')];
    // TASK-1 (0,0) then TASK-2 (0,200) then TASK-3 (300,0)
    expect(findMatches(tasks, 'hit', g)).toEqual(['TASK-1', 'TASK-2', 'TASK-3']);
  });

  it('excludes tasks with no geometry box (not laid out)', () => {
    const tasks = [task('TASK-1', 'hit'), task('TASK-99', 'hit')];
    expect(findMatches(tasks, 'hit', g)).toEqual(['TASK-1']);
  });
});

describe('cycleIndex', () => {
  it('advances forward', () => {
    expect(cycleIndex(0, 3, 1)).toBe(1);
  });

  it('wraps forward past the last', () => {
    expect(cycleIndex(2, 3, 1)).toBe(0);
  });

  it('wraps backward past the first', () => {
    expect(cycleIndex(0, 3, -1)).toBe(2);
  });

  it('cycles a single match to itself', () => {
    expect(cycleIndex(0, 1, 1)).toBe(0);
    expect(cycleIndex(0, 1, -1)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun run test -- treeFind`
Expected: FAIL — `Failed to resolve import "../../webview/lib/treeFind"`.

- [ ] **Step 3: Write the implementation**

Create `src/webview/lib/treeFind.ts`:

```ts
/**
 * Tree find (not filter) — locate tasks on the canvas by id/title/description and walk
 * them in reading order. vscode-free and pure so it can be unit-tested without a webview.
 *
 * The match predicate is deliberately IDENTICAL to the List tab's search
 * (ListView.svelte) — search behaving the same on every tab is the parity property this
 * feature exists to deliver.
 *
 * Results are ordered SPATIALLY (band/x, then lane/y), not by array order, so Enter walks
 * the tree left-to-right, top-to-bottom the way a human reads it.
 */
import type { Task } from './types';
import type { TreeGeometry } from './treeGeometry';

/** Does this task match the query? Case-insensitive substring over id, title, description. */
function matches(task: Task, lowerQuery: string): boolean {
  return (
    task.id.toLowerCase().includes(lowerQuery) ||
    task.title.toLowerCase().includes(lowerQuery) ||
    (task.description ?? '').toLowerCase().includes(lowerQuery)
  );
}

/**
 * Matching task ids, ordered by their laid-out position: x (band) first, then y (lane).
 * Tasks absent from `geometry.nodes` are excluded — they cannot be centered on.
 */
export function findMatches(tasks: Task[], query: string, geometry: TreeGeometry): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: Array<{ id: string; x: number; y: number }> = [];
  for (const t of tasks) {
    if (!matches(t, q)) continue;
    const box = geometry.nodes.get(t.id);
    if (!box) continue;
    hits.push({ id: t.id, x: box.x, y: box.y });
  }

  hits.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  return hits.map((h) => h.id);
}

/** Step `current` by `dir`, wrapping at both ends. `total` must be >= 1. */
export function cycleIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0;
  return (current + dir + total) % total;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun run test -- treeFind`
Expected: PASS — 10 tests.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/webview/lib/treeFind.ts src/test/unit/treeFind.test.ts
git commit -m "Add pure tree-find core (match, spatial order, cycle)

- findMatches: id/title/description, matching the List tab's predicate
- Results ordered by geometry (band/x then lane/y), not array order
- cycleIndex: wraparound in both directions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: TreeNode match rings

**Files:**
- Modify: `src/webview/components/tree/TreeNode.svelte:7-30` (props), `:92-115` (class list), and its `<style>` block.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: two new optional `TreeNode` props — `matched?: boolean` and `currentMatch?: boolean` — which Task 4 passes. They render as CSS classes `find-match` and `find-current`.

This is a UI-only change with no logic to unit-test; its coverage is the e2e spec in Task 7 (project convention: UI-only changes are exempt from TDD, documented here as the reason).

- [ ] **Step 1: Add the props**

In `src/webview/components/tree/TreeNode.svelte`, extend the `Props` interface (after `hidden?: boolean;` on line 22):

```ts
    dimmed?: boolean;
    hidden?: boolean;
    /** Find (not filter): this node matches the active find query. */
    matched?: boolean;
    /** Find: this node is the CURRENT cycle target (Enter centered it). */
    currentMatch?: boolean;
```

And extend the destructure (line 27-30):

```ts
  let {
    task, x, y, w, h, lod, statuses, taskIdDisplay, selected, hovered,
    dimmed = false, hidden = false, matched = false, currentMatch = false,
    onSelect, onHover, onPromote,
  }: Props = $props();
```

- [ ] **Step 2: Add the classes to the node element**

In the `<div class="tree-node {statusClass}">` block, after `class:nav-hidden={hidden}` (line 103):

```svelte
  class:find-match={matched}
  class:find-current={currentMatch}
```

- [ ] **Step 3: Add the ring styling**

Append to `TreeNode.svelte`'s `<style>` block:

```css
  /*
   * Find rings (TASK: tree find bar). A match gets an accent ring; the CURRENT cycle
   * target gets a thicker, brighter one. `box-shadow` (not `border`/`outline`) so the
   * ring never changes the node's box and cannot reflow the canvas — and it composes
   * additively with the existing selected/hovered shadows rather than replacing them.
   */
  .tree-node.find-match {
    box-shadow: 0 0 0 2px var(--vscode-editor-findMatchHighlightBorder, var(--vscode-focusBorder));
  }

  .tree-node.find-current {
    box-shadow:
      0 0 0 3px var(--vscode-focusBorder),
      0 0 12px 2px var(--vscode-focusBorder);
    z-index: 3;
  }

  /*
   * A match always outranks the find-dim: while a find is active every non-match is in
   * `dimmedIds`, so a matched node must never also read as dimmed.
   */
  .tree-node.find-match.nav-dimmed {
    opacity: 1;
  }
```

- [ ] **Step 4: Build the webview and verify it compiles**

Run: `bun run compile:webview`
Expected: builds with no Svelte errors.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/tree/TreeNode.svelte
git commit -m "Add find-match and find-current ring styling to TreeNode

UI-only (no unit test; covered by the e2e find spec). Rings use box-shadow
so they never reflow the node box, and a match always outranks the find dim.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The find bar component

**Files:**
- Create: `src/webview/components/tree/TreeFindBar.svelte`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a component with props
  `{ query: string; matchCount: number; currentIndex: number; onQueryChange: (q: string) => void; onNext: () => void; onPrev: () => void; onClose: () => void; }`.
  It exposes a `focus()` method via `export function focus()` so Task 4 can focus it from the canvas. Its input carries `data-testid="tree-search-input"`; the bar root carries `data-testid="tree-find-bar"`; the counter carries `data-testid="tree-find-count"`.

- [ ] **Step 1: Write the component**

Create `src/webview/components/tree/TreeFindBar.svelte`:

```svelte
<script lang="ts">
  /**
   * Tree FIND bar (distinct from the navigator sidebar's FILTER). Highlights matches on
   * the canvas and walks them; Enter = next, Shift-Enter = previous, Escape = close.
   *
   * Enter deliberately does NOT open the node's popover — that would post
   * popoverActiveChanged and rewrite the ephemeral active task on every keypress.
   */
  interface Props {
    query: string;
    matchCount: number;
    /** 0-based index of the current cycle target; -1 when there is no match. */
    currentIndex: number;
    onQueryChange: (q: string) => void;
    onNext: () => void;
    onPrev: () => void;
    onClose: () => void;
  }
  let { query, matchCount, currentIndex, onQueryChange, onNext, onPrev, onClose }: Props =
    $props();

  let inputEl: HTMLInputElement | undefined = $state();

  /** Called by TechTreeCanvas when `/` or Ctrl/Cmd-F opens the bar. */
  export function focus() {
    inputEl?.focus();
    inputEl?.select();
  }

  const hasQuery = $derived(query.trim().length > 0);
  const counter = $derived(
    !hasQuery ? '' : matchCount === 0 ? 'No results' : `${currentIndex + 1} / ${matchCount}`
  );

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (matchCount === 0) return;
      if (e.shiftKey) onPrev();
      else onNext();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

<div class="tree-find-bar" data-testid="tree-find-bar">
  <svg
    class="find-icon"
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
  </svg>

  <input
    bind:this={inputEl}
    class="find-input"
    data-testid="tree-search-input"
    type="text"
    placeholder="Find task…"
    aria-label="Find task on the tree"
    value={query}
    oninput={(e) => onQueryChange((e.currentTarget as HTMLInputElement).value)}
    onkeydown={onKeydown}
  />

  <span class="find-count" data-testid="tree-find-count" class:empty={hasQuery && matchCount === 0}>
    {counter}
  </span>

  <button
    class="find-btn"
    data-testid="tree-find-prev"
    title="Previous match (Shift+Enter)"
    aria-label="Previous match"
    disabled={matchCount === 0}
    onclick={onPrev}
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>
  </button>

  <button
    class="find-btn"
    data-testid="tree-find-next"
    title="Next match (Enter)"
    aria-label="Next match"
    disabled={matchCount === 0}
    onclick={onNext}
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
  </button>

  <button
    class="find-btn"
    data-testid="tree-find-close"
    title="Close (Escape)"
    aria-label="Close find"
    onclick={onClose}
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
  </button>
</div>

<style>
  .tree-find-bar {
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 12;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    background: var(--vscode-editorWidget-background);
    box-shadow: 0 2px 8px var(--vscode-widget-shadow);
  }

  .find-icon {
    flex: 0 0 auto;
    color: var(--vscode-descriptionForeground);
  }

  .find-input {
    width: 200px;
    min-width: 0;
    padding: 2px 4px;
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: 12px;
  }

  .find-input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .find-count {
    flex: 0 0 auto;
    /* Reserve width so the bar does not jitter as the counter's digits change. */
    min-width: 62px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    white-space: nowrap;
  }

  .find-count.empty {
    color: var(--vscode-errorForeground);
  }

  .find-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
  }

  .find-btn:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .find-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
```

- [ ] **Step 2: Build the webview and verify it compiles**

Run: `bun run compile:webview`
Expected: builds with no Svelte errors.

- [ ] **Step 3: Lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/webview/components/tree/TreeFindBar.svelte
git commit -m "Add TreeFindBar component

Input + match counter + prev/next/close. Enter/Shift-Enter cycle,
Escape closes. Exposes focus() for the canvas's / and Ctrl-F bindings.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire find into the canvas

**Files:**
- Modify: `src/webview/components/tree/TechTreeCanvas.svelte` — imports (`:1-28`), state (after `:104`), `dimmedIds` (`:140-145`), the jump-task effect (`:184-196`), `onCanvasKeydown`, and the template (before `<AgeBandHeader>` at `:888`).

**Interfaces:**
- Consumes: `findMatches` / `cycleIndex` from `src/webview/lib/treeFind.ts` (Task 1); `TreeNode`'s `matched` / `currentMatch` props (Task 2); `TreeFindBar`'s props and its `focus()` method (Task 3).
- Produces: an exported `openFind()` function on the canvas — **no**, the canvas is not addressed by parent; instead it listens for its own key events. Task 5 only widens the *global* `/` handler's DOM selector, so it needs nothing exported from here.

- [ ] **Step 1: Add the imports**

In `TechTreeCanvas.svelte`, after the `ContextMenu` import (line 28):

```ts
import TreeFindBar from './TreeFindBar.svelte';
import { findMatches, cycleIndex } from '../../lib/treeFind';
```

- [ ] **Step 2: Add the find state and derivations**

After the `lod` derivation (line 104), add:

```ts
  // --- Find (NOT filter). The navigator's navSearch filter is separate and untouched;
  // find composes with it — a node the filter dimmed is not a find candidate.
  let findOpen = $state(false);
  let findQuery = $state('');
  let findIdx = $state(0);
  let findBar = $state<ReturnType<typeof TreeFindBar> | undefined>();

  /** Match ids in spatial (reading) order. Only nodes the navigator filter left visible. */
  const findResults = $derived.by(() => {
    if (!findOpen) return [] as string[];
    const candidates = layoutNodes.filter((t) => !fadedIds.has(t.id));
    return findMatches(candidates, findQuery, geometry);
  });
  const findMatchIds = $derived(new Set(findResults));
  const findActive = $derived(findOpen && findResults.length > 0);
  /** Clamped so a shrinking result set (as the user types) can never leave findIdx past the end. */
  const currentFindIdx = $derived(
    findResults.length === 0 ? -1 : Math.min(findIdx, findResults.length - 1)
  );
  const currentFindId = $derived(currentFindIdx >= 0 ? findResults[currentFindIdx] : null);
```

- [ ] **Step 3: Fold non-matches into the existing dim set**

Replace the `dimmedIds` derivation (lines 140-145) with:

```ts
  const dimmedIds = $derived.by(() => {
    const set = new Set<string>();
    // Navigator FILTER dim (unchanged).
    if (navSearch.trim() || navPriority) {
      for (const t of layoutNodes) if (!matchesFilter(t)) set.add(t.id);
    }
    // Find dim: with >=1 hit, every non-match fades back. A zero-result query dims
    // NOTHING — fading the whole board conveys nothing and just hides the map.
    if (findActive) {
      for (const t of layoutNodes) if (!findMatchIds.has(t.id)) set.add(t.id);
    }
    return set;
  });
```

- [ ] **Step 4: Extract `centerOn` and repoint the navigator jump at it**

Replace the jump-task effect (lines 183-196) with:

```ts
  /** Center the viewport on a node. Shared by the navigator jump and the find cycle. */
  function centerOn(taskId: string) {
    const box = geometry.nodes.get(taskId);
    if (!box || !viewportEl) return;
    setViewport({
      scale: vp.scale,
      tx: viewportEl.clientWidth / 2 - (box.x + box.width / 2) * vp.scale,
      ty: viewportEl.clientHeight / 2 - (box.y + box.height / 2) * vp.scale,
    });
  }

  // Jump to a specific task node when the navigator asks (nonce lets retrigger).
  let lastJumpTaskNonce = 0;
  $effect(() => {
    if (jumpTaskNonce === lastJumpTaskNonce) return;
    lastJumpTaskNonce = jumpTaskNonce;
    centerOn(jumpTaskId);
  });
```

- [ ] **Step 5: Add the find control functions**

Add near the other handlers (after `closeMilestone`, line 254):

```ts
  function openFind() {
    findOpen = true;
    // The bar renders on the next tick; focus after it exists.
    queueMicrotask(() => findBar?.focus());
  }

  function closeFind() {
    findOpen = false;
    findQuery = '';
    findIdx = 0;
    viewportEl?.focus();
  }

  function onFindQueryChange(q: string) {
    findQuery = q;
    findIdx = 0;
    // Center the first hit as the user types, so a query lands you somewhere immediately.
    const first = findMatches(
      layoutNodes.filter((t) => !fadedIds.has(t.id)),
      q,
      geometry
    )[0];
    if (first) centerOn(first);
  }

  function stepFind(dir: 1 | -1) {
    if (findResults.length === 0) return;
    findIdx = cycleIndex(currentFindIdx, findResults.length, dir);
    const id = findResults[findIdx];
    // Center only — deliberately NOT handleSelect(): opening the popover posts
    // popoverActiveChanged, which would rewrite the ephemeral active task on every Enter.
    if (id) centerOn(id);
  }
```

- [ ] **Step 6: Bind `/` and Ctrl/Cmd-F on the canvas**

At the top of the existing `onCanvasKeydown` function body, add:

```ts
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openFind();
      return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      openFind();
      return;
    }
```

- [ ] **Step 7: Render the bar and pass the node props**

In the template, immediately before `<AgeBandHeader` (line 888), add:

```svelte
      {#if findOpen}
        <TreeFindBar
          bind:this={findBar}
          query={findQuery}
          matchCount={findResults.length}
          currentIndex={currentFindIdx}
          onQueryChange={onFindQueryChange}
          onNext={() => stepFind(1)}
          onPrev={() => stepFind(-1)}
          onClose={closeFind}
        />
      {/if}
```

And in the `{#each layoutNodes ...}` block, add two props to `<TreeNode>` after `hidden={hiddenIds.has(task.id)}` (line 945):

```svelte
              matched={findMatchIds.has(task.id)}
              currentMatch={currentFindId === task.id}
```

- [ ] **Step 8: Build and verify it compiles**

Run: `bun run compile:webview && bun run typecheck`
Expected: both clean.

- [ ] **Step 9: Run the full unit suite to confirm nothing regressed**

Run: `ch run "bun run test"`
Expected: PASS, no new failures.

- [ ] **Step 10: Commit**

```bash
git add src/webview/components/tree/TechTreeCanvas.svelte
git commit -m "Wire the find bar into the tree canvas

- Find state + spatially-ordered results over filter-visible nodes
- Non-matches fold into the existing dimmedIds set (zero results dims nothing)
- centerOn() extracted from the navigator jump effect and shared with the cycle
- Enter centers but never opens the popover (would thrash the active task)
- / and Ctrl/Cmd-F open the bar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Widen the global `/` binding

**Files:**
- Modify: `src/webview/components/tasks/Tasks.svelte:446-451`

**Interfaces:**
- Consumes: the `data-testid="tree-search-input"` selector that Task 3's find bar exposes.
- Produces: nothing consumed by later tasks.

The global handler's `/` case currently targets `[data-testid="search-input"]`, which only `ListView` renders — so `/` is a **no-op on the Tree today**. Widen it to a union selector. The two never coexist: the find bar renders only on the Tree tab, `ListView` only on list/drafts/archived.

Note the canvas (Task 4) also binds `/` on itself. That fires only when a `.tree-node` or the viewport has focus; this global handler covers the case where focus is elsewhere on the page. Both call the same bar.

- [ ] **Step 1: Widen the `/` case**

Replace lines 446-451:

```ts
        case '/': {
          e.preventDefault();
          // The Tree's find bar and the List's search box never coexist (each renders only
          // on its own tab), so a union selector resolves to whichever is mounted.
          const searchInput = document.querySelector(
            '[data-testid="tree-search-input"], [data-testid="search-input"]'
          ) as HTMLInputElement | null;
          searchInput?.focus();
          break;
        }
```

- [ ] **Step 2: Add the Ctrl/Cmd-F binding**

The `/` case sits inside a `switch (e.key)` that is only reached for un-modified keys. Add `Ctrl/Cmd-F` alongside the existing `Ctrl/Cmd-N` block (after line 420, before the `if (createForm) return;` guard):

```ts
      // Find (Ctrl/Cmd-F). Handled before the single-key switch, alongside Ctrl/Cmd-N.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        const searchInput = document.querySelector(
          '[data-testid="tree-search-input"], [data-testid="search-input"]'
        ) as HTMLInputElement | null;
        searchInput?.focus();
        return;
      }
```

**Caveat to verify in Step 3:** if the Tree tab is active but the find bar is closed, no `tree-search-input` exists yet, so this global `Ctrl/Cmd-F` finds nothing. The canvas's own binding (Task 4, Step 6) handles the open-from-closed case when the canvas has focus. If the e2e test in Task 7 shows `Ctrl/Cmd-F` failing to open the bar from a cold page, make the canvas viewport focusable-on-mount (it is already `role="application"`; add `tabindex="-1"` and call `viewportEl.focus()` in the restore effect) rather than lifting find state into `Tasks.svelte`.

- [ ] **Step 3: Build, typecheck, and run the suite**

Run: `bun run compile:webview && bun run typecheck && ch run "bun run test"`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add src/webview/components/tasks/Tasks.svelte
git commit -m "Point / and Ctrl/Cmd-F at the tree find bar as well as the list search

The / binding targeted [data-testid=search-input], which only ListView
renders — making / a no-op on the Tree. Union selector; the two inputs
never coexist.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Unbind empty-canvas left-click from create-task

**Files:**
- Modify: `src/webview/components/tree/TechTreeCanvas.svelte:474-486` (the `p.kind === 'pan'` branch of `onPointerUp`)
- Modify: `e2e/tree-drag.spec.ts`, `e2e/tree-authoring.spec.ts`, `src/test/cdp/tree-authoring.test.ts` — repoint click-in-place assertions to right-click
- Modify: `CLAUDE.md` — correct the P3b bullet

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `onCreateInPlace` remains a prop and is still called by the Report-bug popover action and by drag-to-connect drop-on-empty; only the *plain click* caller goes away.

- [ ] **Step 1: Remove the click-to-create branch**

Replace lines 474-486 of `TechTreeCanvas.svelte`:

```ts
    if (p.kind === 'pan') {
      if (panning) {
        panning = false;
        persistNow();
      }
      // A plain left-click on empty canvas only dismisses/focuses — it deliberately does
      // NOT open the create form. Creating on click made it impossible to click the panel
      // to focus it without creating a task. Right-click (onContextMenu) is the create
      // path; it already infers lane/band from the click point via cellAt.
      else {
        closePopover();
        closeMilestone();
        contextMenu = null;
      }
      finishDrag();
      return;
    }
```

Note `onCreateInPlace` is still used by drag-to-connect drop-on-empty and the Report-bug action, so the prop and its import stay.

- [ ] **Step 2: Verify no other caller relied on the click path**

Run: `grep -rn "onCreateInPlace" src/webview/`
Expected: the prop declaration, the drag-to-connect drop-on-empty call, and the Report-bug call in `DetailPopover`'s handler — but **no** remaining plain-click call site.

- [ ] **Step 3: Repoint the existing click-in-place tests to right-click**

Find every assertion that a plain left-click on empty canvas opens the create form:

Run: `grep -rn "click-in-place\|clickInPlace" e2e/ src/test/`

For each, replace the left-click with a right-click that then activates the context menu's create item. In Playwright:

```ts
// BEFORE: a plain left-click on empty canvas opened the form.
// await viewport.click({ position: { x: 600, y: 400 } });

// AFTER: right-click opens the context menu, whose create item opens the form.
await viewport.click({ position: { x: 600, y: 400 }, button: 'right' });
await page.getByTestId('tree-context-create').click();
await expect(page.getByTestId('create-task-form')).toBeVisible();
```

**Do not delete these tests** — the lane/band inference they assert is still a real behavior; only its trigger moved. Confirm the context menu's create item's actual `data-testid` by reading `src/webview/components/tree/ContextMenu.svelte` before writing the selector.

- [ ] **Step 4: Add the negative assertion**

In `e2e/tree-drag.spec.ts`, add a test asserting the *new* behavior:

```ts
test('a plain left-click on empty canvas does not open the create form', async ({ page }) => {
  const viewport = page.getByTestId('tree-viewport');
  await viewport.click({ position: { x: 600, y: 400 } });
  await expect(page.getByTestId('create-task-form')).not.toBeVisible();
});
```

- [ ] **Step 5: Run the affected suites**

Run: `ch run "bun run test"` then `ch run "bun run test:playwright"`
Expected: PASS. The repointed click-in-place tests pass via right-click; the new negative test passes.

- [ ] **Step 6: Correct the CLAUDE.md claim**

In `CLAUDE.md`, the **Tech-tree drag surface (P3b)** bullet currently reads:

> drop on empty canvas opens the create form pre-linked (reuses P3a `createTask.linkTo`); a plain empty-canvas **click** opens the form with the clicked cell's lane/band inferred (click-in-place).

Replace the clause after the semicolon with:

> a **right-click** on empty canvas opens a context menu whose create action infers the clicked cell's lane/band (create-in-place). A plain **left-click** on empty canvas only dismisses popovers and focuses the canvas — it deliberately does not create (clicking to focus the panel must not author a task).

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/tree/TechTreeCanvas.svelte e2e/ src/test/ CLAUDE.md
git commit -m "Stop an empty-canvas left-click from creating a task

Clicking the tree to focus the panel authored a task. Left-click on empty
canvas now only dismisses popovers and focuses; right-click's context menu
remains the create path and still infers lane/band. Existing click-in-place
tests repointed to right-click (the inference is still real, its trigger moved).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: End-to-end coverage

**Files:**
- Create: `e2e/tree-find.spec.ts`

**Interfaces:**
- Consumes: `data-testid` hooks from Tasks 2–4: `tree-find-bar`, `tree-search-input`, `tree-find-count`, `tree-find-next`, `tree-find-prev`, `tree-find-close`, `tree-node-{id}`, `tree-viewport`, `tree-surface`.
- Produces: nothing.

Read an existing tree spec (`e2e/tree-canvas.spec.ts`) first to copy its fixture setup and task-injection helper — do not invent a new harness.

- [ ] **Step 1: Write the spec**

Create `e2e/tree-find.spec.ts`. Seed a board with at least three laid-out tasks in known lanes/bands so the spatial order is deterministic — e.g. `TASK-1 "Add login form"` (band 1, lane 1), `TASK-2 "Fix parser"` with description "the login parser", `TASK-3 "Unrelated"`.

Cover:

```ts
test('/ opens the find bar and focuses it', async ({ page }) => {
  await page.getByTestId('tree-viewport').click();      // focus the canvas
  await page.keyboard.press('/');
  await expect(page.getByTestId('tree-find-bar')).toBeVisible();
  await expect(page.getByTestId('tree-search-input')).toBeFocused();
});

test('Ctrl+F opens the find bar', async ({ page }) => {
  await page.getByTestId('tree-viewport').click();
  await page.keyboard.press('Control+f');
  await expect(page.getByTestId('tree-search-input')).toBeFocused();
});

test('typing rings matches, dims non-matches, and counts them', async ({ page }) => {
  // 'login' hits TASK-1 (title) and TASK-2 (description) but not TASK-3.
  await openFind(page, 'login');
  await expect(page.getByTestId('tree-node-TASK-1')).toHaveClass(/find-match/);
  await expect(page.getByTestId('tree-node-TASK-2')).toHaveClass(/find-match/);
  await expect(page.getByTestId('tree-node-TASK-3')).toHaveClass(/nav-dimmed/);
  await expect(page.getByTestId('tree-find-count')).toHaveText('1 / 2');
});

test('Enter advances the current match and re-centers the viewport', async ({ page }) => {
  await openFind(page, 'login');
  await expect(page.getByTestId('tree-node-TASK-1')).toHaveClass(/find-current/);
  const before = await surfaceTransform(page);   // read .tree-surface's style transform
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tree-node-TASK-2')).toHaveClass(/find-current/);
  await expect(page.getByTestId('tree-find-count')).toHaveText('2 / 2');
  expect(await surfaceTransform(page)).not.toBe(before);   // it panned
});

test('Enter past the last match wraps to the first', async ({ page }) => {
  await openFind(page, 'login');
  await page.keyboard.press('Enter');    // -> 2 / 2
  await page.keyboard.press('Enter');    // wrap -> 1 / 2
  await expect(page.getByTestId('tree-find-count')).toHaveText('1 / 2');
  await expect(page.getByTestId('tree-node-TASK-1')).toHaveClass(/find-current/);
});

test('Enter does not open a popover (would thrash the active task)', async ({ page }) => {
  await openFind(page, 'login');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tree-detail-popover')).not.toBeVisible();
  // And no popoverActiveChanged was posted:
  const posted = await page.evaluate(() => (window as any).__vscodeMessages ?? []);
  expect(posted.filter((m: any) => m.type === 'popoverActiveChanged')).toHaveLength(0);
});

test('a zero-result query dims nothing and reads No results', async ({ page }) => {
  await openFind(page, 'zzzznomatch');
  await expect(page.getByTestId('tree-find-count')).toHaveText('No results');
  await expect(page.getByTestId('tree-node-TASK-1')).not.toHaveClass(/nav-dimmed/);
  await expect(page.getByTestId('tree-node-TASK-3')).not.toHaveClass(/nav-dimmed/);
});

test('Escape clears the query, the highlight, and the dim', async ({ page }) => {
  await openFind(page, 'login');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tree-find-bar')).not.toBeVisible();
  await expect(page.getByTestId('tree-node-TASK-1')).not.toHaveClass(/find-match/);
  await expect(page.getByTestId('tree-node-TASK-3')).not.toHaveClass(/nav-dimmed/);
});
```

Confirm the popover's actual `data-testid` (`tree-detail-popover` above is a guess) by reading `DetailPopover.svelte`, and confirm how the fixture captures posted messages by reading `e2e/fixtures/vscode-mock.ts` — the `__vscodeMessages` handle above must match whatever that mock actually exposes.

- [ ] **Step 2: Run the spec and verify it passes**

Run: `ch run "bun run test:playwright -- tree-find"`
Expected: PASS, all 7 tests.

- [ ] **Step 3: Full verification**

Run: `ch run "bun run test && bun run lint && bun run typecheck"`
Expected: all three clean, no regressions.

- [ ] **Step 4: Commit**

```bash
git add e2e/tree-find.spec.ts
git commit -m "Add e2e coverage for the tree find bar

Highlight, dim, spatial cycle order, wraparound, no-popover-on-Enter,
zero-result behavior, and Escape teardown.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Visual proof

**Files:**
- Create: proof doc under `docs/` per the `visual-proof` skill's convention.

The find bar's highlight, current-match ring, and dim treatment are all *visual* claims. A passing e2e test proves the classes are applied; it does not prove the result is legible.

- [ ] **Step 1: Invoke the visual-proof skill**

Load `.claude/skills/visual-proof/SKILL.md` and follow it. Capture, at minimum:
1. The find bar open with a multi-hit query — showing rings on matches and the dim on non-matches.
2. The current-match ring distinguishable from a plain match ring.
3. The zero-result state ("No results", nothing dimmed).
4. The same three in both a light and a dark theme (the rings lean on `--vscode-focusBorder`, which differs sharply between themes).

- [ ] **Step 2: Commit the proof doc**

```bash
git add docs/
git commit -m "Add visual proof for the tree find bar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| Pure core `treeFind.ts`, match on id+title+description | 1 |
| Spatial (band-then-lane) result ordering | 1 |
| `cycleIndex` wraparound | 1 |
| Accent ring on matches; stronger ring on current | 2 |
| `TreeFindBar.svelte` — input, counter, prev/next/close | 3 |
| Canvas state; non-matches folded into `dimmedIds` | 4 |
| Zero results dims nothing, reads "No results" | 4 (logic), 7 (test) |
| `centerOn()` extracted and shared with the navigator jump | 4 |
| Enter/Shift-Enter cycle + center; Enter never opens the popover | 3 (keys), 4 (`stepFind`), 7 (test) |
| Escape closes and clears | 3, 4, 7 |
| `/` and `Ctrl/Cmd-F` open the bar | 4 (canvas), 5 (global) |
| Empty-canvas left-click no longer creates | 6 |
| Right-click remains the create path | 6 (unchanged code; tests repointed) |
| Existing click-in-place tests updated, not deleted | 6 |
| CLAUDE.md P3b bullet corrected | 6 |
| E2E coverage | 7 |
| Visual proof | 8 |

Full coverage; no gaps.

**Type consistency:** `findMatches(tasks, query, geometry)` and `cycleIndex(current, total, dir)` are defined in Task 1 and called with those exact signatures in Task 4. `TreeNode`'s `matched` / `currentMatch` are declared in Task 2 and passed in Task 4, Step 7. `TreeFindBar`'s seven props and its `focus()` method are declared in Task 3 and all bound in Task 4, Step 7. The `data-testid` values in Task 7 match those declared in Tasks 2–4.

**Known unknowns, flagged inline rather than papered over:** Task 5 Step 2 flags that a cold-page `Ctrl/Cmd-F` may not reach a not-yet-mounted find bar, with the concrete remedy. Task 7 flags that the popover `data-testid` and the message-capture handle must be confirmed against `DetailPopover.svelte` and `e2e/fixtures/vscode-mock.ts` rather than assumed.
