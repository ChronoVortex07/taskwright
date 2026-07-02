# Tech-tree P2a — Canvas Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the **tech-tree canvas** as the new default board tab: a full-bleed, pannable/zoomable surface that renders P1's per-task `layout {lane,band,depth,subRow}` spatially — status-colored HTML nodes positioned by CSS transform, dependency edges on an SVG overlay beneath the nodes, level-of-detail as you zoom, and a −/%/+/fit toolbar. Kanban/list/dashboard stay as untouched alternate tabs on the same `TasksController` data bus.

**Scope boundary (P2a only).** This plan covers spec §3 (canvas surface), §4 (spatial model), §5 (node rendering), §6 (edges), §11 (pan/zoom), §13 (architecture), and §15 draft-node **rendering** only. It **excludes** (all P2b/P3): the detail popover, click-to-set-active, navigator/minimap, in-flight panel, milestone popover, details-page rework, and any create/edit/drag-to-connect gestures. A node click may only `selectTask` (the existing message). No new MCP tools, no `package.json`/`vite.webview.config.ts` entries (the canvas rides the existing `tasks.js` bundle).

**Architecture:** A pure, unit-tested geometry core (`src/webview/lib/treeGeometry.ts`, no DOM) maps `layout × cell-size constants → pixels`, computes band/lane ranges, edge endpoints, fit/clamp/zoom math, and LOD thresholds. The controller surfaces the board's `laneOrder`/`bandOrder`/`warnings` in one **locked** outbound message `treeLayoutUpdated`; per-task `layout` already rides on `tasksUpdated`. Svelte 5 components (`TechTreeCanvas` + `TreeNode` + `EdgeLayer` + `AgeBandHeader` + `LaneBand`) render inside `Tasks.svelte` behind a new `'tree'` tab.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest (pure cores + host-agnostic controller), Playwright (canvas interactions), esbuild/Vite bundles, VS Code webview CSP (same-origin, no inline scripts).

## Where this fits (the P2 decomposition)

P2 was split by the orchestrator into two independently-shippable plans:

1. **P2a — canvas core (this plan):** the tree tab + layout bus + canvas/node/edge rendering + pan/zoom.
2. **P2b — interaction shell:** detail popover, ephemeral-active, cancel-dispatch, navigator sidebar, filter dimming/lane collapse, in-flight panel, milestone popover, details-page rework, promote actions, CDP cross-view tests.

Message names that P2b reuses are **locked** here (`treeLayoutUpdated`). Do not start P2b work in this plan.

## Global Constraints

_Every task's requirements implicitly include this section._

- **Worktree:** work in `.worktrees/tech-tree-p2a` on branch `tech-tree-p2a`. Run all git/file/test commands inside the worktree; a fresh worktree has no `node_modules`, so `bun install` there once before building/testing. Never commit/merge from the repo root.
- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`).
- **Pure-core purity:** `src/webview/lib/treeGeometry.ts` is **DOM-free and framework-free** — only `import type { TreeLayout }` from core. All sizing/zoom constants live in this one file. TDD it (failing test first).
- **TDD where a pure core or controller message exists** (`treeGeometry`, `treeDerived` additions, `TasksController` emission/default-tab): write the failing Vitest first, run red, implement, run green, commit. Svelte components are UI; cover their behavior with **Playwright** (REQUIRED per repo convention for canvas pan/zoom/DOM-order interactions) and document the house UI-only exception in the commit for pure-markup steps.
- **Message name is LOCKED:** the outbound message is exactly `treeLayoutUpdated { laneOrder: string[], bandOrder: string[], warnings: string[] }`. Per-task `layout` and the P1 derived fields (`locked`/`blockedBy`/`bugs`/`activeBugIds`) already ride on `tasksUpdated` enrichment — do **not** add a second per-task layout message.
- **Rendering discipline:** HTML nodes positioned by a single outer CSS `transform: translate(...) scale(...)` on one clipped surface; SVG edge overlay sized to the surface and painted **beneath** the nodes. Lucide **inline SVG** only (no emojis); every color/border via `--vscode-*` tokens so all themes work. Reactive `style="..."` attributes and standard Svelte `on*` event attributes are CSP-safe (Svelte applies them via DOM APIs at runtime); **no** inline `<script>`, no string-built event handlers.
- **Svelte 5 runes** (`$state`/`$derived`/`$props`/`$effect`); follow existing component patterns; run the `svelte-autofixer` MCP over each new component until clean before committing.
- **Do not break** the kanban/list/dashboard/drafts/archived/docs/decisions tabs or their tests. Baseline green before starting: **1339 passed / 1 skipped** on `bun run test` (Windows shows ~22 known upstream POSIX-path failures — unrelated, do not "fix"). New tree suites add to this count; confirm no previously-green test regresses.
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (workers substitute their own model line per `AGENTS.md`).

---

## File Structure

**Create:**

- `src/webview/lib/treeGeometry.ts` — pure geometry core (constants, layout→px, band/lane ranges, edge endpoints, fit/clamp/zoom, LOD).
- `src/test/unit/treeGeometry.test.ts` — geometry unit tests.
- `src/webview/components/tree/TechTreeCanvas.svelte` — viewport/surface, pan/zoom, toolbar, persistence, fallback empty-state.
- `src/webview/components/tree/TreeNode.svelte` — a node card with LOD tiers + state styles.
- `src/webview/components/tree/EdgeLayer.svelte` — SVG edge overlay (prereq + bug-reference edges, hover highlight).
- `src/webview/components/tree/AgeBandHeader.svelte` — sticky age-band labels (presentation).
- `src/webview/components/tree/LaneBand.svelte` — sticky lane labels/separators (presentation).
- `e2e/tree-canvas.spec.ts` — Playwright canvas suite.

**Modify:**

- `src/core/treeDerived.ts` — add `deriveTreeBoard` + `loadTreeBoardFromParser` (return `{states,laneOrder,bandOrder,warnings}`); refactor the existing `deriveTreeState`/`loadTreeStateFromParser` to delegate (no signature change for existing callers).
- `src/core/types.ts` — add `'tree'` to the `setViewMode` mode union and the `activeTabChanged` tab union; add the `treeLayoutUpdated` variant to `ExtensionMessage`.
- `src/providers/TasksController.ts` — add `'tree'` to `TasksViewMode`; emit `treeLayoutUpdated`; default persisted tab → `'tree'`; gate the legacy `viewModeChanged` off for tree.
- `src/webview/lib/types.ts` — add `'tree'` to `TabMode`; re-export `TreeLayout`.
- `src/webview/components/shared/TabBar.svelte` — add the `tree` primary tab (first) + Lucide icon.
- `src/webview/components/tasks/Tasks.svelte` — tree state, `treeLayoutUpdated` case, tree render branch, import `TechTreeCanvas`.
- `src/test/unit/treeDerived.test.ts` — tests for `deriveTreeBoard`.
- `src/test/unit/TasksController.test.ts` — `getCategories` mock + tree emission/default-tab tests.
- `e2e/tasks.spec.ts` — update the "only 3 primary tabs" assertion to 4 (tree/kanban/list/dashboard).

---

## Task 1: `treeGeometry` pure core + tests

**Files:**

- Create: `src/webview/lib/treeGeometry.ts`
- Test: `src/test/unit/treeGeometry.test.ts`

**Interfaces:**

- Consumes: `import type { TreeLayout } from '../../core/treeLayout'`.
- Produces: sizing constants; `GeometryNode`, `NodeBox`, `LaneRange`, `BandRange`, `Point`, `Viewport`, `LodTier`, `TreeGeometry`; functions `deriveGeometry`, `edgeAnchors`, `bezierPath`, `lodTier`, `clampScale`, `fitToView`, `zoomAt`, `clampViewport`.

**Spatial model (matches P1 `deriveTreeLayout`):** lanes are horizontal strips stacked in `laneOrder`; each lane's height = its max `subRow + 1`. Bands are vertical column-groups laid out left→right in `bandOrder`; each band's column-count = its max `depth + 1`. A node's X = its band's left offset + `depth × COL_STRIDE`; Y = its lane's top offset + `subRow × ROW_STRIDE`. Bug nodes carry `band: ''` (P1 stacks them by `subRow` in the Bugs lane) → they anchor at the leftmost column (`CANVAS_PAD`).

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/treeGeometry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { TreeLayout } from '../../core/treeLayout';
import {
  NODE_WIDTH,
  NODE_HEIGHT,
  COL_STRIDE,
  ROW_STRIDE,
  CANVAS_PAD,
  LANE_PAD,
  MIN_SCALE,
  MAX_SCALE,
  lodTier,
  clampScale,
  deriveGeometry,
  edgeAnchors,
  bezierPath,
  fitToView,
  zoomAt,
  clampViewport,
  type GeometryNode,
} from '../../webview/lib/treeGeometry';

const node = (id: string, layout: TreeLayout): GeometryNode => ({ id, layout });

describe('treeGeometry — LOD thresholds', () => {
  it('near ≥ 0.75, mid ≥ 0.4, far < 0.4', () => {
    expect(lodTier(2)).toBe('near');
    expect(lodTier(0.75)).toBe('near');
    expect(lodTier(0.74)).toBe('mid');
    expect(lodTier(0.4)).toBe('mid');
    expect(lodTier(0.39)).toBe('far');
    expect(lodTier(0.2)).toBe('far');
  });
});

describe('treeGeometry — clampScale', () => {
  it('clamps to [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(10)).toBe(MAX_SCALE);
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(1)).toBe(1);
  });
});

describe('treeGeometry — deriveGeometry', () => {
  const laneOrder = ['Features', 'Misc', 'Bugs'];
  const bandOrder = ['v1', 'Backburner'];
  // Features lane: two depths in band v1, one branch (subRows 0 and 1).
  const nodes: GeometryNode[] = [
    node('A', { lane: 'Features', band: 'v1', depth: 0, subRow: 0 }),
    node('B', { lane: 'Features', band: 'v1', depth: 1, subRow: 0 }),
    node('C', { lane: 'Features', band: 'v1', depth: 1, subRow: 1 }),
    node('M', { lane: 'Misc', band: 'Backburner', depth: 0, subRow: 0 }),
    node('BUG', { lane: 'Bugs', band: '', depth: 0, subRow: 0 }),
  ];

  it('positions nodes from lane/band/depth/subRow and cell strides', () => {
    const g = deriveGeometry(nodes, laneOrder, bandOrder);
    const a = g.nodes.get('A')!;
    const b = g.nodes.get('B')!;
    const c = g.nodes.get('C')!;
    // A at band v1 column 0, Features lane row 0.
    expect(a.x).toBe(CANVAS_PAD);
    expect(a.y).toBe(CANVAS_PAD + LANE_PAD);
    // B one depth to the right of A.
    expect(b.x).toBe(a.x + COL_STRIDE);
    // C is B's sibling sub-row: same x, one row down.
    expect(c.x).toBe(b.x);
    expect(c.y).toBe(a.y + ROW_STRIDE);
    // node dimensions
    expect(a.width).toBe(NODE_WIDTH);
    expect(a.height).toBe(NODE_HEIGHT);
  });

  it('lays lanes top→down in laneOrder, skipping empty lanes', () => {
    const g = deriveGeometry(nodes, laneOrder, bandOrder);
    expect(g.lanes.map((l) => l.name)).toEqual(['Features', 'Misc', 'Bugs']);
    // lanes are vertically stacked, non-overlapping
    for (let i = 1; i < g.lanes.length; i++) {
      expect(g.lanes[i].y).toBeGreaterThanOrEqual(g.lanes[i - 1].y + g.lanes[i - 1].height);
    }
  });

  it('lays bands left→right in bandOrder, skipping bands with no nodes', () => {
    const g = deriveGeometry(nodes, laneOrder, bandOrder);
    // both v1 and Backburner have nodes here
    expect(g.bands.map((bnd) => bnd.name)).toEqual(['v1', 'Backburner']);
    expect(g.bands[1].x).toBeGreaterThan(g.bands[0].x + g.bands[0].width - 1);
  });

  it('anchors band-less bug nodes at the leftmost column', () => {
    const g = deriveGeometry(nodes, laneOrder, bandOrder);
    expect(g.nodes.get('BUG')!.x).toBe(CANVAS_PAD);
  });

  it('reports a positive content width/height', () => {
    const g = deriveGeometry(nodes, laneOrder, bandOrder);
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
  });

  it('is empty-safe', () => {
    const g = deriveGeometry([], [], []);
    expect(g.nodes.size).toBe(0);
    expect(g.lanes).toEqual([]);
    expect(g.bands).toEqual([]);
  });
});

describe('treeGeometry — edges', () => {
  it('anchors from source right-center to target left-center', () => {
    const src = { x: 0, y: 0, width: 200, height: 100 };
    const tgt = { x: 400, y: 200, width: 200, height: 100 };
    const { from, to } = edgeAnchors(src, tgt);
    expect(from).toEqual({ x: 200, y: 50 });
    expect(to).toEqual({ x: 400, y: 250 });
  });

  it('builds a cubic bezier path string', () => {
    const d = bezierPath({ x: 0, y: 0 }, { x: 100, y: 50 });
    expect(d.startsWith('M 0 0 C ')).toBe(true);
    expect(d).toContain('100 50');
  });
});

describe('treeGeometry — viewport math', () => {
  it('fitToView centers content and never scales above 1', () => {
    const vp = fitToView(100, 100, 1000, 1000, 0);
    expect(vp.scale).toBe(1); // content smaller than viewport → capped at 1
    expect(vp.tx).toBe(450);
    expect(vp.ty).toBe(450);
  });

  it('fitToView scales down large content to fit and clamps to MIN_SCALE', () => {
    const vp = fitToView(100000, 100000, 500, 500, 0);
    expect(vp.scale).toBe(MIN_SCALE);
  });

  it('zoomAt keeps the world point under the cursor fixed', () => {
    const start = { scale: 1, tx: 0, ty: 0 };
    const cx = 300;
    const cy = 200;
    const worldBefore = { x: (cx - start.tx) / start.scale, y: (cy - start.ty) / start.scale };
    const after = zoomAt(start, cx, cy, 1.5);
    const worldAfter = { x: (cx - after.tx) / after.scale, y: (cy - after.ty) / after.scale };
    expect(after.scale).toBeCloseTo(1.5, 5);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 5);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 5);
  });

  it('clampViewport centers content smaller than the viewport', () => {
    const vp = clampViewport({ scale: 1, tx: 9999, ty: -9999 }, 200, 200, 1000, 1000, 80);
    expect(vp.tx).toBe(400);
    expect(vp.ty).toBe(400);
  });

  it('clampViewport bounds panning of content larger than the viewport', () => {
    const vp = clampViewport({ scale: 1, tx: 5000, ty: 5000 }, 4000, 4000, 800, 800, 80);
    expect(vp.tx).toBeLessThanOrEqual(80);
    expect(vp.ty).toBeLessThanOrEqual(80);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- treeGeometry`
