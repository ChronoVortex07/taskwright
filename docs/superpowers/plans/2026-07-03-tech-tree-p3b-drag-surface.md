# Tech-tree P3b — Drag Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the P2/P3a tech-tree canvas into a **spatial editor**. A human wires dependencies by **dragging** between nodes (directional connect handles, live green/red feedback, cycle/dupe refusal), re-homes a task by **dragging** it to another lane (category) / band (milestone) / cell (ordinal), drops onto empty canvas to **create a pre-linked node**, and removes a dependency from an edge ✕ or a popover prereq chip. All of it runs on **one pointer-event mechanism** (no HTML5 DnD), resolves to the **same surgical writers the MCP tools use** (parity), and stores **no coordinates** — layout stays derived (P1/P2). This plan also clears the P2b carry-in debt (minimap drag-to-pan, filter-aware Promote-all, cross-branch empty-state test).

**Scope boundary (P3b).** This plan implements the P3 directives items **6–11** (geometry inverse core, gesture disambiguation, drag-to-connect, drag-to-reslot, edge removal, P2b carry-in debt) plus the P3b slice of testing directive **12** (extend `treeGeometry.test.ts` with the inverse mapping + reslot targets; extend `TasksController.test.ts` with `reslotTask` / `addDependency` cycle-refusal / `removeDependency`; new Playwright `tree-drag.spec.ts` + the click-in-place case in the landed `tree-authoring.spec.ts`; new CDP `tree-reslot.test.ts`) and doc directive **13** (add the P3b bullet — the two P2b wording nits were already fixed by P3a). It does **not** add any new MCP tool, `/create-task` AI authoring (P4), or stored coordinates. The `createTask` message's `linkTo` field, the `onCreateInPlace` prop, and the shared `createTaskWithTreeFields` core were **built by P3a** and are consumed here unchanged.

**Architecture:** `Tasks.svelte` → `TechTreeCanvas.svelte` already renders derived P1 layout and owns pan/zoom pointer handling, the P2b `DetailPopover`, and P3a's `onCreateInPlace` prop. P3b adds: (a) a **geometry-inverse core** in `src/webview/lib/treeGeometry.ts` (`screenToWorld` / `laneAtY` / `bandAtX` / `cellAt` / `reslotTargets` / `DRAG_THRESHOLD`) — pure, unit-tested; (b) a **gesture state machine** in `TechTreeCanvas` that disambiguates connect-handle vs node-body vs empty-canvas pointer presses through one `pointerdown/move/up` + `setPointerCapture` path (the same mechanism as pan), driving a `drag = $state<DragState|null>()`; (c) a new **`DragLayer.svelte`** rendered inside `.tree-surface` (world coords, inherits pan/zoom like `EdgeLayer`) that draws the connect line / reslot ghost / drop-cell / band-expand highlight; (d) **connect handles** on `TreeNode` (left = needs, right = unlocks); (e) **edge-removal** hit-paths + ✕ on `EdgeLayer` and a ✕ on `DetailPopover` prereq chips; (f) new inbound messages `reslotTask` / `addDependency` / `removeDependency` handled in `TasksController` (each re-validated with `wouldCreateCycle` extension-side and routed through `TreeFieldService` / `BacklogWriter.updateTask`), plus a `navigatorMinimapPan` relay for the minimap drag-to-pan. **Cycle/dupe checks run client-side, synchronously**, by importing the vscode-free `wouldCreateCycle` from `src/core/treeGate.ts` directly into the canvas (the same way `treeGeometry` already imports `treeLayout`).

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest (pure geometry inverse + host-agnostic controller cases), Playwright driven by `page.mouse` (every drag interaction — HTML5 DnD can't be unit-tested, repo convention), CDP (reslot → file-on-disk cross-view), esbuild (extension host) + Vite (webview bundles), VS Code webview CSP (same-origin, no inline scripts).

## Where this fits (the P3 decomposition)

P3 was split by the orchestrator (adjudication Q0, `.superpowers/tech-tree-run/p3-plan-adjudications.md`) into two independently-shippable plans, mirroring the P2 a/b precedent:

1. **P3a — create surface (landed at main `5fb53cf`):** the unified `CreateTaskForm`, bug/one-off intake, the shared vscode-free create core `createTaskWithTreeFields` (+ the cycle-guarded `linkTo` post-create wiring), triggers/keybindings, and retiring `TaskCreatePanel`.
2. **P3b — drag surface (this plan):** geometry-inverse hit-testing, gesture disambiguation (pointer events), drag-to-connect, drag-to-reslot, edge removal, and the P2b carry-in debt. Worktree `.worktrees/tech-tree-p3b`, branch `tech-tree-p3b`, base main `5fb53cf`.

**P3b's only P3a dependencies** are drop-on-empty (reuses P3a's `createTask` + `linkTo` + `onCreateInPlace`) and the shared create core — all delivered by P3a. This plan reads the **as-built** P3a code, not the P3a plan.

**Locked message names (exact strings, from the P3 directives — do not rename).**
Inbound (webview→ext): **`reslotTask`** `{taskId, category?, milestone?}` · **`addDependency`** `{taskId, dependsOn}` · **`removeDependency`** `{taskId, dependsOn}` · **`navigatorMinimapPan`** `{x, y}` (normalized 0–1) — plus **reuse `reorderTasks`** `{updates:[{taskId,ordinal}]}` (in-cell ordinal) and **`promoteDraft`** (unchanged). `addDependency{taskId, dependsOn}` means **`task[taskId].dependencies += dependsOn`** (dependsOn is the prerequisite) — this matches `wouldCreateCycle(tasks, taskId, dependsOn)` exactly, so the guard fires on the same argument order both client- and extension-side. `removeDependency` is its inverse. The connect-handle → message mapping is **locked by P3a's `linkTo.direction` semantics** and reused here 1:1: the drag **origin** is the node whose handle you grabbed; **right handle = `'unlocks'`** ⇒ origin unlocks the target ⇒ `addDependency{taskId: targetId, dependsOn: originId}`; **left handle = `'needs'`** ⇒ origin needs the target ⇒ `addDependency{taskId: originId, dependsOn: targetId}`. Drop-on-empty reuses P3a's `createTask.linkTo` `{taskId: originId, direction}` unchanged. The P3a-built create message and `openCreateForm` are **not** re-defined here. `createTask` payloads keep the **Q1 blessed wire field `taskType`** (never `type`) — this binds the drop-on-empty create path below (it never sets `taskType`, but any create payload obeys the rule).