Expected: FAIL — cannot resolve `../../webview/lib/treeGeometry` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/webview/lib/treeGeometry.ts`:

```ts
import type { TreeLayout } from '../../core/treeLayout';

/* ------------------------------------------------------------------ *
 * Sizing constants — the single source of truth for canvas geometry. *
 * ------------------------------------------------------------------ */
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 92;
/** Horizontal gap between depth columns within a band. */
export const COL_GAP = 56;
/** Vertical gap between sub-rows within a lane. */
export const ROW_GAP = 18;
/** Vertical padding inside a lane strip (top and bottom each). */
export const LANE_PAD = 16;
/** Extra horizontal gap between adjacent age bands. */
export const BAND_GAP = 48;
/** Outer padding around all content. */
export const CANVAS_PAD = 48;

/** Distance from one column's left edge to the next column's left edge. */
export const COL_STRIDE = NODE_WIDTH + COL_GAP;
/** Distance from one sub-row's top to the next sub-row's top. */
export const ROW_STRIDE = NODE_HEIGHT + ROW_GAP;

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 2;

/* Level-of-detail thresholds (spec §5): near ≥ 0.75, mid ≥ 0.4, far < 0.4. */
export const LOD_NEAR = 0.75;
export const LOD_MID = 0.4;

export type LodTier = 'near' | 'mid' | 'far';

export interface GeometryNode {
  id: string;
  layout: TreeLayout;
}

export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaneRange {
  name: string;
  y: number;
  height: number;
  rows: number;
}