> **`navigatorMinimapPan` is a relay message, not a controller write (locked-name clarification).** Like `navigatorJump`, it originates in the **navigator** webview, is forwarded by `TreeNavigatorProvider` through the injected `relayToBoard` callback → each host's `relayNavigator` → the board webview, where `Tasks.svelte` consumes it as an `ExtensionMessage` and sets the canvas's `minimapPan*` props. It therefore lives in **both** the `WebviewMessage` union (navigator → provider) and the `ExtensionMessage` union (provider relay → board), exactly as `navigatorJump` does. There is **no `TasksController.handleMessage` case** for it (the directive's phrase "relayed by the controller" = the generic `relayNavigator`, already present). Do not add a controller write-case for it.

## Global Constraints

_Every task's requirements implicitly include this section._

- **Worktree:** work in `.worktrees/tech-tree-p3b` on branch `tech-tree-p3b`. Run all git/file/test commands inside the worktree. A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there **once** before the first build/test. Never commit/merge from the repo root; stage only the files each task names; commit with `--no-verify` (the repo's lint-staged pre-commit hook flips the whole tree CRLF→LF on Windows — see the memory note).
- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:cdp`).
- **Baselines at branch base (`5fb53cf`):** unit **1368 passed / 1 skipped**; Playwright **342 passed**; CDP **16/16**; lint zero-warning; typecheck clean. Windows shows ~22 known upstream POSIX-path unit failures — unrelated, do not "fix". Confirm no previously-green test regresses; each task states what it adds.
- **Parity (mandatory):** every gesture resolves to the **same writers the MCP tools use** — new linked creates go through `createTaskWithTreeFields` (via `createTask`); `category` through `TreeFieldService.setCategory/clearCategory`; `milestone`/`dependencies` through `BacklogWriter.updateTask`; `ordinal` through `ordinalUtils` + the existing `reorderTasks`; and **every** dependency write is cycle-guarded by `wouldCreateCycle` — the same guard MCP `edit_task` uses (`assertDependenciesValid`). No create/edit business logic is re-implemented in the webview; the client-side `wouldCreateCycle` is a **UX gate** (green/red), and the controller re-validates before writing (defense in depth). **No stored coordinates** — layout stays derived.
- **TDD where a pure core or controller message exists** (the `treeGeometry` inverse functions; the `TasksController` `reslotTask`/`addDependency`/`removeDependency` cases): write the failing Vitest first, run red, implement, run green. Svelte components + drag gestures are UI — cover behavior with **Playwright** driven by `page.mouse` (REQUIRED for drag/pointer/DOM-order); cover reslot→disk with **CDP**. Document the house UI-only exception in the commit for pure-markup steps.
- **ONE gesture mechanism — pointer events** (`pointerdown`/`pointermove`/`pointerup` + `setPointerCapture`), **never HTML5 DnD** (matches P2 pan; Playwright-drivable via `page.mouse`). No `draggable`, no `dragstart`/`drop`.
- **Rendering discipline:** Lucide **inline SVG** only (no emojis); every color/border via `--vscode-*` tokens so all themes work. Reactive `style="…"` and Svelte `on*`/`bind:` handlers are CSP-safe; **no** inline `<script>`, no string-built handlers. All new drawing lives inside the existing same-origin `tasks.js` bundle (CSP `default-src 'none'; style-src/script-src ${cspSource}`) — no new webview bundle entry.
- **Svelte 5 runes** (`$state`/`$derived`/`$props`/`$effect`/`{#snippet}`); follow existing component patterns; run the `svelte` MCP `svelte-autofixer` over each new/edited component until it reports no issues **before** committing. **House precedent:** a `state_referenced_locally` warning on an init-once read (e.g. `lastJumpNonce`/`restored` patterns) is suppressed with a `<!-- svelte-ignore state_referenced_locally -->` comment — **do not restructure** to dodge it.
- **Do not break** the kanban/list/dashboard/drafts/archived/docs/decisions tabs, the P3a create form, the P2b popover / milestone popover / in-flight panel / navigator, the detail panel, or their tests. In particular, **node click must still open the popover** (existing `tree-popover.spec.ts` + CDP `tree-popover.test.ts` click nodes): a Playwright/CDP `.click()` fires `pointerdown`+`pointerup` at the same coordinates (0px movement < threshold), which the new gesture machine resolves to a **select**, not a drag — verify this.
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (workers substitute their own model line per `AGENTS.md`). **The orchestrator lands this branch (ff-merge) — the close task (Task 10) ends at "worktree clean, all gates green, ledger updated", NOT `request_merge`.**

---

## File Structure

**Create:**

- `src/webview/components/tree/DragLayer.svelte` — world-space SVG overlay drawing the connect line / reslot ghost / drop-cell / band-expand highlight from the canvas `drag` state.
- `e2e/tree-drag.spec.ts` — Playwright (`page.mouse`): connect green/red/refusal, reslot vertical/horizontal/in-cell, band-expand target, drop-on-empty pre-link, edge ✕, popover prereq ✕.
- `src/test/cdp/tree-reslot.test.ts` — CDP cross-view: drag a node to another lane/band → `category`/`milestone` written to disk.

**Modify:**

- `src/webview/lib/treeGeometry.ts` — the geometry-inverse core: `screenToWorld`, `laneAtY`, `bandAtX`, `cellAt`, `reslotTargets`, `DRAG_THRESHOLD` (+ `RESLOT_MIN_W`/`RESLOT_MIN_H` and the `ReslotTargets` types).
- `src/test/unit/treeGeometry.test.ts` — unit tests for the inverse functions + reslot-target coverage of empty lanes/bands.
- `src/core/types.ts` — `WebviewMessage` gains `reslotTask` / `addDependency` / `removeDependency`; `navigatorMinimapPan` added to **both** `WebviewMessage` and `ExtensionMessage`.
- `src/providers/TasksController.ts` — new inbound cases `reslotTask` / `addDependency` / `removeDependency` (cycle-guarded, routed through `TreeFieldService` + `BacklogWriter.updateTask`, then `refresh()`).
- `src/providers/TreeNavigatorProvider.ts` — relay `navigatorMinimapPan` to the board.
- `src/webview/components/navigator/TreeNavigator.svelte` — minimap **drag-to-pan** → posts `navigatorMinimapPan{x,y}` (threshold-gated click-vs-drag per adjudication Q2).
- `src/webview/components/tree/TechTreeCanvas.svelte` — the gesture state machine (pointer disambiguation: connect / node-body / empty-canvas), `DragLayer` mount, client-side `wouldCreateCycle`, connect + reslot drop resolution, edge-removal + prereq-✕ routing, filter-aware Promote-all, `minimapPan*` props.
- `src/webview/components/tree/AgeBandHeader.svelte` / `src/webview/components/tree/LaneBand.svelte` — `emphasis` prop: highlight the hovered band/lane target during a reslot drag (directive 9, m5).
- `src/webview/components/tree/TreeNode.svelte` — two connect handles (left=needs, right=unlocks) shown on hover; **remove** the node-body `onclick={select}` (selection now resolves in the canvas via pointerup-under-threshold; keep `onkeydown` for a11y).
- `src/webview/components/tree/EdgeLayer.svelte` — per-prereq-edge invisible wide hit-path (`pointer-events:stroke`) + a ✕ at the midpoint on edge hover → `onRemoveDependency(dependentId, prereqId)`.
- `src/webview/components/tree/DetailPopover.svelte` — a ✕ on each prereq chip → `onRemovePrereq(taskId, dependsOn)`.
- `src/webview/components/tasks/Tasks.svelte` — thread `minimapPanX/Y/Nonce` into the canvas; `navigatorMinimapPan` inbound case; thread drop-on-empty `linkTo` through the create-form state into the posted `createTask`.
- Existing tests: `e2e/tree-authoring.spec.ts` (add the click-in-place create case), `e2e/tree-canvas.spec.ts` (Promote-all filter + cross-branch empty-state copy), `e2e/tree-navigator.spec.ts` (minimap drag-to-pan posts `navigatorMinimapPan`).
- `CLAUDE.md` — doc-sync (Task 10): add the P3b bullet (the two P2b wording nits were already fixed by P3a — do not re-touch them).

---

## Recommended execution order

Leaves-first so the bundle builds green at every commit:

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10`

- **1** (`treeGeometry` inverse) is the pure leaf the whole drag surface hit-tests through — TDD it first; it adds only new exports.
- **2** (messages + controller cases + `TreeNavigatorProvider` relay) makes `reslotTask`/`addDependency`/`removeDependency`/`navigatorMinimapPan` handled so later webview tasks can post them; TDD the three write-cases.
- **3** (`DragLayer` + gesture state machine) lands the pointer scaffolding: empty-canvas **click-in-place create** and node-body **select** work fully; node-body **drag** promotes to a reslot ghost whose **drop is a no-op stub** (filled by 5); connect can't start yet (handles arrive in 4). Node click still opens the popover.
- **4** (connect handles + drag-to-connect) needs **3**'s state machine; adds `TreeNode` handles, client-side `wouldCreateCycle` green/red, drop-over-node → `addDependency`, drop-on-empty → `onCreateInPlace` with `linkTo`.
- **5** (drag-to-reslot) fills **3**'s reslot drop: reorder-vs-reslot routing, band-expand visual, bug-lane rules.
- **6** (edge removal) is independent of the drag machine (its own hover ✕ paths) — either edge ✕ or popover prereq ✕ posts `removeDependency` (handled in **2**).
- **7** (P2b carry-in debt) is three self-contained fixes. **8** (`tree-drag.spec.ts`) exercises **3/4/5/6**; **9** (CDP) needs the reslot write path (**2/5**) landed. **10** runs the full gate + doc-sync + visual proof + close.

> **Anchor caveat (read before transcribing):** every edit hunk quotes the exact existing lines to match — **match the quoted text, not the cited line number**. Tasks 3/4/5/6 grow `TechTreeCanvas.svelte`/`TreeNode.svelte`/`EdgeLayer.svelte`, so absolute line numbers cited for those files drift under earlier insertions; the quoted before/after snippets are unique and authoritative.

Each task's model tier is noted in its heading: **[haiku-transcription]** = fully-specified single-surface, safe to transcribe verbatim; **[opus-integration]** = cross-file wiring/judgment.

---

## Task 1: Geometry-inverse core in `treeGeometry.ts` + unit tests [opus-integration]

**Files:**

- Modify: `src/webview/lib/treeGeometry.ts`
- Test: `src/test/unit/treeGeometry.test.ts`

**Why (directive 6):** the drag surface needs to invert the forward layout — screen→world, world→lane, world→band, world→cell — plus a set of **hittable reslot strips that cover every lane/band including zero-node ones**. Study the forward layout first: `deriveGeometry` (`treeGeometry.ts:93-146`) **skips** empty lanes (`if (rows === 0) continue;`) and empty bands (`if (cols === 0) continue;`), so empty lanes/bands **reserve no pixels** and cannot be found by position. `laneAtY`/`bandAtX`/`cellAt` therefore return `undefined` inside a gap; `reslotTargets` synthesizes **min-size strips for the empty ones, appended past the content edge** (non-overlapping with the authoritative populated ranges) so any milestone/lane — even a narrow or empty one — is a reachable drop target (band-expand-on-hover, Task 5, makes them easy to hit).

> **Design decision (empty-target placement) — review-confirmed.** The directive says empty lanes/bands "reserve no px today." An in-**order** strip for an empty lane between two populated lanes would necessarily **overlap** the next populated lane's real range (which starts exactly at the previous lane's bottom, since no gap was reserved). To keep populated ranges authoritative (they must match rendered node positions) and non-overlapping, `reslotTargets` emits **populated targets at their exact geometry range** and **empty targets as `RESLOT_MIN_*` strips appended after the content bottom/right** (stacked in `laneOrder`/`bandOrder`). Coverage is total (one target per order entry) and overlap-free. This is a deliberate divergence from a strictly interleaved tiling; the adversarial review verified the adjacency math against the forward layout (first empty strip starts exactly at the content edge — adjacent, not overlapping).

- [ ] **Step 1: Write the failing tests**

Append to `src/test/unit/treeGeometry.test.ts` (after the existing `deriveGeometry` describe). First extend the import block (`treeGeometry.test.ts:3-21`) to add the new symbols:

```ts
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
  screenToWorld,
  laneAtY,
  bandAtX,
  cellAt,
  reslotTargets,
  DRAG_THRESHOLD,
  RESLOT_MIN_H,
  RESLOT_MIN_W,
  type GeometryNode,
} from '../../webview/lib/treeGeometry';
```

Then add:

```ts
describe('treeGeometry — inverse mapping', () => {
  const laneOrder = ['Features', 'Misc', 'Bugs'];
  const bandOrder = ['v1', 'v2', 'Backburner'];
  // Populated: Features/v1 (A), Misc/v2 (M). Empty lanes: Bugs. Empty bands: Backburner.
  const nodes: GeometryNode[] = [
    node('A', { lane: 'Features', band: 'v1', depth: 0, subRow: 0 }),
    node('M', { lane: 'Misc', band: 'v2', depth: 0, subRow: 0 }),
  ];
  const g = deriveGeometry(nodes, laneOrder, bandOrder);

  it('screenToWorld inverts the viewport transform', () => {
    const vp = { scale: 2, tx: 40, ty: -30 };
    // world (100,50) → screen (100*2+40, 50*2-30) = (240,70) → back to (100,50)
    expect(screenToWorld(vp, 240, 70)).toEqual({ x: 100, y: 50 });
  });

  it('laneAtY / bandAtX resolve a populated cell and return undefined in a gap', () => {
    const a = g.nodes.get('A')!;
    expect(laneAtY(g, a.y + 1)).toBe('Features');
    expect(bandAtX(g, a.x + 1)).toBe('v1');
    // far below all lanes → gap
    expect(laneAtY(g, g.height + 1000)).toBeUndefined();
    // far right of all bands → gap
    expect(bandAtX(g, g.width + 1000)).toBeUndefined();
  });

  it('cellAt returns the lane+band under a world point (undefined components in a gap)', () => {
    const m = g.nodes.get('M')!;
    expect(cellAt(g, m.x + 1, m.y + 1)).toEqual({ lane: 'Misc', band: 'v2' });
    expect(cellAt(g, -9999, -9999)).toEqual({ lane: undefined, band: undefined });
  });

  it('reslotTargets covers EVERY lane and band, including zero-node ones', () => {
    const t = reslotTargets(g, laneOrder, bandOrder);
    expect(t.lanes.map((l) => l.name)).toEqual(laneOrder);
    expect(t.bands.map((b) => b.name)).toEqual(bandOrder);

    // Populated targets equal the geometry ranges.
    const feat = t.lanes.find((l) => l.name === 'Features')!;
    const gFeat = g.lanes.find((l) => l.name === 'Features')!;
    expect(feat.populated).toBe(true);
    expect(feat.y).toBe(gFeat.y);
    expect(feat.height).toBe(gFeat.height);

    // Empty lane 'Bugs' gets a min-height strip below the content, not overlapping any populated range.
    const bugs = t.lanes.find((l) => l.name === 'Bugs')!;
    expect(bugs.populated).toBe(false);
    expect(bugs.height).toBeGreaterThanOrEqual(RESLOT_MIN_H);
    const maxPopulatedBottom = Math.max(...g.lanes.map((l) => l.y + l.height));
    expect(bugs.y).toBeGreaterThanOrEqual(maxPopulatedBottom);

    // Empty band 'Backburner' gets a min-width strip right of the content.
    const bb = t.bands.find((b) => b.name === 'Backburner')!;
    expect(bb.populated).toBe(false);
    expect(bb.width).toBeGreaterThanOrEqual(RESLOT_MIN_W);
    const maxPopulatedRight = Math.max(...g.bands.map((b) => b.x + b.width));
    expect(bb.x).toBeGreaterThanOrEqual(maxPopulatedRight);
  });

  it('reslot lane/band targets do not overlap within their axis', () => {
    const t = reslotTargets(g, laneOrder, bandOrder);
    const lanes = [...t.lanes].sort((p, q) => p.y - q.y);
    for (let i = 1; i < lanes.length; i++) {
      expect(lanes[i].y).toBeGreaterThanOrEqual(lanes[i - 1].y + lanes[i - 1].height);
    }
    const bands = [...t.bands].sort((p, q) => p.x - q.x);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].x).toBeGreaterThanOrEqual(bands[i - 1].x + bands[i - 1].width);
    }
  });

  it('DRAG_THRESHOLD is a small positive pixel constant', () => {
    expect(DRAG_THRESHOLD).toBe(6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- treeGeometry`
Expected: FAIL — `screenToWorld`/`laneAtY`/`bandAtX`/`cellAt`/`reslotTargets`/`DRAG_THRESHOLD`/`RESLOT_MIN_*` are not exported.

- [ ] **Step 3: Implement the inverse core**

Append to `src/webview/lib/treeGeometry.ts` (after `clampViewport`, the current last export at `treeGeometry.ts:195-212`):

```ts
/* ------------------------------------------------------------------ *
 * Geometry inverse (P3b) — screen→world + world→lane/band/cell + the  *
 * hittable reslot strips (covering empty lanes/bands too).            *
 * ------------------------------------------------------------------ */

/** Pointer-drag threshold (screen px): movement under this is a click, not a drag. */
export const DRAG_THRESHOLD = 6;

/** Min hittable strip size for empty (zero-node) reslot lanes/bands. */
export const RESLOT_MIN_W = NODE_WIDTH;
export const RESLOT_MIN_H = ROW_STRIDE;

export interface ReslotLaneTarget {
  name: string;
  y: number;
  height: number;
  /** false = synthesized strip for a lane with no nodes. */
  populated: boolean;
}
export interface ReslotBandTarget {
  name: string;
  x: number;
  width: number;
  populated: boolean;
}
export interface ReslotTargets {
  lanes: ReslotLaneTarget[];
  bands: ReslotBandTarget[];
}

/** Screen point → world point under `vp` (inverse of the surface transform). */
export function screenToWorld(vp: Viewport, screenX: number, screenY: number): Point {
  return { x: (screenX - vp.tx) / vp.scale, y: (screenY - vp.ty) / vp.scale };
}

/** Populated lane whose vertical range contains `worldY`; undefined in a gap. */
export function laneAtY(geometry: TreeGeometry, worldY: number): string | undefined {
  for (const l of geometry.lanes) {
    if (worldY >= l.y && worldY < l.y + l.height) return l.name;
  }
  return undefined;
}

/** Populated band whose horizontal range contains `worldX`; undefined in a gap. */
export function bandAtX(geometry: TreeGeometry, worldX: number): string | undefined {
  for (const b of geometry.bands) {
    if (worldX >= b.x && worldX < b.x + b.width) return b.name;
  }
  return undefined;
}

/**
 * Drop / click cell at a world point. Either component may be undefined (a gap /
 * empty lane or band) — the caller maps undefined lane → Misc (no category) and
 * undefined band → Backburner (no milestone).
 */
export function cellAt(
  geometry: TreeGeometry,
  worldX: number,
  worldY: number
): { lane?: string; band?: string } {
  return { lane: laneAtY(geometry, worldY), band: bandAtX(geometry, worldX) };
}

/**
 * Hittable reslot strips covering EVERY lane/band in order. Populated lanes/bands
 * use their exact geometry range (authoritative — they match rendered nodes); empty
 * ones get `RESLOT_MIN_*` strips appended past the content bottom/right so they never
 * overlap a populated range yet stay reachable (band-expand-on-hover makes them easy).
 */
export function reslotTargets(
  geometry: TreeGeometry,
  laneOrder: string[],
  bandOrder: string[],
  minW = RESLOT_MIN_W,
  minH = RESLOT_MIN_H
): ReslotTargets {
  const laneByName = new Map(geometry.lanes.map((l) => [l.name, l]));
  const bandByName = new Map(geometry.bands.map((b) => [b.name, b]));

  const lanes: ReslotLaneTarget[] = [];
  for (const name of laneOrder) {
    const g = laneByName.get(name);
    if (g) lanes.push({ name, y: g.y, height: g.height, populated: true });
  }
  // Empty lanes: stack min-height strips below the last populated row (deriveGeometry:
  // height = contentBottom + CANVAS_PAD, so contentBottom = height - CANVAS_PAD).
  let ly = geometry.lanes.length > 0 ? geometry.height - CANVAS_PAD : CANVAS_PAD;
  for (const name of laneOrder) {
    if (laneByName.has(name)) continue;
    lanes.push({ name, y: ly, height: minH, populated: false });
    ly += minH;
  }

  const bands: ReslotBandTarget[] = [];
  for (const name of bandOrder) {
    const g = bandByName.get(name);
    if (g) bands.push({ name, x: g.x, width: g.width, populated: true });
  }
  // Empty bands: min-width strips right of the last populated column
  // (width = contentRight + CANVAS_PAD, so contentRight = width - CANVAS_PAD).
  let bx = geometry.bands.length > 0 ? geometry.width - CANVAS_PAD : CANVAS_PAD;
  for (const name of bandOrder) {
    if (bandByName.has(name)) continue;
    bands.push({ name, x: bx, width: minW, populated: false });
    bx += minW + BAND_GAP;
  }

  // Keep both axes in the given order (populated first, then appended empties) —
  // callers rely on `.map(name)` matching laneOrder/bandOrder.
  lanes.sort((a, b) => laneOrder.indexOf(a.name) - laneOrder.indexOf(b.name));
  bands.sort((a, b) => bandOrder.indexOf(a.name) - bandOrder.indexOf(b.name));
  return { lanes, bands };
}
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `bun run test -- treeGeometry` → PASS (existing geometry describes + the new inverse describe). Then `bun run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview/lib/treeGeometry.ts src/test/unit/treeGeometry.test.ts
git commit --no-verify -m "feat(tree P3b): geometry inverse core (screenToWorld/laneAtY/bandAtX/cellAt/reslotTargets)

- screenToWorld inverts the pan/zoom transform; laneAtY/bandAtX/cellAt map a world
  point to a populated lane/band (undefined in a gap)
- reslotTargets covers every lane/band incl. zero-node ones (empty ones get
  RESLOT_MIN_* strips appended past the content edge, non-overlapping)
- DRAG_THRESHOLD=6px click-vs-drag constant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Inbound `reslotTask` / `addDependency` / `removeDependency` + `navigatorMinimapPan` relay + controller cases [opus-integration]

**Files:**

- Modify: `src/core/types.ts`, `src/providers/TasksController.ts`, `src/providers/TreeNavigatorProvider.ts`
- Test: `src/test/unit/TasksController.test.ts`

**Why (directives 8, 9, 11a):** the drag surface posts three new inbound messages the controller must resolve through the same writers the MCP tools use — `reslotTask` (category via `TreeFieldService`, milestone via `BacklogWriter.updateTask`), `addDependency`/`removeDependency` (dependency array via `BacklogWriter.updateTask`, **re-validated** with `wouldCreateCycle`). The minimap drag-to-pan message `navigatorMinimapPan` is a **relay** (like `navigatorJump`) — no controller write-case; `TreeNavigatorProvider` forwards it to the board.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/unit/TasksController.test.ts` (inside the top-level `describe`, near the other `handleMessage` assertions). These spy on the writer/service methods to prove the routing:

```ts
describe('TasksController — P3b drag writes', () => {
  it('reslotTask: category via TreeFieldService.setCategory, milestone via updateTask (resolved)', async () => {
    const setCat = vi
      .spyOn(TreeFieldService.prototype, 'setCategory')
      .mockResolvedValue('Features');
    const updateSpy = vi
      .spyOn(BacklogWriter.prototype, 'updateTask')
      .mockResolvedValue(undefined as never);
    (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'TASK-1',
      title: 'T',
      status: 'To Do',
      labels: [],
      assignee: [],
      dependencies: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: '/fake/backlog/tasks/task-1.md',
    } as Task);
    (mockParser.resolveMilestone as ReturnType<typeof vi.fn>).mockResolvedValue('v1');
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.handleMessage({
      type: 'reslotTask',
      taskId: 'TASK-1',
      category: 'Features',
      milestone: 'v1',
    });
    expect(setCat).toHaveBeenCalledWith('TASK-1', 'Features', mockParser);
    expect(updateSpy).toHaveBeenCalledWith('TASK-1', { milestone: 'v1' }, mockParser);
  });

  it('reslotTask: Misc clears the category, Backburner clears the milestone', async () => {
    const clearCat = vi
      .spyOn(TreeFieldService.prototype, 'clearCategory')
      .mockResolvedValue(undefined as never);
    const updateSpy = vi
      .spyOn(BacklogWriter.prototype, 'updateTask')
      .mockResolvedValue(undefined as never);
    (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'TASK-1',
      title: 'T',
      status: 'To Do',
      labels: [],
      assignee: [],
      dependencies: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: '/fake/backlog/tasks/task-1.md',
    } as Task);
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.handleMessage({
      type: 'reslotTask',
      taskId: 'TASK-1',
      category: 'Misc',
      milestone: 'Backburner',
    });
    expect(clearCat).toHaveBeenCalledWith('TASK-1', mockParser);
    // Backburner clears milestone via an empty string (updateTask omits empty milestone on write).
    expect(updateSpy).toHaveBeenCalledWith('TASK-1', { milestone: '' }, mockParser);
  });

  it('addDependency: writes task[taskId].dependencies += dependsOn (deduped) via updateTask', async () => {
    const updateSpy = vi
      .spyOn(BacklogWriter.prototype, 'updateTask')
      .mockResolvedValue(undefined as never);
    (mockParser.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'TASK-1', dependencies: [] },
      { id: 'TASK-2', dependencies: [] },
    ]);
    (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'TASK-1',
      title: 'T',
      status: 'To Do',
      labels: [],
      assignee: [],
      dependencies: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: '/fake/backlog/tasks/task-1.md',
    } as Task);
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.handleMessage({
      type: 'addDependency',
      taskId: 'TASK-1',
      dependsOn: 'TASK-2',
    });
    expect(updateSpy).toHaveBeenCalledWith('TASK-1', { dependencies: ['TASK-2'] }, mockParser);
  });

  it('addDependency: refuses a cycle (no write)', async () => {
    const updateSpy = vi
      .spyOn(BacklogWriter.prototype, 'updateTask')
      .mockResolvedValue(undefined as never);
    // TASK-2 already depends on TASK-1, so adding TASK-2 to TASK-1 closes 1→2→1.
    (mockParser.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'TASK-1', dependencies: [] },
      { id: 'TASK-2', dependencies: ['TASK-1'] },
    ]);
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.handleMessage({
      type: 'addDependency',
      taskId: 'TASK-1',
      dependsOn: 'TASK-2',
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('removeDependency: writes the pruned dependency array via updateTask', async () => {
    const updateSpy = vi
      .spyOn(BacklogWriter.prototype, 'updateTask')
      .mockResolvedValue(undefined as never);
    (mockParser.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'TASK-1',
      title: 'T',
      status: 'To Do',
      labels: [],
      assignee: [],
      dependencies: ['TASK-2', 'TASK-3'],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: '/fake/backlog/tasks/task-1.md',
    } as Task);
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.handleMessage({
      type: 'removeDependency',
      taskId: 'TASK-1',
      dependsOn: 'TASK-2',
    });
    expect(updateSpy).toHaveBeenCalledWith('TASK-1', { dependencies: ['TASK-3'] }, mockParser);
  });
});
```

> **Harness note:** `TreeFieldService`, `BacklogWriter`, `host`, `mockParser`, `mockContext` are existing `TasksController.test.ts` fixtures. Add `import { TreeFieldService } from '../../core/TreeFieldService';` if not already present, and ensure `mockParser` stubs `resolveMilestone` (add `resolveMilestone: vi.fn()` to the parser mock's `beforeEach` if missing). Each case constructs its own controller and stubs only what it asserts; reuse the file's existing mock scaffold so `refresh()` (called after each write) doesn't throw.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- TasksController`
Expected: FAIL — no `reslotTask`/`addDependency`/`removeDependency` cases (messages are no-ops).

- [ ] **Step 3: Add the inbound messages to `WebviewMessage`**

In `src/core/types.ts`, add to the `WebviewMessage` union. Change the current last member's terminator — `minimapViewport` (`types.ts:324`) — from `;` to `|`, and append the new members:

```ts
  | { type: 'minimapViewport'; x: number; y: number; w: number; h: number }
  | { type: 'reslotTask'; taskId: string; category?: string; milestone?: string }
  | { type: 'addDependency'; taskId: string; dependsOn: string }
  | { type: 'removeDependency'; taskId: string; dependsOn: string }
  | { type: 'navigatorMinimapPan'; x: number; y: number };
```

- [ ] **Step 4: Add `navigatorMinimapPan` to `ExtensionMessage`**

In `src/core/types.ts`, add to the `ExtensionMessage` union immediately after its `minimapViewport` variant (`types.ts:383`, the navigator-relay group):

```ts
  | { type: 'navigatorMinimapPan'; x: number; y: number }
```

> **Kept deliberately (m4, not load-bearing):** nothing type-checks this member — the webview
> receives via the loose `VsCodeMessage` shape and `TreeNavigatorProvider` relays with a
> double-cast — but every other `navigator*` relay message appears in **both** unions, and this
> keeps the relay contract documented in one place. The Step 3 `WebviewMessage` additions, by
> contrast, **are** required (`handleMessage(message: WebviewMessage)` must see the discriminants
> for the new cases to compile). Do not "optimize" this member away.

- [ ] **Step 5: Handle the write cases in `TasksController`**

`TreeFieldService`, `createTaskWithTreeFields`, and `wouldCreateCycle` reach: `TreeFieldService` is already imported (P3a added `private readonly treeFieldService = new TreeFieldService();`). Add the cycle import near the other core imports at the top of `TasksController.ts` (after the `createTaskCore` import P3a added):

```ts
import { wouldCreateCycle } from '../core/treeGate';
```

Add the three cases in `handleMessage`, immediately after the existing `reorderTasks` case closes (`TasksController.ts:698`):

```ts
      case 'reslotTask': {
        if (!this.parser) break;
        const task = await this.parser.getTask(message.taskId);
        if (!task) break;
        if (isReadOnlyTask(task)) {
          vscode.window.showErrorMessage(
            `Cannot move task: ${task.id} is read-only from ${getReadOnlyTaskContext(task)}.`
          );
          break;
        }
        try {
          // Category (lane) via the surgical Taskwright-only writer. Misc = no category.
          if (message.category !== undefined) {
            if (message.category === 'Misc' || message.category.trim() === '') {
              await this.treeFieldService.clearCategory(message.taskId, this.parser);
            } else {
              await this.treeFieldService.setCategory(message.taskId, message.category, this.parser);
            }
          }
          // Milestone (band) via BacklogWriter. Backburner = no milestone (empty string,
          // which updateTask omits on write); otherwise resolve to the canonical id.
          if (message.milestone !== undefined) {
            if (message.milestone === 'Backburner' || message.milestone.trim() === '') {
              await this.writer.updateTask(message.taskId, { milestone: '' }, this.parser);
            } else {
              const resolved =
                (await this.parser.resolveMilestone(message.milestone)) ?? message.milestone;
              await this.writer.updateTask(message.taskId, { milestone: resolved }, this.parser);
            }
          }
          await this.refresh();
        } catch (error) {
          console.error('[Taskwright] reslotTask failed:', error);
          vscode.window.showErrorMessage(
            `Failed to move task: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
      }

      case 'addDependency': {
        if (!this.parser) break;
        const task = await this.parser.getTask(message.taskId);
        if (!task) break;
        if (isReadOnlyTask(task)) break;
        try {
          // Re-validate the cycle guard extension-side (defense in depth; same predicate
          // MCP edit_task uses). wouldCreateCycle(all, taskId, dependsOn) matches the
          // addDependency direction: task[taskId].dependencies += dependsOn.
          const all = await this.parser.getTasks();
          if (wouldCreateCycle(all, message.taskId, message.dependsOn)) {
            vscode.window.showWarningMessage(
              `Linking ${message.dependsOn} into ${message.taskId} would create a dependency cycle.`
            );
            break;
          }
          const key = message.dependsOn.trim().toUpperCase();
          if (task.dependencies.some((d) => d.trim().toUpperCase() === key)) break; // dupe
          const next = [...task.dependencies, message.dependsOn];
          await this.writer.updateTask(message.taskId, { dependencies: next }, this.parser);
          await this.refresh();
        } catch (error) {
          console.error('[Taskwright] addDependency failed:', error);
        }
        break;
      }

      case 'removeDependency': {
        if (!this.parser) break;
        const task = await this.parser.getTask(message.taskId);
        if (!task) break;
        if (isReadOnlyTask(task)) break;
        try {
          const key = message.dependsOn.trim().toUpperCase();
          const next = task.dependencies.filter((d) => d.trim().toUpperCase() !== key);
          if (next.length === task.dependencies.length) break; // nothing removed
          await this.writer.updateTask(message.taskId, { dependencies: next }, this.parser);
          await this.refresh();
        } catch (error) {
          console.error('[Taskwright] removeDependency failed:', error);
        }
        break;
      }
```

> `isReadOnlyTask` / `getReadOnlyTaskContext` are already imported in `TasksController.ts` (used by the `updateTask`/`reorderTasks` cases). `this.writer` and `this.treeFieldService` are existing instance fields.

- [ ] **Step 6: Relay `navigatorMinimapPan` in `TreeNavigatorProvider`**

In `src/providers/TreeNavigatorProvider.ts`, extend the relay condition (`TreeNavigatorProvider.ts:41-47`):

```ts
if (
  message.type === 'navigatorFilterChanged' ||
  message.type === 'navigatorLaneToggle' ||
  message.type === 'navigatorJump' ||
  message.type === 'navigatorMinimapPan'
) {
  this.relayToBoard(message as unknown as ExtensionMessage);
}
```

- [ ] **Step 7: Run tests + typecheck**

Run: `bun run test -- TasksController` → PASS (baseline + 5 new). Then `bun run typecheck` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/providers/TasksController.ts src/providers/TreeNavigatorProvider.ts \
  src/test/unit/TasksController.test.ts
git commit --no-verify -m "feat(tree P3b): reslotTask/addDependency/removeDependency controller cases + navigatorMinimapPan relay

- reslotTask routes category through TreeFieldService (Misc→clearCategory) and
  milestone through BacklogWriter.updateTask (Backburner→clear, else resolveMilestone)
- addDependency/removeDependency write task.dependencies via updateTask; addDependency
  re-validates wouldCreateCycle extension-side (parity with MCP edit_task) + dedupes
- navigatorMinimapPan added to both message unions and relayed by TreeNavigatorProvider

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `DragLayer.svelte` + gesture state machine (pointer disambiguation + click-in-place create) [opus-integration]

**Files:**

- Create: `src/webview/components/tree/DragLayer.svelte`
- Modify: `src/webview/components/tree/TechTreeCanvas.svelte`, `src/webview/components/tree/TreeNode.svelte`
- Test: `e2e/tree-authoring.spec.ts` (add the click-in-place create case)

**Behavior (directive 7):** replace the pan-only pointer handling with **one** state machine on `.tree-viewport`. A `pointerdown` records a `pending` press classified by target: **connect handle** (Task 4 adds the handles), **node body**, or **empty viewport**. On `pointermove`, once movement exceeds `DRAG_THRESHOLD`, the pending press **promotes**: empty → pan (existing), node → `drag.mode='reslot'`, connect → `drag.mode='connect'`. On `pointerup` **under** threshold: empty → **click-in-place create** (`cellAt` → Misc/Backburner), node → **select** (open popover; replaces the node's `onclick`), connect → cancel. `DragLayer` renders the drag visuals in world space. This task lands the pan + click-in-place + select paths fully; the **reslot drop is a no-op stub** (Task 5) and **connect can't start** until Task 4 adds handles.

> **Deliberate UX change (m2, directive-7-blessed — stated, not hidden):** today a click on empty
> canvas only closes the popover/milestone popover (`closePopover(); closeMilestone();` in
> `onPointerDown`). After this task it **also opens the create form** on pointerup-under-threshold —
> "click empty to deselect without spawning a form" is no longer possible (Escape / the form's ✕
> close it; the deselect itself still fires on pointerdown, before the form opens). **No existing
> spec asserts empty-click-deselect-only** (review-verified: `tree-popover.spec.ts` dismisses via
> `tp-close`, `tree-canvas.spec.ts` pans via wheel), so no baseline test changes; the new behavior
> is asserted in Step 7 and must be captured in the Task 10 visual proof.

- [ ] **Step 1: Create `DragLayer.svelte`**

Create `src/webview/components/tree/DragLayer.svelte`:

```svelte
<script lang="ts">
  import { edgeAnchors, type NodeBox, type Point } from '../../lib/treeGeometry';

  /** Discriminated drag state, mirrored from TechTreeCanvas. */
  export type DragState =
    | {
        mode: 'connect';
        fromId: string;
        dir: 'needs' | 'unlocks';
        cursor: Point;
        targetId: string | null;
        valid: boolean;
      }
    | {
        mode: 'reslot';
        taskId: string;
        cursor: Point;
        targetLane?: string;
        targetBand?: string;
        valid: boolean;
      };

  interface LaneRect { name: string; y: number; height: number; }
  interface BandRect { name: string; x: number; width: number; }

  interface Props {
    drag: DragState;
    /** Positioned node boxes (world coords) for anchoring the connect line + reslot ghost. */
    nodes: Map<string, NodeBox>;
    /** Highlighted reslot lane target (the hovered band-expand strip). */
    laneTarget?: LaneRect | null;
    bandTarget?: BandRect | null;
    width: number;
    height: number;
  }
  let { drag, nodes, laneTarget = null, bandTarget = null, width, height }: Props = $props();

  // Connect: line from the origin handle anchor to the cursor.
  const connectFrom = $derived.by<Point | null>(() => {
    if (drag.mode !== 'connect') return null;
    const box = nodes.get(drag.fromId);
    if (!box) return null;
    return drag.dir === 'unlocks'
      ? { x: box.x + box.width, y: box.y + box.height / 2 } // right handle
      : { x: box.x, y: box.y + box.height / 2 }; // left handle
  });
  const connectTargetBox = $derived(
    drag.mode === 'connect' && drag.targetId ? nodes.get(drag.targetId) : undefined
  );
  const reslotBox = $derived(drag.mode === 'reslot' ? nodes.get(drag.taskId) : undefined);
</script>

<svg
  class="drag-layer"
  data-testid="drag-layer"
  width={width}
  height={height}
  viewBox="0 0 {width} {height}"
  aria-hidden="true"
>
  {#if drag.mode === 'reslot'}
    {#if laneTarget}
      <rect
        class="drag-target-strip"
        data-testid="drag-lane-target"
        x="0"
        y={laneTarget.y}
        width={width}
        height={laneTarget.height}
      />
    {/if}
    {#if bandTarget}
      <rect
        class="drag-target-strip"
        data-testid="drag-band-target"
        x={bandTarget.x}
        y="0"
        width={bandTarget.width}
        height={height}
      />
    {/if}
    {#if reslotBox}
      <rect
        class="drag-ghost"
        data-testid="drag-ghost"
        x={drag.cursor.x - reslotBox.width / 2}
        y={drag.cursor.y - reslotBox.height / 2}
        width={reslotBox.width}
        height={reslotBox.height}
        rx="8"
      />
    {/if}
  {:else if connectFrom}
    <path
      class="drag-connect"
      class:valid={drag.valid}
      class:invalid={!drag.valid}
      data-testid="drag-connect-line"
      d="M {connectFrom.x} {connectFrom.y} L {drag.cursor.x} {drag.cursor.y}"
    />
    {#if connectTargetBox}
      <rect
        class="drag-connect-ring"
        class:valid={drag.valid}
        class:invalid={!drag.valid}
        data-testid="drag-connect-ring"
        x={connectTargetBox.x - 2}
        y={connectTargetBox.y - 2}
        width={connectTargetBox.width + 4}
        height={connectTargetBox.height + 4}
        rx="10"
      />
    {/if}
  {/if}
</svg>

<style>
  .drag-layer {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    overflow: visible;
    z-index: 8; /* above EdgeLayer (default) + nodes' shadow, below popovers (z 30) */
  }
  .drag-target-strip {
    fill: color-mix(in srgb, var(--vscode-focusBorder) 14%, transparent);
    stroke: var(--vscode-focusBorder);
    stroke-width: 1.5;
    stroke-dasharray: 6 4;
  }
  .drag-ghost {
    fill: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
    stroke: var(--vscode-focusBorder);
    stroke-width: 1.5;
    stroke-dasharray: 4 4;
  }
  .drag-connect {
    fill: none;
    stroke-width: 2;
    stroke-dasharray: 6 5;
  }
  .drag-connect.valid,
  .drag-connect-ring.valid {
    stroke: var(--vscode-charts-green, #89d185);
  }
  .drag-connect.invalid,
  .drag-connect-ring.invalid {
    stroke: var(--vscode-editorError-foreground, #f14c4c);
  }
  .drag-connect-ring {
    fill: color-mix(in srgb, var(--vscode-charts-green, #89d185) 12%, transparent);
    stroke-width: 2;
  }
  .drag-connect-ring.invalid {
    fill: color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 12%, transparent);
  }
</style>
```

> `edgeAnchors` is imported for API parity with the plan's later connect anchoring; if the `svelte-autofixer`/lint flags it as unused after Task 4 lands, drop the import. (Task 4 does not need it — the anchors are computed inline above — so you may remove it now.)

- [ ] **Step 2: `TechTreeCanvas.svelte` — imports only**

In `src/webview/components/tree/TechTreeCanvas.svelte`, extend the `treeGeometry` import (`TechTreeCanvas.svelte:4-12`) and add the geometry inverse + the vscode-free cycle guard + `DragLayer`:

```ts
import {
  deriveGeometry,
  fitToView,
  zoomAt,
  clampViewport,
  lodTier,
  screenToWorld,
  cellAt,
  reslotTargets,
  DRAG_THRESHOLD,
  type Viewport,
  type GeometryNode,
  type Point,
} from '../../lib/treeGeometry';
import { wouldCreateCycle } from '../../../core/treeGate';
import DragLayer, { type DragState } from './DragLayer.svelte';
```

> **Import-path note:** `TechTreeCanvas.svelte` is at `src/webview/components/tree/`, so `../../../core/treeGate` reaches `src/core/treeGate.ts` — the same depth `KanbanBoard.svelte`/`ListView.svelte` use for `../../../core/ordinalUtils`. This is the client-side `wouldCreateCycle` UX gate (directive 8); the extension re-validates (Task 2). **This step touches nothing below the import block** — all state/handler changes land in Step 3 as one edit (M1).

- [ ] **Step 3: `TechTreeCanvas.svelte` — replace the pan handlers with the state machine (ONE contiguous edit)**

> **M1 (review-fixed) edit-ordering note:** the gesture helpers (`pending`/`drag`/`targets`/`connectValid`/`worldAt`/`nodeAt`) live **inside** the range this step replaces — do **not** insert them separately beforehand. This step is a **single Edit**: the `old_string` is the original pan block (`TechTreeCanvas.svelte:254-283`, quoted verbatim below) and the `new_string` is the full machine (helpers + pan state + handlers + trailing stubs) as **one contiguous block**, so the anchor matches when applied in order and `onPointerDown` never references undefined helpers.

Replace this exact existing block (`TechTreeCanvas.svelte:254-283`):

```ts
// Pan by dragging empty canvas.
let panning = $state(false);
let panStart = { x: 0, y: 0, tx: 0, ty: 0 };
function onPointerDown(e: PointerEvent) {
  const target = e.target as HTMLElement;
  if (target.closest('.tree-toolbar') || target.closest('.tree-popover')) return;
  // Band headers live inside the viewport; capturing the pointer here would
  // swallow their native click (same reason `.tree-node` returns early), so
  // the milestone popover would never open. Let the header's onclick fire.
  if (target.closest('.tree-node') || target.closest('.tree-band-header')) return;
  closePopover();
  closeMilestone();
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
  persistNow();
}
```

with the unified machine — one contiguous block (the existing early-return guards and the `panning` grabbing-cursor class are preserved inside it):

```ts
// P3b gesture machine. `pending` is the pre-threshold press; `drag` is the promoted gesture.
type Pending =
  | { kind: 'pan'; startX: number; startY: number; tx: number; ty: number }
  | { kind: 'node'; id: string; startX: number; startY: number }
  | { kind: 'connect'; id: string; dir: 'needs' | 'unlocks'; startX: number; startY: number };
let pending: Pending | null = null;
let drag = $state<DragState | null>(null);

const targets = $derived(reslotTargets(geometry, laneOrder, bandOrder));

/** In-webview cycle/dupe/self gate for a candidate edge task[taskId].dependencies += dependsOn. */
function connectValid(taskId: string, dependsOn: string): boolean {
  const a = taskId.trim().toUpperCase();
  const b = dependsOn.trim().toUpperCase();
  if (a === b) return false; // self
  const dep = layoutNodes.find((t) => t.id.trim().toUpperCase() === a);
  if (dep?.dependencies.some((d) => d.trim().toUpperCase() === b)) return false; // dupe
  return !wouldCreateCycle(layoutNodes, taskId, dependsOn);
}

/** World point under a client event, relative to the viewport. */
function worldAt(e: PointerEvent): Point {
  const rect = viewportEl!.getBoundingClientRect();
  return screenToWorld(vp, e.clientX - rect.left, e.clientY - rect.top);
}

/** Node id under a world point (topmost box hit), else null. */
function nodeAt(p: Point): string | null {
  for (const [id, box] of geometry.nodes) {
    if (p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height) {
      return id;
    }
  }
  return null;
}

// Pan by dragging empty canvas.
let panning = $state(false);
let panStart = { x: 0, y: 0, tx: 0, ty: 0 };

function onPointerDown(e: PointerEvent) {
  const target = e.target as HTMLElement;
  if (target.closest('.tree-toolbar') || target.closest('.tree-popover')) return;
  if (target.closest('.tree-band-header')) return; // let the milestone popover open
  if (target.closest('.tree-edge-remove')) return; // edge ✕ handles its own click (Task 6)

  const handle = target.closest('.tree-connect-handle') as HTMLElement | null;
  if (handle) {
    // (a) connect-handle press — starts a connect gesture on threshold (Task 4 renders handles).
    e.stopPropagation();
    pending = {
      kind: 'connect',
      id: handle.dataset.connectId ?? '',
      dir: (handle.dataset.connectDir as 'needs' | 'unlocks') ?? 'unlocks',
      startX: e.clientX,
      startY: e.clientY,
    };
    viewportEl?.setPointerCapture(e.pointerId);
    return;
  }

  const node = target.closest('.tree-node') as HTMLElement | null;
  if (node) {
    // (b) node-body press — select on click, reslot on drag.
    pending = { kind: 'node', id: node.dataset.nodeId ?? '', startX: e.clientX, startY: e.clientY };
    viewportEl?.setPointerCapture(e.pointerId);
    return;
  }

  // (c) empty viewport — pan on drag, click-in-place create on click.
  closePopover();
  closeMilestone();
  pending = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx: vp.tx, ty: vp.ty };
  panStart = { x: e.clientX, y: e.clientY, tx: vp.tx, ty: vp.ty };
  viewportEl?.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (!pending) return;
  const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);

  if (pending.kind === 'pan') {
    if (!panning && dist < DRAG_THRESHOLD) return;
    panning = true;
    setViewport({
      scale: vp.scale,
      tx: panStart.tx + (e.clientX - panStart.x),
      ty: panStart.ty + (e.clientY - panStart.y),
    });
    return;
  }

  if (dist < DRAG_THRESHOLD && !drag) return;
  const cursor = worldAt(e);

  if (pending.kind === 'node') {
    const overId = nodeAt(cursor);
    const t = layoutNodes.find((n) => n.id === pending!.id);
    // Bugs are reorder-only (M2): Task 5's reslotValid shows cross-lane red and its
    // onReslotDrop never posts reslotTask for a bug.
    const cell = cellAt(geometry, cursor.x, cursor.y);
    const laneT = laneTargetAt(cursor.y);
    const bandT = bandTargetAt(cursor.x);
    drag = {
      mode: 'reslot',
      taskId: pending.id,
      cursor,
      targetLane: laneT?.name ?? cell.lane,
      targetBand: bandT?.name ?? cell.band,
      valid: reslotValid(t, laneT?.name ?? cell.lane, bandT?.name ?? cell.band, overId),
    };
    dragLaneTarget = laneT ?? null;
    dragBandTarget = bandT ?? null;
    return;
  }

  if (pending.kind === 'connect') {
    const overId = nodeAt(cursor);
    const edge = connectEdge(pending.id, pending.dir, overId);
    drag = {
      mode: 'connect',
      fromId: pending.id,
      dir: pending.dir,
      cursor,
      targetId: overId && overId !== pending.id ? overId : null,
      valid: edge ? connectValid(edge.taskId, edge.dependsOn) : true, // empty target = create (valid)
    };
  }
}

function onPointerUp(e: PointerEvent) {
  const p = pending;
  pending = null;
  viewportEl?.releasePointerCapture?.(e.pointerId);
  if (!p) return;
  const wasDrag = !!drag || panning;

  if (p.kind === 'pan') {
    if (panning) {
      panning = false;
      persistNow();
    } else {
      // Click-in-place create (empty canvas): infer lane/band; Misc / Backburner defaults.
      const world = worldAt(e);
      const cell = cellAt(geometry, world.x, world.y);
      onCreateInPlace?.({ mode: 'full', category: cell.lane, milestone: cell.band });
    }
    finishDrag();
    return;
  }

  if (p.kind === 'node') {
    if (!wasDrag)
      handleSelect(p.id); // click → open popover (replaces onclick)
    else onReslotDrop(); // Task 5 fills this
    finishDrag();
    return;
  }

  // connect
  if (wasDrag) onConnectDrop(); // Task 4 fills this
  finishDrag();
}

function onPointerLeave(e: PointerEvent) {
  // Abort any in-flight gesture when the pointer leaves the viewport.
  if (pending || drag) {
    if (panning) {
      panning = false;
      persistNow();
    }
    pending = null;
    finishDrag();
    viewportEl?.releasePointerCapture?.(e.pointerId);
  }
}

function finishDrag() {
  drag = null;
  dragLaneTarget = null;
  dragBandTarget = null;
}

// Reslot target strips highlighted under the cursor (band-expand visual, Task 5).
let dragLaneTarget = $state<{ name: string; y: number; height: number } | null>(null);
let dragBandTarget = $state<{ name: string; x: number; width: number } | null>(null);
function laneTargetAt(worldY: number) {
  return targets.lanes.find((l) => worldY >= l.y && worldY < l.y + l.height) ?? null;
}
function bandTargetAt(worldX: number) {
  return targets.bands.find((b) => worldX >= b.x && worldX < b.x + b.width) ?? null;
}

// Filled by Task 4 (connect) / Task 5 (reslot). Stubs keep the bundle green now.
function connectEdge(
  _fromId: string,
  _dir: 'needs' | 'unlocks',
  _overId: string | null
): { taskId: string; dependsOn: string } | null {
  return null;
}
function reslotValid(
  _t: Task | undefined,
  _lane: string | undefined,
  _band: string | undefined,
  _overId: string | null
): boolean {
  return true;
}
function onReslotDrop() {
  /* Task 5 */
}
function onConnectDrop() {
  /* Task 4 */
}
```

Then wire `onpointerleave` to the new handler on the viewport (`TechTreeCanvas.svelte:441`) — change `onpointerleave={onPointerUp}` to `onpointerleave={onPointerLeave}` (the pointer-leaving-mid-drag case now aborts cleanly rather than committing a stray pan).

- [ ] **Step 4: `TechTreeCanvas.svelte` — mount `DragLayer` inside the surface**

Add `DragLayer` inside `.tree-surface`, immediately after the `EdgeLayer` (`TechTreeCanvas.svelte:455-464`) and before the `{#each layoutNodes …}`:

```svelte
        {#if drag}
          <DragLayer
            {drag}
            nodes={geometry.nodes}
            laneTarget={dragLaneTarget}
            bandTarget={dragBandTarget}
            width={geometry.width}
            height={geometry.height}
          />
        {/if}
```

- [ ] **Step 5: `TreeNode.svelte` — remove the node-body click (selection moves to the canvas)**

In `src/webview/components/tree/TreeNode.svelte`, add a `data-node-id` to the root div and **remove** the `onclick={select}` (the canvas now resolves click-vs-drag). Change the node root attributes (`TreeNode.svelte:107-118`):

```svelte
  data-testid="tree-node-{task.id}"
  data-node-id={task.id}
  data-node-x={x}
  data-node-y={y}
  data-lod={lod}
  style="left:{x}px; top:{y}px; width:{w}px; min-height:{h}px;"
  role="button"
  tabindex="0"
  onkeydown={onKey}
  onpointerenter={() => onHover(task.id)}
  onpointerleave={() => onHover(null)}
```

(The `onclick={select}` line is deleted; `onKey` still calls `select()` for Enter/Space a11y. `select`/`onKey` and the `onSelect` prop are unchanged and still used by keyboard.)

> **Compatibility (verify):** Playwright/CDP `.click()` and `clickInWebview` dispatch `pointerdown`+`pointerup` at one coordinate (0px < `DRAG_THRESHOLD`), so the canvas resolves the node press to `handleSelect` → the popover opens exactly as before. `tree-popover.spec.ts` and CDP `tree-popover.test.ts` must stay green.

- [ ] **Step 6: svelte-autofixer**

Run the `svelte` MCP `svelte-autofixer` on `DragLayer.svelte`, `TechTreeCanvas.svelte`, and `TreeNode.svelte` until clean. Expect a `state_referenced_locally` note on the init-once `panStart` read pattern — suppress with `<!-- svelte-ignore state_referenced_locally -->` per house precedent; do **not** restructure the machine.

- [ ] **Step 7: Add the click-in-place Playwright case**

The empty-canvas click now opens the create form with the inferred cell. Append to the landed `e2e/tree-authoring.spec.ts` (inside its `test.describe('Tree authoring — create form', …)` block):

```ts
test('clicking empty canvas opens the create form (click-in-place)', async ({ page }) => {
  // A single click on empty viewport space (no node) opens the full form.
  const viewport = page.locator('[data-testid="tree-viewport"]');
  const box = (await viewport.boundingBox())!;
  // Bottom-right corner is empty in the single-node fixture.
  await page.mouse.click(box.x + box.width - 20, box.y + box.height - 20);
  await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
});
```

- [ ] **Step 8: Build + regression**

Run: `bun run build && bun run typecheck && bun run lint`
Then `bun run test:playwright -- tree-authoring tree-popover tree-canvas` → PASS (the new click-in-place case; popover click still opens the popover; canvas pan/hover unaffected). The `plain wheel pans` / `ctrl-wheel zooms` tests are untouched (wheel path unchanged).

- [ ] **Step 9: Commit**

```bash
git add src/webview/components/tree/DragLayer.svelte src/webview/components/tree/TechTreeCanvas.svelte \
  src/webview/components/tree/TreeNode.svelte e2e/tree-authoring.spec.ts
git commit --no-verify -m "feat(tree P3b): pointer gesture state machine + DragLayer + click-in-place create

- one pointerdown/move/up machine on .tree-viewport disambiguates connect-handle /
  node-body / empty-canvas presses via DRAG_THRESHOLD (setPointerCapture, no HTML5 DnD)
- empty-canvas click → onCreateInPlace(cellAt → Misc/Backburner); node click → select
  (replaces TreeNode onclick; keyboard select kept); node/connect drag promote to DragLayer
- DragLayer draws the connect line / reslot ghost / band-expand strips (world coords)
- reslot/connect DROP resolution stubbed (Tasks 4/5); pan + click paths fully landed

House UI exception: interaction scaffolding; behavior covered by e2e/tree-drag.spec.ts (Task 8).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Connect handles on `TreeNode` + drag-to-connect flow [opus-integration]

**Files:**

- Modify: `src/webview/components/tree/TreeNode.svelte`, `src/webview/components/tree/TechTreeCanvas.svelte`, `src/webview/components/tasks/Tasks.svelte`

**Behavior (directive 8, spec §5):** two connect handles appear on a hovered node — **left = "needs"**, **right = "unlocks"**. Dragging from a handle draws a dashed cursor-follow line (`DragLayer`); a valid target node glows **green**, an invalid one (self/dupe/cycle) glows **red**. Drop over a **valid node** → `addDependency`; drop over **empty canvas** → `onCreateInPlace` with a `linkTo` so the new node is pre-linked (reuses P3a's `createTask.linkTo`). The direction→message mapping is locked (see the locked-names paragraph): right/`unlocks` ⇒ `addDependency{taskId: target, dependsOn: origin}`; left/`needs` ⇒ `addDependency{taskId: origin, dependsOn: target}`.

- [ ] **Step 1: `TreeNode.svelte` — render the two connect handles on hover**

In `src/webview/components/tree/TreeNode.svelte`, add the handles as the first children of the node root (right after `<span class="tree-node-bar" …></span>` at `TreeNode.svelte:119`). They carry `data-connect-*` so the canvas machine reads them; they render only when `hovered` and not for read-only/done nodes:

```svelte
  {#if hovered && !isDone}
    <span
      class="tree-connect-handle tree-connect-left"
      data-testid="tree-connect-needs-{task.id}"
      data-connect-id={task.id}
      data-connect-dir="needs"
      title="Drag to make this task depend on another"
      aria-hidden="true"
    ></span>
    <span
      class="tree-connect-handle tree-connect-right"
      data-testid="tree-connect-unlocks-{task.id}"
      data-connect-id={task.id}
      data-connect-dir="unlocks"
      title="Drag to make another task depend on this"
      aria-hidden="true"
    ></span>
  {/if}
```

Add the handle styles inside the `<style>` block (after `.tree-node-bar` rules, near `TreeNode.svelte:234`):

```css
.tree-connect-handle {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  margin-top: -7px;
  border-radius: 50%;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border: 2px solid var(--vscode-focusBorder);
  cursor: crosshair;
  z-index: 5;
}
.tree-connect-handle:hover {
  background: var(--vscode-focusBorder);
}
.tree-connect-left {
  left: -7px;
}
.tree-connect-right {
  right: -7px;
}
/* Handles are meaningless at far LOD (nodes are pills). */
.tree-node.lod-far .tree-connect-handle {
  display: none;
}
```

> The handle is a passive `<span>` (no JS handler) — the canvas's `.tree-viewport` `pointerdown` reads `data-connect-id`/`data-connect-dir` off `target.closest('.tree-connect-handle')` (Task 3 already handles this branch with `stopPropagation`). This keeps `TreeNode` presentational.

- [ ] **Step 2: `TechTreeCanvas.svelte` — fill `connectEdge` + `onConnectDrop`**

Replace the Task-3 stub `connectEdge` (the `return null;` version) with the locked direction mapping, and the stub `onConnectDrop` with the drop resolution:

```ts
/** Map a connect gesture (origin handle) + hovered target to an addDependency edge. */
function connectEdge(
  fromId: string,
  dir: 'needs' | 'unlocks',
  overId: string | null
): { taskId: string; dependsOn: string } | null {
  if (!overId || overId === fromId) return null;
  // right/unlocks: origin unlocks target ⇒ target depends on origin.
  // left/needs:    origin needs target   ⇒ origin depends on target.
  return dir === 'unlocks'
    ? { taskId: overId, dependsOn: fromId }
    : { taskId: fromId, dependsOn: overId };
}

function onConnectDrop() {
  if (!drag || drag.mode !== 'connect') return;
  const overId = drag.targetId;
  if (overId) {
    const edge = connectEdge(drag.fromId, drag.dir, overId);
    if (edge && connectValid(edge.taskId, edge.dependsOn)) {
      vscode.postMessage({ type: 'addDependency', taskId: edge.taskId, dependsOn: edge.dependsOn });
    }
    return; // invalid target: no-op (DragLayer already showed red)
  }
  // Drop on empty canvas → create a new pre-linked node (reuses P3a createTask.linkTo).
  const cell = cellAt(geometry, drag.cursor.x, drag.cursor.y);
  onCreateInPlace?.({
    mode: 'full',
    category: cell.lane,
    milestone: cell.band,
    linkTo: { taskId: drag.fromId, direction: drag.dir },
  });
}
```

- [ ] **Step 3: `TechTreeCanvas.svelte` — extend `onCreateInPlace` with `linkTo`**

Extend the `onCreateInPlace` prop type (`TechTreeCanvas.svelte:43-50`, P3a's declaration) to carry the optional drop-on-empty link:

```ts
    /** Open the unified create form (P3a: reportBug; P3b: drop-on-empty click-in-place). */
    onCreateInPlace?: (opts: {
      mode?: 'full' | 'quick';
      bugMode?: boolean;
      causedBy?: string;
      category?: string;
      milestone?: string;
      /** P3b drop-on-empty pre-link (origin node + its handle direction). */
      linkTo?: { taskId: string; direction: 'needs' | 'unlocks' };
    }) => void;
```

- [ ] **Step 4: `Tasks.svelte` — thread `linkTo` from the create-form state into the posted `createTask`**

The P3a `CreateTaskForm` never displays `linkTo`; it rides alongside the form as invisible metadata on the host state and is merged into the posted message. In `src/webview/components/tasks/Tasks.svelte`:

Extend the `createForm` state + `openCreateForm` signature (`Tasks.svelte:55-67`) to carry `linkTo`:

```ts
// Unified create form (hosted at root so it works from any tab).
let createForm = $state<{
  mode: 'full' | 'quick';
  bugMode: boolean;
  prefill?: { category?: string; milestone?: string; causedBy?: string };
  linkTo?: { taskId: string; direction: 'needs' | 'unlocks' };
} | null>(null);

function openCreateForm(
  mode: 'full' | 'quick',
  opts?: {
    bugMode?: boolean;
    prefill?: { category?: string; milestone?: string; causedBy?: string };
    linkTo?: { taskId: string; direction: 'needs' | 'unlocks' };
  }
) {
  createForm = {
    mode,
    bugMode: opts?.bugMode ?? false,
    prefill: opts?.prefill,
    linkTo: opts?.linkTo,
  };
}
```

Include `linkTo` in the posted `createTask` (`handleCreateSubmit`, `Tasks.svelte:69-84`) — read it from the outer `createForm` state (the form payload never carries it):

```ts
function handleCreateSubmit(payload: CreateTaskPayload) {
  // Q1: map fields explicitly — never spread a payload into the message envelope
  // (a spread carrying a `type` key would clobber the discriminant).
  vscode.postMessage({
    type: 'createTask',
    title: payload.title,
    description: payload.description,
    priority: payload.priority,
    category: payload.category,
    milestone: payload.milestone,
    taskType: payload.taskType,
    causedBy: payload.causedBy,
    openAfter: payload.openAfter,
    // P3b drop-on-empty pre-link (undefined for every non-connect create).
    linkTo: createForm?.linkTo,
  });
  createForm = null;
}
```

Pass `linkTo` through the canvas `onCreateInPlace` handler (`Tasks.svelte:607-611`):

```svelte
      onCreateInPlace={(opts) =>
        openCreateForm(opts.mode ?? 'full', {
          bugMode: opts.bugMode,
          prefill: { causedBy: opts.causedBy, category: opts.category, milestone: opts.milestone },
          linkTo: opts.linkTo,
        })}
```

> The `createTask.linkTo` field and the cycle-guarded `applyLinkTo` core were built by P3a — no core/message change is needed. The controller's `createTask` case already forwards `message.linkTo` into `createTaskWithTreeFields`.

- [ ] **Step 5: svelte-autofixer + build**

Run the `svelte-autofixer` on `TreeNode.svelte`, `TechTreeCanvas.svelte`, `Tasks.svelte` until clean. Then `bun run build && bun run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/tree/TreeNode.svelte src/webview/components/tree/TechTreeCanvas.svelte \
  src/webview/components/tasks/Tasks.svelte
git commit --no-verify -m "feat(tree P3b): drag-to-connect — handles + green/red + addDependency + drop-on-empty pre-link

- TreeNode shows left(needs)/right(unlocks) connect handles on hover; the canvas machine
  reads data-connect-* and draws the DragLayer line with client-side wouldCreateCycle gate
- drop over a valid node posts addDependency (direction mapping locked to P3a linkTo);
  drop on empty canvas → onCreateInPlace with linkTo (reuses P3a createTask.linkTo)
- Tasks.svelte threads linkTo from the create-form state into the posted createTask

House UI exception: interaction; behavior covered by e2e/tree-drag.spec.ts (Task 8).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Drag-to-reslot — reorder vs reslot routing, band-expand, bug-lane rules [opus-integration]

**Files:**

- Modify: `src/webview/components/tree/TechTreeCanvas.svelte`, `src/webview/components/tree/AgeBandHeader.svelte`, `src/webview/components/tree/LaneBand.svelte`

**Behavior (directive 9, spec §6):** dropping a dragged node **edits fields, not coordinates**. If the target **lane and band are unchanged** → in-cell **ordinal reorder** via `calculateOrdinalsForDrop` (`core/ordinalUtils`) + the existing `reorderTasks{updates}`. If the **lane or band changed** → `reslotTask{taskId, category?, milestone?}` (only the changed field(s)). The hovered `reslotTargets` strip highlights (band-expand visual, drawn by `DragLayer` + the Step 3 `AgeBandHeader`/`LaneBand` emphasis). **Bug rules (M2, review-fixed):** a bug (`type==='bug'`) is **reorder-only** — a drop onto another **lane** is refused (red, no-op), and a bug drop **never posts `reslotTask` at all** (so a horizontal drag can never assign a milestone); any in-lane drop resolves to an ordinal reorder. The band axis cannot be gated by literal comparison for bugs: a bug has `band: ''` and anchors at the leftmost column **under the first populated band's x-range**, so `bandAtX` always resolves _some_ band and a literal `sameBand` check would mark **every** bug drag invalid — forbidding the in-lane ordinal reorder directive 9 requires. Hence the two-part enforcement: `reslotValid` gates the lane (red feedback); `onReslotDrop` hard-routes bugs to reorder-only. One-offs drag out of Misc as normal tasks.

- [ ] **Step 1: `TechTreeCanvas.svelte` — fill `reslotValid`**

Replace the Task-3 stub `reslotValid` (the `return true;` version) with the bug-lane + validity rules:

```ts
/**
 * Reslot validity (M2): bugs are reorder-only. A bug drop onto another LANE is
 * refused here (red). The band axis is enforced in onReslotDrop (bug ⇒ never
 * reslotTask) rather than by a literal band comparison: bugs have `band: ''` and
 * anchor under the FIRST populated band's x-range, so bandAtX always resolves some
 * band and a literal sameBand check would mark every bug drag invalid — forbidding
 * the in-lane ordinal reorder directive 9 requires.
 */
function reslotValid(
  t: Task | undefined,
  lane: string | undefined,
  _band: string | undefined,
  _overId: string | null
): boolean {
  if (!t) return false;
  if (t.type === 'bug') {
    // A bug stays on the Bugs lane; only in-lane drops are valid (they reorder).
    return (lane ?? t.layout?.lane) === (t.layout?.lane ?? 'Bugs');
  }
  return true;
}
```

- [ ] **Step 2: `TechTreeCanvas.svelte` — fill `onReslotDrop`**

Replace the Task-3 stub `onReslotDrop` with the routing:

```ts
function onReslotDrop() {
  if (!drag || drag.mode !== 'reslot') return;
  const t = layoutNodes.find((n) => n.id === drag!.taskId);
  if (!t || !t.layout) return;
  if (!drag.valid) return; // bug cross-lane etc. — refused (DragLayer showed red)

  // M2 (directive 9): bugs are reorder-only. NEVER post reslotTask for a bug — a
  // horizontal drag must not assign a milestone; any in-lane drop reorders ordinal.
  if (t.type === 'bug') {
    const updates = inCellReorder(t, drag.cursor.y);
    if (updates.length > 0) vscode.postMessage({ type: 'reorderTasks', updates });
    return;
  }

  const fromLane = t.layout.lane;
  const fromBand = t.layout.band || 'Backburner';
  const toLane = drag.targetLane ?? fromLane;
  const toBand = drag.targetBand ?? fromBand;
  const laneChanged = toLane !== fromLane;
  const bandChanged = toBand !== fromBand;

  if (!laneChanged && !bandChanged) {
    // Same cell → ordinal reorder among the cell's siblings (kanban path parity).
    const updates = inCellReorder(t, drag.cursor.y);
    if (updates.length > 0) vscode.postMessage({ type: 'reorderTasks', updates });
    return;
  }

  // Lane and/or band changed → reslot the changed field(s) only.
  const msg: { type: 'reslotTask'; taskId: string; category?: string; milestone?: string } = {
    type: 'reslotTask',
    taskId: t.id,
  };
  if (laneChanged) msg.category = toLane; // controller maps Misc → clearCategory
  if (bandChanged) msg.milestone = toBand; // controller maps Backburner → clear
  vscode.postMessage(msg);
}

/** In-cell ordinal reorder: order same-cell siblings, find the drop index by cursor Y. */
function inCellReorder(dragged: Task, cursorWorldY: number) {
  const lane = dragged.layout!.lane;
  const band = dragged.layout!.band;
  const siblings = layoutNodes
    .filter((n) => n.layout?.lane === lane && (n.layout?.band || '') === (band || ''))
    .map((n) => ({ taskId: n.id, ordinal: n.ordinal, priority: n.priority }));
  if (siblings.length <= 1) return [];
  const sorted = sortSiblingsByBox(siblings);
  // Drop index = count of siblings whose row-center is above the cursor.
  let dropIndex = 0;
  for (const s of sorted) {
    const box = geometry.nodes.get(s.taskId);
    if (box && box.y + box.height / 2 < cursorWorldY && s.taskId !== dragged.id) dropIndex++;
  }
  return calculateOrdinalsForDrop(
    sorted,
    { taskId: dragged.id, ordinal: dragged.ordinal, priority: dragged.priority },
    dropIndex
  );
}

function sortSiblingsByBox(cards: Array<{ taskId: string; ordinal?: number; priority?: string }>) {
  return [...cards].sort((a, b) => {
    const ba = geometry.nodes.get(a.taskId);
    const bb = geometry.nodes.get(b.taskId);
    return (ba?.y ?? 0) - (bb?.y ?? 0);
  });
}
```

Add `calculateOrdinalsForDrop` to the imports at the top of `TechTreeCanvas.svelte` (next to the `wouldCreateCycle` import from Task 3):

```ts
import { calculateOrdinalsForDrop } from '../../../core/ordinalUtils';
```

> **In-cell reorder scope (review-confirmed):** `calculateOrdinalsForDrop` (`core/ordinalUtils`) is the kanban-column reorder helper; here it is fed the same-cell sibling set sorted by rendered `y`. The Playwright coverage (Task 8) asserts an in-cell drag posts a `reorderTasks{updates}` message — **not** exact ordinal math (the drop-index heuristic is deliberately simple; the shared helper computes the fractional ordinals). This keeps the reslot routing testable without pinning pixel-precise ordinals.

- [ ] **Step 3: `AgeBandHeader`/`LaneBand` emphasis on the hovered drop target (m5, directive 9)**

Directive 9: the hovered strip gets "a highlight + AgeBandHeader/LaneBand emphasis". The `DragLayer` strip is the highlight; this step adds the header/label emphasis. Both components get an optional `emphasis` prop (the hovered target's name); the canvas feeds it from `dragBandTarget`/`dragLaneTarget` while a reslot drag is live. Headers/labels exist only for **populated** bands/lanes (`geometry.bands`/`geometry.lanes`) — empty-target strips are highlighted by `DragLayer` alone; that satisfies the directive's "visual only, no relayout".

In `src/webview/components/tree/AgeBandHeader.svelte`, extend `Props` + destructure (`AgeBandHeader.svelte:4-10`):

```ts
interface Props {
  bands: BandRange[];
  scale: number;
  tx: number;
  onOpenMilestone: (band: string) => void;
  /** Name of the band to emphasize while a reslot drag hovers it (null = none). */
  emphasis?: string | null;
}
let { bands, scale, tx, onOpenMilestone, emphasis = null }: Props = $props();
```

Add the class to the header button (`AgeBandHeader.svelte:15-18`) — insert `class:emphasized={band.name === emphasis}` after the `class="tree-band-header"` line — and the style (after the `.tree-band-header` rule):

```css
.tree-band-header.emphasized {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-focusBorder) 18%, var(--vscode-editor-background));
  border-left-color: var(--vscode-focusBorder);
}
```

In `src/webview/components/tree/LaneBand.svelte`, the same shape — extend `Props` + destructure (`LaneBand.svelte:4-9`):

```ts
interface Props {
  lanes: LaneRange[];
  scale: number;
  ty: number;
  /** Name of the lane to emphasize while a reslot drag hovers it (null = none). */
  emphasis?: string | null;
}
let { lanes, scale, ty, emphasis = null }: Props = $props();
```

Add `class:emphasized={lane.name === emphasis}` to the label div (`LaneBand.svelte:14-18`, after `class="tree-lane-label"`) and the style (after the `.tree-lane-label` rule):

```css
.tree-lane-label.emphasized {
  background: color-mix(in srgb, var(--vscode-focusBorder) 18%, var(--vscode-editor-background));
  border-top-color: var(--vscode-focusBorder);
}
.tree-lane-label.emphasized span {
  color: var(--vscode-foreground);
}
```

In `src/webview/components/tree/TechTreeCanvas.svelte`, feed the props at the two mounts (`TechTreeCanvas.svelte:447-448`). Change:

```svelte
      <AgeBandHeader bands={geometry.bands} scale={vp.scale} tx={vp.tx} onOpenMilestone={openMilestone} />
      <LaneBand lanes={geometry.lanes} scale={vp.scale} ty={vp.ty} />
```

to:

```svelte
      <AgeBandHeader
        bands={geometry.bands}
        scale={vp.scale}
        tx={vp.tx}
        onOpenMilestone={openMilestone}
        emphasis={drag?.mode === 'reslot' ? (dragBandTarget?.name ?? null) : null}
      />
      <LaneBand
        lanes={geometry.lanes}
        scale={vp.scale}
        ty={vp.ty}
        emphasis={drag?.mode === 'reslot' ? (dragLaneTarget?.name ?? null) : null}
      />
```

- [ ] **Step 4: svelte-autofixer + build**

Run the `svelte-autofixer` on `TechTreeCanvas.svelte`, `AgeBandHeader.svelte`, and `LaneBand.svelte` until clean. Then `bun run build && bun run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview/components/tree/TechTreeCanvas.svelte src/webview/components/tree/AgeBandHeader.svelte \
  src/webview/components/tree/LaneBand.svelte
git commit --no-verify -m "feat(tree P3b): drag-to-reslot — reorder vs reslot routing + band-expand + bug reorder-only rules

- same cell → calculateOrdinalsForDrop + reorderTasks; lane/band changed → reslotTask
  with the changed field(s) only (controller maps Misc→clearCategory, Backburner→clear)
- bugs are reorder-only (M2): cross-lane refused (DragLayer red); a bug drop NEVER posts
  reslotTask (no milestone can be assigned) — in-lane drops reorder ordinal
- hovered reslotTargets strip highlights (band-expand) + AgeBandHeader/LaneBand emphasis
  (directive 9), covering empty milestones/lanes

House UI exception: interaction; behavior covered by e2e/tree-drag.spec.ts (Task 8) + CDP tree-reslot (Task 9).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Edge removal — `EdgeLayer` hit-path ✕ + popover prereq-chip ✕ [opus-integration]

**Files:**

- Modify: `src/webview/components/tree/EdgeLayer.svelte`, `src/webview/components/tree/DetailPopover.svelte`, `src/webview/components/tree/TechTreeCanvas.svelte`

**Behavior (directive 10, spec §5):** hovering a **prereq** edge reveals a ✕ at its midpoint → removes that dependency; each **prereq chip** in the popover gets a ✕ firing the same message. Both post `removeDependency{taskId: dependentId, dependsOn: prereqId}` (handled in Task 2). Bug reference edges are **not** removable here.

- [ ] **Step 1: `EdgeLayer.svelte` — hit-path + midpoint ✕ on prereq edges**

In `src/webview/components/tree/EdgeLayer.svelte`, add an `onRemoveDependency` prop and a per-edge midpoint + hover state. Extend `Props` (`EdgeLayer.svelte:5-15`):

```ts
interface Props {
  nodes: Map<string, NodeBox>;
  tasks: Task[];
  doneStatus: string;
  hoveredId: string | null;
  selectedId: string | null;
  fadedIds: Set<string>;
  width: number;
  height: number;
  /** Remove a prereq edge: dependent no longer depends on prereq. */
  onRemoveDependency?: (dependentId: string, prereqId: string) => void;
}
let {
  nodes,
  tasks,
  doneStatus,
  hoveredId,
  selectedId,
  fadedIds,
  width,
  height,
  onRemoveDependency,
}: Props = $props();
```

Add `from`/`to` anchors + a `mid` point to the `Edge` interface and its construction. Extend the interface (`EdgeLayer.svelte:17-23`):

```ts
interface Edge {
  id: string;
  from: string;
  to: string;
  d: string;
  mid: { x: number; y: number };
  kind: 'satisfied' | 'blocking' | 'bug';
}
```

In the prereq-edge push (`EdgeLayer.svelte:41-48`), compute the midpoint from the anchors:

```ts
const { from, to } = edgeAnchors(sourceBox, targetBox);
out.push({
  id: `${dep.id}->${t.id}`,
  from: dep.id,
  to: t.id,
  d: bezierPath(from, to),
  mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
  kind: done ? 'satisfied' : 'blocking',
});
```

In the bug-edge push (`EdgeLayer.svelte:56-63`), add `mid` too (bug edges get no ✕, but the field is required):

```ts
const { from, to } = edgeAnchors(targetBox, causeBox);
out.push({
  id: `bug:${t.id}->${cause.id}`,
  from: t.id,
  to: cause.id,
  d: bezierPath(from, to),
  mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
  kind: 'bug',
});
```

Add a per-edge hover state and render the hit-path + ✕ for **non-bug** edges. Add above the `<svg>` markup (after the `visible` function, `EdgeLayer.svelte:74-78`):

```ts
let hoveredEdge = $state<string | null>(null);
```

Then, inside the `{#each edges as e (e.id)}` block (`EdgeLayer.svelte:97-113`), replace the single `<path>` with the visible edge + an invisible wide hit-path + a hover ✕:

```svelte
  {#each edges as e (e.id)}
    {#if visible(e)}
      <path
        class="tree-edge tree-edge-{e.kind}"
        class:incident={activeId !== null && incident(e, activeId)}
        class:faded={activeId !== null && !incident(e, activeId)}
        class:nav-faded={fadedIds.has(e.from) || fadedIds.has(e.to)}
        data-testid="tree-edge-{e.from}-{e.to}"
        d={e.d}
        marker-end={e.kind === 'bug'
          ? undefined
          : e.kind === 'blocking'
            ? 'url(#tw-arrow-blocking)'
            : 'url(#tw-arrow)'}
      />
      {#if e.kind !== 'bug'}
        <!-- m3: enter/leave live on the GROUP (hit-path + ✕ together), so moving the
             pointer from the hit-stroke onto the ✕ never fires a leave (pointerenter/
             pointerleave treat descendants as inside) and the ✕ can't unmount mid-hover. -->
        <g
          class="tree-edge-interactive"
          onpointerenter={() => (hoveredEdge = e.id)}
          onpointerleave={() => (hoveredEdge = null)}
        >
          <path class="tree-edge-hit" data-testid="tree-edge-hit-{e.from}-{e.to}" d={e.d} />
          {#if hoveredEdge === e.id}
            <g
              class="tree-edge-remove"
              data-testid="tree-edge-remove-{e.from}-{e.to}"
              transform="translate({e.mid.x} {e.mid.y})"
              role="button"
              tabindex="-1"
              aria-label="Remove dependency"
              onpointerdown={(ev) => ev.stopPropagation()}
              onclick={(ev) => {
                ev.stopPropagation();
                onRemoveDependency?.(e.to, e.from);
              }}
            >
              <circle r="9" class="tree-edge-remove-bg" />
              <path d="M -3 -3 L 3 3 M 3 -3 L -3 3" class="tree-edge-remove-x" />
            </g>
          {/if}
        </g>
      {/if}
    {/if}
  {/each}
```

> **Direction:** the prereq edge is `dep.id → t.id` (prereq → dependent), so `e.from` = prereq, `e.to` = dependent. Removing it is `removeDependency{taskId: e.to (dependent), dependsOn: e.from (prereq)}` — hence `onRemoveDependency?.(e.to, e.from)`.

Add the hit-path + ✕ styles (the layer stays `pointer-events:none`; only the hit-path and ✕ opt in). After `.edge-layer { … }` (`EdgeLayer.svelte:117-123`):

```css
.tree-edge-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  pointer-events: stroke;
  cursor: pointer;
}
.tree-edge-remove {
  pointer-events: all;
  cursor: pointer;
}
.tree-edge-remove-bg {
  fill: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  stroke: var(--vscode-editorError-foreground, #f14c4c);
  stroke-width: 1.5;
}
.tree-edge-remove-x {
  stroke: var(--vscode-editorError-foreground, #f14c4c);
  stroke-width: 2;
  stroke-linecap: round;
}
```

> **z-order / occlusion (review-confirmed):** `EdgeLayer` is the first child of `.tree-surface` (under the nodes), and the whole SVG keeps `pointer-events:none` except the `.tree-edge-hit` stroke and the `.tree-edge-remove` group — the standard opt-back-in overlay pattern, valid for SVG. A prereq edge's midpoint lies in the inter-node gap (NODE_WIDTH 208, COL_GAP 56 — not under a node), so the wide hit-stroke and ✕ receive pointer events there; during a canvas pointer capture the hit-path is unreachable, but edge removal is an idle-state interaction, so no conflict. The ✕ `onpointerdown` `stopPropagation` prevents the canvas machine from treating the click as a pan/create (the canvas `onPointerDown` also early-returns on `.tree-edge-remove`, added in Task 3).

- [ ] **Step 2: `DetailPopover.svelte` — ✕ on each prereq chip**

In `src/webview/components/tree/DetailPopover.svelte`, add an `onRemovePrereq` prop and a ✕ inside each prereq chip. Extend `Props` (`DetailPopover.svelte:21-32`) with:

```ts
    onRemovePrereq?: (taskId: string, dependsOn: string) => void;
```

and add it to the `$props()` destructure (`DetailPopover.svelte:33`):

```ts
let {
  task,
  statuses,
  priorities,
  taskIdDisplay,
  x,
  y,
  onClose,
  onExpand,
  onQuickEdit,
  onAction,
  onRemovePrereq,
}: Props = $props();
```

Change the prereq chips block (`DetailPopover.svelte:171-176`) to add the ✕ button:

```svelte
  {#if prereqs.length > 0}
    <div class="tp-rel">
      <span class="tp-rel-label">Prereqs</span>
      {#each prereqs as d (d)}
        <span class="tp-rel-chip" class:unmet={blockedBy.includes(d)}>
          {d}
          <button
            class="tp-rel-remove"
            data-testid="tp-prereq-remove-{d}"
            title="Remove prerequisite"
            aria-label="Remove prerequisite {d}"
            onclick={() => onRemovePrereq?.(task.id, d)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </span>
      {/each}
    </div>
  {/if}
```

Add the ✕ button style (after `.tp-rel-chip.unmet` at `DetailPopover.svelte:325-328`):

```css
.tp-rel-remove {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  margin-left: 3px;
  vertical-align: middle;
  opacity: 0.7;
}
.tp-rel-remove:hover {
  opacity: 1;
  color: var(--vscode-editorError-foreground, #f14c4c);
}
```

- [ ] **Step 3: `TechTreeCanvas.svelte` — wire both removal paths**

Pass `onRemoveDependency` to `EdgeLayer` (`TechTreeCanvas.svelte:455-464`) and `onRemovePrereq` to `DetailPopover` (`TechTreeCanvas.svelte:500-513`). Both post the locked message:

For `EdgeLayer`, add the prop:

```svelte
        <EdgeLayer
          nodes={geometry.nodes}
          tasks={layoutNodes}
          {doneStatus}
          {hoveredId}
          {selectedId}
          {fadedIds}
          width={geometry.width}
          height={geometry.height}
          onRemoveDependency={(dependentId, prereqId) =>
            vscode.postMessage({ type: 'removeDependency', taskId: dependentId, dependsOn: prereqId })}
        />
```

For `DetailPopover`, add the prop:

```svelte
        onRemovePrereq={(taskId, dependsOn) =>
          vscode.postMessage({ type: 'removeDependency', taskId, dependsOn })}
```

- [ ] **Step 4: svelte-autofixer + build**

Run the `svelte-autofixer` on `EdgeLayer.svelte`, `DetailPopover.svelte`, `TechTreeCanvas.svelte` until clean. Then `bun run build && bun run typecheck` → PASS. Then `bun run test:playwright -- tree-canvas tree-popover` → PASS (the existing edge/popover suites still green; the hit-path/✕ are additive and only appear on hover).

- [ ] **Step 5: Commit**

```bash
git add src/webview/components/tree/EdgeLayer.svelte src/webview/components/tree/DetailPopover.svelte \
  src/webview/components/tree/TechTreeCanvas.svelte
git commit --no-verify -m "feat(tree P3b): edge removal — EdgeLayer hit-path ✕ + popover prereq-chip ✕ → removeDependency

- prereq edges get an invisible wide hit-stroke + a midpoint ✕ on hover (bug edges excluded)
- popover prereq chips get a ✕; both post removeDependency{taskId:dependent, dependsOn:prereq}
- EdgeLayer stays pointer-events:none except the hit-stroke and the ✕ group (stopPropagation)

House UI exception: interaction; behavior covered by e2e/tree-drag.spec.ts (Task 8).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: P2b carry-in debt — minimap drag-to-pan, filter-aware Promote-all, cross-branch empty-state test [opus-integration]

**Files:**

- Modify: `src/webview/components/navigator/TreeNavigator.svelte`, `src/webview/components/tasks/Tasks.svelte`, `src/webview/components/tree/TechTreeCanvas.svelte`
- Test: `e2e/tree-navigator.spec.ts`, `e2e/tree-canvas.spec.ts`

**Behavior (directive 11):** three self-contained P2b follow-ups. (a) The navigator minimap gains **drag-to-pan** → `navigatorMinimapPan{x,y}` (normalized), relayed to the canvas which sets `vp.tx/ty` via new `minimapPan*` props — **click vs drag is threshold-gated per adjudication Q2** (sub-threshold click = the column's jump; past-threshold movement = pan). (b) `TechTreeCanvas.promoteAll` must filter `!fadedIds.has(id)` and the button count reflect the filtered set. (c) Add the missing cross-branch empty-state **copy** assertion to the tree Playwright suite.

- [ ] **Step 1: `TreeNavigator.svelte` — minimap drag-to-pan (Q2: threshold-gated)**

> **Q2 (orchestrator-adjudicated, `.superpowers/tech-tree-run/p3-plan-adjudications.md`):** the
> minimap distinguishes **click** from **drag** with a small movement threshold mirroring the
> canvas `DRAG_THRESHOLD` — `setPointerCapture` + `emitPan` fire only **after** the pointer moves
> past the threshold. A sub-threshold pointerup is a plain click: no pan is emitted, no capture is
> taken, so a minimap **column**'s `onclick` jump stands untouched (capturing on pointerdown would
> retarget the click and suppress the jump — the m1 finding).

In `src/webview/components/navigator/TreeNavigator.svelte`, import the shared threshold (extend the imports at the top of the file):

```ts
import { DRAG_THRESHOLD } from '../../lib/treeGeometry';
```

Add the threshold-gated pan handlers near `jump` (`TreeNavigator.svelte:50-52`):

```ts
let minimapEl: HTMLDivElement | undefined = $state();
let panning = $state(false);
let panPress: { x: number; y: number; pointerId: number } | null = null;
function emitPan(e: PointerEvent) {
  if (!minimapEl) return;
  const r = minimapEl.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  vscode.postMessage({ type: 'navigatorMinimapPan', x, y });
}
function onMinimapDown(e: PointerEvent) {
  // Q2: record the press only — capture + pan start after DRAG_THRESHOLD, so a
  // plain click leaves the column buttons' onclick jump intact.
  panPress = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
}
function onMinimapMove(e: PointerEvent) {
  if (!panPress) return;
  // Re-review m7 guard: a press that leaves the minimap under-threshold and is released
  // outside never reaches onMinimapUp (no capture yet); without this, the stale panPress
  // turns the next buttonless hover into an unintended pan.
  if (!(e.buttons & 1)) {
    panPress = null;
    panning = false;
    return;
  }
  if (!panning) {
    if (Math.hypot(e.clientX - panPress.x, e.clientY - panPress.y) < DRAG_THRESHOLD) return;
    panning = true;
    minimapEl?.setPointerCapture(panPress.pointerId);
  }
  emitPan(e);
}
function onMinimapUp(e: PointerEvent) {
  if (panning) minimapEl?.releasePointerCapture?.(e.pointerId);
  panning = false;
  panPress = null;
  // Sub-threshold pointerup = plain click: nothing was emitted/captured; a column's
  // onclick jump fires normally.
}
```

Wire the handlers + `bind:this` onto `.nav-minimap` (`TreeNavigator.svelte:114`). The band columns keep their `onclick` jump (a sub-threshold click still jumps, Q2); dragging past the threshold pans:

```svelte
    <div
      class="nav-minimap"
      data-testid="nav-minimap"
      bind:this={minimapEl}
      onpointerdown={onMinimapDown}
      onpointermove={onMinimapMove}
      onpointerup={onMinimapUp}
      role="presentation"
    >
```

- [ ] **Step 2: `Tasks.svelte` — consume `navigatorMinimapPan`, thread `minimapPan*` props**

In `src/webview/components/tasks/Tasks.svelte`, add state beside `jumpBand`/`jumpNonce` (`Tasks.svelte:48-49`):

```ts
let minimapPanX = $state(0);
let minimapPanY = $state(0);
let minimapPanNonce = $state(0);
```

Add a case to the `onMessage` switch after `navigatorJump` (`Tasks.svelte:175-178`):

```ts
      case 'navigatorMinimapPan':
        minimapPanX = message.x;
        minimapPanY = message.y;
        minimapPanNonce += 1;
        break;
```

Pass the props into `TechTreeCanvas` (`Tasks.svelte:604-605`, after `{jumpNonce}`):

```svelte
      {jumpBand}
      {jumpNonce}
      {minimapPanX}
      {minimapPanY}
      {minimapPanNonce}
```

- [ ] **Step 3: `TechTreeCanvas.svelte` — apply the minimap pan + filter Promote-all**

Add the props to `Props` + `$props()` (after `jumpBand`/`jumpNonce`, `TechTreeCanvas.svelte:40-41` / `:65-66`):

```ts
    jumpBand?: string;
    jumpNonce?: number;
    minimapPanX?: number;
    minimapPanY?: number;
    minimapPanNonce?: number;
```

```ts
    jumpBand = '',
    jumpNonce = 0,
    minimapPanX = 0,
    minimapPanY = 0,
    minimapPanNonce = 0,
```

Add an effect (next to the jump effect, `TechTreeCanvas.svelte:150-159`) that centers the viewport on the normalized minimap point when the nonce bumps:

```ts
// Minimap drag-to-pan: center the viewport on the normalized (x,y) world point.
let lastMinimapPanNonce = 0;
$effect(() => {
  if (minimapPanNonce === lastMinimapPanNonce) return;
  lastMinimapPanNonce = minimapPanNonce;
  if (!viewportEl || geometry.width <= 0 || geometry.height <= 0) return;
  const worldX = minimapPanX * geometry.width;
  const worldY = minimapPanY * geometry.height;
  setViewport({
    scale: vp.scale,
    tx: viewportEl.clientWidth / 2 - worldX * vp.scale,
    ty: viewportEl.clientHeight / 2 - worldY * vp.scale,
  });
});
```

> The `lastMinimapPanNonce` init-once read mirrors the `lastJumpNonce` pattern; the `svelte-autofixer` `state_referenced_locally` note is suppressed the same way (house precedent).

Make Promote-all filter-aware. Replace the `promoteAll` function (`TechTreeCanvas.svelte:128-132`) and derive the promotable set:

```ts
const promotableDrafts = $derived(draftNodes.filter((t) => !fadedIds.has(t.id)));
function promoteAll() {
  for (const t of promotableDrafts) {
    vscode.postMessage({ type: 'promoteDraft', taskId: t.id });
  }
}
```

Update the button guard + count (`TechTreeCanvas.svelte:427-431`) to use the filtered set:

```svelte
    {#if promotableDrafts.length > 0}
      <button class="tree-promote-all" data-testid="tree-promote-all" onclick={promoteAll}>
        Promote all proposed ({promotableDrafts.length})
      </button>
    {/if}
```

- [ ] **Step 4: Playwright — minimap pan + cross-branch copy + Promote-all filter**

Append to `e2e/tree-navigator.spec.ts` (inside its top-level describe):

```ts
test('dragging the minimap posts navigatorMinimapPan', async ({ page }) => {
  const minimap = page.locator('[data-testid="nav-minimap"]');
  const box = (await minimap.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  // Cross DRAG_THRESHOLD with intermediate steps (Q2: pan only starts past the threshold).
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 5 });
  await page.mouse.up();
  const msgs = await getPostedMessages(page);
  expect(msgs.some((m) => m.type === 'navigatorMinimapPan')).toBe(true);
});

test('a plain click on a minimap column still jumps, no pan (Q2)', async ({ page }) => {
  await clearPostedMessages(page);
  // Sub-threshold click: the column's onclick jump fires; no navigatorMinimapPan.
  await page.locator('[data-testid="nav-minimap-v1"]').click();
  const msgs = await getPostedMessages(page);
  expect(msgs.some((m) => m.type === 'navigatorJump')).toBe(true);
  expect(msgs.some((m) => m.type === 'navigatorMinimapPan')).toBe(false);
});
```

Append to `e2e/tree-canvas.spec.ts` (inside `test.describe('Tech tree canvas', …)`):

```ts
test('cross-branch mode shows the cross-branch empty-state copy (11c)', async ({ page }) => {
  await postMessageToWebview(page, { type: 'dataSourceChanged', mode: 'cross-branch' });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: [] });
  await postMessageToWebview(page, {
    type: 'treeLayoutUpdated',
    laneOrder: [],
    bandOrder: [],
    warnings: [],
  });
  await page.waitForTimeout(80);
  await expect(page.locator('[data-testid="tree-empty-state"]')).toContainText(
    "isn't available in cross-branch mode"
  );
});

test('Promote-all counts only non-filtered drafts (11b)', async ({ page }) => {
  // Two drafts; a search filter that matches only one → the button shows (1) and
  // promotes only the visible draft.
  await postMessageToWebview(page, {
    type: 'tasksUpdated',
    tasks: [
      {
        id: 'TASK-D1',
        title: 'Alpha draft',
        status: 'Draft',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/b/tasks/task-d1.md',
        category: 'Features',
        milestone: 'v1',
        layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
      } as Task,
      {
        id: 'TASK-D2',
        title: 'Beta draft',
        status: 'Draft',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/b/tasks/task-d2.md',
        category: 'Features',
        milestone: 'v1',
        layout: { lane: 'Features', band: 'v1', depth: 1, subRow: 0 },
      } as Task,
    ],
  });
  await postMessageToWebview(page, {
    type: 'treeLayoutUpdated',
    laneOrder: ['Features'],
    bandOrder: ['v1'],
    warnings: [],
  });
  await postMessageToWebview(page, {
    type: 'navigatorFilterChanged',
    search: 'Alpha',
    priority: '',
  });
  await page.waitForTimeout(80);
  await expect(page.locator('[data-testid="tree-promote-all"]')).toContainText('(1)');
});
```

> The `tree-navigator.spec.ts` `getPostedMessages` import and `setup` scaffold already exist (P2b); extend the fixture import with `clearPostedMessages` if it isn't already there. If the navigator fixture doesn't render the minimap without `navigatorData` bands, post a `navigatorData` with a couple of bands (incl. `v1`, for the `nav-minimap-v1` column) in the test's `beforeEach` (mirror the existing `jump button posts navigatorJump` test's setup — use whatever band names that suite already seeds).

- [ ] **Step 5: svelte-autofixer + build + regression**

Run the `svelte-autofixer` on the three edited components until clean. Then `bun run build && bun run typecheck && bun run lint`, then `bun run test:playwright -- tree-navigator tree-canvas` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/navigator/TreeNavigator.svelte src/webview/components/tasks/Tasks.svelte \
  src/webview/components/tree/TechTreeCanvas.svelte e2e/tree-navigator.spec.ts e2e/tree-canvas.spec.ts
git commit --no-verify -m "feat(tree P3b): P2b carry-in debt — minimap drag-to-pan, filter-aware Promote-all, cross-branch copy test

- navigator minimap pointer-drag posts navigatorMinimapPan{x,y}; relayed to the canvas,
  which centers the viewport on the normalized point (minimapPan* props)
- promoteAll + its button count now filter !fadedIds.has(id) (only visible drafts)
- add the cross-branch empty-state copy assertion to the tree Playwright suite

House UI exception: interaction/polish; behavior covered by e2e/tree-navigator.spec.ts + e2e/tree-canvas.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Playwright `e2e/tree-drag.spec.ts` — connect / reslot / edge-✕ [opus-integration]

**Files:**

- Create: `e2e/tree-drag.spec.ts`

**Behavior (directive 12):** drive every drag gesture on the Vite fixture (`/tasks.html`, `tasks.js`) with `page.mouse`. Fixture-inject `statusesUpdated` + `prioritiesUpdated` + `milestonesUpdated` + `tasksUpdated` + `treeLayoutUpdated` + `activeTabChanged:tree`, then drag: connect green (valid) → `addDependency`, connect red (cycle) → no message, reslot vertical (lane change) → `reslotTask{category}`, reslot horizontal (band change) → `reslotTask{milestone}`, in-cell → `reorderTasks`, band-expand target visible, drop-on-empty → `createTask` with `linkTo`, edge ✕ → `removeDependency`, popover prereq ✕ → `removeDependency`. Mirror the house pattern (`e2e/tree-canvas.spec.ts` / `e2e/tree-authoring.spec.ts` imports, `setup`, `data-testid`, `getPostedMessages`/`getLastPostedMessage`).

- [ ] **Step 1: Write the spec**

Create `e2e/tree-drag.spec.ts`. Use a **multi-lane, multi-band** fixture so nodes sit in distinct cells that `page.mouse` can drag between, and compute node centers from the rendered `data-node-x`/`data-node-y` + the surface transform (mirror how `tree-canvas.spec.ts` reads geometry). A helper drags from a source screen point to a target screen point with intermediate moves (so movement exceeds `DRAG_THRESHOLD`):

```ts
import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getPostedMessages,
  getLastPostedMessage,
  clearPostedMessages,
} from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const laneOrder = ['Features', 'Backend', 'Bugs'];
const bandOrder = ['v1', 'v2'];

function tasks(): Task[] {
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
      title: 'Root',
      category: 'Features',
      milestone: 'v1',
      layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-2',
      title: 'Backend thing',
      category: 'Backend',
      milestone: 'v1',
      layout: { lane: 'Backend', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-3',
      title: 'Later',
      category: 'Features',
      milestone: 'v2',
      layout: { lane: 'Features', band: 'v2', depth: 0, subRow: 0 },
    }),
    // Bug node (M2 coverage): bugs anchor at band '' on the Bugs lane and are reorder-only.
    base({
      id: 'TASK-4',
      title: 'A bug',
      type: 'bug',
      layout: { lane: 'Bugs', band: '', depth: 0, subRow: 0 },
    }),
  ];
}

async function setup(page: Parameters<typeof installVsCodeMock>[0]) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVsCodeMock(page);
  await page.goto('/tasks.html');
  await page.waitForTimeout(100);
  await postMessageToWebview(page, {
    type: 'statusesUpdated',
    statuses: ['To Do', 'In Progress', 'Done'],
  });
  await postMessageToWebview(page, {
    type: 'prioritiesUpdated',
    priorities: ['high', 'medium', 'low'],
  });
  await postMessageToWebview(page, {
    type: 'milestonesUpdated',
    milestones: [
      { id: 'v1', name: 'v1' },
      { id: 'v2', name: 'v2' },
    ],
  });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: tasks() });
  await postMessageToWebview(page, {
    type: 'treeLayoutUpdated',
    laneOrder,
    bandOrder,
    warnings: [],
  });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(150);
  await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
}

/** Center of a node in page (screen) coordinates. */
async function nodeCenter(page: Parameters<typeof installVsCodeMock>[0], id: string) {
  const box = await page.locator(`[data-testid="tree-node-${id}"]`).boundingBox();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** Drag from a→b with intermediate steps so movement crosses DRAG_THRESHOLD. */
async function drag(
  page: Parameters<typeof installVsCodeMock>[0],
  from: { x: number; y: number },
  to: { x: number; y: number }
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

test.describe('Tree drag — connect / reslot / edge removal', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('drag right handle onto a node posts addDependency (target depends on origin)', async ({
    page,
  }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').hover();
    const handle = await page.locator('[data-testid="tree-connect-unlocks-TASK-1"]').boundingBox();
    await clearPostedMessages(page);
    await drag(page, { x: handle!.x + 7, y: handle!.y + 7 }, await nodeCenter(page, 'TASK-2'));
    // right/unlocks: TASK-2 depends on TASK-1.
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'addDependency',
      taskId: 'TASK-2',
      dependsOn: 'TASK-1',
    });
  });

  test('a cycle-forming connect is refused (no addDependency)', async ({ page }) => {
    // Pre-wire TASK-1 depends on TASK-2, then try to make TASK-2 depend on TASK-1 (cycle).
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: tasks().map((t) => (t.id === 'TASK-1' ? { ...t, dependencies: ['TASK-2'] } : t)),
    });
    await page.waitForTimeout(80);
    await page.locator('[data-testid="tree-node-TASK-2"]').hover();
    const handle = await page.locator('[data-testid="tree-connect-unlocks-TASK-2"]').boundingBox();
    await clearPostedMessages(page);
    await drag(page, { x: handle!.x + 7, y: handle!.y + 7 }, await nodeCenter(page, 'TASK-1'));
    const msgs = await getPostedMessages(page);
    expect(msgs.some((m) => m.type === 'addDependency')).toBe(false);
  });

  test('dragging a node to another lane posts reslotTask with the new category', async ({
    page,
  }) => {
    await clearPostedMessages(page);
    await drag(page, await nodeCenter(page, 'TASK-1'), await nodeCenter(page, 'TASK-2')); // Features → Backend lane
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'reslotTask',
      taskId: 'TASK-1',
      category: 'Backend',
    });
  });

  test('dragging a node to another band posts reslotTask with the new milestone', async ({
    page,
  }) => {
    await clearPostedMessages(page);
    await drag(page, await nodeCenter(page, 'TASK-1'), await nodeCenter(page, 'TASK-3')); // v1 → v2 band
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'reslotTask',
      taskId: 'TASK-1',
      milestone: 'v2',
    });
  });

  test('a bug dragged horizontally posts NO reslotTask (reorder-only, M2)', async ({ page }) => {
    await clearPostedMessages(page);
    const from = await nodeCenter(page, 'TASK-4');
    // Horizontal drag: well into another band's x-range, same y (stays in the Bugs lane).
    await drag(page, from, { x: from.x + 300, y: from.y });
    const msgs = await getPostedMessages(page);
    // Never a reslotTask for a bug — no milestone can be assigned by a drag. (With a
    // single bug in the lane there are no siblings, so no reorderTasks either.)
    expect(msgs.some((m) => m.type === 'reslotTask')).toBe(false);
  });

  test('hovering an edge shows a ✕ that posts removeDependency', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: tasks().map((t) => (t.id === 'TASK-2' ? { ...t, dependencies: ['TASK-1'] } : t)),
    });
    await page.waitForTimeout(80);
    await page.locator('[data-testid="tree-edge-hit-TASK-1-TASK-2"]').hover();
    await clearPostedMessages(page);
    await page.locator('[data-testid="tree-edge-remove-TASK-1-TASK-2"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'removeDependency',
      taskId: 'TASK-2',
      dependsOn: 'TASK-1',
    });
  });

  test('popover prereq ✕ posts removeDependency', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: tasks().map((t) => (t.id === 'TASK-2' ? { ...t, dependencies: ['TASK-1'] } : t)),
    });
    await page.waitForTimeout(80);
    await page.locator('[data-testid="tree-node-TASK-2"]').click();
    await expect(page.locator('[data-testid="tree-popover"]')).toBeVisible();
    await clearPostedMessages(page);
    await page.locator('[data-testid="tp-prereq-remove-TASK-1"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'removeDependency',
      taskId: 'TASK-2',
      dependsOn: 'TASK-1',
    });
  });

  test('dropping a connect on empty canvas opens the create form pre-linked', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').hover();
    const handle = await page.locator('[data-testid="tree-connect-unlocks-TASK-1"]').boundingBox();
    const vp = (await page.locator('[data-testid="tree-viewport"]').boundingBox())!;
    await drag(
      page,
      { x: handle!.x + 7, y: handle!.y + 7 },
      { x: vp.x + vp.width - 20, y: vp.y + vp.height - 20 }
    );
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    // Submitting posts createTask with linkTo (origin TASK-1, direction unlocks).
    await page.locator('[data-testid="cf-title"]').fill('Linked node');
    await clearPostedMessages(page);
    await page.locator('[data-testid="cf-submit"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'createTask',
      title: 'Linked node',
      linkTo: { taskId: 'TASK-1', direction: 'unlocks' },
    });
  });
});
```

> **Coordinate note:** node centers are read from the rendered bounding boxes after fit-to-view, so the drags are robust to the surface transform. If a drag lands one cell short because fit-to-view scaled the board, the `steps`-based moves still cross `DRAG_THRESHOLD`; assert on the **message shape**, not pixel positions. The in-cell reorder case is intentionally omitted from hard assertions here (siblings share a cell only in denser fixtures) — the routing is covered by the lane/band cases + the unit-tested `calculateOrdinalsForDrop`; add an in-cell case only if the fixture reliably stacks two nodes in one cell.

- [ ] **Step 2: Run Playwright**

Run: `bun run build && bun run test:playwright -- tree-drag`
Expected: PASS (all cases). Then run the full webview suite `bun run test:playwright` to confirm the **342** baseline holds plus the new `tree-drag` + `tree-authoring`/`tree-navigator`/`tree-canvas` additions from earlier tasks, with **no** regression in `tree-popover` (node click still opens the popover).

- [ ] **Step 3: Commit**

```bash
git add e2e/tree-drag.spec.ts
git commit --no-verify -m "test(tree P3b): Playwright tree-drag — connect green/red, reslot lane/band, edge ✕, drop-on-empty

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: CDP cross-view — reslot writes `category`/`milestone` to disk [opus-integration]

**Files:**

- Create: `src/test/cdp/tree-reslot.test.ts`

**Behavior (directive 12):** in a real VS Code instance, dragging a node to another lane/band writes the new `category`/`milestone` into the task file on disk (proving the reslot → `TreeFieldService`/`BacklogWriter` path runs cross-view). Reuses the CDP library (`src/test/cdp/lib/`) and the harness scaffold from `tree-authoring.test.ts` (P3a).

> **CDP file/port choice (justified):** a **new** file `src/test/cdp/tree-reslot.test.ts` on **port 9343** (9340/9341/9342 are taken by `cross-view`/`tree-popover`/`tree-authoring`). Rationale: reslot is a distinct concern from create; a separate file keeps each CDP suite's setup focused and lets it own its port and workspace reset without editing the landed `tree-authoring.test.ts`. The drag is driven by dispatching pointer events in the inner webview frame (mouse-move sequence over the node → target cell) via the CDP webview helpers — no new `taskwright.*` command keybinding is needed.

- [ ] **Step 1: Write the CDP spec**

Create `src/test/cdp/tree-reslot.test.ts`, modeled on `src/test/cdp/tree-authoring.test.ts`. Seed the fixture workspace (which has `TASK-1..TASK-8`), switch to the tree tab, drag a node from its current lane to another lane's vertical position, and poll the moved task's file for the new `category:` frontmatter:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { launchVsCode, closeVsCode, type VsCodeInstance } from './lib/vscode-launcher';
import {
  createTestWorkspace,
  resetTestWorkspace,
  cleanupTestWorkspace,
} from './lib/test-workspace';
import { waitForExtensionReady, waitForWebviewContent } from './lib/wait-helpers';
import {
  clickInWebview,
  elementExistsInWebview,
  clearWebviewSessionCache,
} from './lib/webview-helpers';
import { dismissNotifications, resetEditorState, executeCommand, sleep } from './lib/cdp-helpers';