export interface BandRange {
  name: string;
  x: number;
  width: number;
  cols: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

export interface TreeGeometry {
  nodes: Map<string, NodeBox>;
  lanes: LaneRange[];
  bands: BandRange[];
  width: number;
  height: number;
}

export function lodTier(scale: number): LodTier {
  if (scale >= LOD_NEAR) return 'near';
  if (scale >= LOD_MID) return 'mid';
  return 'far';
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Map P1 layout → absolute pixel boxes, plus lane (row-strip) and band
 * (column-group) ranges. Lanes/bands with no nodes reserve no space. Bug nodes
 * (`band: ''`) anchor at the leftmost column.
 */
export function deriveGeometry(
  nodes: GeometryNode[],
  laneOrder: string[],
  bandOrder: string[]
): TreeGeometry {
  const bandCols = new Map<string, number>();
  const laneRows = new Map<string, number>();
  for (const n of nodes) {
    const { band, lane, depth, subRow } = n.layout;
    if (band) bandCols.set(band, Math.max(bandCols.get(band) ?? 0, depth + 1));
    laneRows.set(lane, Math.max(laneRows.get(lane) ?? 0, subRow + 1));
  }

  const bands: BandRange[] = [];
  const bandX = new Map<string, number>();
  let x = CANVAS_PAD;
  for (const name of bandOrder) {
    const cols = bandCols.get(name) ?? 0;
    if (cols === 0) continue;
    const width = cols * COL_STRIDE - COL_GAP; // trim the trailing inter-column gap
    bands.push({ name, x, width, cols });
    bandX.set(name, x);
    x += width + BAND_GAP;
  }
  const width = bands.length > 0 ? x - BAND_GAP + CANVAS_PAD : CANVAS_PAD * 2;

  const lanes: LaneRange[] = [];
  const laneTop = new Map<string, number>(); // y of first node row in the lane
  let y = CANVAS_PAD;
  for (const name of laneOrder) {
    const rows = laneRows.get(name) ?? 0;
    if (rows === 0) continue;
    const height = rows * ROW_STRIDE - ROW_GAP + LANE_PAD * 2;
    lanes.push({ name, y, height, rows });
    laneTop.set(name, y + LANE_PAD);
    y += height;
  }
  const height = lanes.length > 0 ? y + CANVAS_PAD : CANVAS_PAD * 2;

  const boxes = new Map<string, NodeBox>();
  for (const n of nodes) {
    const { band, lane, depth, subRow } = n.layout;
    const bx = band && bandX.has(band) ? bandX.get(band)! : CANVAS_PAD;
    const ly = laneTop.get(lane) ?? CANVAS_PAD;
    boxes.set(n.id, {
      x: bx + depth * COL_STRIDE,
      y: ly + subRow * ROW_STRIDE,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  }

  return { nodes: boxes, lanes, bands, width, height };
}

/** Prereq→dependent edge anchors: source right-center → target left-center. */
export function edgeAnchors(source: NodeBox, target: NodeBox): { from: Point; to: Point } {
  return {
    from: { x: source.x + source.width, y: source.y + source.height / 2 },
    to: { x: target.x, y: target.y + target.height / 2 },
  };
}

/** A horizontal cubic bezier between two anchor points. */
export function bezierPath(from: Point, to: Point): string {
  const dx = Math.max(COL_GAP, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/** Center content in the viewport at a scale that fits, never above 1x. */
export function fitToView(
  contentW: number,
  contentH: number,
  viewportW: number,
  viewportH: number,
  pad = 24
): Viewport {
  if (contentW <= 0 || contentH <= 0 || viewportW <= 0 || viewportH <= 0) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const scale = clampScale(
    Math.min((viewportW - pad * 2) / contentW, (viewportH - pad * 2) / contentH, 1)
  );
  return {
    scale,
    tx: (viewportW - contentW * scale) / 2,
    ty: (viewportH - contentH * scale) / 2,
  };
}

/** Zoom by `factor` while keeping the world point under (cursorX, cursorY) fixed. */
export function zoomAt(vp: Viewport, cursorX: number, cursorY: number, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor);
  const worldX = (cursorX - vp.tx) / vp.scale;
  const worldY = (cursorY - vp.ty) / vp.scale;
  return { scale, tx: cursorX - worldX * scale, ty: cursorY - worldY * scale };
}

/**
 * Keep the surface within reach: content smaller than the viewport is centered;
 * larger content may pan but not drift entirely off-screen (leaves `margin` px).
 */
export function clampViewport(
  vp: Viewport,
  contentW: number,
  contentH: number,
  viewportW: number,
  viewportH: number,
  margin = 80
): Viewport {
  const scaledW = contentW * vp.scale;
  const scaledH = contentH * vp.scale;
  const clamp = (v: number, lo: number, hi: number) =>
    lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
  return {
    scale: vp.scale,
    tx: clamp(vp.tx, viewportW - scaledW - margin, margin),
    ty: clamp(vp.ty, viewportH - scaledH - margin, margin),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- treeGeometry`
Expected: PASS (all `treeGeometry` describes green).

- [ ] **Step 5: Commit**

```bash
git add src/webview/lib/treeGeometry.ts src/test/unit/treeGeometry.test.ts
git commit -m "feat(tree): pure treeGeometry core (layout→px, edges, fit/zoom, LOD)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Controller — `'tree'` view mode, `treeLayoutUpdated` emission, default-tab logic

**Files:**

- Modify: `src/core/treeDerived.ts`, `src/core/types.ts`, `src/providers/TasksController.ts`
- Test: `src/test/unit/treeDerived.test.ts`, `src/test/unit/TasksController.test.ts`

**Interfaces:**

- `treeDerived.ts` produces `TreeBoard { states; laneOrder; bandOrder; warnings }`, `deriveTreeBoard(tasks, opts): TreeBoard`, `loadTreeBoardFromParser(parser): Promise<TreeBoard>`. Existing `deriveTreeState`/`loadTreeStateFromParser` keep their signatures and delegate to the new pair (returning `.states`), so `mcp/handlers.ts`, `claimActions.ts`, `dispatchActions.ts` are untouched.
- `types.ts`: `setViewMode.mode` and `activeTabChanged.tab` unions gain `'tree'`; `ExtensionMessage` gains `{ type: 'treeLayoutUpdated'; laneOrder: string[]; bandOrder: string[]; warnings: string[] }`.
- `TasksController`: `TasksViewMode` gains `'tree'`; `refresh()` emits `treeLayoutUpdated` immediately after `tasksUpdated`; `loadPersistedState()` defaults to `'tree'` when nothing is persisted (respects a persisted `'kanban'`).

- [ ] **Step 1: Write the failing tests**

Append to `src/test/unit/treeDerived.test.ts`:

```ts
import { deriveTreeBoard } from '../../core/treeDerived';

describe('deriveTreeBoard', () => {
  it('returns states plus laneOrder/bandOrder/warnings', () => {
    const tasks = [
      task({ id: 'TASK-1', category: 'Features', milestone: 'v1', status: 'Done' }),
      task({ id: 'TASK-2', category: 'Features', milestone: 'v1', dependencies: ['TASK-1'] }),
      task({ id: 'TASK-3', type: 'bug', causedBy: 'TASK-1' }),
    ];
    const board = deriveTreeBoard(tasks, {
      doneStatus: 'Done',
      milestoneOrder: ['v1'],
      priorities: ['high', 'medium', 'low'],
      categories: ['Features'],
    });
    // Misc + Bugs are always the last two lanes; declared "Features" leads.
    expect(board.laneOrder).toEqual(['Features', 'Misc', 'Bugs']);
    // Backburner is always the rightmost band.
    expect(board.bandOrder[board.bandOrder.length - 1]).toBe('Backburner');
    expect(board.bandOrder).toContain('v1');
    // states carry the same layout the legacy map exposes.
    expect(board.states.get('TASK-2')!.layout.depth).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(board.warnings)).toBe(true);
  });

  it('deriveTreeState still returns just the states map (delegation intact)', () => {
    const s = deriveTreeState([task({ id: 'TASK-1' })], opts);
    expect(s.get('TASK-1')!.layout.lane).toBeDefined();
  });
});
```

Append to `src/test/unit/TasksController.test.ts` — first extend the `mockParser` in `beforeEach` with the categories reader the tree loader needs:

```ts
// add inside the beforeEach mockParser object:
getCategories: vi.fn().mockResolvedValue([]),
```

Then add a describe block:

```ts
describe('TasksController — tree tab', () => {
  function treeTasks(): Task[] {
    return [
      {
        id: 'TASK-1',
        title: 'Root',
        status: 'Done',
        category: 'Features',
        milestone: 'v1',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-1.md',
      } as Task,
      {
        id: 'TASK-2',
        title: 'Child',
        status: 'To Do',
        category: 'Features',
        milestone: 'v1',
        labels: [],
        assignee: [],
        dependencies: ['TASK-1'],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-2.md',
      } as Task,
    ];
  }

  beforeEach(() => {
    (mockParser.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue(treeTasks());
    (mockParser.getCategories as ReturnType<typeof vi.fn>).mockResolvedValue(['Features']);
    (mockParser.getMilestones as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'v1', name: 'v1' },
    ]);
  });

  it('emits treeLayoutUpdated immediately after tasksUpdated', async () => {
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.refresh();
    const types = postedTypes();
    const tasksIdx = types.indexOf('tasksUpdated');
    const treeIdx = types.indexOf('treeLayoutUpdated');
    expect(tasksIdx).toBeGreaterThanOrEqual(0);
    expect(treeIdx).toBe(tasksIdx + 1);
    const msg = posted[treeIdx] as Extract<ExtensionMessage, { type: 'treeLayoutUpdated' }>;
    expect(msg.laneOrder).toEqual(['Features', 'Misc', 'Bugs']);
    expect(msg.bandOrder[msg.bandOrder.length - 1]).toBe('Backburner');
    expect(Array.isArray(msg.warnings)).toBe(true);
  });

  it('defaults the persisted view mode to tree when nothing is stored', async () => {
    const controller = new TasksController(host, mockParser, mockContext);
    controller.loadPersistedState();
    await controller.refresh();
    expect(posted).toContainEqual({ type: 'activeTabChanged', tab: 'tree' });
  });

  it('respects a persisted kanban choice (default only applies when unset)', async () => {
    await mockContext.globalState.update('backlog.viewMode', 'kanban');
    const controller = new TasksController(host, mockParser, mockContext);
    controller.loadPersistedState();
    await controller.refresh();
    expect(posted).toContainEqual({ type: 'activeTabChanged', tab: 'kanban' });
    expect(posted).not.toContainEqual({ type: 'activeTabChanged', tab: 'tree' });
  });

  it('setViewMode(tree) posts activeTabChanged tree and no legacy viewModeChanged', () => {
    const controller = new TasksController(host, mockParser, mockContext);
    controller.setViewMode('tree');
    expect(posted).toContainEqual({ type: 'activeTabChanged', tab: 'tree' });
    expect(posted.some((m) => m.type === 'viewModeChanged')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- treeDerived TasksController`
Expected: FAIL — `deriveTreeBoard` not exported; `treeLayoutUpdated` not a valid `ExtensionMessage`; default is `kanban`; `setViewMode('tree')` not typeable.

- [ ] **Step 3: Implement — `treeDerived.ts`**

Refactor `src/core/treeDerived.ts` so the body of `deriveTreeState` moves into a new `deriveTreeBoard` that also returns the layout metadata, and both public loaders delegate:

```ts
/** The full board derivation: per-task state plus the lane/band vocabulary + warnings. */
export interface TreeBoard {
  states: Map<string, TreeDerivedState>;
  laneOrder: string[];
  bandOrder: string[];
  warnings: string[];
}

export function deriveTreeBoard(tasks: Task[], opts: DeriveTreeStateOptions): TreeBoard {
  const byId = new Map<string, Task>(tasks.map((t) => [t.id.trim().toUpperCase(), t]));
  const { layout, laneOrder, bandOrder, warnings } = deriveTreeLayout(tasks, {
    categories: opts.categories,
    milestoneOrder: opts.milestoneOrder,
    doneStatus: opts.doneStatus,
    priorities: opts.priorities,
  });

  const bugsByCause = new Map<string, string[]>();
  const activeByCause = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.type !== 'bug') continue;
    const cause = t.causedBy?.trim().toUpperCase();
    if (!cause) continue;
    (bugsByCause.get(cause) ?? bugsByCause.set(cause, []).get(cause)!).push(t.id);
    const active =
      t.status !== opts.doneStatus && t.folder !== 'completed' && t.folder !== 'archive';
    if (active) (activeByCause.get(cause) ?? activeByCause.set(cause, []).get(cause)!).push(t.id);
  }

  const states = new Map<string, TreeDerivedState>();
  for (const t of tasks) {
    const key = t.id.trim().toUpperCase();
    const blockedBy = computeBlockedBy(t, byId, opts.doneStatus);
    states.set(key, {
      locked: blockedBy.length > 0,
      blockedBy,
      bugs: bugsByCause.get(key) ?? [],
      activeBugIds: activeByCause.get(key) ?? [],
      layout: layout.get(t.id) ?? { lane: laneOf(t), band: BACKBURNER_BAND, depth: 0, subRow: 0 },
    });
  }
  return { states, laneOrder, bandOrder, warnings };
}

export function deriveTreeState(
  tasks: Task[],
  opts: DeriveTreeStateOptions
): Map<string, TreeDerivedState> {
  return deriveTreeBoard(tasks, opts).states;
}

export async function loadTreeBoardFromParser(parser: BacklogParser): Promise<TreeBoard> {
  const [tasks, completed, archived, config, milestones, categories] = await Promise.all([
    parser.getTasks(),
    parser.getCompletedTasks(),
    parser.getArchivedTasks(),
    parser.getConfig(),
    parser.getMilestones(),
    parser.getCategories(),
  ]);
  return deriveTreeBoard([...tasks, ...completed, ...archived], {
    doneStatus: resolveDoneStatus(config.statuses),
    milestoneOrder: milestones.map((m) => m.name),
    priorities: resolvePriorities(config),
    categories,
  });
}

export async function loadTreeStateFromParser(
  parser: BacklogParser
): Promise<Map<string, TreeDerivedState>> {
  return (await loadTreeBoardFromParser(parser)).states;
}
```

(Delete the old standalone bodies of `deriveTreeState`/`loadTreeStateFromParser` — they are now the thin delegators above. Keep the existing imports of `deriveTreeLayout`, `laneOf`, `BACKBURNER_BAND`, `computeBlockedBy`, `resolveDoneStatus`, `resolvePriorities`.)

- [ ] **Step 4: Implement — `types.ts`**

In `src/core/types.ts`, add `'tree'` to the two unions and the new outbound message. Change the `setViewMode` variant:

```ts
  | {
      type: 'setViewMode';
      mode: 'tree' | 'kanban' | 'list' | 'drafts' | 'archived' | 'dashboard' | 'docs' | 'decisions';
    }
```

Change the `activeTabChanged` variant:

```ts
  | {
      type: 'activeTabChanged';
      tab: 'tree' | 'kanban' | 'list' | 'drafts' | 'archived' | 'dashboard' | 'docs' | 'decisions';
    }
```

Add to the `ExtensionMessage` union (e.g. right after `activeTabChanged`):

```ts
  | { type: 'treeLayoutUpdated'; laneOrder: string[]; bandOrder: string[]; warnings: string[] }
```

- [ ] **Step 5: Implement — `TasksController.ts`**

1. Add `'tree'` to the `TasksViewMode` union:

```ts
export type TasksViewMode =
  | 'tree'
  | 'kanban'
  | 'list'
  | 'drafts'
  | 'archived'
  | 'dashboard'
  | 'docs'
  | 'decisions';
```

2. Import the board loader — **replace, don't add alongside.** The file imports `loadTreeStateFromParser` from `../core/treeDerived` at `TasksController.ts:27` (P1's board-enrichment import); **replace that import** with the board loader below — `loadTreeStateFromParser` has no other use in the controller, and leaving it in fails `bun run lint` (unused import) at Task 8's full gate:

```ts
import { loadTreeBoardFromParser } from '../core/treeDerived';
```

3. Default the persisted tab to `'tree'` — **change only the `loadPersistedState` fallback; leave the field initializer alone.** Keep `src/providers/TasksController.ts:73` as `private viewMode: TasksViewMode = 'kanban';`. Do **not** set the field to `'tree'`: `setViewMode` early-returns when the mode is unchanged (`if (this.viewMode === mode) return;`, `TasksController.ts:892`), so a `'tree'` field would make `setViewMode('tree')` on a fresh controller post nothing — the Step 1 test `setViewMode(tree) posts activeTabChanged tree…` would then fail (it asserts `posted` contains `{ type: 'activeTabChanged', tab: 'tree' }`). Change **only** the `loadPersistedState` fallback:

```ts
    this.viewMode = legacyDrafts
      ? 'drafts'
      : this.context.globalState.get<TasksViewMode>('backlog.viewMode', 'tree');
```

Tree stays the effective default because both providers (`TasksViewProvider.resolveWebviewView`, `TasksPanelProvider.reveal`) call `loadPersistedState()` before the first `refresh()`. All four Step 1 controller tests stay green with the field kept at `'kanban'`: `defaults the persisted view mode to tree` and `respects a persisted kanban choice` both drive `loadPersistedState()`; `emits treeLayoutUpdated…` calls `refresh()` directly (field `'kanban'` is not a special mode, so it still loads the tree board and emits); `setViewMode(tree)…` runs against a fresh `'kanban'` controller, so the `this.viewMode === mode` guard does not short-circuit. (Do **not** adopt the alternative of switching off tree first in the test — it would require clearing `posted` mid-test and would still emit a `viewModeChanged` from the intermediate `setViewMode('kanban')`, tripping the second assertion.)

4. In `refresh()`, replace the `treeStates` block (currently `let treeStates … loadTreeStateFromParser`) with a board load:

```ts
      let treeBoard: Awaited<ReturnType<typeof loadTreeBoardFromParser>> | undefined;
      if (this.dataSourceMode !== 'cross-branch') {
        try {
          treeBoard = await loadTreeBoardFromParser(this.parser);
        } catch {
          treeBoard = undefined;
        }
      }
```

Update the enrichment lookup inside `tasks.map(...)` to read from `treeBoard?.states`:

```ts
        const derived = treeBoard?.states.get(task.id.trim().toUpperCase());
```

5. Gate the legacy `viewModeChanged` off for the tree tab (the tree tab is driven only by `activeTabChanged`). Replace the unconditional `viewModeChanged` post in `refresh()` with:

```ts
      if (this.viewMode !== 'tree') {
        this.host.postMessage({
          type: 'viewModeChanged',
          viewMode:
            this.viewMode === 'drafts' || this.viewMode === 'archived' ? 'list' : this.viewMode,
        });
      }
```

6. Emit `treeLayoutUpdated` immediately after the `tasksUpdated` post:

```ts
      this.host.postMessage({ type: 'tasksUpdated', tasks: tasksWithBlocks });
      this.host.postMessage({
        type: 'treeLayoutUpdated',
        laneOrder: treeBoard?.laneOrder ?? [],
        bandOrder: treeBoard?.bandOrder ?? [],
        warnings: treeBoard?.warnings ?? [],
      });
```

(When `treeBoard` is undefined — cross-branch mode — this emits empty arrays, which the webview renders as the empty-state notice.)

7. In `setViewMode`, keep the legacy `viewModeChanged` out for tree by extending the existing guard:

```ts
    if (!isDashboard && !isDocs && !isDecisions && mode !== 'tree') {
      this.host.postMessage({
        type: 'viewModeChanged',
        viewMode: isDrafts || isArchived ? 'list' : mode,
      });
    }
```

(`'tree'` is not in `specialModes`, so switching tree↔kanban↔list reuses the already-loaded task set + the `treeLayoutUpdated` sent on the prior refresh — no extra reload needed.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test -- treeDerived TasksController`
Expected: PASS. Then `bun run typecheck` — expected PASS (the new unions/message compile).

- [ ] **Step 7: Commit**

```bash
git add src/core/treeDerived.ts src/core/types.ts src/providers/TasksController.ts \
  src/test/unit/treeDerived.test.ts src/test/unit/TasksController.test.ts
git commit -m "feat(tree): controller emits treeLayoutUpdated + tree is the default tab

- deriveTreeBoard/loadTreeBoardFromParser surface laneOrder/bandOrder/warnings
- legacy deriveTreeState/loadTreeStateFromParser delegate (callers unchanged)
- persisted viewMode defaults to tree; existing kanban choice respected

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Webview scaffolding — `TabMode 'tree'`, TabBar entry, `Tasks.svelte` branch

**Files:**

- Modify: `src/webview/lib/types.ts`, `src/webview/components/shared/TabBar.svelte`, `src/webview/components/tasks/Tasks.svelte`, `e2e/tasks.spec.ts`
- Create (stub for wiring): `src/webview/components/tree/TechTreeCanvas.svelte` (fleshed out in Task 4)

This task is UI wiring; behavior is covered by Task 8's Playwright suite. Document the house UI-only exception in the commit.

- [ ] **Step 1: `lib/types.ts` — add `'tree'` to `TabMode` and re-export `TreeLayout`**

```ts
export type TabMode =
  | 'tree'
  | 'kanban'
  | 'list'
  | 'drafts'
  | 'archived'
  | 'dashboard'
  | 'docs'
  | 'decisions';
```

Add to the core re-export block:

```ts
export type { TreeLayout } from '../../core/treeLayout';
```

- [ ] **Step 2: `TabBar.svelte` — add `tree` as the first primary tab**

Prepend to `primaryTabs`:

```ts
  const primaryTabs: Tab[] = [
    { mode: 'tree', label: 'Tree' },
    { mode: 'kanban', label: 'Kanban' },
    { mode: 'list', label: 'List' },
    { mode: 'dashboard', label: 'Dashboard' },
  ];
```

Add a Lucide icon branch (a `git-fork`/network glyph) as the first case in the primary-tab `{#if tab.mode === ...}` chain:

```svelte
      {#if tab.mode === 'tree'}
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>
        </svg>
      {:else if tab.mode === 'kanban'}
```

- [ ] **Step 3: `Tasks.svelte` — state, message case, render branch, import**

Add the import beside the other view imports:

```ts
  import TechTreeCanvas from '../tree/TechTreeCanvas.svelte';
```

Initialize the active tab to `'tree'` so the tree tab shows first — this avoids a brief kanban flash before the controller's first `activeTabChanged` message lands. Change `Tasks.svelte:22` from `'kanban'` to `'tree'`:

```ts
  let activeTab = $state<TabMode>('tree');
```

Add tree state (near the other `$state` declarations):

```ts
  // Tech-tree layout vocabulary (from the controller's treeLayoutUpdated).
  let laneOrder = $state<string[]>([]);
  let bandOrder = $state<string[]>([]);
  let treeWarnings = $state<string[]>([]);
```

Add a case to the `onMessage` switch:

```ts
      case 'treeLayoutUpdated':
        laneOrder = message.laneOrder;
        bandOrder = message.bandOrder;
        treeWarnings = message.warnings;
        break;
```

Add the tree render branch immediately **before** the existing `{:else if activeTab === 'kanban'}` branch (`Tasks.svelte:484`). The block above it is `{#if noBacklog}` (an `{#if}`, not `{:else if}`), so the tree branch becomes the first `activeTab` case in that `{#if noBacklog}…{:else if activeTab === …}` chain:

```svelte
{:else if activeTab === 'tree'}
  <div id="tree-view" class="view-content">
    <TechTreeCanvas
      {tasks}
      {laneOrder}
      {bandOrder}
      warnings={treeWarnings}
      {statuses}
      {taskIdDisplay}
      onSelectTask={handleSelectTask}
    />
  </div>
{:else if activeTab === 'kanban'}
```

- [ ] **Step 4: Create the canvas stub so the bundle compiles**

Create `src/webview/components/tree/TechTreeCanvas.svelte` as a temporary stub (replaced in Task 4):

```svelte
<script lang="ts">
  import type { Task, TaskIdDisplayMode } from '../../lib/types';

  interface Props {
    tasks: Task[];
    laneOrder: string[];
    bandOrder: string[];
    warnings: string[];
    statuses: string[];
    taskIdDisplay: TaskIdDisplayMode;
    onSelectTask: (taskId: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
  }
  let { tasks, laneOrder }: Props = $props();
</script>

<div data-testid="tree-canvas-stub">{tasks.length} tasks · {laneOrder.length} lanes</div>
```

- [ ] **Step 5: Update the existing primary-tab-count assertion**

In `e2e/tasks.spec.ts`, the test `only 3 primary tabs visible plus overflow trigger` now sees four primary tabs. Update it:

```ts
    test('primary tabs visible plus overflow trigger', async ({ page }) => {
      await expect(page.locator('[data-testid="tab-tree"]')).toBeVisible();
      await expect(page.locator('[data-testid="tab-kanban"]')).toBeVisible();
      await expect(page.locator('[data-testid="tab-list"]')).toBeVisible();
      await expect(page.locator('[data-testid="tab-dashboard"]')).toBeVisible();
      await expect(page.locator('[data-testid="overflow-menu-btn"]')).toBeVisible();

      await expect(page.locator('[data-testid="tab-drafts"]')).not.toBeVisible();
      await expect(page.locator('[data-testid="tab-archived"]')).not.toBeVisible();
      await expect(page.locator('[data-testid="tab-docs"]')).not.toBeVisible();
      await expect(page.locator('[data-testid="tab-decisions"]')).not.toBeVisible();
    });
```

(Grep `e2e/` for any other test asserting a primary-tab count and update likewise; at time of writing only `tasks.spec.ts` has one.)

- [ ] **Step 6: Build + typecheck + regression**

Run: `bun run build && bun run typecheck`
Expected: PASS (bundle builds; unions line up).

Run: `bun run test:playwright -- tasks`
Expected: PASS — the kanban/list suites are unaffected; the renamed primary-tab test passes with four tabs.

- [ ] **Step 7: Commit**

```bash
git add src/webview/lib/types.ts src/webview/components/shared/TabBar.svelte \
  src/webview/components/tasks/Tasks.svelte src/webview/components/tree/TechTreeCanvas.svelte \
  e2e/tasks.spec.ts
git commit -m "feat(tree): add the Tree tab wiring (TabMode, TabBar, Tasks.svelte branch)

House UI exception: pure wiring; behavior covered by e2e/tree-canvas.spec.ts (Task 8).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `TechTreeCanvas.svelte` — viewport/surface transform, pan/zoom, toolbar, persistence, fallback

**Files:**

- Modify: `src/webview/components/tree/TechTreeCanvas.svelte` (replace the stub)

This is the canvas shell. It renders one clipped `.tree-viewport`, one transformed `.tree-surface`, the SVG `EdgeLayer` beneath `TreeNode`s, the sticky band/lane chrome, and a toolbar. Pan by dragging empty canvas or plain wheel; zoom with Ctrl/Cmd-wheel (anchored at cursor) or toolbar; persist the viewport via `vscode.setState`. When no task carries `layout` (cross-branch mode), it renders the empty-state notice instead of crashing.

> **Build-order caveat (read before running Step 3):** `TechTreeCanvas` imports `TreeNode`/`EdgeLayer`/`AgeBandHeader`/`LaneBand`, which are created in Tasks 5–7. A verbatim 1→8 run hits a **red build** at Step 3 unless those leaves exist first. Implement Tasks 5–7 before this build (recommended — they have no dependency on the canvas), or land one-line stub components here and replace them. See the Ordering note after Step 3.

- [ ] **Step 1: Replace the stub with the full component**

```svelte
<script lang="ts">
  import type { Task, TaskIdDisplayMode } from '../../lib/types';
  import { vscode } from '../../stores/vscode.svelte';
  import {
    deriveGeometry,
    fitToView,
    zoomAt,
    clampViewport,
    lodTier,
    type Viewport,
    type GeometryNode,
  } from '../../lib/treeGeometry';
  import TreeNode from './TreeNode.svelte';
  import EdgeLayer from './EdgeLayer.svelte';
  import AgeBandHeader from './AgeBandHeader.svelte';
  import LaneBand from './LaneBand.svelte';

  interface Props {
    tasks: Task[];
    laneOrder: string[];
    bandOrder: string[];
    warnings: string[];
    statuses: string[];
    taskIdDisplay: TaskIdDisplayMode;
    onSelectTask: (taskId: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
  }
  let { tasks, laneOrder, bandOrder, warnings, statuses, taskIdDisplay, onSelectTask }: Props =
    $props();

  const layoutNodes = $derived(tasks.filter((t) => !!t.layout));
  const hasLayout = $derived(layoutNodes.length > 0 && laneOrder.length > 0);
  const geometryNodes = $derived<GeometryNode[]>(
    layoutNodes.map((t) => ({ id: t.id, layout: t.layout! }))
  );
  const geometry = $derived(deriveGeometry(geometryNodes, laneOrder, bandOrder));
  const doneStatus = $derived(statuses.length > 0 ? statuses[statuses.length - 1] : 'Done');

  let viewportEl: HTMLDivElement | undefined = $state();
  let vp = $state<Viewport>({ scale: 1, tx: 0, ty: 0 });
  let hoveredId = $state<string | null>(null);
  let selectedId = $state<string | null>(null);
  const lod = $derived(lodTier(vp.scale));

  let restored = false;
  $effect(() => {
    if (restored || !hasLayout) return;
    restored = true;
    const saved = (vscode.getState() as { treeViewport?: Viewport } | undefined)?.treeViewport;
    if (saved && Number.isFinite(saved.scale)) {
      vp = saved;
    } else {
      fit();
    }
  });

  function persist() {
    const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
    vscode.setState({ ...prev, treeViewport: vp });
  }

  function setViewport(next: Viewport) {
    if (viewportEl) {
      vp = clampViewport(
        next,
        geometry.width,
        geometry.height,
        viewportEl.clientWidth,
        viewportEl.clientHeight
      );
    } else {
      vp = next;
    }
    persist();
  }

  function fit() {
    requestAnimationFrame(() => {
      if (!viewportEl) return;
      vp = fitToView(
        geometry.width,
        geometry.height,
        viewportEl.clientWidth,
        viewportEl.clientHeight
      );
      persist();
    });
  }

  // Pan by dragging empty canvas.
  let panning = $state(false);
  let panStart = { x: 0, y: 0, tx: 0, ty: 0 };
  function onPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('.tree-node') || target.closest('.tree-toolbar')) return;
    panning = true;
    panStart = { x: e.clientX, y: e.clientY, tx: vp.tx, ty: vp.ty };
    viewportEl?.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!panning) return;
    setViewport({
      scale: vp.scale,
      tx: panStart.tx + (e.clientX - panStart.x),
      ty: panStart.ty + (e.clientY - panStart.y),
    });
  }
  function onPointerUp(e: PointerEvent) {
    if (!panning) return;
    panning = false;
    viewportEl?.releasePointerCapture?.(e.pointerId);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (!viewportEl) return;
    if (e.ctrlKey || e.metaKey) {
      const rect = viewportEl.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setViewport(zoomAt(vp, e.clientX - rect.left, e.clientY - rect.top, factor));
    } else {
      setViewport({ scale: vp.scale, tx: vp.tx - e.deltaX, ty: vp.ty - e.deltaY });
    }
  }

  function zoomBy(factor: number) {
    if (!viewportEl) return;
    setViewport(zoomAt(vp, viewportEl.clientWidth / 2, viewportEl.clientHeight / 2, factor));
  }

  function handleSelect(id: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) {
    selectedId = id;
    onSelectTask(id, meta);
  }
</script>

{#if !hasLayout}
  <div class="tree-empty-state" data-testid="tree-empty-state">
    <p class="tree-empty-title">The tech tree isn't available for this view.</p>
    <p class="tree-empty-hint">
      The tree needs local task layout data, which isn't computed in cross-branch mode. Switch to
      the Kanban or List tab, or turn off cross-branch mode.
    </p>
  </div>
{:else}
  <div class="tree-canvas" data-testid="tree-canvas">
    <div class="tree-toolbar" data-testid="tree-toolbar">
      <button
        class="tree-tool-btn"
        data-testid="tree-zoom-out"
        title="Zoom out"
        onclick={() => zoomBy(1 / 1.2)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
      </button>
      <span class="tree-zoom-label" data-testid="tree-zoom-label">{Math.round(vp.scale * 100)}%</span>
      <button
        class="tree-tool-btn"
        data-testid="tree-zoom-in"
        title="Zoom in"
        onclick={() => zoomBy(1.2)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
      </button>
      <button class="tree-tool-btn" data-testid="tree-zoom-fit" title="Fit to view" onclick={fit}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      </button>
    </div>

    <div
      class="tree-viewport"
      class:panning
      data-testid="tree-viewport"
      bind:this={viewportEl}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointerleave={onPointerUp}
      onwheel={onWheel}
      role="application"
      aria-label="Tech tree canvas"
    >
      <AgeBandHeader bands={geometry.bands} scale={vp.scale} tx={vp.tx} />
      <LaneBand lanes={geometry.lanes} scale={vp.scale} ty={vp.ty} />

      <div
        class="tree-surface"
        data-testid="tree-surface"
        style="width:{geometry.width}px; height:{geometry.height}px; transform: translate({vp.tx}px, {vp.ty}px) scale({vp.scale});"
      >
        <EdgeLayer
          nodes={geometry.nodes}
          tasks={layoutNodes}
          {doneStatus}
          {hoveredId}
          {selectedId}
          width={geometry.width}
          height={geometry.height}
        />
        {#each layoutNodes as task (task.id)}
          {@const box = geometry.nodes.get(task.id)}
          {#if box}
            <TreeNode
              {task}
              x={box.x}
              y={box.y}
              w={box.width}
              h={box.height}
              {lod}
              {statuses}
              {taskIdDisplay}
              selected={selectedId === task.id}
              hovered={hoveredId === task.id}
              onSelect={handleSelect}
              onHover={(id) => (hoveredId = id)}
            />
          {/if}
        {/each}
      </div>
    </div>

    {#if warnings.length > 0}
      <div class="tree-warnings" data-testid="tree-warnings" title={warnings.join('\n')}>
        {warnings.length} layout warning{warnings.length === 1 ? '' : 's'}
      </div>
    {/if}
  </div>
{/if}

<style>
  .tree-canvas {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 400px;
    overflow: hidden;
  }
  .tree-viewport {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: var(--vscode-editor-background);
    cursor: grab;
    touch-action: none;
  }
  .tree-viewport.panning {
    cursor: grabbing;
  }
  .tree-surface {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    will-change: transform;
  }
  .tree-toolbar {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .tree-tool-btn {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border-radius: 4px;
    color: var(--vscode-foreground);
    opacity: 0.8;
  }
  .tree-tool-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .tree-zoom-label {
    min-width: 40px;
    text-align: center;
    font-size: 11px;
    color: var(--vscode-foreground);
  }
  .tree-warnings {
    position: absolute;
    bottom: 8px;
    right: 8px;
    z-index: 20;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.2));
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
  }
  .tree-empty-state {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 240px;
    padding: 24px;
    text-align: center;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  }
  .tree-empty-title {
    font-weight: 600;
  }
  .tree-empty-hint {
    max-width: 420px;
    opacity: 0.8;
    font-size: 12px;
  }
</style>
```

> **Full-bleed caveat (spec §3):** `.tree-canvas` uses `height: 100%` with a `min-height: 400px` fallback, but no ancestor (`body`/`#app`/`.view-content` at `styles.css:188` is `display: block`) has a definite height, and the canvas's own children are absolutely positioned — so content height collapses and the surface resolves to ~400px in both the fixture and the editor tab. Pan/zoom works and every Task 8 assertion still passes (the short viewport is what lets the `plain wheel pans` vertical pan register). It just will not fill a tall editor tab. If true full-bleed is desired, give the tree branch's container/ancestor a real height (e.g. a flex column with `flex: 1`/`height: 100%` from `#tree-view` down, or a definite height on the surrounding view-content) — leave the assertions intact.

- [ ] **Step 2: Run the svelte-autofixer**

Use the `svelte` MCP `svelte-autofixer` on `TechTreeCanvas.svelte`; fix any reported issue and re-run until clean.

- [ ] **Step 3: Build + typecheck**

Run: `bun run build && bun run typecheck`
Expected: PASS. (Task 5–7 components must exist as at least stubs for the bundle to build — create minimal `TreeNode.svelte`/`EdgeLayer.svelte`/`AgeBandHeader.svelte`/`LaneBand.svelte` stubs now if implementing out of order, or build after Task 7. Recommended: implement Tasks 5–7 before this build, or add trivial stubs here and replace them.)

> **Ordering note:** `TechTreeCanvas` imports `TreeNode`/`EdgeLayer`/`AgeBandHeader`/`LaneBand`. Implement Tasks 5–7 first (they have no dependency on the canvas), then this component compiles cleanly. If you prefer to land the canvas first, add one-line stub components and replace them in Tasks 5–7. Either way the suite must be green at each commit.

- [ ] **Step 4: Commit**

```bash
git add src/webview/components/tree/TechTreeCanvas.svelte
git commit -m "feat(tree): TechTreeCanvas viewport/surface, pan/zoom, toolbar, fallback

House UI exception: rendering shell; behavior covered by e2e/tree-canvas.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `TreeNode.svelte` — card at geometry position, LOD tiers, state styles

**Files:**

- Create/replace: `src/webview/components/tree/TreeNode.svelte`

**Encoding (spec §5):** left status color bar + faint tint + status SVG icon. **LOD:** near = id + title + text priority + label chips + plan bar (when progress present) + worker badge + lock + active-bug badge + count (halo); mid = title + status icon + glyphs; far = status pill. **States:** Done (dimmed + check), Locked (dashed + lock), Pending Review (queue position from `mergeState`), has-active-bug (halo), bug node (Bugs-lane styling), Draft = proposed (dashed/ghosted). Priority renders as **text** (P1 §12). The status glyph is a Svelte `{#snippet}` reused across tiers.

> **Plan-progress note:** `tasksUpdated` enrichment does not currently carry per-task plan progress (only the `plan` path string; progress is enriched only on the detail/preview bus). The node renders a plan bar when an optional `planProgress` field is present, otherwise omits it. Per-task board-bus plan-progress enrichment is deferred (P2b popover/details already surface it).

- [ ] **Step 1: Write the component**

```svelte
<script lang="ts">
  import type { Task, TaskIdDisplayMode, MergeTaskState } from '../../lib/types';
  import { statusToClass } from '../../lib/statusColors';
  import { formatTaskIdForDisplay } from '../../lib/taskIdDisplay';
  import type { LodTier } from '../../lib/treeGeometry';

  interface Props {
    task: Task & {
      mergeState?: MergeTaskState;
      planProgress?: { done: number; total: number };
    };
    x: number;
    y: number;
    w: number;
    h: number;
    lod: LodTier;
    statuses: string[];
    taskIdDisplay: TaskIdDisplayMode;
    selected: boolean;
    hovered: boolean;
    onSelect: (id: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
    onHover: (id: string | null) => void;
  }
  let { task, x, y, w, h, lod, statuses, taskIdDisplay, selected, hovered, onSelect, onHover }: Props =
    $props();

  const doneStatus = $derived(statuses.length > 0 ? statuses[statuses.length - 1] : 'Done');
  const isDone = $derived(
    task.status === doneStatus || task.folder === 'completed' || task.folder === 'archive'
  );
  const isLocked = $derived(task.locked === true);
  const isBug = $derived(task.type === 'bug');
  const isDraft = $derived(task.status === 'Draft' || task.folder === 'drafts');
  const activeBugCount = $derived(task.activeBugIds?.length ?? 0);
  const hasActiveBug = $derived(activeBugCount > 0);
  const queuePosition = $derived(
    task.mergeState && !task.mergeState.approved && task.mergeState.mode === 'manual-review'
      ? task.mergeState.position
      : undefined
  );
  const isPendingReview = $derived(queuePosition !== undefined);
  const statusClass = $derived(`status-${statusToClass(task.status)}`);
  const displayId = $derived(formatTaskIdForDisplay(task.id, taskIdDisplay));
  const showId = $derived(taskIdDisplay !== 'hidden');
  const labels = $derived(task.labels?.slice(0, 3) ?? []);
  const iconKind = $derived(
    isBug
      ? 'bug'
      : isDraft
        ? 'draft'
        : isDone
          ? 'done'
          : isLocked
            ? 'locked'
            : task.status.toLowerCase().includes('progress')
              ? 'progress'
              : 'todo'
  );

  function select() {
    onSelect(task.id, { filePath: task.filePath, source: task.source, branch: task.branch });
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    }
  }
</script>

{#snippet statusGlyph()}
  {#if iconKind === 'bug'}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>
  {:else if iconKind === 'draft'}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
  {:else if iconKind === 'done'}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>
  {:else if iconKind === 'locked'}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
  {:else if iconKind === 'progress'}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg>
  {:else}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>
  {/if}
{/snippet}

<div
  class="tree-node {statusClass}"
  class:done={isDone}
  class:locked={isLocked}
  class:bug-node={isBug}
  class:proposed={isDraft}
  class:has-active-bug={hasActiveBug}
  class:pending-review={isPendingReview}
  class:selected
  class:hovered
  class:lod-near={lod === 'near'}
  class:lod-mid={lod === 'mid'}
  class:lod-far={lod === 'far'}
  data-testid="tree-node-{task.id}"
  data-node-x={x}
  data-node-y={y}
  data-lod={lod}
  style="left:{x}px; top:{y}px; width:{w}px; min-height:{h}px;"
  role="button"
  tabindex="0"
  onclick={select}
  onkeydown={onKey}
  onpointerenter={() => onHover(task.id)}
  onpointerleave={() => onHover(null)}
>
  <span class="tree-node-bar" aria-hidden="true"></span>

  {#if lod === 'far'}
    <span class="tree-node-pill" data-testid="tree-node-pill-{task.id}" title={task.title}>
      {@render statusGlyph()}
    </span>
  {:else if lod === 'mid'}
    <div class="tree-node-mid">
      <span class="tree-node-status-icon">{@render statusGlyph()}</span>
      <span class="tree-node-title" title={task.title}>{task.title}</span>
      {#if isLocked}<span class="tree-node-lock" data-testid="tree-node-lock-{task.id}">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </span>{/if}
      {#if hasActiveBug}<span class="tree-node-bugbadge" data-testid="tree-node-bugbadge-{task.id}">{activeBugCount}</span>{/if}
    </div>
  {:else}
    <div class="tree-node-header">
      <span class="tree-node-status-icon">{@render statusGlyph()}</span>
      {#if showId}<span class="tree-node-id" data-testid="tree-node-id-{task.id}">{displayId}</span>{/if}
      {#if task.priority}<span class="tree-node-priority" data-testid="tree-node-priority-{task.id}">{task.priority}</span>{/if}
    </div>
    <div class="tree-node-title" title={task.title}>{task.title}</div>
    {#if labels.length > 0}
      <div class="tree-node-labels">
        {#each labels as label (label)}
          <span class="tree-node-label">{label}</span>
        {/each}
      </div>
    {/if}
    {#if task.planProgress && task.planProgress.total > 0}
      <div class="tree-node-plan" data-testid="tree-node-plan-{task.id}">
        <span
          class="tree-node-plan-fill"
          style="width:{(task.planProgress.done / task.planProgress.total) * 100}%"
        ></span>
      </div>
    {/if}
    <div class="tree-node-badges">
      {#if task.claimedBy}
        <span class="tree-node-worker" data-testid="tree-node-worker-{task.id}" title="Claimed by {task.claimedBy}">
          {#if task.worktree}
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          {/if}
        </span>
      {/if}
      {#if isLocked}
        <span class="tree-node-lock" data-testid="tree-node-lock-{task.id}" title="Locked by prerequisites">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </span>
      {/if}
      {#if hasActiveBug}
        <span class="tree-node-bugbadge" data-testid="tree-node-bugbadge-{task.id}" title="{activeBugCount} active bug(s)">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/></svg>
          {activeBugCount}
        </span>
      {/if}
      {#if isPendingReview}
        <span class="tree-node-queue" data-testid="tree-node-queue-{task.id}" title="Pending review">#{queuePosition}</span>
      {/if}
      {#if isDone}
        <span class="tree-node-check" data-testid="tree-node-check-{task.id}" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        </span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tree-node {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px 8px 14px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    color: var(--vscode-foreground);
    overflow: hidden;
    cursor: pointer;
    /* faint status tint via the status class below */
  }
  .tree-node:focus-visible,
  .tree-node.selected {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 0;
  }
  .tree-node.hovered {
    border-color: var(--vscode-focusBorder);
  }
  /* Left status color bar. */
  .tree-node-bar {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    background: var(--tw-status-color, var(--vscode-foreground));
  }
  /* Known-status colors + faint tints (theme tokens). */
  .tree-node.status-to-do,
  .tree-node.status-todo {
    --tw-status-color: var(--vscode-charts-blue, #3794ff);
  }
  .tree-node.status-in-progress {
    --tw-status-color: var(--vscode-charts-yellow, #cca700);
  }
  .tree-node.status-done {
    --tw-status-color: var(--vscode-charts-green, #89d185);
  }
  .tree-node.status-draft {
    --tw-status-color: var(--vscode-descriptionForeground, #999);
  }
  .tree-node {
    background: color-mix(in srgb, var(--tw-status-color, transparent) 8%, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
  }
  .tree-node-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    opacity: 0.9;
  }
  .tree-node-id {
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }
  .tree-node-priority {
    margin-left: auto;
    text-transform: capitalize;
    font-size: 10px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
  }
  .tree-node-status-icon {
    display: inline-flex;
    color: var(--tw-status-color, var(--vscode-foreground));
  }
  .tree-node-title {
    font-size: 12px;
    font-weight: 500;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tree-node-labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .tree-node-label {
    font-size: 10px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    opacity: 0.85;
  }
  .tree-node-plan {
    height: 4px;
    border-radius: 2px;
    background: var(--vscode-progressBar-background, rgba(255, 255, 255, 0.1));
    overflow: hidden;
  }
  .tree-node-plan-fill {
    display: block;
    height: 100%;
    background: var(--vscode-charts-green, #89d185);
  }
  .tree-node-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    opacity: 0.9;
  }
  .tree-node-bugbadge {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--vscode-editorError-foreground, #f14c4c);
  }
  .tree-node-queue {
    font-variant-numeric: tabular-nums;
    color: var(--vscode-charts-purple, #b180d7);
  }
  .tree-node-check {
    color: var(--vscode-charts-green, #89d185);
  }

  /* --- State styles --- */
  .tree-node.done {
    opacity: 0.55;
  }
  .tree-node.locked {
    border-style: dashed;
  }
  .tree-node.proposed {
    border-style: dashed;
    opacity: 0.7;
    background: repeating-linear-gradient(
      45deg,
      transparent,
      transparent 6px,
      var(--vscode-editorWidget-background, rgba(255, 255, 255, 0.02)) 6px,
      var(--vscode-editorWidget-background, rgba(255, 255, 255, 0.02)) 12px
    );
  }
  .tree-node.bug-node {
    --tw-status-color: var(--vscode-editorError-foreground, #f14c4c);
  }
  .tree-node.has-active-bug {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 40%, transparent);
  }

  /* --- LOD tiers --- */
  .tree-node.lod-far {
    min-height: 0 !important;
    height: 24px;
    width: auto !important;
    padding: 2px 8px 2px 12px;
    flex-direction: row;
    align-items: center;
  }
  .tree-node-pill {
    display: inline-flex;
    align-items: center;
  }
  .tree-node-mid {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tree-node.lod-mid {
    padding-top: 6px;
    padding-bottom: 6px;
  }
</style>
```

- [ ] **Step 2: svelte-autofixer** on `TreeNode.svelte` until clean.

- [ ] **Step 3: Build + typecheck**

Run: `bun run build && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/webview/components/tree/TreeNode.svelte
git commit -m "feat(tree): TreeNode card with LOD tiers and state styles

House UI exception: rendering component; behavior covered by e2e/tree-canvas.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `EdgeLayer.svelte` — SVG overlay, prereq + bug-reference edges, hover highlight

**Files:**

- Create/replace: `src/webview/components/tree/EdgeLayer.svelte`

**Edges (spec §6):** prerequisite edges point prereq → dependent; **solid** when the source is Done, **dashed amber** when still blocking (arrowheads). Bug→cause reference edges are **dotted** and only appear when the bug or its cause is hovered/selected. Hovering a node highlights its incident edges and fades the rest. Endpoints come from `treeGeometry.edgeAnchors`/`bezierPath`. The SVG sits beneath the nodes (painted first inside the surface).

- [ ] **Step 1: Write the component**

```svelte
<script lang="ts">
  import type { Task } from '../../lib/types';
  import { edgeAnchors, bezierPath, type NodeBox } from '../../lib/treeGeometry';

  interface Props {
    nodes: Map<string, NodeBox>;
    tasks: Task[];
    doneStatus: string;
    hoveredId: string | null;
    selectedId: string | null;
    width: number;
    height: number;
  }
  let { nodes, tasks, doneStatus, hoveredId, selectedId, width, height }: Props = $props();

  interface Edge {
    id: string;
    from: string;
    to: string;
    d: string;
    kind: 'satisfied' | 'blocking' | 'bug';
  }

  const byId = $derived(new Map(tasks.map((t) => [t.id.trim().toUpperCase(), t])));

  const edges = $derived.by<Edge[]>(() => {
    const out: Edge[] = [];
    for (const t of tasks) {
      const targetBox = nodes.get(t.id);
      if (!targetBox) continue;

      // Prerequisite edges: dependency (source) → this task (target).
      for (const rawDep of t.dependencies) {
        const dep = byId.get(rawDep.trim().toUpperCase());
        if (!dep) continue;
        const sourceBox = nodes.get(dep.id);
        if (!sourceBox) continue;
        const done =
          dep.status === doneStatus || dep.folder === 'completed' || dep.folder === 'archive';
        const { from, to } = edgeAnchors(sourceBox, targetBox);
        out.push({
          id: `${dep.id}->${t.id}`,
          from: dep.id,
          to: t.id,
          d: bezierPath(from, to),
          kind: done ? 'satisfied' : 'blocking',
        });
      }

      // Bug → cause reference edge.
      if (t.type === 'bug' && t.causedBy) {
        const cause = byId.get(t.causedBy.trim().toUpperCase());
        const causeBox = cause ? nodes.get(cause.id) : undefined;
        if (cause && causeBox) {
          const { from, to } = edgeAnchors(targetBox, causeBox);
          out.push({
            id: `bug:${t.id}->${cause.id}`,
            from: t.id,
            to: cause.id,
            d: bezierPath(from, to),
            kind: 'bug',
          });
        }
      }
    }
    return out;
  });

  const activeId = $derived(hoveredId ?? selectedId);
  function incident(e: Edge, id: string | null): boolean {
    return id !== null && (e.from === id || e.to === id);
  }
  function visible(e: Edge): boolean {
    if (e.kind !== 'bug') return true;
    return incident(e, hoveredId) || incident(e, selectedId);
  }
</script>

<svg
  class="edge-layer"
  data-testid="edge-layer"
  width={width}
  height={height}
  viewBox="0 0 {width} {height}"
  aria-hidden="true"
>
  <defs>
    <marker id="tw-arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="4" orient="auto" markerUnits="userSpaceOnUse">
      <path class="tw-arrow-satisfied" d="M0,0 L9,4 L0,8 z" />
    </marker>
    <marker id="tw-arrow-blocking" markerWidth="9" markerHeight="9" refX="7.5" refY="4" orient="auto" markerUnits="userSpaceOnUse">
      <path class="tw-arrow-blocking" d="M0,0 L9,4 L0,8 z" />
    </marker>
  </defs>

  {#each edges as e (e.id)}
    {#if visible(e)}
      <path
        class="tree-edge tree-edge-{e.kind}"
        class:incident={activeId !== null && incident(e, activeId)}
        class:faded={activeId !== null && !incident(e, activeId)}
        data-testid="tree-edge-{e.from}-{e.to}"
        d={e.d}
        marker-end={e.kind === 'blocking' ? 'url(#tw-arrow-blocking)' : 'url(#tw-arrow)'}
      />
    {/if}
  {/each}
</svg>

<style>
  .edge-layer {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    overflow: visible;
  }
  .tree-edge {
    fill: none;
    stroke-width: 1.5;
    transition: opacity 0.12s ease;
  }
  .tree-edge-satisfied {
    stroke: var(--vscode-charts-lines, var(--vscode-editorIndentGuide-activeBackground, #888));
  }
  .tree-edge-blocking {
    stroke: var(--vscode-editorWarning-foreground, #cca700);
    stroke-dasharray: 6 4;
  }
  .tree-edge-bug {
    stroke: var(--vscode-editorError-foreground, #f14c4c);
    stroke-dasharray: 2 4;
    opacity: 0.8;
  }
  .tree-edge.incident {
    stroke-width: 2.5;
    opacity: 1;
  }
  .tree-edge.faded {
    opacity: 0.15;
  }
  .tw-arrow-satisfied {
    fill: var(--vscode-charts-lines, var(--vscode-editorIndentGuide-activeBackground, #888));
  }
  .tw-arrow-blocking {
    fill: var(--vscode-editorWarning-foreground, #cca700);
  }
</style>
```

- [ ] **Step 2: svelte-autofixer** on `EdgeLayer.svelte` until clean.

- [ ] **Step 3: Build + typecheck** → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/webview/components/tree/EdgeLayer.svelte
git commit -m "feat(tree): EdgeLayer SVG overlay (prereq/blocking/bug edges, hover highlight)

House UI exception: rendering component; behavior covered by e2e/tree-canvas.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Band/lane chrome — `AgeBandHeader.svelte` + `LaneBand.svelte`

**Files:**

- Create/replace: `src/webview/components/tree/AgeBandHeader.svelte`, `src/webview/components/tree/LaneBand.svelte`

Presentation-only overlays pinned inside `.tree-viewport`: band labels sticky to the top edge (tracking horizontal pan/zoom), lane labels sticky to the left edge (tracking vertical pan/zoom). Band/lane ranges come from `geometry.bands`/`geometry.lanes`; positions are `coord × scale + translate`.

- [ ] **Step 1: `AgeBandHeader.svelte`**

```svelte
<script lang="ts">
  import type { BandRange } from '../../lib/treeGeometry';

  interface Props {
    bands: BandRange[];
    scale: number;
    tx: number;
  }
  let { bands, scale, tx }: Props = $props();
</script>

<div class="tree-band-headers" data-testid="tree-band-headers">
  {#each bands as band (band.name)}
    <div
      class="tree-band-header"
      data-testid="tree-band-{band.name}"
      style="left:{band.x * scale + tx}px; width:{band.width * scale}px;"
    >
      <span class="tree-band-label">{band.name}</span>
    </div>
  {/each}
</div>

<style>
  .tree-band-headers {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 24px;
    z-index: 10;
    pointer-events: none;
    overflow: hidden;
  }
  .tree-band-header {
    position: absolute;
    top: 0;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-left: 1px solid var(--vscode-panel-border, transparent);
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent);
  }
  .tree-band-label {
    padding: 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
```

- [ ] **Step 2: `LaneBand.svelte`**

```svelte
<script lang="ts">
  import type { LaneRange } from '../../lib/treeGeometry';

  interface Props {
    lanes: LaneRange[];
    scale: number;
    ty: number;
  }
  let { lanes, scale, ty }: Props = $props();
</script>

<div class="tree-lane-labels" data-testid="tree-lane-labels">
  {#each lanes as lane (lane.name)}
    <div
      class="tree-lane-label"
      data-testid="tree-lane-{lane.name}"
      style="top:{lane.y * scale + ty}px; height:{lane.height * scale}px;"
    >
      <span>{lane.name}</span>
    </div>
  {/each}
</div>

<style>
  .tree-lane-labels {
    position: absolute;
    top: 24px;
    left: 0;
    bottom: 0;
    width: 28px;
    z-index: 10;
    pointer-events: none;
    overflow: hidden;
  }
  .tree-lane-label {
    position: absolute;
    left: 0;
    width: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-top: 1px solid var(--vscode-panel-border, transparent);
    background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent);
  }
  .tree-lane-label span {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-height: 100%;
  }
</style>
```

- [ ] **Step 3: svelte-autofixer** on both components until clean.

- [ ] **Step 4: Build + typecheck + full unit gate**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (Windows: only the ~22 known upstream POSIX-path failures; all new/tree suites green).

- [ ] **Step 5: Commit**

```bash
git add src/webview/components/tree/AgeBandHeader.svelte src/webview/components/tree/LaneBand.svelte
git commit -m "feat(tree): sticky age-band headers and lane labels

House UI exception: presentation-only; behavior covered by e2e/tree-canvas.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Playwright suite `e2e/tree-canvas.spec.ts`

**Files:**

- Create: `e2e/tree-canvas.spec.ts`

Reuses the existing `tasks.html` fixture (loads the `tasks.js` bundle). Drives the tree tab by injecting `statusesUpdated` + `tasksUpdated` (tasks carrying `layout` + P1 derived fields) + `treeLayoutUpdated` + `activeTabChanged: 'tree'`. Uses a larger viewport so fit-to-view resolves to near LOD and geometry positions are stable. Imports the geometry core to assert node positions match without hand-coding pixel math.

- [ ] **Step 1: Write the suite**

```ts
import { test, expect } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview } from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';
import { deriveGeometry, type GeometryNode } from '../src/webview/lib/treeGeometry';

const laneOrder = ['Features', 'Misc', 'Bugs'];
const bandOrder = ['v1', 'Backburner'];

// A graph exercising: satisfied edge (TASK-1 Done → TASK-2), blocking edge
// (TASK-2 not done → TASK-3 locked), a draft node (TASK-4), and a bug with a
// cause (TASK-5 caused by TASK-1).
function treeTasks(): Task[] {
  const base = (over: Partial<Task> & { id: string }): Task =>
    ({
      title: over.id,
      status: 'To Do',
      labels: [],
      assignee: [],
      dependencies: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: `/b/tasks/${over.id}.md`,
      ...over,
    }) as Task;

  return [
    base({
      id: 'TASK-1',
      title: 'Root feature',
      status: 'Done',
      category: 'Features',
      milestone: 'v1',
      priority: 'high',
      // Controller-side enrichment: TASK-1 caused active bug TASK-5. The webview
      // does not re-derive backlinks, so the fixture must carry these directly or
      // the `has-active-bug` halo assertion below cannot pass.
      activeBugIds: ['TASK-5'],
      bugs: ['TASK-5'],
      layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-2',
      title: 'Child feature',
      status: 'In Progress',
      category: 'Features',
      milestone: 'v1',
      dependencies: ['TASK-1'],
      layout: { lane: 'Features', band: 'v1', depth: 1, subRow: 0 },
    }),
    base({
      id: 'TASK-3',
      title: 'Grandchild (locked)',
      status: 'To Do',
      category: 'Features',
      milestone: 'v1',
      dependencies: ['TASK-2'],
      locked: true,
      blockedBy: ['TASK-2'],
      layout: { lane: 'Features', band: 'v1', depth: 2, subRow: 0 },
    }),
    base({
      id: 'TASK-4',
      title: 'Proposed idea',
      status: 'Draft',
      category: 'Misc',
      milestone: 'v1',
      layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-5',
      title: 'Crash on save',
      status: 'To Do',
      type: 'bug',
      causedBy: 'TASK-1',
      layout: { lane: 'Bugs', band: '', depth: 0, subRow: 0 },
    }),
  ];
}

async function setupTreeView(page: Parameters<typeof installVsCodeMock>[0]) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVsCodeMock(page);
  await page.goto('/tasks.html');
  await page.waitForTimeout(100);
  await postMessageToWebview(page, {
    type: 'statusesUpdated',
    statuses: ['To Do', 'In Progress', 'Done'],
  });
  await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: treeTasks() });
  await postMessageToWebview(page, { type: 'treeLayoutUpdated', laneOrder, bandOrder, warnings: [] });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(150);
  await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
}

test.describe('Tech tree canvas', () => {
  test.beforeEach(async ({ page }) => {
    await setupTreeView(page);
  });

  test('renders one node per layout task at the geometry positions', async ({ page }) => {
    await expect(page.locator('.tree-node')).toHaveCount(5);

    const geoNodes: GeometryNode[] = treeTasks().map((t) => ({ id: t.id, layout: t.layout! }));
    const geometry = deriveGeometry(geoNodes, laneOrder, bandOrder);

    for (const [id, box] of geometry.nodes) {
      const el = page.locator(`[data-testid="tree-node-${id}"]`);
      await expect(el).toHaveAttribute('data-node-x', String(box.x));
      await expect(el).toHaveAttribute('data-node-y', String(box.y));
    }
  });

  test('nodes carry state styling classes', async ({ page }) => {
    await expect(page.locator('[data-testid="tree-node-TASK-1"]')).toHaveClass(/done/);
    await expect(page.locator('[data-testid="tree-node-TASK-3"]')).toHaveClass(/locked/);
    await expect(page.locator('[data-testid="tree-node-TASK-4"]')).toHaveClass(/proposed/);
    await expect(page.locator('[data-testid="tree-node-TASK-5"]')).toHaveClass(/bug-node/);
    // TASK-1 caused an active bug (TASK-5) → halo class.
    await expect(page.locator('[data-testid="tree-node-TASK-1"]')).toHaveClass(/has-active-bug/);
  });

  test('edges use solid (satisfied) and dashed-amber (blocking) classes', async ({ page }) => {
    await expect(page.locator('[data-testid="tree-edge-TASK-1-TASK-2"]')).toHaveClass(
      /tree-edge-satisfied/
    );
    await expect(page.locator('[data-testid="tree-edge-TASK-2-TASK-3"]')).toHaveClass(
      /tree-edge-blocking/
    );
  });

  test('bug→cause edge is hidden until the bug is hovered', async ({ page }) => {
    const bugEdge = page.locator('[data-testid="tree-edge-TASK-5-TASK-1"]');
    await expect(bugEdge).toHaveCount(0);
    await page.locator('[data-testid="tree-node-TASK-5"]').hover();
    await expect(bugEdge).toHaveCount(1);
    await expect(bugEdge).toHaveClass(/tree-edge-bug/);
  });

  test('hovering a node highlights incident edges and fades the rest', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-2"]').hover();
    await expect(page.locator('[data-testid="tree-edge-TASK-1-TASK-2"]')).toHaveClass(/incident/);
    await expect(page.locator('[data-testid="tree-edge-TASK-2-TASK-3"]')).toHaveClass(/incident/);
  });

  test('clicking a node sends selectTask (no popover in P2a)', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-2"]').click();
    const last = await page.evaluate(() =>
      (window as any).__vscodeTestHelpers.getLastPostedMessage()
    );
    expect(last).toMatchObject({ type: 'selectTask', taskId: 'TASK-2' });
  });

  test('ctrl-wheel zooms and switches LOD tiers', async ({ page }) => {
    const surface = page.locator('[data-testid="tree-surface"]');
    const beforeTransform = await surface.getAttribute('style');

    // Zoom out hard with ctrl-wheel → far LOD.
    await page.locator('[data-testid="tree-viewport"]').evaluate((el) => {
      for (let i = 0; i < 20; i++) {
        el.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, clientX: 400, clientY: 300, bubbles: true, cancelable: true })
        );
      }
    });
    await page.waitForTimeout(50);
    await expect(page.locator('[data-testid="tree-node-TASK-1"]')).toHaveAttribute('data-lod', 'far');
    const afterTransform = await surface.getAttribute('style');
    expect(afterTransform).not.toBe(beforeTransform);
  });

  test('plain wheel pans (updates the surface transform)', async ({ page }) => {
    const surface = page.locator('[data-testid="tree-surface"]');
    const before = await surface.getAttribute('style');
    await page.locator('[data-testid="tree-viewport"]').evaluate((el) => {
      el.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 120, deltaY: 80, ctrlKey: false, bubbles: true, cancelable: true })
      );
    });
    await page.waitForTimeout(50);
    expect(await surface.getAttribute('style')).not.toBe(before);
  });

  test('fit-to-view resets the zoom toward 100% or below', async ({ page }) => {
    // Zoom in first.
    await page.locator('[data-testid="tree-zoom-in"]').click();
    await page.locator('[data-testid="tree-zoom-in"]').click();
    await page.waitForTimeout(30);
    await page.locator('[data-testid="tree-zoom-fit"]').click();
    await page.waitForTimeout(50);
    const label = await page.locator('[data-testid="tree-zoom-label"]').textContent();
    const pct = parseInt((label ?? '0').replace('%', ''), 10);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  test('cross-branch / no-layout renders the empty-state notice, not a crash', async ({ page }) => {
    // Tasks with no layout + empty laneOrder (cross-branch mode).
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: [
        {
          id: 'X-1',
          title: 'Cross-branch task',
          status: 'To Do',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/b/tasks/x-1.md',
        } as Task,
      ],
    });
    await postMessageToWebview(page, { type: 'treeLayoutUpdated', laneOrder: [], bandOrder: [], warnings: [] });
    await page.waitForTimeout(80);
    await expect(page.locator('[data-testid="tree-empty-state"]')).toBeVisible();
  });
});
```

- [ ] **Step 2: Build then run the suite**

Run: `bun run build && bun run test:playwright -- tree-canvas`
Expected: PASS (all tree-canvas tests green). If a geometry-position assertion fails, the mismatch is a real bug in `treeGeometry` or the node style — fix the code, do not weaken the assertion.

- [ ] **Step 3: Full regression gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright`
Expected: PASS (Windows: only the ~22 known upstream POSIX-path unit failures; all Playwright suites — including the unaffected kanban/list ones — green).

- [ ] **Step 4: Commit**

```bash
git add e2e/tree-canvas.spec.ts
git commit -m "test(tree): Playwright suite for node positions, LOD, edges, pan/zoom, fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Close the task**

When the worktree is clean and all gates pass, run `request_merge` from inside the worktree.

---

## Self-Review

**1. Spec §→task mapping (P2a slice):**

- **§3 canvas surface** (full-bleed WebviewPanel-hosted canvas) → Task 3 (tree tab in `Tasks.svelte`) + Task 4 (`TechTreeCanvas` viewport/surface). The canvas rides the existing editor `TasksPanelProvider`/`tasks.js` bundle (no new provider — the navigator/in-flight panel are P2b).
- **§4 spatial model** (lane=band with sub-rows, band=age column, X=depth, Y=subRow) → Task 1 `deriveGeometry` (consumes P1's `layout`, computes lane/band ranges, positions), backed by the P1 `treeLayout` already producing `laneOrder`/`bandOrder`, surfaced by Task 2 `treeLayoutUpdated`.
- **§5 node rendering** (left bar + tint + status icon; near/mid/far LOD; To Do/In Progress/Pending Review/Done/Locked/has-active-bug/bug states) → Task 5 `TreeNode`. Priority is **text** (§12). Plan bar renders when `planProgress` present (documented deferral).
- **§6 edges** (solid satisfied / dashed-amber blocking, arrowheads prereq→dependent, bezier, hover highlight+fade, dotted bug→cause on hover/selection) → Task 6 `EdgeLayer` + Task 1 endpoints.
- **§11 pan/zoom** (drag empty + wheel pan; Ctrl/Cmd-wheel zoom anchored at cursor; toolbar −/%/+/fit; viewport persisted) → Task 4 + Task 1 (`fitToView`/`zoomAt`/`clampViewport`). Filter dimming / lane collapse / minimap are **P2b** (out of scope, not implemented).
- **§13 architecture/testing** (HTML nodes by CSS transform + SVG overlay; CSP same-origin no inline scripts; unit tests for layout live with P1; Playwright for canvas interactions) → all tasks; Task 1 unit tests, Task 2 controller tests, Task 8 Playwright.
- **§15 draft/proposed rendering** (dashed/ghosted, participates in layout) → Task 5 `.proposed` styling; Task 8 asserts the class. **Promote** actions are P2b (out of scope).

**2. Locked-message compliance:** `treeLayoutUpdated { laneOrder, bandOrder, warnings }` is used verbatim in `types.ts`, emitted in `TasksController.refresh()` right after `tasksUpdated`, and consumed in `Tasks.svelte`. Per-task `layout`/`locked`/`blockedBy`/`bugs`/`activeBugIds` continue to ride on `tasksUpdated` enrichment (verified against `TasksController.ts:306–347` and `types.ts` Task fields) — no duplicate per-task message.

**3. Scope discipline:** No popover, no click-to-active, no navigator/minimap, no in-flight panel, no milestone popover, no details rework, no create/edit/connect gestures, no promote. Node click → `selectTask` only. No `package.json`/`vite.webview.config.ts` entries added.

**4. No-regression checks:** `deriveTreeState`/`loadTreeStateFromParser` keep signatures (delegate) so `mcp/handlers.ts`, `claimActions.ts`, `dispatchActions.ts` are untouched. Legacy `viewModeChanged` is gated off for `'tree'` (its type stays `'kanban'|'list'`). The only existing test edited is the primary-tab-count assertion in `tasks.spec.ts` (intended behavior change: 4 primary tabs).

**5. Placeholder scan:** every code and test step contains complete, runnable content. No TBD/TODO left in shipped code (the P5 cancel-dispatch TODO belongs to P2b, not here).

**6. Type consistency:** `Viewport`/`GeometryNode`/`NodeBox`/`LaneRange`/`BandRange`/`LodTier` names are identical across `treeGeometry.ts`, the components, and the spec. `TreeBoard` fields (`states`/`laneOrder`/`bandOrder`/`warnings`) match every call site. `TabMode`/`TasksViewMode`/`setViewMode.mode`/`activeTabChanged.tab` all gain `'tree'` together.

**7. Known deviations (see the plan's inline notes):**

- Plan-progress bar renders only when an optional `planProgress` field is present (board-bus enrichment deferred; kanban has the same gap).
- Worker badge distinguishes bot vs. user heuristically (dispatched worktree ⇒ bot icon) since enrichment has no explicit flag.
- Cross-branch fallback shows a notice (chosen over the directive's alternative "hide the tab"), matching the plan requirement.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Note the Task 4↔5–7 ordering caveat (implement the leaf components 5–7 before the canvas build, or land trivial stubs).
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