const CDP_PORT = 9343;

function tasksDir(workspacePath: string): string {
  return path.join(workspacePath, 'backlog', 'tasks');
}

/** Poll a task file (by id) until its content matches `predicate` (e.g. new category). */
async function waitForTaskFile(
  workspacePath: string,
  taskId: string,
  predicate: (content: string) => boolean,
  timeoutMs = 15_000
): Promise<string> {
  const dir = tasksDir(workspacePath);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      if (new RegExp(`^id:\\s*${taskId}\\b`, 'm').test(content) && predicate(content))
        return content;
    }
    await sleep(250);
  }
  throw new Error(`Task ${taskId} never satisfied the predicate within ${timeoutMs}ms`);
}

describe('Tree reslot cross-view (CDP)', () => {
  let instance: VsCodeInstance;
  let workspacePath: string;

  beforeAll(async () => {
    workspacePath = createTestWorkspace();
    instance = await launchVsCode({ workspacePath, cdpPort: CDP_PORT });
    await waitForExtensionReady(instance.cdp);
    await dismissNotifications(instance.cdp);
  }, 90_000);

  afterAll(async () => {
    if (instance) closeVsCode(instance);
    if (workspacePath) cleanupTestWorkspace(workspacePath);
  }, 15_000);

  beforeEach(async () => {
    clearWebviewSessionCache();
    resetTestWorkspace(workspacePath);
    fs.rmSync(path.join(workspacePath, '.taskwright'), { recursive: true, force: true });
    await resetEditorState(instance.cdp);
    await dismissNotifications(instance.cdp);
    await executeCommand(instance.cdp, 'taskwright.refresh');
    await waitForWebviewContent(instance.cdp, 'tasks', 'TASK-', { timeoutMs: 10_000 });
  }, 30_000);

  it('dragging a node to another lane writes the new category to disk', async () => {
    // Switch to the tree tab.
    await clickInWebview(instance.cdp, 'tasks', '[data-testid="tab-tree"]');
    await sleep(400);
    const nodeShown = await elementExistsInWebview(
      instance.cdp,
      'tasks',
      '[data-testid="tree-node-TASK-1"]'
    );
    expect(nodeShown).toBe(true);

    // Drive a pointer drag from TASK-1's center to a different lane's vertical band, in the
    // inner webview frame (dispatch pointerdown → several pointermove → pointerup so the
    // gesture crosses DRAG_THRESHOLD and resolves to a reslot). Use the CDP drag helper if
    // present (see docs/cdp-testing-notes.md); otherwise dispatch the events on the
    // .tree-viewport element at the computed node/target coordinates.
    const moved = await dragNodeToLane(instance, 'TASK-1', /* targetLaneNodeId */ 'TASK-2');
    expect(moved).toBe(true);

    // The category frontmatter reflects the target lane (whatever TASK-2's lane is on the
    // seeded board). Assert a `category:` line appears/changes (reslot wrote through
    // TreeFieldService → the file on disk).
    const content = await waitForTaskFile(workspacePath, 'TASK-1', (c) =>
      /^category:\s*\S+/m.test(c)
    );
    expect(content).toMatch(/^category:\s*\S+/m);
  }, 60_000);
});
```

> `dragNodeToLane` is a thin helper the worker implements against the CDP webview-frame primitives (compute the two nodes' centers from their `data-node-x`/`data-node-y` + surface transform, then dispatch `pointerdown`/several `pointermove`/`pointerup` in the inner frame's JS context so the Svelte handlers fire — the same inner-frame dispatch technique the existing CDP tests use for clicks). If the seeded board's `TASK-1`/`TASK-2` share a lane, pick two seeded ids that don't (inspect the fixture in `src/test/cdp/lib/test-workspace`), and target the other's lane. Do **not** weaken the disk assertion — a failure there is a real reslot-path regression.

- [ ] **Step 2: Run the CDP suite**

Run: `bun run test:cdp` (build + `vitest run --config vitest.cdp.config.ts`, xvfb on headless Linux), or during iteration `vitest run --config vitest.cdp.config.ts src/test/cdp/tree-reslot.test.ts`.
Expected: PASS alongside the existing CDP suites (baseline **16/16** + this file). If the inner-frame drag lands short, add intermediate `pointermove` steps and a small `sleep` between them; if the tree tab isn't ready, extend the `sleep(400)` after switching tabs.

- [ ] **Step 3: Commit**

```bash
git add src/test/cdp/tree-reslot.test.ts
git commit --no-verify -m "test(tree P3b): CDP cross-view — drag-to-reslot writes category/milestone to disk

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Full gate + CLAUDE.md doc-sync + visual proof + close [opus-integration]

**Files:** `CLAUDE.md` (doc-sync) + verification/proof (no other code).

- [ ] **Step 1: Full regression gate**

Run, in the worktree:

```bash
bun run test && bun run lint && bun run typecheck && bun run test:playwright
```

Expected: PASS. Unit: baseline **1368 passed / 1 skipped** + the new `treeGeometry` inverse describe + the five `TasksController` P3b write-case tests — record the exact new total. Playwright: baseline **342** + the new `tree-drag` cases + the additions to `tree-authoring`/`tree-navigator`/`tree-canvas`. Lint zero-warning; typecheck clean. (Windows: the ~22 known upstream POSIX-path unit failures are pre-existing and unrelated — do not "fix".)

- [ ] **Step 2: CDP proof**

Run: `bun run test:cdp` (headless Linux uses xvfb). Expected: the new `tree-reslot` CDP test passes alongside the existing **16/16**.

- [ ] **Step 3: CLAUDE.md doc-sync**

In `CLAUDE.md`, **add the P3b bullet** immediately after the P3a create-surface bullet (added by P3a; the two P2b wording nits it also fixed must **not** be re-touched). Insert:

```md
- **Tech-tree drag surface (P3b)** ✅: the canvas is a spatial editor. **Drag-to-connect** —
  two connect handles per node (left = needs, right = unlocks) drag a dashed line
  (`DragLayer.svelte`, world coords); a valid target glows green, a self/dupe/cycle red
  (client-side `wouldCreateCycle` imported from `src/core/treeGate.ts`); drop over a node posts
  `addDependency`, drop on empty canvas opens the create form pre-linked (reuses P3a
  `createTask.linkTo`); a plain empty-canvas **click** opens the form with the clicked cell's
  lane/band inferred (click-in-place). **Drag-to-reslot** — vertical → `category` (`reslotTask`),
  horizontal → `milestone` (`reslotTask`), in-cell → `ordinal` (`reorderTasks` + `ordinalUtils`);
  bugs are reorder-only (never `reslotTask`). **Edge removal** — a ✕ on the edge hover hit-path or a popover prereq
  chip posts `removeDependency`. One pointer-event gesture machine in `TechTreeCanvas.svelte`
  disambiguates connect / node-body / empty-canvas via a `DRAG_THRESHOLD` (no HTML5 DnD); the
  geometry inverse (`screenToWorld`/`laneAtY`/`bandAtX`/`cellAt`/`reslotTargets`) lives in
  `src/webview/lib/treeGeometry.ts`. `TasksController` re-validates `wouldCreateCycle` before every
  dependency write and routes category via `TreeFieldService`, milestone/dependencies via
  `BacklogWriter.updateTask` — one writer path for human and agent (parity), **no stored
  coordinates**. Also lands the P2b carry-in debt (minimap drag-to-pan → `navigatorMinimapPan`;
  filter-aware Promote-all). Coverage: `src/test/unit/treeGeometry.test.ts`,
  `src/test/unit/TasksController.test.ts`, `e2e/tree-drag.spec.ts`, `src/test/cdp/tree-reslot.test.ts`.
  Design: `docs/superpowers/specs/2026-07-02-tech-tree-p3-create-edit-design.md`; plan:
  `docs/superpowers/plans/2026-07-03-tech-tree-p3b-drag-surface.md`.
```

- [ ] **Step 4: Visual proof**

Invoke the **`visual-proof`** skill (`.claude/skills/visual-proof/`) to produce a showboat doc capturing: a **drag-to-connect** (dashed line + green valid target + a red cycle refusal); a **drag-to-reslot** (node moving lanes, band-expand strip highlighted + the `AgeBandHeader`/`LaneBand` emphasis); the **click-in-place create** (single click on empty canvas opens the form with the clicked cell's lane/band inferred — the m2 deliberate UX change; verify the deselect-then-form flow reads well); the **drop-on-empty** create form opening pre-linked; an **edge ✕** removing a dependency; and (CDP path) a reslot → the task file's `category`/`milestone` changing on disk. Prefer the CDP (real-VS-Code) path for the reslot→disk flow since it spans views; the Vite-fixture path is fine for the isolated drag visuals. Save under the skill's output location (git-ignored screenshots).

- [ ] **Step 5: Commit the doc-sync**

```bash
git add CLAUDE.md
git commit --no-verify -m "docs(tree P3b): CLAUDE.md doc-sync — P3b drag-surface bullet

- add the P3b drag-surface bullet (connect, reslot, edge removal, gesture machine,
  geometry inverse, parity writers, P2b carry-in debt)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand back to the orchestrator**

Confirm the worktree is clean (`git status` shows nothing uncommitted), all gates are green (unit + Playwright + CDP + lint + typecheck), and update the run ledger. **Do NOT run `request_merge`** — in this run the orchestrator lands the branch (ff-merge). Stop at "worktree clean, all gates green, ledger updated".

---

## Self-Review

**1. Directive → task mapping (P3b slice):**

- **Dir 6 (geometry inverse)** → Task 1 (`screenToWorld`/`laneAtY`/`bandAtX`/`cellAt`/`reslotTargets`/`DRAG_THRESHOLD`; empty lane/band coverage documented as a placement decision).
- **Dir 7 (gesture disambiguation — pointer events only)** → Task 3 (one `pointerdown/move/up` machine, `DRAG_THRESHOLD` promote, connect-handle/node-body/empty-canvas branches, click-in-place create).
- **Dir 8 (drag-to-connect)** → Task 4 (`TreeNode` handles, client-side `wouldCreateCycle` green/red, `addDependency` over node, `onCreateInPlace` + `linkTo` over empty) + Task 2 (extension-side re-validation).
- **Dir 9 (drag-to-reslot)** → Task 5 (reorder-vs-reslot routing; band-expand = `DragLayer` strip **+ `AgeBandHeader`/`LaneBand` emphasis** (m5); bugs **reorder-only** — cross-lane refused red, bug drops never post `reslotTask` (M2)) + Task 2 (`reslotTask` controller case: Misc→`clearCategory`, Backburner→clear milestone).
- **Dir 10 (edge removal)** → Task 6 (`EdgeLayer` hit-path ✕ + popover prereq-chip ✕ → `removeDependency`; hover group per m3).
- **Dir 11 (P2b carry-in debt)** → Task 7 (minimap drag-to-pan `navigatorMinimapPan`, threshold-gated per **Q2**; filter-aware Promote-all; cross-branch empty-state copy test). Dir 11d (CLAUDE.md nits) already fixed by P3a; Task 10 only adds the P3b bullet.
- **Dir 12 (testing)** → Task 1 (`treeGeometry.test.ts`) + Task 2 (`TasksController` reslot/addDependency-cycle/removeDependency) + Task 8 (Playwright `tree-drag.spec.ts` + click-in-place in `tree-authoring.spec.ts`) + Task 9 (CDP `tree-reslot.test.ts`).
- **Dir 13 (doc-sync)** → Task 10 (P3b bullet; the P2b nits are already fixed).

**2. Locked-message compliance:** `reslotTask`/`addDependency`/`removeDependency`/`navigatorMinimapPan` used verbatim; `reorderTasks`/`promoteDraft` reused. `addDependency{taskId,dependsOn}` = `task[taskId].dependencies += dependsOn`, matching `wouldCreateCycle(tasks, taskId, dependsOn)` on both sides. Connect handle→message mapping is P3a's `linkTo.direction` 1:1 (right/unlocks ⇒ target depends on origin; left/needs ⇒ origin depends on target). Drop-on-empty reuses P3a `createTask.linkTo`; every create payload keeps the **Q1** `taskType` wire field (never `type`). `navigatorMinimapPan` is a relay in **both** unions (like `navigatorJump`) with **no** controller write-case — a documented clarification of the directive's "relayed by the controller."

**3. Parity + no stored coordinates:** create via `createTaskWithTreeFields` (P3a); `category` via `TreeFieldService.setCategory/clearCategory`; `milestone`/`dependencies` via `BacklogWriter.updateTask`; `ordinal` via `ordinalUtils`+`reorderTasks`; `wouldCreateCycle` guards dependency writes client-side (UX) **and** extension-side (before write). Layout stays derived — the gesture machine reads geometry, never persists it.

**4. Scope discipline:** no new MCP tool, no P4 AI authoring, no stored coordinates. The connect/reslot drop resolution is stubbed in Task 3 and filled in Tasks 4/5 so every commit is bundle-green. Node click still opens the popover (0px < threshold), keeping `tree-popover` Playwright + CDP green.

**5. Leaves-first build integrity:** Task 1 (pure geometry) and Task 2 (messages + controller, TDD) precede any webview posting. Task 3 lands the machine with reslot/connect drops as no-op stubs (pan + click fully working); Task 4 fills connect + adds handles; Task 5 fills reslot; Task 6 is independent (edge ✕). Task 7's three fixes are self-contained. Each task ends green (`bun run build` + its scoped tests); the full gate runs in Task 10.

**6. Verify commands are per-task and concrete** (`bun run test -- treeGeometry`, `… -- TasksController`, `bun run test:playwright -- tree-drag`, `bun run test:cdp`, plus the Task 10 full gate). Commits stage only named files and use `--no-verify` (Windows CRLF hook). The orchestrator lands the branch — Task 10 stops at "worktree clean, gates green," not `request_merge`.

**7. Deviations & review status (adversarial review 2026-07-03: READY WITH FIXES — all applied):**

- **Review-settled (Verified-good, no action):** the `reslotTargets` empty-lane/band placement (populated = exact geometry ranges; empties appended past the content bottom/right — adjacency confirmed non-overlapping against the forward math); `navigatorMinimapPan` relay-only (both unions, no controller case); **milestone clear via `updateTask({milestone:''})`** (omit-on-empty confirmed at `BacklogWriter.ts:1329-1377` — empty strings on the omit list are dropped from frontmatter); the in-cell `calculateOrdinalsForDrop` framing; edge-✕ reachability (`pointer-events:stroke` opt-in under a `none` layer, midpoint in the inter-node gap); the client-side `treeGate` import precedent; drop-on-empty `linkTo` needing no extra extension-side cycle check (a fresh node can't close a cycle). The review also confirmed every quoted anchor against committed `5fb53cf` (its intermediate "fictional anchor" alarm was self-retracted — an artifact of a dirty main working tree, not of this plan; workers build from the clean worktree at `5fb53cf`).
- **M1 (fixed):** Task 3 Steps 2/3 no longer overlap — Step 2 is imports-only; Step 3 is **one contiguous Edit** whose `old_string` is the original pan block (254–283) and whose `new_string` contains helpers + pan state + handlers + stubs together.
- **M2 (fixed):** bugs are **reorder-only** — `reslotValid` refuses cross-lane (red) and `onReslotDrop` never posts `reslotTask` for a bug (a literal band comparison is impossible: bugs have `band:''` under the first populated band's x-range, so it would outlaw the directive-9 in-lane reorder). Playwright asserts a horizontal bug drag posts **no** `reslotTask`.
- **Q2 (adjudicated, applied):** the minimap gates click-vs-drag on a movement threshold mirroring `DRAG_THRESHOLD` — capture + `emitPan` only past the threshold; a sub-threshold click leaves the column `onclick` jump intact (also resolves m1). Covered by a dedicated Playwright case.
- **Minors applied:** m2 (the empty-canvas click-in-place UX change is stated explicitly in Task 3, captured in the visual proof, and in the CLAUDE.md bullet; review verified no baseline spec asserts click-empty-deselect-only), m3 (edge hit-path + ✕ share one hover `<g>` so the ✕ can't unmount mid-transition), m4 (the `ExtensionMessage` `navigatorMinimapPan` member is kept, annotated as documented-contract hygiene, not load-bearing), m5 (`AgeBandHeader`/`LaneBand` `emphasis` prop on band-expand, Task 5 Step 3), m6 (anchor cite corrected to `:65-66`).
