# Tech-tree P2b — Interaction Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the P2a canvas from a read-only picture into the **interaction shell**: click a node to open a **state-aware detail popover** that makes the task the **ephemeral active task** and drives claim/dispatch/force-claim/mark-done/release/cancel-dispatch/approve/send-back through the **same cores/commands the MCP tools use**; add a sidebar **navigator** WebviewView (search, priority chips, lane toggles, age jump, minimap) that filters/collapses/jumps the canvas; an in-canvas **in-flight panel** (active + merge queue with Approve/Send-back); a **milestone popover** with a file-backed **release checklist**; **promote** actions for draft nodes; the P1 **plan-progress** enrichment on the board bus; the **details-page rework** (DoD leaves the task UI); and cross-view **CDP** proof. Kanban/list/dashboard stay untouched.

**Scope boundary (P2b).** This plan implements the P2 directives §P2b items 1–10 and the orchestrator adjudications. It does **not** add create-on-canvas, drag-to-connect, bug intake (P3), the P5 cancellation-marker protocol (one documented TODO hook only), or any new MCP tools (P4). Human/agent **parity** is mandatory: every popover/panel action calls the same core/service the MCP tools use — no duplicated business logic.

**Architecture:** The canvas (`Tasks.svelte` → `TechTreeCanvas.svelte`) already renders P1 layout from `tasksUpdated` enrichment + the locked `treeLayoutUpdated`. P2b adds (a) two board-bus enrichments in `TasksController.refresh()` (`planProgress`, `claimedByMe`) plus a `prioritiesUpdated` message; (b) a `DetailPopover.svelte` anchored to a node that emits action intents and toggles ephemeral active via `popoverActiveChanged`; (c) new inbound cases in `TasksController.handleMessage` that delegate to existing/added VS Code commands (parity); (d) a new `taskwright.treeNavigator` WebviewView with its own Vite bundle entry, relayed to the canvas through the extension; (e) an `InFlightPanel`, a `MilestonePopover` backed by a new pure core `src/core/releaseChecklist.ts`; and (f) the details-page rework in `TaskDetail.svelte`/`TaskDetailProvider.ts`.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest (pure cores + host-agnostic controller), Playwright (canvas/popover/navigator interactions), CDP (cross-view), esbuild (extension host) + Vite (webview bundles), VS Code webview CSP (same-origin, no inline scripts).

## Where this fits (the P2 decomposition)

P2 was split by the orchestrator into two independently-shippable plans:

1. **P2a — canvas core (landed):** tree tab + `treeLayoutUpdated` bus + canvas/node/edge rendering + pan/zoom. Its as-built code is on this branch (`.worktrees/tech-tree-p2b`, branch `tech-tree-p2b`, base main `941b0b0`).
2. **P2b — interaction shell (this plan).**

**Locked message names (exact strings, from the P2 directives):** `treeLayoutUpdated` (already shipped), `popoverActiveChanged`, `cancelDispatch`, `milestoneData`, `toggleReleaseChecklistItem`, and the `navigator*` family (`navigatorFilterChanged`, `navigatorJump`, `minimapViewport`). Do not rename these. Non-locked helper messages this plan introduces (`prioritiesUpdated`, `claimTask`, `dispatchTask`, `forceClaimTask`, `releaseTask`, `requestMilestoneData`, `navigatorData`, `navigatorLaneToggle`, `promoteDraft` — the last already exists) may keep the names given here.

## Global Constraints

_Every task's requirements implicitly include this section._

- **Worktree:** work in `.worktrees/tech-tree-p2b` on branch `tech-tree-p2b`. Run all git/file/test commands inside the worktree; `node_modules` is already installed here. Never commit/merge from the repo root.
- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:cdp`).
- **Baselines at branch base (941b0b0):** unit **1360 passed / 1 skipped**; Playwright **307 passed**; lint zero-warning; typecheck clean. Windows shows ~22 known upstream POSIX-path unit failures — unrelated, do not "fix". Confirm no previously-green test regresses; each task states what it adds.
- **Parity (mandatory):** every popover/panel action posts a message that the controller routes to the **same** VS Code command / core service the detail panel and MCP tools use (`claimTaskForCurrentUser`, `dispatchTask`, `releaseTaskClaim`, `writeActiveTask`/`clearActiveTask`, `approveMergeInQueue`/`sendBackMerge`, `promoteDraft`). No business logic is re-implemented in the webview.
- **TDD where a pure core or controller message/enrichment exists** (`releaseChecklist`, `cancelDispatch` orchestrator, `TasksController` enrichment/emission/relay cases): write the failing Vitest first, run red, implement, run green. Svelte components are UI — cover behavior with **Playwright** (REQUIRED for click/hover/keyboard/DOM-order); cover cross-view coordination with **CDP**. Document the house UI-only exception in the commit for pure-markup steps.
- **Rendering discipline:** Lucide **inline SVG** only (no emojis); every color/border via `--vscode-*` tokens so all themes work. Reactive `style="…"` and Svelte `on*` handlers are CSP-safe; **no** inline `<script>`, no string-built handlers. Popovers/panels live inside the existing same-origin `tasks.js`/`tree-navigator.js` bundles (CSP `default-src 'none'; style-src/script-src ${cspSource}`).
- **Svelte 5 runes** (`$state`/`$derived`/`$props`/`$effect`/`{#snippet}`); follow existing component patterns; run the `svelte-autofixer` MCP over each new/edited component until clean before committing.
- **Do not break** kanban/list/dashboard/drafts/archived/docs/decisions tabs, the detail panel's kept controls (plan banner, merge-review banner), or their tests.
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (workers substitute their own model line per `AGENTS.md`). Close the branch with `request_merge` from inside the worktree (Task 13), not a manual merge.

---

## File Structure

**Create:**

- `src/core/releaseChecklist.ts` — pure LF-string core: parse/toggle/serialize a `## Release Checklist` (`<!-- RC:BEGIN/END -->`, `- [ ] #N text`).
- `src/test/unit/releaseChecklist.test.ts` — its unit tests.
- `src/core/cancelDispatch.ts` — pure orchestrator for cancel-dispatch (injected deps), unit-testable.
- `src/test/unit/cancelDispatch.test.ts` — its unit tests.
- `src/webview/components/tree/DetailPopover.svelte` — anchored state-aware detail popover.
- `src/webview/components/tree/InFlightPanel.svelte` — right-edge active + merge-queue overlay.
- `src/webview/components/tree/MilestonePopover.svelte` — milestone progress + release checklist.
- `src/webview/components/task-detail/AttachmentChips.svelte` — details-page attachment chips (Plan / Spec / Notes / Final Summary): inline markdown preview + open-in-editor + `+ Add` (Task 11b).
- `src/webview/components/navigator/TreeNavigator.svelte` — sidebar navigator UI.
- `src/webview/entries/tree-navigator.ts` — navigator bundle entry.
- `src/providers/TreeNavigatorProvider.ts` — navigator WebviewView provider (relays to the board).
- `e2e/webview-fixtures/tree-navigator.html` — Playwright fixture for the navigator bundle (served by the Vite fixture server; the `vscode-mock` helper stays in `e2e/fixtures/`).
- `e2e/tree-popover.spec.ts` — popover + ephemeral-active + actions.
- `e2e/tree-inflight.spec.ts` — in-flight panel.
- `e2e/tree-milestone.spec.ts` — milestone popover + release checklist.
- `e2e/tree-navigator.spec.ts` — navigator filter/lane/jump + canvas dimming.
- `src/test/cdp/tree-popover.test.ts` — CDP cross-view proof.

**Modify:**

- `src/core/types.ts` — new `WebviewMessage`/`ExtensionMessage` variants (per task).
- `src/webview/lib/types.ts` — nothing structural (messages re-exported via `WebviewMessage`/`ExtensionMessage`); add `priorities` handling in components only.
- `src/providers/TasksController.ts` — enrichment (`planProgress`/`claimedByMe`), `prioritiesUpdated` emit, new inbound cases (`popoverActiveChanged`, `claimTask`, `dispatchTask`, `forceClaimTask`, `releaseTask`, `cancelDispatch`, `requestMilestoneData`, `toggleReleaseChecklistItem`, `navigatorFilterChanged`, `navigatorJump`, `navigatorLaneToggle`, `minimapViewport`), and a `relayNavigator` method.
- `src/webview/components/tasks/Tasks.svelte` — new message cases, popover/in-flight/milestone state + render, navigator-driven state, `dataSourceChanged` tracking, tree keyboard shortcut.
- `src/webview/components/tree/TechTreeCanvas.svelte` — popover/in-flight/milestone hosting, filter dimming, lane collapse, jump, minimap feed, debounced persist, empty-state copy branch, keyboard node nav.
- `src/webview/components/tree/TreeNode.svelte` — Promote button on draft nodes, dim class.
- `src/webview/components/tree/EdgeLayer.svelte` — drop the bug→cause arrowhead; dim class.
- `src/webview/components/tree/AgeBandHeader.svelte` — clickable band headers (milestone popover).
- `src/webview/components/tree/LaneBand.svelte` — fix the 24px label offset; collapse toggle.
- `src/providers/TaskDetailProvider.ts` — remove Set-active UI plumbing note; stop creating DoD on new tasks (via BacklogWriter change).
- `src/webview/components/task-detail/TaskDetail.svelte` — remove claim/active/dispatch banners; remove DoD checklist; reorder; long-form sections → attachment chips (Task 11b).
- `src/core/BacklogWriter.ts` — stop injecting `config.definition_of_done` on create.
- `src/extension.ts` — register `TreeNavigatorProvider`; add the `taskwright.cancelDispatch` command (`taskwright.forceClaimTask` already exists from P1 — reused, not re-registered); wire the navigator relay + refresh.
- `src/providers/TasksViewProvider.ts` / `src/providers/TasksPanelProvider.ts` — expose `relayNavigator`.
- `vite.webview.config.ts` — add the `tree-navigator` entry.
- `package.json` — add the `taskwright.treeNavigator` view + the `taskwright.cancelDispatch` command.
- Existing tests: `src/test/unit/TasksController.test.ts`, `src/test/unit/BacklogWriter.test.ts`, `e2e/task-detail.spec.ts` (DoD/banner assertions).

---

## Recommended execution order

Leaves-first so the bundle builds green at every commit:

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 11b → 12 → 13`

- **1** (board-bus enrichment + the Q1 `updateTask` priority-write widening) and **3** (`releaseChecklist` core) are pure leaves — do them early; nothing else blocks the bundle on them.
- **2** (review debt) touches only existing components; land it before the popover so the canvas base is clean.
- **4** defines every popover-action message (incl. `cancelDispatch`) so the bundle compiles; **5** adds the `cancelDispatch` command/handler behind the already-emitted message.
- **6** consumes the Task 3 core; **8** must precede **9** (navigator bundle + relay exist before the canvas consumes them).
- **11** (details rework) is independent; **11b** (attachments-as-chips) extends the details rework and must land **after** 11; **12** (CDP) needs **4** landed; **13** runs the full gate + visual proof + `request_merge`.

> **Anchor caveat (read before transcribing):** every edit hunk quotes the exact existing lines to match — **match the quoted text, not the cited line number**. Tasks 2/4/6/7 grow `TechTreeCanvas.svelte`/`EdgeLayer.svelte`/`AgeBandHeader.svelte`, so absolute line numbers cited for those files in the later tasks (6–10) are approximate (drifted by earlier insertions); the quoted before/after snippets are unique and authoritative.

Each task's model tier is noted in its heading: **[haiku-transcription]** = fully-specified single-surface, safe to transcribe verbatim; **[opus-integration]** = cross-file wiring/judgment.

## Task 1: Board-bus enrichment — `planProgress` + `claimedByMe` + `prioritiesUpdated` [opus-integration]

**Files:**

- Modify: `src/providers/TasksController.ts`, `src/core/types.ts`
- Test: `src/test/unit/TasksController.test.ts`

**Why:** P2a deferred per-task plan-progress on the board bus, so `TreeNode`'s plan bar never renders. The popover (Task 4) also needs `claimedByMe` to gate the "yours vs agent" actions and the config `priorities` for its priority dropdown. All three are enrichment-time additions — no new per-task message beyond the existing `tasksUpdated`, plus one small `prioritiesUpdated`.

**Interfaces:**

- `Task` (core) gains two optional enrichment fields: `planProgress?: { done: number; total: number }`, `claimedByMe?: boolean`. (`TreeNode` already reads `planProgress` and P2a's inline type used it; adding it to `Task` makes it flow through `tasksUpdated`.)
- `ExtensionMessage` gains `{ type: 'prioritiesUpdated'; priorities: string[] }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/unit/TasksController.test.ts` (inside the existing top-level `describe`, near the other refresh assertions):

```ts
describe('TasksController — P2b board-bus enrichment', () => {
  it('emits prioritiesUpdated from config priorities', async () => {
    (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      statuses: ['To Do', 'In Progress', 'Done'],
      priorities: ['P0', 'P1', 'P2'],
    });
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.refresh();
    expect(posted).toContainEqual({ type: 'prioritiesUpdated', priorities: ['P0', 'P1', 'P2'] });
  });

  it('marks claimedByMe true only for tasks claimed by the current identity', async () => {
    (mockParser.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'TASK-1',
        title: 'Mine',
        status: 'In Progress',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-1.md',
        claimedBy: currentIdentity(),
      } as Task,
      {
        id: 'TASK-2',
        title: 'Theirs',
        status: 'In Progress',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-2.md',
        claimedBy: 'someone-else',
      } as Task,
    ]);
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.refresh();
    const upd = posted.find((m) => m.type === 'tasksUpdated') as Extract<
      ExtensionMessage,
      { type: 'tasksUpdated' }
    >;
    const byId = new Map(upd.tasks.map((t) => [t.id, t]));
    expect((byId.get('TASK-1') as Task).claimedByMe).toBe(true);
    expect((byId.get('TASK-2') as Task).claimedByMe).toBe(false);
  });
});

// Q1 (adjudicated): widen the updateTask priority write path. P1 §10 made priority a
// user-configured list; the popover/detail quick-edit must persist any configured value
// and keep rejecting unknown strings. TDD — these fail until Step 6b lands.
describe('TasksController — updateTask priority write path (Q1)', () => {
  it('persists any configured priority (not just high/medium/low)', async () => {
    const updateSpy = vi
      .spyOn(BacklogWriter.prototype, 'updateTask')
      .mockResolvedValue(undefined as never);
    (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      statuses: ['To Do', 'In Progress', 'Done'],
      priorities: ['P0', 'P1', 'P2'],
    });
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
      type: 'updateTask',
      taskId: 'TASK-1',
      updates: { priority: 'P0' },
    });
    expect(updateSpy).toHaveBeenCalledWith('TASK-1', { priority: 'P0' }, mockParser);
  });

  it('rejects an unknown priority string (no write)', async () => {
    const updateSpy = vi
      .spyOn(BacklogWriter.prototype, 'updateTask')
      .mockResolvedValue(undefined as never);
    (mockParser.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      priorities: ['P0', 'P1', 'P2'],
    });
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
      type: 'updateTask',
      taskId: 'TASK-1',
      updates: { priority: 'nope' },
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
```

Add these helpers near the top of the test file (after the imports). `getClaimIdentity` keeps the identity test off the OS username; `BacklogWriter` is spied so the write-path tests assert the persisted `updates` without touching disk:

```ts
import { getClaimIdentity } from '../../providers/claimActions';
import { BacklogWriter } from '../../core/BacklogWriter';
const currentIdentity = () => getClaimIdentity();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- TasksController`
Expected: FAIL — `prioritiesUpdated` not emitted; `claimedByMe` undefined; and `updateTask` drops the configured `P0` (the legacy `high|medium|low` guard rejects it → no write).

- [ ] **Step 3: Implement — imports**

In `src/providers/TasksController.ts`, extend the `claimActions` import (currently `import { getClaimStalenessMs } from './claimActions';` at line 23) to also pull `getClaimIdentity`, and add the plan-progress + priorities imports right after `loadTreeBoardFromParser` (line 27):

```ts
import { getClaimStalenessMs, getClaimIdentity } from './claimActions';
```

```ts
import { loadTreeBoardFromParser } from '../core/treeDerived';
import { loadPlanProgress } from '../core/loadPlanProgress';
import { resolvePriorities } from '../core/priorityOrder';
```

- [ ] **Step 4: Implement — compute identity/repo root in `refresh()` (reuse the existing `config`)**

`refresh()` **already** reads config at `TasksController.ts:215` (`const config = await this.parser.getConfig();`, used immediately for `config.project_name` at `:218` and `config.check_active_branches` at `:223`). **Do NOT** add `getConfig()` to the `Promise.all` at `:238` and destructure a second `…, config]` — a second `const config` in the same `try` block is a block-scoped redeclaration (TypeScript `TS2451`, "Cannot redeclare block-scoped variable 'config'") and the whole extension bundle fails to build. Leave the `Promise.all` destructure at `:238` **unchanged**, and reuse the line-215 `config` (it is already in scope for Step 6's `resolvePriorities(config)`).

Immediately after the `const stalenessMs = getClaimStalenessMs();` line (`TasksController.ts:295`), add the identity + repo root (best-effort; identity read never throws):

```ts
const claimIdentity = getClaimIdentity();
const repoRoot = path.dirname(this.parser.getBacklogPath());
```

- [ ] **Step 5: Implement — enrichment fields**

Extend the enhanced inline type and the enrichment object in the `tasks.map(...)` block (`TasksController.ts:308`). Change the type union:

```ts
const enhanced: Task & {
  blocksTaskIds?: string[];
  subtaskProgress?: { total: number; done: number };
  blockingDependencyIds?: string[];
  isActiveTask?: boolean;
  claimStale?: boolean;
  mergeState?: MergeTaskState;
} = {
  ...task,
  blocksTaskIds: reverseDeps.get(task.id) || [],
  isActiveTask: !!activeTaskId && task.id === activeTaskId,
  claimStale: !!task.claimedBy && isClaimStale(task.claimedAt, stalenessMs),
  mergeState: mergeQueue ? mergeStateForTask(mergeQueue, task.id) : undefined,
};
```

to:

```ts
const enhanced: Task & {
  blocksTaskIds?: string[];
  subtaskProgress?: { total: number; done: number };
  blockingDependencyIds?: string[];
  isActiveTask?: boolean;
  claimStale?: boolean;
  claimedByMe?: boolean;
  planProgress?: { done: number; total: number };
  mergeState?: MergeTaskState;
} = {
  ...task,
  blocksTaskIds: reverseDeps.get(task.id) || [],
  isActiveTask: !!activeTaskId && task.id === activeTaskId,
  claimStale: !!task.claimedBy && isClaimStale(task.claimedAt, stalenessMs),
  claimedByMe: !!task.claimedBy && task.claimedBy === claimIdentity,
  mergeState: mergeQueue ? mergeStateForTask(mergeQueue, task.id) : undefined,
};
// Plan-progress for the tree node bar + popover. Synchronous, never throws
// (missing plan file → exists:false, zeros). Only set when a plan is linked.
if (task.plan) {
  try {
    const loaded = loadPlanProgress(repoRoot, task.plan);
    if (loaded.progress.total > 0) {
      enhanced.planProgress = { done: loaded.progress.done, total: loaded.progress.total };
    }
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 6: Implement — emit `prioritiesUpdated`**

Right after the `this.host.postMessage({ type: 'statusesUpdated', statuses });` line (`TasksController.ts:373`), add:

```ts
this.host.postMessage({ type: 'prioritiesUpdated', priorities: resolvePriorities(config) });
```

- [ ] **Step 6b: Implement — widen the `updateTask` priority write path (Q1)**

In `handleMessage`'s `updateTask` case, replace the legacy priority guard (`TasksController.ts:533-540`):

```ts
if (
  message.updates.priority === 'high' ||
  message.updates.priority === 'medium' ||
  message.updates.priority === 'low' ||
  message.updates.priority === undefined
) {
  updates.priority = message.updates.priority;
}
```

with a check against the board's configured priorities (`resolvePriorities` is already imported in Step 3). Read config in the handler — `this.parser` is guaranteed here (the case opens with `if (!this.parser) break;` at `TasksController.ts:507`):

```ts
// Priority: accept any configured priority (P1 §10 made priority a user-defined
// list); `undefined` clears it; unknown strings are rejected (no write).
const configuredPriorities = resolvePriorities(await this.parser.getConfig());
if (
  message.updates.priority === undefined ||
  configuredPriorities.some(
    (p) => p.toLowerCase() === String(message.updates.priority).toLowerCase()
  )
) {
  updates.priority = message.updates.priority;
}
```

(The empty-updates guard below — `if (Object.keys(updates).length === 0) break;` — still short-circuits when nothing valid was supplied.)

- [ ] **Step 7: Implement — types**

In `src/core/types.ts`, add the two optional fields to the `Task` interface (immediately after `mergeState?: MergeTaskState;` at `types.ts:107`, the last field before the interface closes):

```ts
  /** Board-bus enrichment: plan checkbox progress for the tree node + popover. */
  planProgress?: { done: number; total: number };
  /** Board-bus enrichment: true when `claimedBy` equals the current claim identity. */
  claimedByMe?: boolean;
```

(`TreeNode.svelte:8-11` already declares an inline `planProgress` intersection on its `task` prop; once `planProgress` is on `Task` that intersection is redundant but non-conflicting — leave it, or drop it in a later component edit.)

Add the outbound message to the `ExtensionMessage` union (right after the `treeLayoutUpdated` variant at `types.ts:324`):

```ts
  | { type: 'prioritiesUpdated'; priorities: string[] }
```

- [ ] **Step 8: Run tests + typecheck**

Run: `bun run test -- TasksController` → PASS (baseline + 4 new: the two enrichment tests + the two Q1 write-path tests). Then `bun run typecheck` → PASS.

- [ ] **Step 9: Commit**

```bash
git add src/providers/TasksController.ts src/core/types.ts src/test/unit/TasksController.test.ts
git commit -m "feat(tree P2b): board-bus enrichment (planProgress/claimedByMe/prioritiesUpdated) + widen updateTask priority

- refresh() enriches each task with plan checkbox progress (loadPlanProgress) and
  claimedByMe (claimedBy === current identity); emits prioritiesUpdated from config
- updateTask now persists any configured priority (resolvePriorities), not just
  legacy high|medium|low; unknown strings still rejected (Q1)
- unblocks tree node plan bars and the popover's state-aware action gating

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: P2a review-debt polish [opus-integration]

**Files:**

- Modify: `src/webview/components/tree/LaneBand.svelte`, `src/webview/components/tree/TechTreeCanvas.svelte`, `src/webview/components/tree/EdgeLayer.svelte`, `src/webview/components/tasks/Tasks.svelte`
- Test: `e2e/tree-canvas.spec.ts`

Five reviewer follow-ups from P2a, each self-contained. UI-only where noted; document the house exception in the commit.

- [ ] **Step 1: LaneBand label vertical offset (a)**

`LaneBand.svelte` positions labels with `top:{lane.y * scale + ty}px`, but the container `.tree-lane-labels` is `top: 24px` (below the band header) while lane `y` is measured from the surface top (0). The 24px offset double-counts. Fix by subtracting the band-header height in the inline `top`. Change the label div (`LaneBand.svelte:14-18`):

```svelte
    <div
      class="tree-lane-label"
      data-testid="tree-lane-{lane.name}"
      style="top:{lane.y * scale + ty}px; height:{lane.height * scale}px;"
    >
```

to:

```svelte
    <div
      class="tree-lane-label"
      data-testid="tree-lane-{lane.name}"
      style="top:{lane.y * scale + ty - 24}px; height:{lane.height * scale}px;"
    >
```

(The container's `top: 24px` in the style block already shifts the whole strip down by the band-header height; subtracting 24 in the per-label `top` aligns each label with its row instead of sitting 24px below it.)

- [ ] **Step 2: Drop the bug→cause arrowhead (e)**

`EdgeLayer.svelte` currently gives bug edges `url(#tw-arrow)` (an arrowhead) because the ternary only special-cases `blocking`. Change the `marker-end` attribute on the edge path (`EdgeLayer.svelte:104`) from:

```svelte
        marker-end={e.kind === 'blocking' ? 'url(#tw-arrow-blocking)' : 'url(#tw-arrow)'}
```

to:

```svelte
        marker-end={e.kind === 'bug'
          ? undefined
          : e.kind === 'blocking'
            ? 'url(#tw-arrow-blocking)'
            : 'url(#tw-arrow)'}
```

(Arrowless bug→cause reference edges — approved design tweak. The dotted `.tree-edge-bug` stroke stays.)

- [ ] **Step 3: Debounce viewport persistence (d)**

`TechTreeCanvas.svelte` calls `persist()` on every `setViewport` (i.e. every pointermove during a pan and every wheel tick), hitting `vscode.setState` continuously. Debounce it: commit on pointerup / wheel-settle. Replace the `persist()` function (`TechTreeCanvas.svelte:56-59`):

```ts
function persist() {
  const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
  vscode.setState({ ...prev, treeViewport: vp });
}
```

with a debounced writer (persist coalesces to a single write ~120ms after motion settles):

```ts
let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistNow() {
  const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
  vscode.setState({ ...prev, treeViewport: vp });
}
function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 120);
}
```

Then flush immediately on pointer-up so a pan that ends is saved even if the component unmounts. In `onPointerUp` (`TechTreeCanvas.svelte:107-111`), after `panning = false;`, add `persistNow();`:

```ts
function onPointerUp(e: PointerEvent) {
  if (!panning) return;
  panning = false;
  viewportEl?.releasePointerCapture?.(e.pointerId);
  persistNow();
}
```

- [ ] **Step 4: Empty-state copy branch (b) + `dataSourceChanged` tracking in Tasks.svelte**

The tree empty-state over-claims "cross-branch mode" even when the local board is simply empty. Give `TechTreeCanvas` a `crossBranch` prop and branch the copy.

In `Tasks.svelte`, add state (near the tree vocab state at line 37-40):

```ts
// True while the board is in cross-branch mode (no local tree layout is computed).
let crossBranch = $state(false);
```

Add a `dataSourceChanged` case to the `onMessage` switch (after the `treeLayoutUpdated` case at line 99):

```ts
      case 'dataSourceChanged':
        crossBranch = message.mode === 'cross-branch';
        break;
```

Pass it into the canvas — change the tree render branch (`Tasks.svelte:496-507`) to add `{crossBranch}`:

```svelte
{:else if activeTab === 'tree'}
  <div id="tree-view" class="view-content">
    <TechTreeCanvas
      {tasks}
      {laneOrder}
      {bandOrder}
      warnings={treeWarnings}
      {statuses}
      {priorities}
      {taskIdDisplay}
      {crossBranch}
      onSelectTask={handleSelectTask}
    />
  </div>
```

(The `{priorities}` prop is added here for Task 4's popover; declare the state now to avoid a second edit — add `let priorities = $state<string[]>(['high', 'medium', 'low']);` beside `crossBranch`, and a `case 'prioritiesUpdated': priorities = message.priorities; break;` in the switch.)

In `TechTreeCanvas.svelte`, add `crossBranch` (and the not-yet-used `priorities`) to `Props` and `$props()` (`TechTreeCanvas.svelte:18-28`):

```ts
interface Props {
  tasks: Task[];
  laneOrder: string[];
  bandOrder: string[];
  warnings: string[];
  statuses: string[];
  priorities: string[];
  taskIdDisplay: TaskIdDisplayMode;
  crossBranch?: boolean;
  onSelectTask: (taskId: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
}
let {
  tasks,
  laneOrder,
  bandOrder,
  warnings,
  statuses,
  priorities,
  taskIdDisplay,
  crossBranch = false,
  onSelectTask,
}: Props = $props();
```

Branch the empty-state copy (`TechTreeCanvas.svelte:136-143`):

```svelte
{#if !hasLayout}
  <div class="tree-empty-state" data-testid="tree-empty-state">
    {#if crossBranch}
      <p class="tree-empty-title">The tech tree isn't available in cross-branch mode.</p>
      <p class="tree-empty-hint">
        The tree needs local task layout, which isn't computed when the board is scanning other
        branches. Switch to the Kanban or List tab, or turn off cross-branch mode.
      </p>
    {:else}
      <p class="tree-empty-title">No tasks to plot yet.</p>
      <p class="tree-empty-hint">
        Create a task and it will appear here as a node, positioned by its category, milestone, and
        dependencies.
      </p>
    {/if}
  </div>
{:else}
```

- [ ] **Step 5: Tree keyboard shortcut + node arrow navigation (c)**

Add a tree tab shortcut alongside z/x/c/v. In `Tasks.svelte`'s `handleGlobalKeydown` switch (`Tasks.svelte:282-306`), add `t` as the first case:

```ts
      switch (e.key) {
        case 't': handleTabChange('tree'); break;
        case 'z': handleTabChange('kanban'); break;
```

Make canvas nodes arrow-navigable. In `TechTreeCanvas.svelte`, add a keydown handler on the viewport that moves focus between `.tree-node` elements in DOM order (arrows + j/k). Add the function near `zoomBy` (`TechTreeCanvas.svelte:125-128`):

```ts
function onCanvasKeydown(e: KeyboardEvent) {
  const key = e.key;
  if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'j', 'k'].includes(key)) return;
  const nodes = Array.from(viewportEl?.querySelectorAll<HTMLElement>('.tree-node') ?? []);
  if (nodes.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const idx = active ? nodes.indexOf(active) : -1;
  const forward = key === 'ArrowRight' || key === 'ArrowDown' || key === 'j';
  const next = idx < 0 ? 0 : (idx + (forward ? 1 : -1) + nodes.length) % nodes.length;
  e.preventDefault();
  nodes[next]?.focus();
}
```

Wire it onto the `.tree-viewport` div (`TechTreeCanvas.svelte:169-181`) by adding `onkeydown={onCanvasKeydown}` to its attribute list (after `onwheel={onWheel}`):

```svelte
      onwheel={onWheel}
      onkeydown={onCanvasKeydown}
      role="application"
      aria-label="Tech tree canvas"
```

- [ ] **Step 6: svelte-autofixer**

Run the `svelte` MCP `svelte-autofixer` on `LaneBand.svelte`, `TechTreeCanvas.svelte`, `EdgeLayer.svelte` until clean.

- [ ] **Step 7: Extend the Playwright suite**

Append to `e2e/tree-canvas.spec.ts` (inside the `test.describe('Tech tree canvas', …)` block):

```ts
test('bug→cause edge has no arrowhead marker', async ({ page }) => {
  await page.locator('[data-testid="tree-node-TASK-5"]').hover();
  const bugEdge = page.locator('[data-testid="tree-edge-TASK-5-TASK-1"]');
  await expect(bugEdge).toHaveCount(1);
  await expect(bugEdge).not.toHaveAttribute('marker-end', /tw-arrow/);
});

test('empty board (not cross-branch) shows the "no tasks" copy', async ({ page }) => {
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: [] });
  await postMessageToWebview(page, {
    type: 'treeLayoutUpdated',
    laneOrder: [],
    bandOrder: [],
    warnings: [],
  });
  await page.waitForTimeout(80);
  await expect(page.locator('[data-testid="tree-empty-state"]')).toContainText('No tasks to plot');
});

test('arrow key moves focus to the next node', async ({ page }) => {
  await page.locator('[data-testid="tree-node-TASK-1"]').focus();
  await page.locator('[data-testid="tree-viewport"]').press('ArrowRight');
  const focusedId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  expect(focusedId).toMatch(/^tree-node-/);
});
```

- [ ] **Step 8: Build + regression**

Run: `bun run build && bun run typecheck && bun run test:playwright -- tree-canvas`
Expected: PASS (existing tree-canvas tests + 3 new). The `bug→cause edge is hidden until hovered` P2a test still passes (unchanged behavior).

- [ ] **Step 9: Commit**

```bash
git add src/webview/components/tree/LaneBand.svelte src/webview/components/tree/TechTreeCanvas.svelte \
  src/webview/components/tree/EdgeLayer.svelte src/webview/components/tasks/Tasks.svelte \
  e2e/tree-canvas.spec.ts
git commit -m "fix(tree P2b): P2a review debt — lane label offset, arrowless bug edge, debounced persist, empty-state copy, node keyboard nav

House UI exception: presentation/interaction polish; behavior covered by e2e/tree-canvas.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `releaseChecklist` pure core + tests [haiku-transcription]

**Files:**

- Create: `src/core/releaseChecklist.ts`
- Test: `src/test/unit/releaseChecklist.test.ts`

A DOM-free, LF-normalized string core (mirrors `claims.ts`/`markerBlock.ts`): parse a `## Release Checklist` section (`<!-- RC:BEGIN -->`/`<!-- RC:END -->`, `- [ ] #N text` lines) into `ChecklistItem[]`, toggle one item by id, and upsert the section into a milestone file's body. The file-backed caller (Task 6) wraps it with the `detectCRLF/normalizeToLF/restoreLineEndings` trio.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/releaseChecklist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseReleaseChecklist,
  toggleReleaseChecklistItem,
  serializeReleaseChecklist,
  upsertReleaseChecklist,
  RC_BEGIN,
  RC_END,
} from '../../core/releaseChecklist';

const WITH_MARKERS = `# m-1 - Launch

## Description

Ship it.

## Release Checklist

<!-- RC:BEGIN -->
- [x] #1 Update changelog
- [ ] #2 Smoke test the build
- [ ] #3 Tag the release
<!-- RC:END -->
`;

describe('releaseChecklist — parse', () => {
  it('reads items between the RC markers', () => {
    const items = parseReleaseChecklist(WITH_MARKERS);
    expect(items).toEqual([
      { id: 1, text: 'Update changelog', checked: true },
      { id: 2, text: 'Smoke test the build', checked: false },
      { id: 3, text: 'Tag the release', checked: false },
    ]);
  });

  it('returns [] when there is no Release Checklist section', () => {
    expect(parseReleaseChecklist('# m-2 - Nothing\n\n## Description\n\nx\n')).toEqual([]);
  });

  it('parses a marker-less "## Release Checklist" section (fallback)', () => {
    const md = '## Release Checklist\n\n- [ ] #1 A\n- [x] #2 B\n';
    expect(parseReleaseChecklist(md)).toEqual([
      { id: 1, text: 'A', checked: false },
      { id: 2, text: 'B', checked: true },
    ]);
  });
});

describe('releaseChecklist — toggle', () => {
  it('flips only the targeted item and preserves the rest of the file', () => {
    const out = toggleReleaseChecklistItem(WITH_MARKERS, 2);
    const items = parseReleaseChecklist(out);
    expect(items[1]).toEqual({ id: 2, text: 'Smoke test the build', checked: true });
    expect(items[0].checked).toBe(true); // #1 untouched
    expect(items[2].checked).toBe(false); // #3 untouched
    expect(out).toContain('## Description'); // body preserved
  });

  it('is a no-op when the id is absent', () => {
    expect(toggleReleaseChecklistItem(WITH_MARKERS, 99)).toBe(WITH_MARKERS);
  });
});

describe('releaseChecklist — serialize + upsert', () => {
  it('serializes items to numbered checkbox lines', () => {
    expect(
      serializeReleaseChecklist([
        { id: 1, text: 'A', checked: false },
        { id: 2, text: 'B', checked: true },
      ])
    ).toBe('- [ ] #1 A\n- [x] #2 B');
  });

  it('inserts a Release Checklist section when none exists', () => {
    const base = '# m-3 - Fresh\n\n## Description\n\nx\n';
    const out = upsertReleaseChecklist(base, [{ id: 1, text: 'New item', checked: false }]);
    expect(out).toContain('## Release Checklist');
    expect(out).toContain(RC_BEGIN);
    expect(out).toContain(RC_END);
    expect(parseReleaseChecklist(out)).toEqual([{ id: 1, text: 'New item', checked: false }]);
  });

  it('replaces the section content when one already exists', () => {
    const out = upsertReleaseChecklist(WITH_MARKERS, [{ id: 1, text: 'Only one', checked: true }]);
    expect(parseReleaseChecklist(out)).toEqual([{ id: 1, text: 'Only one', checked: true }]);
    expect(out).toContain('## Description');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- releaseChecklist`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/core/releaseChecklist.ts`:

```ts
/**
 * Release Checklist — the milestone's manual Definition-of-Done home (P2 spec §9).
 *
 * A `## Release Checklist` section inside a milestone file (`backlog/milestones/
 * m-N - *.md`), delimited by `<!-- RC:BEGIN -->` / `<!-- RC:END -->` and made of
 * `- [ ] #N text` lines (the AC/DoD line format). This module is a pure, DOM-free,
 * LF-normalized string core (mirrors `claims.ts` / `markerBlock.ts`); the file-backed
 * caller applies the CRLF detect/restore wrapper.
 */
import type { ChecklistItem } from './types';

export const RC_BEGIN = '<!-- RC:BEGIN -->';
export const RC_END = '<!-- RC:END -->';
export const RC_HEADER = '## Release Checklist';

/** `- [ ] #1 text` / `- [x] text` — group1 check, group2 optional id, group3 text. */
const ITEM_RE = /^-\s*\[([ xX])\]\s*(?:#(\d+)\s+)?(.+)$/;

/** Locate the content range of the RC section: markers first, else header→next `## `. */
function sectionRange(content: string): { start: number; end: number } | null {
  const b = content.indexOf(RC_BEGIN);
  const e = content.indexOf(RC_END);
  if (b !== -1 && e !== -1 && e > b) {
    return { start: b + RC_BEGIN.length, end: e };
  }
  const headerRe = new RegExp(`^${RC_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const m = content.match(headerRe);
  if (m && m.index !== undefined) {
    const start = m.index + m[0].length;
    const after = content.slice(start);
    const next = after.match(/^## /m);
    return { start, end: start + (next?.index ?? after.length) };
  }
  return null;
}

/** Parse the RC items (empty array when there is no section). */
export function parseReleaseChecklist(content: string): ChecklistItem[] {
  const range = sectionRange(content);
  if (!range) return [];
  const items: ChecklistItem[] = [];
  for (const line of content.slice(range.start, range.end).split('\n')) {
    const match = line.trim().match(ITEM_RE);
    if (!match) continue;
    items.push({
      id: match[2] ? parseInt(match[2], 10) : items.length + 1,
      checked: match[1].toLowerCase() === 'x',
      text: match[3].trim(),
    });
  }
  return items;
}

/** Flip a single item by `#id`, scoped to the RC section; no-op when absent. */
export function toggleReleaseChecklistItem(content: string, itemId: number): string {
  const range = sectionRange(content);
  if (!range) return content;
  const regex = new RegExp(`^(- \\[)([ xX])(\\]\\s*#${itemId}\\s+.*)$`, 'gm');
  const before = content.slice(0, range.start);
  const section = content.slice(range.start, range.end);
  const after = content.slice(range.end);
  const replaced = section.replace(
    regex,
    (_m, p, check, s) => `${p}${check === ' ' ? 'x' : ' '}${s}`
  );
  return before + replaced + after;
}

/** Items → numbered checkbox lines (no trailing newline). */
export function serializeReleaseChecklist(items: ChecklistItem[]): string {
  return items
    .map((it, i) => `- [${it.checked ? 'x' : ' '}] #${it.id ?? i + 1} ${it.text}`)
    .join('\n');
}

/** Replace the RC section body (markers preserved), or append a new section. */
export function upsertReleaseChecklist(content: string, items: ChecklistItem[]): string {
  const body = serializeReleaseChecklist(items);
  const b = content.indexOf(RC_BEGIN);
  const e = content.indexOf(RC_END);
  if (b !== -1 && e !== -1 && e > b) {
    return `${content.slice(0, b + RC_BEGIN.length)}\n${body}\n${content.slice(e)}`;
  }
  const headerRe = new RegExp(`^${RC_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const m = content.match(headerRe);
  if (m && m.index !== undefined) {
    const start = m.index + m[0].length;
    const after = content.slice(start);
    const next = after.match(/^## /m);
    const cut = start + (next?.index ?? after.length);
    return `${content.slice(0, start)}\n${RC_BEGIN}\n${body}\n${RC_END}\n${content.slice(cut)}`;
  }
  const sep = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${sep}${RC_HEADER}\n\n${RC_BEGIN}\n${body}\n${RC_END}\n`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- releaseChecklist` → PASS (all describes green).

- [ ] **Step 5: Commit**

```bash
git add src/core/releaseChecklist.ts src/test/unit/releaseChecklist.test.ts
git commit -m "feat(tree P2b): releaseChecklist pure core (parse/toggle/serialize/upsert RC section)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Detail popover + ephemeral active + state-aware actions [opus-integration]

**Files:**

- Create: `src/webview/components/tree/DetailPopover.svelte`
- Modify: `src/webview/components/tree/TechTreeCanvas.svelte`, `src/core/types.ts`, `src/providers/TasksController.ts` (Task 4 does **not** touch `src/extension.ts`/`package.json` — force-claim already exists)
- Create test: `e2e/tree-popover.spec.ts`

**Behavior (spec §7):** node click opens an anchored popover (id/lane/age chips, title, status/priority quick-edit `<select>`, description expand, prereqs/unlocks, plan bar, worker line) and makes the task **ephemeral active** (`popoverActiveChanged{taskId}`); closing clears active (`popoverActiveChanged{taskId:null}`). Actions are **state-aware** and posted as messages the controller routes to the **same commands** the detail panel uses. Claim ⟂ Dispatch. `⤢` opens the full details (existing `selectTask`).

**Locked message:** `popoverActiveChanged` (exact). Action messages: `claimTask`/`dispatchTask`/`forceClaimTask`/`releaseTask`/`cancelDispatch` (new inbound to `TasksController`), `approveMerge`/`sendBackMerge`/`updateTask` (existing).

- [ ] **Step 1: Add the messages to `WebviewMessage`**

In `src/core/types.ts`, add to the `WebviewMessage` union (after the `sendBackMerge` variant at `types.ts:292`, keeping the trailing `;` on the last member):

```ts
  | { type: 'popoverActiveChanged'; taskId: string | null }
  | { type: 'claimTask'; taskId: string }
  | { type: 'dispatchTask'; taskId: string }
  | { type: 'forceClaimTask'; taskId: string }
  | { type: 'releaseTask'; taskId: string }
  | { type: 'cancelDispatch'; taskId: string };
```

Change the previous last member's terminator from `;` to `|` — i.e. the `sendBackMerge` line becomes:

```ts
  | { type: 'sendBackMerge'; taskId: string }
```

- [ ] **Step 2: Create `DetailPopover.svelte`**

Create `src/webview/components/tree/DetailPopover.svelte`:

```svelte
<script lang="ts">
  import type { Task, TaskIdDisplayMode } from '../../lib/types';
  import { formatTaskIdForDisplay } from '../../lib/taskIdDisplay';

  type PopoverTask = Task & {
    claimedByMe?: boolean;
    planProgress?: { done: number; total: number };
  };

  export type PopoverActionKind =
    | 'claim'
    | 'dispatch'
    | 'forceClaim'
    | 'release'
    | 'markDone'
    | 'cancelDispatch'
    | 'approve'
    | 'sendBack';

  interface Props {
    task: PopoverTask;
    statuses: string[];
    priorities: string[];
    taskIdDisplay: TaskIdDisplayMode;
    x: number;
    y: number;
    onClose: () => void;
    onExpand: (taskId: string) => void;
    onQuickEdit: (updates: { status?: string; priority?: string }) => void;
    onAction: (kind: PopoverActionKind, taskId: string) => void;
  }
  let { task, statuses, priorities, taskIdDisplay, x, y, onClose, onExpand, onQuickEdit, onAction }: Props =
    $props();

  const doneStatus = $derived(statuses.length > 0 ? statuses[statuses.length - 1] : 'Done');
  const firstStatus = $derived(statuses.length > 0 ? statuses[0] : 'To Do');
  const isDone = $derived(
    task.status === doneStatus || task.folder === 'completed' || task.folder === 'archive'
  );
  const isDraft = $derived(task.status === 'Draft' || task.folder === 'drafts');
  const isLocked = $derived(task.locked === true);
  const isTodo = $derived(task.status === firstStatus);
  const pendingReview = $derived(
    !!task.mergeState && !task.mergeState.approved && task.mergeState.mode === 'manual-review'
  );
  const inProgress = $derived(!isDone && !isDraft && !isTodo && !pendingReview);
  const claimedByMe = $derived(task.claimedByMe === true);
  const hasWorktree = $derived(!!task.worktree);
  const displayId = $derived(formatTaskIdForDisplay(task.id, taskIdDisplay));
  const lane = $derived(task.layout?.lane ?? '');
  const age = $derived(task.milestone ?? 'Backburner');
  const prereqs = $derived(task.dependencies ?? []);
  const unlocks = $derived(task.blocksTaskIds ?? []);
  const blockedBy = $derived(task.blockedBy ?? []);

  interface ActionBtn {
    key: string;
    label: string;
    kind: PopoverActionKind;
    primary?: boolean;
  }
  const actions = $derived.by<ActionBtn[]>(() => {
    if (pendingReview)
      return [
        { key: 'approve', label: 'Approve & merge', kind: 'approve', primary: true },
        { key: 'sendBack', label: 'Send back', kind: 'sendBack' },
      ];
    if (isDone || isDraft) return [];
    if (isTodo && isLocked) return [{ key: 'force', label: 'Force claim', kind: 'forceClaim' }];
    if (isTodo)
      return [
        { key: 'claim', label: 'Claim', kind: 'claim', primary: true },
        { key: 'dispatch', label: 'Dispatch', kind: 'dispatch' },
      ];
    if (inProgress && hasWorktree)
      return [{ key: 'cancel', label: 'Cancel dispatch', kind: 'cancelDispatch' }];
    if (inProgress && claimedByMe)
      return [
        { key: 'done', label: 'Mark done', kind: 'markDone', primary: true },
        { key: 'release', label: 'Release claim', kind: 'release' },
      ];
    if (task.claimedBy) return [{ key: 'release', label: 'Release claim', kind: 'release' }];
    return [
      { key: 'claim', label: 'Claim', kind: 'claim', primary: true },
      { key: 'dispatch', label: 'Dispatch', kind: 'dispatch' },
    ];
  });

  let showDescription = $state(false);
  const planPct = $derived(
    task.planProgress && task.planProgress.total > 0
      ? Math.round((task.planProgress.done / task.planProgress.total) * 100)
      : undefined
  );

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="tree-popover"
  data-testid="tree-popover"
  data-popover-task={task.id}
  style="left:{x}px; top:{y}px;"
  role="dialog"
  aria-label="Task {displayId}"
>
  <div class="tp-head">
    <div class="tp-chips">
      <span class="tp-chip" data-testid="tp-id">{displayId}</span>
      {#if lane}<span class="tp-chip">{lane}</span>{/if}
      <span class="tp-chip">{age}</span>
    </div>
    <div class="tp-head-actions">
      <button class="tp-icon" data-testid="tp-expand" title="Open full details" onclick={() => onExpand(task.id)}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
      </button>
      <button class="tp-icon" data-testid="tp-close" title="Close" onclick={onClose}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
  </div>

  <div class="tp-title" title={task.title}>{task.title}</div>

  <div class="tp-edits">
    <label class="tp-field">
      <span>Status</span>
      <select
        data-testid="tp-status"
        value={task.status}
        onchange={(e) => onQuickEdit({ status: (e.currentTarget as HTMLSelectElement).value })}
      >
        {#each statuses as s (s)}<option value={s}>{s}</option>{/each}
      </select>
    </label>
    <label class="tp-field">
      <span>Priority</span>
      <select
        data-testid="tp-priority"
        value={task.priority ?? ''}
        onchange={(e) =>
          onQuickEdit({ priority: (e.currentTarget as HTMLSelectElement).value || undefined })}
      >
        <option value="">—</option>
        {#each priorities as p (p)}<option value={p}>{p}</option>{/each}
      </select>
    </label>
  </div>

  {#if task.description}
    <button class="tp-desc-toggle" data-testid="tp-desc-toggle" onclick={() => (showDescription = !showDescription)}>
      {showDescription ? 'Hide description' : 'Show description'}
    </button>
    {#if showDescription}<div class="tp-desc" data-testid="tp-desc">{task.description}</div>{/if}
  {/if}

  {#if planPct !== undefined}
    <div class="tp-plan" data-testid="tp-plan" title="{task.planProgress!.done}/{task.planProgress!.total} steps">
      <span class="tp-plan-fill" style="width:{planPct}%"></span>
    </div>
  {/if}

  {#if prereqs.length > 0}
    <div class="tp-rel">
      <span class="tp-rel-label">Prereqs</span>
      {#each prereqs as d (d)}<span class="tp-rel-chip" class:unmet={blockedBy.includes(d)}>{d}</span>{/each}
    </div>
  {/if}
  {#if unlocks.length > 0}
    <div class="tp-rel">
      <span class="tp-rel-label">Unlocks</span>
      {#each unlocks as u (u)}<span class="tp-rel-chip">{u}</span>{/each}
    </div>
  {/if}

  {#if task.claimedBy}
    <div class="tp-worker" data-testid="tp-worker">
      Claimed by {claimedByMe ? 'you' : task.claimedBy}{#if task.worktree} · {task.worktree}{/if}
    </div>
  {/if}

  {#if actions.length > 0}
    <div class="tp-actions" data-testid="tp-actions">
      {#each actions as a (a.key)}
        <button class="tp-btn" class:primary={a.primary} data-testid="tp-action-{a.kind}" onclick={() => onAction(a.kind, task.id)}>
          {a.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tree-popover {
    position: absolute;
    z-index: 30;
    width: 300px;
    max-width: calc(100% - 16px);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    color: var(--vscode-foreground);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  .tp-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .tp-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .tp-chip {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
  }
  .tp-head-actions {
    display: flex;
    gap: 2px;
  }
  .tp-icon {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    padding: 3px;
    border-radius: 4px;
    color: var(--vscode-foreground);
    opacity: 0.8;
  }
  .tp-icon:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .tp-title {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
  }
  .tp-edits {
    display: flex;
    gap: 8px;
  }
  .tp-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    font-size: 10px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  }
  .tp-field select {
    font-size: 12px;
    padding: 2px 4px;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    background: var(--vscode-input-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 4px;
  }
  .tp-desc-toggle {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    color: var(--vscode-textLink-foreground, #3794ff);
  }
  .tp-desc {
    font-size: 12px;
    max-height: 120px;
    overflow: auto;
    white-space: pre-wrap;
    opacity: 0.9;
  }
  .tp-plan {
    height: 5px;
    border-radius: 3px;
    background: var(--vscode-progressBar-background, rgba(255, 255, 255, 0.1));
    overflow: hidden;
  }
  .tp-plan-fill {
    display: block;
    height: 100%;
    background: var(--vscode-charts-green, #89d185);
  }
  .tp-rel {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    font-size: 11px;
  }
  .tp-rel-label {
    opacity: 0.7;
    margin-right: 2px;
  }
  .tp-rel-chip {
    font-size: 10px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
  }
  .tp-rel-chip.unmet {
    background: var(--vscode-editorWarning-foreground, #cca700);
    color: var(--vscode-editor-background, #1e1e1e);
  }
  .tp-worker {
    font-size: 11px;
    opacity: 0.85;
  }
  .tp-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tp-btn {
    all: unset;
    cursor: pointer;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
  }
  .tp-btn.primary {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .tp-btn:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }
</style>
```

- [ ] **Step 3: Host the popover in `TechTreeCanvas.svelte`**

Add the import beside the other tree imports (`TechTreeCanvas.svelte:16`):

```ts
import DetailPopover, { type PopoverActionKind } from './DetailPopover.svelte';
```

> **If `bun run typecheck` rejects the `PopoverActionKind` re-import** (svelte2tsx usually re-exports an instance-`<script>` `export type`, but not always), move the `export type PopoverActionKind = …` union out of `DetailPopover.svelte`'s instance `<script lang="ts">` into a `<script module lang="ts">` block in the same file (or a tiny `./popoverActions.ts`) and re-import it from there. No behavior change.

Add popover state after `let selectedId` (`TechTreeCanvas.svelte:41`):

```ts
let popoverTaskId = $state<string | null>(null);
let popoverX = $state(0);
let popoverY = $state(0);
const popoverTask = $derived(
  popoverTaskId ? layoutNodes.find((t) => t.id === popoverTaskId) : undefined
);
// Close the popover if its task vanished from the board (e.g. completed/archived).
$effect(() => {
  if (popoverTaskId && !popoverTask) closePopover();
});
// Keep the popover glued to its node while panning/zooming.
$effect(() => {
  if (popoverTaskId) {
    const a = anchorFor(popoverTaskId);
    popoverX = a.x;
    popoverY = a.y;
  }
});
```

Add the popover helpers next to `handleSelect` (replace the existing `handleSelect` at `TechTreeCanvas.svelte:130-133`):

```ts
function anchorFor(id: string): { x: number; y: number } {
  const box = geometry.nodes.get(id);
  if (!box || !viewportEl) return { x: 8, y: 8 };
  const POP_W = 300;
  const vw = viewportEl.clientWidth;
  let px = box.x * vp.scale + vp.tx + box.width * vp.scale + 8;
  if (px + POP_W > vw) px = Math.max(8, box.x * vp.scale + vp.tx - POP_W - 8);
  const py = Math.max(8, box.y * vp.scale + vp.ty);
  return { x: px, y: py };
}

function handleSelect(id: string) {
  selectedId = id;
  popoverTaskId = id;
  const a = anchorFor(id);
  popoverX = a.x;
  popoverY = a.y;
  vscode.postMessage({ type: 'popoverActiveChanged', taskId: id });
}

function closePopover() {
  if (popoverTaskId === null) return;
  popoverTaskId = null;
  vscode.postMessage({ type: 'popoverActiveChanged', taskId: null });
}

function onPopoverAction(kind: PopoverActionKind, id: string) {
  switch (kind) {
    case 'claim':
      vscode.postMessage({ type: 'claimTask', taskId: id });
      break;
    case 'dispatch':
      vscode.postMessage({ type: 'dispatchTask', taskId: id });
      break;
    case 'forceClaim':
      vscode.postMessage({ type: 'forceClaimTask', taskId: id });
      break;
    case 'release':
      vscode.postMessage({ type: 'releaseTask', taskId: id });
      break;
    case 'cancelDispatch':
      vscode.postMessage({ type: 'cancelDispatch', taskId: id });
      break;
    case 'approve':
      vscode.postMessage({ type: 'approveMerge', taskId: id });
      break;
    case 'sendBack':
      vscode.postMessage({ type: 'sendBackMerge', taskId: id });
      break;
    case 'markDone':
      vscode.postMessage({ type: 'updateTask', taskId: id, updates: { status: doneStatus } });
      break;
  }
}

function onPopoverExpand(id: string) {
  const t = layoutNodes.find((n) => n.id === id);
  onSelectTask(id, t ? { filePath: t.filePath, source: t.source, branch: t.branch } : undefined);
}
```

> **Note:** `handleSelect` no longer calls `onSelectTask` directly — a node click now opens the popover (which makes the task ephemeral-active), and the popover's `⤢` calls `onPopoverExpand → onSelectTask` to open the full details. This is the intended P2b behavior change; the P2a `clicking a node sends selectTask` test is replaced by `e2e/tree-popover.spec.ts` (Step 5) — **delete** that P2a test in `tree-canvas.spec.ts` (the one titled `clicking a node sends selectTask (no popover in P2a)`).

Close the popover when the user clicks empty canvas. Update `onPointerDown` (`TechTreeCanvas.svelte:92-98`):

```ts
function onPointerDown(e: PointerEvent) {
  const target = e.target as HTMLElement;
  if (target.closest('.tree-toolbar') || target.closest('.tree-popover')) return;
  if (target.closest('.tree-node')) return;
  closePopover();
  panning = true;
  panStart = { x: e.clientX, y: e.clientY, tx: vp.tx, ty: vp.ty };
  viewportEl?.setPointerCapture(e.pointerId);
}
```

Render the popover inside `.tree-canvas`, immediately after the closing `</div>` of `.tree-viewport` and before the warnings block (`TechTreeCanvas.svelte:219`, right after the viewport div closes):

```svelte
    </div>

    {#if popoverTask}
      <DetailPopover
        task={popoverTask}
        {statuses}
        {priorities}
        {taskIdDisplay}
        x={popoverX}
        y={popoverY}
        onClose={closePopover}
        onExpand={onPopoverExpand}
        onQuickEdit={(u) => vscode.postMessage({ type: 'updateTask', taskId: popoverTask.id, updates: u })}
        onAction={onPopoverAction}
      />
    {/if}

    {#if warnings.length > 0}
```

- [ ] **Step 4: Controller — route popover actions to commands (parity)**

In `src/providers/TasksController.ts`, extend the `activeTask` import (`TasksController.ts:21`) to add the writers:

```ts
import { readActiveTask, writeActiveTask, clearActiveTask } from '../core/activeTask';
```

Add cases to `handleMessage`'s switch. Put them next to the existing `approveMerge`/`sendBackMerge` cases (`TasksController.ts:774-782`):

```ts
      // Q6 (adjudicated, accepted for v1): a full refresh() on every open/close keeps
      // the isActiveTask board indicator correct and matches the existing setActiveTask
      // flow; on rapid node-clicking this re-emits the whole board. Accepted debt — a
      // targeted taskUpdated-style patch is a later optimization if it reads janky.
      case 'popoverActiveChanged': {
        if (!this.parser) break;
        try {
          const root = path.dirname(this.parser.getBacklogPath());
          if (message.taskId) {
            writeActiveTask(root, message.taskId);
          } else {
            clearActiveTask(root);
          }
          await this.refresh();
        } catch (error) {
          console.error('[Taskwright] popoverActiveChanged failed:', error);
        }
        break;
      }

      case 'claimTask': {
        vscode.commands.executeCommand('taskwright.claimTask', message.taskId);
        break;
      }

      case 'dispatchTask': {
        vscode.commands.executeCommand('taskwright.dispatchTask', message.taskId);
        break;
      }

      case 'forceClaimTask': {
        vscode.commands.executeCommand('taskwright.forceClaimTask', message.taskId);
        break;
      }

      case 'releaseTask': {
        vscode.commands.executeCommand('taskwright.releaseTask', message.taskId);
        break;
      }
```

(The `cancelDispatch` case is added in Task 5 with its command; leaving the message unhandled until then is harmless — the switch's default path ignores it.)

> **`taskwright.forceClaimTask` already exists — do NOT register it.** P1 ("UI dependency gate — force-claim override", commit `e777226`) already registered `taskwright.forceClaimTask` in `src/extension.ts:1056` and declared it in `package.json:260`; its body is functionally identical (`claimTaskForCurrentUser(taskId, parser, { force: true })` → `refreshAllViews()` → notify). A second `registerCommand('taskwright.forceClaimTask', …)` throws `command 'taskwright.forceClaimTask' already exists` at activation, so the extension never activates and every CDP/e2e test breaks. The Step-4 controller case (`case 'forceClaimTask': vscode.commands.executeCommand('taskwright.forceClaimTask', message.taskId)`) routes to the pre-existing command and needs nothing else. Consequently **Task 4 does not touch `src/extension.ts` or `package.json`** — they are dropped from Step 7's `git add`.

- [ ] **Step 5: Playwright — `e2e/tree-popover.spec.ts`**

Create `e2e/tree-popover.spec.ts`. It reuses the P2a fixture/setup shape; add `prioritiesUpdated` to the setup so the priority dropdown has options:

```ts
import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getLastPostedMessage,
  getPostedMessages,
  clearPostedMessages,
} from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const laneOrder = ['Features', 'Misc', 'Bugs'];
const bandOrder = ['v1', 'Backburner'];

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
      title: 'Unlocked todo',
      status: 'To Do',
      category: 'Features',
      milestone: 'v1',
      layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-2',
      title: 'Locked todo',
      status: 'To Do',
      category: 'Features',
      milestone: 'v1',
      dependencies: ['TASK-1'],
      locked: true,
      blockedBy: ['TASK-1'],
      layout: { lane: 'Features', band: 'v1', depth: 1, subRow: 0 },
    }),
    base({
      id: 'TASK-3',
      title: 'Mine in progress',
      status: 'In Progress',
      category: 'Misc',
      milestone: 'v1',
      claimedBy: 'me',
      claimedByMe: true,
      layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 0 },
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
  await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
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

test.describe('Tree detail popover', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('clicking a node opens the popover and posts popoverActiveChanged', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await expect(page.locator('[data-testid="tree-popover"]')).toBeVisible();
    const msgs = await getPostedMessages(page);
    expect(msgs).toContainEqual({ type: 'popoverActiveChanged', taskId: 'TASK-1' });
  });

  test('closing the popover posts popoverActiveChanged null', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await clearPostedMessages(page);
    await page.locator('[data-testid="tp-close"]').click();
    await expect(page.locator('[data-testid="tree-popover"]')).toHaveCount(0);
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'popoverActiveChanged',
      taskId: null,
    });
  });

  test('unlocked To Do offers Claim + Dispatch', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await expect(page.locator('[data-testid="tp-action-claim"]')).toBeVisible();
    await expect(page.locator('[data-testid="tp-action-dispatch"]')).toBeVisible();
    await page.locator('[data-testid="tp-action-claim"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'claimTask', taskId: 'TASK-1' });
  });

  test('locked To Do offers only Force claim', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-2"]').click();
    await expect(page.locator('[data-testid="tp-action-forceClaim"]')).toBeVisible();
    await expect(page.locator('[data-testid="tp-action-claim"]')).toHaveCount(0);
    await page.locator('[data-testid="tp-action-forceClaim"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'forceClaimTask',
      taskId: 'TASK-2',
    });
  });

  test('my in-progress task offers Mark done + Release', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-3"]').click();
    await page.locator('[data-testid="tp-action-markDone"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'updateTask',
      taskId: 'TASK-3',
      updates: { status: 'Done' },
    });
  });

  test('status quick-edit posts updateTask', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await page.locator('[data-testid="tp-status"]').selectOption('In Progress');
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'updateTask',
      taskId: 'TASK-1',
      updates: { status: 'In Progress' },
    });
  });

  test('expand posts selectTask', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await clearPostedMessages(page);
    await page.locator('[data-testid="tp-expand"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'selectTask',
      taskId: 'TASK-1',
    });
  });
});
```

- [ ] **Step 6: svelte-autofixer + build + test**

Run the `svelte` MCP `svelte-autofixer` on `DetailPopover.svelte` and `TechTreeCanvas.svelte` until clean. Then:

Run: `bun run build && bun run typecheck && bun run test -- TasksController && bun run test:playwright -- tree-popover tree-canvas`
Expected: PASS. (`tree-canvas` still green after deleting the obsolete `clicking a node sends selectTask` test; `tree-popover` green.)

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/tree/DetailPopover.svelte src/webview/components/tree/TechTreeCanvas.svelte \
  src/core/types.ts src/providers/TasksController.ts \
  e2e/tree-popover.spec.ts e2e/tree-canvas.spec.ts
git commit -m "feat(tree P2b): state-aware detail popover + ephemeral active (popoverActiveChanged)

- node click opens an anchored popover; opening writes .taskwright/active-task.json,
  closing clears it (popoverActiveChanged)
- state-aware actions route to the same commands the detail panel uses (parity);
  reuses the pre-existing taskwright.forceClaimTask command (no re-registration)
- Claim ⟂ Dispatch; ⤢ opens full details via selectTask

House UI exception on DetailPopover markup; behavior covered by e2e/tree-popover.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Cancel dispatch — pure orchestrator + command + controller case [opus-integration]

**Files:**

- Create: `src/core/cancelDispatch.ts`
- Test: `src/test/unit/cancelDispatch.test.ts`
- Modify: `src/providers/TasksController.ts`, `src/extension.ts`, `package.json`

**Behavior (directive item 3, adjudicated v1):** `cancelDispatch{taskId}` → **release claim** + **status → first configured status (To Do)** + **`git worktree remove --force` + prune** + **dispose the terminal if the extension launched it**. Leave exactly **one** documented TODO hook for P5's cancellation-marker protocol — no marker now. The order-and-parity logic lives in a pure, dependency-injected core so it is unit-tested; the command wires the real deps.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/cancelDispatch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { cancelDispatch } from '../../core/cancelDispatch';

describe('cancelDispatch', () => {
  it('releases the claim, resets status, removes the worktree, and disposes the terminal — in order', async () => {
    const calls: string[] = [];
    const deps = {
      releaseClaim: vi.fn(async () => {
        calls.push('release');
      }),
      setStatus: vi.fn(async (_id: string, _status: string) => {
        calls.push('status');
      }),
      removeWorktree: vi.fn(async (_rel: string) => {
        calls.push('worktree');
      }),
      disposeTerminal: vi.fn((_name: string) => {
        calls.push('terminal');
      }),
    };
    await cancelDispatch(deps, {
      taskId: 'TASK-7',
      branch: 'task-7-thing',
      toDoStatus: 'To Do',
      terminalName: 'Taskwright TASK-7',
    });
    expect(calls).toEqual(['release', 'status', 'worktree', 'terminal']);
    expect(deps.releaseClaim).toHaveBeenCalledWith('TASK-7');
    expect(deps.setStatus).toHaveBeenCalledWith('TASK-7', 'To Do');
    expect(deps.removeWorktree).toHaveBeenCalledWith('.worktrees/task-7-thing');
    expect(deps.disposeTerminal).toHaveBeenCalledWith('Taskwright TASK-7');
  });

  it('is best-effort: a failing step does not abort the remaining cleanup', async () => {
    const deps = {
      releaseClaim: vi.fn(async () => {
        throw new Error('release boom');
      }),
      setStatus: vi.fn(async () => {}),
      removeWorktree: vi.fn(async () => {}),
      disposeTerminal: vi.fn(() => {}),
    };
    await expect(
      cancelDispatch(deps, {
        taskId: 'TASK-1',
        branch: 'b',
        toDoStatus: 'To Do',
        terminalName: 'Taskwright TASK-1',
      })
    ).resolves.toBeUndefined();
    expect(deps.setStatus).toHaveBeenCalled();
    expect(deps.removeWorktree).toHaveBeenCalled();
    expect(deps.disposeTerminal).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- cancelDispatch` → FAIL (module missing).

- [ ] **Step 3: Write the implementation**

Create `src/core/cancelDispatch.ts`:

```ts
/**
 * Cancel a dispatched task (P2 spec §7, v1 scope). Reverses a dispatch: release
 * the claim, return the task to the first configured status, remove the isolated
 * worktree, and dispose the terminal the extension launched. Pure orchestrator —
 * every side effect is injected so this is unit-testable and reuses the same cores
 * the MCP/commands use (parity). Best-effort: one failing step never blocks the rest.
 */
export interface CancelDispatchDeps {
  releaseClaim: (taskId: string) => Promise<void>;
  setStatus: (taskId: string, status: string) => Promise<void>;
  removeWorktree: (worktreeRelPath: string) => Promise<void>;
  disposeTerminal: (terminalName: string) => void;
}

export interface CancelDispatchInput {
  taskId: string;
  /** Dispatch branch name (`dispatchBranchName(task)`); the worktree is `.worktrees/<branch>`. */
  branch: string;
  /** The status to reset to — the first configured status (usually "To Do"). */
  toDoStatus: string;
  /** The terminal name the dispatch used (`Taskwright <taskId>`). */
  terminalName: string;
}

async function attempt(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort cleanup — a failed step must not block the others
  }
}

export async function cancelDispatch(
  deps: CancelDispatchDeps,
  input: CancelDispatchInput
): Promise<void> {
  await attempt(() => deps.releaseClaim(input.taskId));
  await attempt(() => deps.setStatus(input.taskId, input.toDoStatus));
  await attempt(() => deps.removeWorktree(`.worktrees/${input.branch}`));
  await attempt(() => deps.disposeTerminal(input.terminalName));

  // TODO(P5): write a task/worktree-scoped cancellation marker that the dispatched
  // agent detects at its next checkpoint (the P5 cancellation-signal protocol — see
  // the P5 spec §6). P2 only tears down local state; it does not signal a live agent.
  //
  // Q2 (adjudicated, v1): "dispatched/agent" is inferred from the `worktree` claim
  // field — a human claiming from a worktree, or a dispatched-but-unclaimed task, are
  // accepted edge cases for v1. A firmer marker (`dispatched_at` frontmatter) lands
  // with this P5 cancellation protocol, not now.
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- cancelDispatch` → PASS.

- [ ] **Step 5: Controller — add the `cancelDispatch` case**

In `src/providers/TasksController.ts`, add next to the `releaseTask` case added in Task 4:

```ts
      case 'cancelDispatch': {
        vscode.commands.executeCommand('taskwright.cancelDispatch', message.taskId);
        break;
      }
```

- [ ] **Step 6: Register `taskwright.cancelDispatch`**

In `src/extension.ts`, add imports near the other core/provider imports (top of file):

```ts
import { cancelDispatch } from './core/cancelDispatch';
import { removeWorktree } from './core/finishTask';
import { dispatchBranchName } from './core/dispatchPrompt';
import type { GitExecFn } from './core/WorktreeService';
```

(`releaseTaskClaim` is already imported for `taskwright.releaseTask`; `execFileAsync`, `path`, `parser`, `writer`, `refreshAllViews`, `taskDetailProvider`, `resolveClaimTarget` are in scope in `activate()`. If `writer` is not already a local, add `const writer = new BacklogWriter();` beside the existing provider construction — grep for `new BacklogWriter()` first; `TaskDetailProvider`/`TasksController` construct their own, so a local may need adding.)

Register the command next to the existing `taskwright.forceClaimTask` (registered by P1 at `extension.ts:1056`; `writer`/`execFileAsync`/`path`/`parser`/`refreshAllViews`/`taskDetailProvider`/`resolveClaimTarget` are all in scope above it):

```ts
context.subscriptions.push(
  vscode.commands.registerCommand('taskwright.cancelDispatch', async (arg: unknown) => {
    const taskId = resolveClaimTarget(arg);
    if (!taskId || !parser) return;
    const task = await parser.getTask(taskId);
    if (!task) return;
    const confirm = await vscode.window.showWarningMessage(
      `Cancel dispatch for ${taskId}? This releases the claim, resets it to To Do, and removes its worktree.`,
      { modal: true },
      'Cancel dispatch'
    );
    if (confirm !== 'Cancel dispatch') return;

    const branch = dispatchBranchName(task);
    const statuses = await parser.getStatuses();
    const toDo = statuses[0] ?? 'To Do';
    const repoRoot = path.dirname(parser.getBacklogPath());
    const exec: GitExecFn = (cwd, args) =>
      execFileAsync('git', args, { cwd, timeout: 15_000 }).then((r) => ({
        stdout: r.stdout,
        stderr: r.stderr,
      }));

    await cancelDispatch(
      {
        releaseClaim: (id) => releaseTaskClaim(id, parser),
        setStatus: (id, status) => writer.updateTask(id, { status }, parser),
        removeWorktree: (rel) => removeWorktree(exec, repoRoot, rel),
        disposeTerminal: (name) => vscode.window.terminals.find((t) => t.name === name)?.dispose(),
      },
      { taskId, branch, toDoStatus: toDo, terminalName: `Taskwright ${taskId}` }
    );

    refreshAllViews();
    TaskDetailProvider.refreshCurrent(taskDetailProvider);
    vscode.window.showInformationMessage(
      `Cancelled dispatch for ${taskId}: released claim, reset to ${toDo}, removed worktree.`
    );
  })
);
```

Add the command to `package.json` `contributes.commands` (sibling of `taskwright.forceClaimTask`):

```json
        {
          "command": "taskwright.cancelDispatch",
          "title": "Taskwright: Cancel Dispatch"
        },
```

- [ ] **Step 7: Build + test + typecheck**

Run: `bun run build && bun run typecheck && bun run test -- cancelDispatch`
Expected: PASS. Manual sanity note (not a gate): the popover `Cancel dispatch` button (shown for an in-progress task with a `worktree`) posts `cancelDispatch` → the command prompts, tears down, and refreshes.

- [ ] **Step 8: Commit**

```bash
git add src/core/cancelDispatch.ts src/test/unit/cancelDispatch.test.ts \
  src/providers/TasksController.ts src/extension.ts package.json
git commit -m "feat(tree P2b): cancelDispatch — release claim + reset status + remove worktree + dispose terminal

- pure injected orchestrator (unit-tested, best-effort ordering); taskwright.cancelDispatch command
- one documented TODO hook for the P5 cancellation-marker protocol; no marker in P2

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Milestone popover + release checklist wiring [opus-integration]

**Files:**

- Create: `src/webview/components/tree/MilestonePopover.svelte`, `src/core/milestoneReleaseChecklist.ts`
- Modify: `src/webview/components/tree/AgeBandHeader.svelte`, `src/webview/components/tree/TechTreeCanvas.svelte`, `src/webview/components/tasks/Tasks.svelte`, `src/core/types.ts`, `src/providers/TasksController.ts`
- Create test: `e2e/tree-milestone.spec.ts`

**Behavior (directive item 7, spec §9):** click a band header → milestone popover with overall + per-lane progress and the milestone's **release checklist** (the manual DoD home). Checklist is stored in the milestone file as a `## Release Checklist` (`<!-- RC:BEGIN/END -->`) section, read/toggled through the Task 3 core. Note in the popover that automated checks are enforced by `request_merge`.

**Locked messages:** `milestoneData` (outbound), `toggleReleaseChecklistItem` (inbound). Helper: `requestMilestoneData{milestone}` (inbound).

- [ ] **Step 1: Milestone file adapter**

Create `src/core/milestoneReleaseChecklist.ts` (thin fs adapter over the Task 3 pure core + the shared CRLF idiom):

```ts
import * as fs from 'fs';
import * as path from 'path';
import { detectCRLF, normalizeToLF, restoreLineEndings } from './BacklogWriter';
import { parseReleaseChecklist, toggleReleaseChecklistItem } from './releaseChecklist';
import type { ChecklistItem } from './types';

/** Resolve the milestone file for a milestone id ("m-1") or display name. */
export function resolveMilestoneFile(backlogPath: string, milestone: string): string | undefined {
  const dir = path.join(backlogPath, 'milestones');
  if (!fs.existsSync(dir)) return undefined;
  const target = milestone.trim().toLowerCase();
  const slug = target.replace(/\s+/g, '-');
  for (const f of fs.readdirSync(dir)) {
    if (!/^m-\d+/i.test(f) || !f.toLowerCase().endsWith('.md')) continue;
    const id = f.match(/^(m-\d+)/i)?.[1]?.toLowerCase();
    const nameSlug = f
      .replace(/^m-\d+\s*-\s*/i, '')
      .replace(/\.md$/i, '')
      .toLowerCase();
    if (id === target || nameSlug === slug || f.toLowerCase().includes(target)) {
      return path.join(dir, f);
    }
  }
  return undefined;
}

/** Read the milestone's release-checklist items (empty when no file/section). */
export function readReleaseChecklist(backlogPath: string, milestone: string): ChecklistItem[] {
  const file = resolveMilestoneFile(backlogPath, milestone);
  if (!file) return [];
  try {
    return parseReleaseChecklist(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

/** Toggle one item by id (CRLF-preserving) and return the updated items. */
export function toggleReleaseChecklist(
  backlogPath: string,
  milestone: string,
  itemId: number
): ChecklistItem[] {
  const file = resolveMilestoneFile(backlogPath, milestone);
  if (!file) return [];
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const hasCRLF = detectCRLF(raw);
    const updated = toggleReleaseChecklistItem(normalizeToLF(raw), itemId);
    fs.writeFileSync(file, restoreLineEndings(updated, hasCRLF), 'utf-8');
    return parseReleaseChecklist(updated);
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Messages in `types.ts`**

`src/core/types.ts` — add to `WebviewMessage` (after the `cancelDispatch` variant from Task 4):

```ts
  | { type: 'requestMilestoneData'; milestone: string }
  | { type: 'toggleReleaseChecklistItem'; milestone: string; itemId: number }
```

(Move the trailing `;` to the new last member; the previous last member ends with `|`.)

Add to `ExtensionMessage` (after `prioritiesUpdated` from Task 1):

```ts
  | {
      type: 'milestoneData';
      milestone: string;
      total: number;
      done: number;
      lanes: Array<{ name: string; total: number; done: number }>;
      checklist: ChecklistItem[];
    }
```

(`ChecklistItem` is already declared in `types.ts`.)

- [ ] **Step 3: Controller — `requestMilestoneData` / `toggleReleaseChecklistItem`**

In `src/providers/TasksController.ts`, add imports:

```ts
import { laneOf } from '../core/treeLayout';
import { readReleaseChecklist, toggleReleaseChecklist } from '../core/milestoneReleaseChecklist';
```

Add the two cases (next to the popover cases from Task 4/5):

```ts
      case 'requestMilestoneData': {
        await this.sendMilestoneData(message.milestone);
        break;
      }

      case 'toggleReleaseChecklistItem': {
        if (!this.parser) break;
        toggleReleaseChecklist(this.parser.getBacklogPath(), message.milestone, message.itemId);
        this.parser.invalidateMilestoneCache();
        await this.sendMilestoneData(message.milestone);
        break;
      }
```

Add the private helper method (place it near `refresh()` / other private methods in the class body):

```ts
  private async sendMilestoneData(milestone: string): Promise<void> {
    if (!this.parser) return;
    try {
      const [tasks, statuses] = await Promise.all([
        this.parser.getTasks(),
        this.parser.getStatuses(),
      ]);
      const doneStatus = statuses.length > 0 ? statuses[statuses.length - 1] : 'Done';
      const inMilestone = tasks.filter((t) => (t.milestone ?? 'Backburner') === milestone);
      const laneMap = new Map<string, { total: number; done: number }>();
      let total = 0;
      let done = 0;
      for (const t of inMilestone) {
        total++;
        const isDone = t.status === doneStatus;
        if (isDone) done++;
        const lane = laneOf(t);
        const l = laneMap.get(lane) ?? { total: 0, done: 0 };
        l.total++;
        if (isDone) l.done++;
        laneMap.set(lane, l);
      }
      const checklist = readReleaseChecklist(this.parser.getBacklogPath(), milestone);
      this.host.postMessage({
        type: 'milestoneData',
        milestone,
        total,
        done,
        lanes: Array.from(laneMap.entries()).map(([name, v]) => ({ name, ...v })),
        checklist,
      });
    } catch (error) {
      console.error('[Taskwright] milestone data failed:', error);
    }
  }
```

- [ ] **Step 4: `MilestonePopover.svelte`**

Create `src/webview/components/tree/MilestonePopover.svelte`:

```svelte
<script lang="ts">
  import type { ChecklistItem } from '../../lib/types';

  interface LaneProgress {
    name: string;
    total: number;
    done: number;
  }
  interface Props {
    milestone: string;
    total: number;
    done: number;
    lanes: LaneProgress[];
    checklist: ChecklistItem[];
    x: number;
    y: number;
    onClose: () => void;
    onToggle: (itemId: number) => void;
  }
  let { milestone, total, done, lanes, checklist, x, y, onClose, onToggle }: Props = $props();

  const pct = $derived(total > 0 ? Math.round((done / total) * 100) : 0);
  const lanePct = (l: LaneProgress) => (l.total > 0 ? Math.round((l.done / l.total) * 100) : 0);
</script>

<div
  class="ms-popover"
  data-testid="milestone-popover"
  data-milestone={milestone}
  style="left:{x}px; top:{y}px;"
  role="dialog"
  aria-label="Milestone {milestone}"
>
  <div class="ms-head">
    <span class="ms-title">{milestone}</span>
    <button class="ms-close" data-testid="ms-close" title="Close" onclick={onClose}>
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
  </div>

  <div class="ms-overall" data-testid="ms-overall">
    <div class="ms-bar"><span class="ms-bar-fill" style="width:{pct}%"></span></div>
    <span class="ms-stat">{done}/{total} tasks · {pct}%</span>
  </div>

  {#if lanes.length > 0}
    <div class="ms-lanes">
      {#each lanes as l (l.name)}
        <div class="ms-lane" data-testid="ms-lane-{l.name}">
          <span class="ms-lane-name">{l.name}</span>
          <span class="ms-lane-stat">{l.done}/{l.total} · {lanePct(l)}%</span>
        </div>
      {/each}
    </div>
  {/if}

  <div class="ms-checklist">
    <div class="ms-checklist-title">Release checklist</div>
    {#if checklist.length === 0}
      <div class="ms-empty" data-testid="ms-empty">No release checklist items yet.</div>
    {:else}
      {#each checklist as item (item.id)}
        <label class="ms-item" data-testid="rc-item-{item.id}">
          <input
            type="checkbox"
            checked={item.checked}
            data-testid="rc-toggle-{item.id}"
            onchange={() => onToggle(item.id)}
          />
          <span class:checked={item.checked}>{item.text}</span>
        </label>
      {/each}
    {/if}
  </div>

  <div class="ms-note">
    Automated checks (test · lint · typecheck) are enforced per task by request_merge — not listed
    here.
  </div>
</div>

<style>
  .ms-popover {
    position: absolute;
    z-index: 30;
    width: 300px;
    max-width: calc(100% - 16px);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    color: var(--vscode-foreground);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  .ms-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .ms-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ms-close {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    padding: 3px;
    border-radius: 4px;
    opacity: 0.8;
  }
  .ms-close:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .ms-overall {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ms-bar {
    height: 6px;
    border-radius: 3px;
    background: var(--vscode-progressBar-background, rgba(255, 255, 255, 0.1));
    overflow: hidden;
  }
  .ms-bar-fill {
    display: block;
    height: 100%;
    background: var(--vscode-charts-green, #89d185);
  }
  .ms-stat {
    font-size: 11px;
    opacity: 0.85;
  }
  .ms-lanes {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .ms-lane {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    opacity: 0.9;
  }
  .ms-checklist {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ms-checklist-title {
    font-size: 11px;
    font-weight: 600;
    opacity: 0.8;
  }
  .ms-empty {
    font-size: 11px;
    opacity: 0.6;
  }
  .ms-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12px;
    cursor: pointer;
  }
  .ms-item span.checked {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .ms-note {
    font-size: 10px;
    opacity: 0.6;
    line-height: 1.3;
  }
</style>
```

- [ ] **Step 5: Make band headers clickable in `AgeBandHeader.svelte`**

Add an `onOpenMilestone` prop and turn each header into a `<button>`. Replace `AgeBandHeader.svelte:1-22` (the script props + markup, from the opening `<script lang="ts">` through the closing `</div>` of `.tree-band-headers`) with:

```svelte
<script lang="ts">
  import type { BandRange } from '../../lib/treeGeometry';

  interface Props {
    bands: BandRange[];
    scale: number;
    tx: number;
    onOpenMilestone: (band: string) => void;
  }
  let { bands, scale, tx, onOpenMilestone }: Props = $props();
</script>

<div class="tree-band-headers" data-testid="tree-band-headers">
  {#each bands as band (band.name)}
    <button
      class="tree-band-header"
      data-testid="tree-band-{band.name}"
      style="left:{band.x * scale + tx}px; width:{band.width * scale}px;"
      onclick={() => onOpenMilestone(band.name)}
      title="Milestone {band.name}"
    >
      <span class="tree-band-label">{band.name}</span>
    </button>
  {/each}
</div>
```

In its `<style>` block, the container `.tree-band-headers` keeps `pointer-events: none;` — override it on the button so clicks land. Change the `.tree-band-header` rule (`AgeBandHeader.svelte:35`) to add these three lines to the existing declarations:

```css
.tree-band-header {
  all: unset;
  cursor: pointer;
  pointer-events: auto;
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
```

(`all: unset` resets the button; re-declare the visual rules that P2a had. The `pointer-events: auto` beats the container's `none`.)

- [ ] **Step 6: Host in `TechTreeCanvas.svelte`**

Add the import:

```ts
import MilestonePopover from './MilestonePopover.svelte';
```

Add a `milestoneData` prop (fed by Tasks.svelte) to `Props`/`$props()` — add it after `crossBranch`:

```ts
    crossBranch?: boolean;
    milestoneData?: {
      milestone: string;
      total: number;
      done: number;
      lanes: Array<{ name: string; total: number; done: number }>;
      checklist: import('../../lib/types').ChecklistItem[];
    } | null;
```

and in the destructure add `milestoneData = null,`.

Add milestone popover state (after the detail-popover state from Task 4):

```ts
let milestoneBand = $state<string | null>(null);
let milestoneX = $state(0);
let milestoneY = $state(0);
const openMilestoneData = $derived(
  milestoneBand && milestoneData && milestoneData.milestone === milestoneBand ? milestoneData : null
);

function openMilestone(band: string) {
  milestoneBand = band;
  const b = geometry.bands.find((bnd) => bnd.name === band);
  milestoneX = b ? Math.max(8, b.x * vp.scale + vp.tx) : 8;
  milestoneY = 28;
  vscode.postMessage({ type: 'requestMilestoneData', milestone: band });
}
function closeMilestone() {
  milestoneBand = null;
}
```

Also close the milestone popover when the user clicks empty canvas (Minor 11 — both popovers render as siblings **outside** `.tree-viewport`, so `onPointerDown` fires only for in-canvas clicks; adding this is safe and never fires from inside a popover). In the Task-4 `onPointerDown` rewrite, add `closeMilestone();` beside the existing `closePopover();`:

```ts
if (target.closest('.tree-node')) return;
closePopover();
closeMilestone();
panning = true;
```

Wire `onOpenMilestone` into `<AgeBandHeader>` (match the `<AgeBandHeader …>` line — after Tasks 2/4 it sits around `TechTreeCanvas.svelte:~214`; base was `:182`):

```svelte
      <AgeBandHeader bands={geometry.bands} scale={vp.scale} tx={vp.tx} onOpenMilestone={openMilestone} />
```

Render the milestone popover beside the detail popover (inside `.tree-canvas`, after the `{#if popoverTask}` block from Task 4):

```svelte
    {#if openMilestoneData}
      <MilestonePopover
        milestone={openMilestoneData.milestone}
        total={openMilestoneData.total}
        done={openMilestoneData.done}
        lanes={openMilestoneData.lanes}
        checklist={openMilestoneData.checklist}
        x={milestoneX}
        y={milestoneY}
        onClose={closeMilestone}
        onToggle={(itemId) =>
          vscode.postMessage({ type: 'toggleReleaseChecklistItem', milestone: openMilestoneData.milestone, itemId })}
      />
    {/if}
```

- [ ] **Step 7: Relay `milestoneData` through `Tasks.svelte`**

Add state (near the tree vocab state):

```ts
let milestoneData = $state<Extract<ExtensionMessage, { type: 'milestoneData' }> | null>(null);
```

(`ExtensionMessage` is already imported into `Tasks.svelte` via `../../lib/types`? It is re-exported there; add it to the type import at `Tasks.svelte:2` if missing.)

Add the message case:

```ts
      case 'milestoneData':
        milestoneData = message;
        break;
```

Pass it to the canvas in the tree render branch:

```svelte
      {crossBranch}
      {milestoneData}
      onSelectTask={handleSelectTask}
```

- [ ] **Step 8: Playwright — `e2e/tree-milestone.spec.ts`**

Create `e2e/tree-milestone.spec.ts` (reuses the tasks fixture; drives the band header, injects `milestoneData` as the extension would reply):

```ts
import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getLastPostedMessage,
} from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const laneOrder = ['Features', 'Bugs'];
const bandOrder = ['v1', 'Backburner'];

function tasks(): Task[] {
  return [
    {
      id: 'TASK-1',
      title: 'A',
      status: 'Done',
      category: 'Features',
      milestone: 'v1',
      labels: [],
      assignee: [],
      dependencies: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: '/b/tasks/task-1.md',
      layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
    } as Task,
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
  await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: tasks() });
  await postMessageToWebview(page, {
    type: 'treeLayoutUpdated',
    laneOrder,
    bandOrder,
    warnings: [],
  });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(150);
}

test.describe('Milestone popover', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('clicking a band header requests milestone data and renders the popover', async ({
    page,
  }) => {
    await page.locator('[data-testid="tree-band-v1"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'requestMilestoneData',
      milestone: 'v1',
    });

    await postMessageToWebview(page, {
      type: 'milestoneData',
      milestone: 'v1',
      total: 4,
      done: 1,
      lanes: [{ name: 'Features', total: 3, done: 1 }],
      checklist: [
        { id: 1, text: 'Update changelog', checked: false },
        { id: 2, text: 'Smoke test', checked: true },
      ],
    });
    await expect(page.locator('[data-testid="milestone-popover"]')).toBeVisible();
    await expect(page.locator('[data-testid="ms-overall"]')).toContainText('1/4');
    await expect(page.locator('[data-testid="rc-item-1"]')).toBeVisible();
  });

  test('toggling a release-checklist item posts toggleReleaseChecklistItem', async ({ page }) => {
    await page.locator('[data-testid="tree-band-v1"]').click();
    await postMessageToWebview(page, {
      type: 'milestoneData',
      milestone: 'v1',
      total: 1,
      done: 0,
      lanes: [],
      checklist: [{ id: 1, text: 'Update changelog', checked: false }],
    });
    await page.locator('[data-testid="rc-toggle-1"]').check();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'toggleReleaseChecklistItem',
      milestone: 'v1',
      itemId: 1,
    });
  });
});
```

- [ ] **Step 9: svelte-autofixer + build + test**

Run the `svelte` MCP `svelte-autofixer` on `MilestonePopover.svelte`, `AgeBandHeader.svelte`, `TechTreeCanvas.svelte` until clean. Then:

Run: `bun run build && bun run typecheck && bun run test:playwright -- tree-milestone tree-canvas`
Expected: PASS. The P2a `AgeBandHeader` positioning tests still pass (band `left`/`width` unchanged; only the element became a `<button>`).

- [ ] **Step 10: Commit**

```bash
git add src/webview/components/tree/MilestonePopover.svelte src/core/milestoneReleaseChecklist.ts \
  src/webview/components/tree/AgeBandHeader.svelte src/webview/components/tree/TechTreeCanvas.svelte \
  src/webview/components/tasks/Tasks.svelte src/core/types.ts src/providers/TasksController.ts \
  e2e/tree-milestone.spec.ts
git commit -m "feat(tree P2b): milestone popover + file-backed release checklist (milestoneData/toggleReleaseChecklistItem)

- band header opens overall + per-lane progress and the milestone's Release Checklist
- RC section stored in the milestone file, parsed/toggled via releaseChecklist core

House UI exception on popover markup; behavior covered by e2e/tree-milestone.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: In-flight panel [opus-integration]

**Files:**

- Create: `src/webview/components/tree/InFlightPanel.svelte`
- Modify: `src/webview/components/tree/TechTreeCanvas.svelte`
- Create test: `e2e/tree-inflight.spec.ts`

**Behavior (spec §10):** a collapsible right-edge overlay inside the canvas showing **Active** tasks (from the `isActiveTask` enrichment) and **merge-queue** entries (`mergeState`, with queue position) with inline **Approve / Send back** for manual-review pending entries. Reuses the existing `approveMerge`/`sendBackMerge` messages — no new logic.

- [ ] **Step 1: `InFlightPanel.svelte`**

Create `src/webview/components/tree/InFlightPanel.svelte`:

```svelte
<script lang="ts">
  import type { Task, MergeTaskState } from '../../lib/types';

  type FlightTask = Task & { isActiveTask?: boolean; mergeState?: MergeTaskState };
  interface Props {
    tasks: FlightTask[];
    onApprove: (taskId: string) => void;
    onSendBack: (taskId: string) => void;
  }
  let { tasks, onApprove, onSendBack }: Props = $props();

  let collapsed = $state(false);
  const active = $derived(tasks.filter((t) => t.isActiveTask));
  const queue = $derived(
    tasks
      .filter((t) => !!t.mergeState)
      .sort((a, b) => (a.mergeState!.position ?? 0) - (b.mergeState!.position ?? 0))
  );
  const isManualPending = (t: FlightTask) =>
    !!t.mergeState && !t.mergeState.approved && t.mergeState.mode === 'manual-review';
</script>

<div class="inflight" class:collapsed data-testid="inflight-panel">
  <button
    class="inflight-toggle"
    data-testid="inflight-toggle"
    title={collapsed ? 'Show in-flight' : 'Hide in-flight'}
    onclick={() => (collapsed = !collapsed)}
  >
    {#if collapsed}
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
    {:else}
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
    {/if}
  </button>

  {#if !collapsed}
    <div class="inflight-body">
      <div class="inflight-section">
        <div class="inflight-title">Active</div>
        {#if active.length === 0}<div class="inflight-empty">None</div>{/if}
        {#each active as t (t.id)}
          <div class="inflight-row" data-testid="inflight-active-{t.id}">
            <span class="inflight-id">{t.id}</span>
            <span class="inflight-name" title={t.title}>{t.title}</span>
          </div>
        {/each}
      </div>

      <div class="inflight-section">
        <div class="inflight-title">Merge queue</div>
        {#if queue.length === 0}<div class="inflight-empty">None</div>{/if}
        {#each queue as t (t.id)}
          <div class="inflight-row" data-testid="inflight-queue-{t.id}">
            <span class="inflight-id">{t.id}</span>
            {#if t.mergeState?.position}<span class="inflight-pos">#{t.mergeState.position}</span>{/if}
            <span class="inflight-name" title={t.title}>{t.title}</span>
            {#if isManualPending(t)}
              <div class="inflight-actions">
                <button class="inflight-btn primary" data-testid="inflight-approve-{t.id}" onclick={() => onApprove(t.id)}>Approve</button>
                <button class="inflight-btn" data-testid="inflight-sendback-{t.id}" onclick={() => onSendBack(t.id)}>Send back</button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .inflight {
    position: absolute;
    top: 44px;
    right: 8px;
    z-index: 15;
    display: flex;
    align-items: flex-start;
    max-height: calc(100% - 60px);
  }
  .inflight-toggle {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 6px 0 0 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    color: var(--vscode-foreground);
  }
  .inflight-body {
    width: 220px;
    max-height: calc(100vh - 120px);
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 0 6px 6px 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .inflight-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .inflight-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }
  .inflight-empty {
    font-size: 11px;
    opacity: 0.5;
  }
  .inflight-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    font-size: 11px;
  }
  .inflight-id {
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }
  .inflight-pos {
    color: var(--vscode-charts-purple, #b180d7);
  }
  .inflight-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .inflight-actions {
    display: flex;
    gap: 4px;
    width: 100%;
  }
  .inflight-btn {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
  }
  .inflight-btn.primary {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .inflight-btn:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }
</style>
```

- [ ] **Step 2: Host in `TechTreeCanvas.svelte`**

Add the import:

```ts
import InFlightPanel from './InFlightPanel.svelte';
```

Render it inside `.tree-canvas`, right after the `.tree-toolbar` div closes (`TechTreeCanvas.svelte:167`):

```svelte
    </div>

    <InFlightPanel
      {tasks}
      onApprove={(id) => vscode.postMessage({ type: 'approveMerge', taskId: id })}
      onSendBack={(id) => vscode.postMessage({ type: 'sendBackMerge', taskId: id })}
    />

    <div
      class="tree-viewport"
```

(`tasks` here is the full enriched task list already passed into the canvas — it carries `isActiveTask` and `mergeState`.)

- [ ] **Step 3: Playwright — `e2e/tree-inflight.spec.ts`**

Create `e2e/tree-inflight.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getLastPostedMessage,
} from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const laneOrder = ['Features'];
const bandOrder = ['v1'];

function tasks(): Task[] {
  const base = (over: Partial<Task> & { id: string }): Task =>
    ({
      title: over.id,
      status: 'In Progress',
      labels: [],
      assignee: [],
      dependencies: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: `/b/tasks/${over.id}.md`,
      category: 'Features',
      milestone: 'v1',
      layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
      ...over,
    }) as Task;
  return [
    base({ id: 'TASK-1', title: 'Active one', isActiveTask: true } as Partial<Task> & {
      id: string;
    }),
    base({
      id: 'TASK-2',
      title: 'Pending review',
      layout: { lane: 'Features', band: 'v1', depth: 1, subRow: 0 },
      mergeState: { position: 2, approved: false, mode: 'manual-review' },
    } as unknown as Partial<Task> & { id: string }),
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
  await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: tasks() });
  await postMessageToWebview(page, {
    type: 'treeLayoutUpdated',
    laneOrder,
    bandOrder,
    warnings: [],
  });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(150);
}

test.describe('In-flight panel', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('lists active tasks and merge-queue entries', async ({ page }) => {
    await expect(page.locator('[data-testid="inflight-active-TASK-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="inflight-queue-TASK-2"]')).toBeVisible();
  });

  test('Approve posts approveMerge', async ({ page }) => {
    await page.locator('[data-testid="inflight-approve-TASK-2"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'approveMerge',
      taskId: 'TASK-2',
    });
  });

  test('collapses to reclaim width', async ({ page }) => {
    await page.locator('[data-testid="inflight-toggle"]').click();
    await expect(page.locator('[data-testid="inflight-active-TASK-1"]')).toHaveCount(0);
  });
});
```

- [ ] **Step 4: svelte-autofixer + build + test**

Run the `svelte` MCP `svelte-autofixer` on `InFlightPanel.svelte` until clean. Then:

Run: `bun run build && bun run typecheck && bun run test:playwright -- tree-inflight`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview/components/tree/InFlightPanel.svelte src/webview/components/tree/TechTreeCanvas.svelte \
  e2e/tree-inflight.spec.ts
git commit -m "feat(tree P2b): in-flight panel (active + merge queue with Approve/Send back)

House UI exception on panel markup; behavior covered by e2e/tree-inflight.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Navigator webview — scaffolding, provider, static UI, `navigatorData` feed [opus-integration]

**Files:**

- Create: `src/webview/entries/tree-navigator.ts`, `src/webview/components/navigator/TreeNavigator.svelte`, `src/providers/TreeNavigatorProvider.ts`, `e2e/webview-fixtures/tree-navigator.html`, `e2e/tree-navigator.spec.ts`
- Modify: `vite.webview.config.ts`, `package.json`, `src/core/types.ts`, `src/providers/TasksController.ts`, `src/providers/TasksViewProvider.ts`, `src/providers/TasksPanelProvider.ts`, `src/extension.ts`

**Behavior (directive item 4, spec §3):** a NEW sidebar `WebviewView` `taskwright.treeNavigator` (its own bundle) with search, priority chips (from config priorities), lane toggles + counts, an age jump-bar, and a minimap grid. It posts `navigatorFilterChanged`/`navigatorLaneToggle`/`navigatorJump`; the extension **relays** these to the canvas. Its data (`navigatorData`) is computed by its provider from the parser. The existing sidebar kanban view REMAINS. (Canvas **consumption** of these messages + the minimap viewport rect are Task 9; this task defines every message and stands the navigator up.)

**Message shapes (defined here, consumed across Tasks 8–9):**

- `WebviewMessage`: `navigatorFilterChanged{ search, priority }`, `navigatorLaneToggle{ lane }`, `navigatorJump{ band }`, `minimapViewport{ x, y, w, h }`.
- `ExtensionMessage`: `navigatorData{ lanes: {name,count}[], bands: string[], priorities: string[] }`, plus the same `navigatorFilterChanged`/`navigatorLaneToggle`/`navigatorJump`/`minimapViewport` (relay targets for the canvas / navigator).

- [ ] **Step 1: Messages in `types.ts`**

`src/core/types.ts` — add to `WebviewMessage` (after `toggleReleaseChecklistItem` from Task 6; keep the `;` on the final member):

```ts
  | { type: 'navigatorFilterChanged'; search: string; priority: string }
  | { type: 'navigatorLaneToggle'; lane: string }
  | { type: 'navigatorJump'; band: string }
  | { type: 'minimapViewport'; x: number; y: number; w: number; h: number }
```

Add to `ExtensionMessage` (after `milestoneData` from Task 6):

```ts
  | {
      type: 'navigatorData';
      lanes: Array<{ name: string; count: number }>;
      bands: string[];
      priorities: string[];
    }
  | { type: 'navigatorFilterChanged'; search: string; priority: string }
  | { type: 'navigatorLaneToggle'; lane: string }
  | { type: 'navigatorJump'; band: string }
  | { type: 'minimapViewport'; x: number; y: number; w: number; h: number }
```

- [ ] **Step 2: Vite bundle entry**

In `vite.webview.config.ts`, add to the `rollupOptions.input` map (after the `content-detail` line):

```ts
        'content-detail': resolve(__dirname, 'src/webview/entries/content-detail.ts'),
        'tree-navigator': resolve(__dirname, 'src/webview/entries/tree-navigator.ts'),
```

- [ ] **Step 3: `package.json` — the new view**

Add a third view object into `contributes.views.taskwright` (after the `taskwright.taskPreview` entry):

```json
        {
          "type": "webview",
          "id": "taskwright.taskPreview",
          "name": "Details",
          "icon": "images/view-task-preview.svg",
          "visibility": "visible"
        },
        {
          "type": "webview",
          "id": "taskwright.treeNavigator",
          "name": "Tree Navigator",
          "icon": "images/view-kanban.svg"
        }
```

- [ ] **Step 4: Entry file**

Create `src/webview/entries/tree-navigator.ts`:

```ts
/**
 * Tree Navigator webview entry point — search, priority chips, lane toggles,
 * age jump-bar, and minimap for the tech-tree canvas (P2 spec §3).
 */
import { mount } from 'svelte';
import TreeNavigator from '../components/navigator/TreeNavigator.svelte';

const target = document.getElementById('app');
if (target) {
  mount(TreeNavigator, { target });
}

export {};
```

- [ ] **Step 5: `TreeNavigator.svelte`**

Create `src/webview/components/navigator/TreeNavigator.svelte`:

```svelte
<script lang="ts">
  import { vscode, onMessage } from '../../stores/vscode.svelte';
  import { onMount } from 'svelte';

  let lanes = $state<Array<{ name: string; count: number }>>([]);
  let bands = $state<string[]>([]);
  let priorities = $state<string[]>([]);
  let search = $state('');
  let activePriority = $state('');
  let collapsedLanes = $state(new Set<string>());
  let viewport = $state<{ x: number; y: number; w: number; h: number } | null>(null);

  onMessage((message) => {
    switch (message.type) {
      case 'navigatorData':
        lanes = message.lanes;
        bands = message.bands;
        priorities = message.priorities;
        break;
      case 'minimapViewport':
        viewport = { x: message.x, y: message.y, w: message.w, h: message.h };
        break;
    }
  });

  onMount(() => vscode.postMessage({ type: 'refresh' }));

  function emitFilter() {
    vscode.postMessage({ type: 'navigatorFilterChanged', search, priority: activePriority });
  }
  function onSearchInput(e: Event) {
    search = (e.currentTarget as HTMLInputElement).value;
    emitFilter();
  }
  function togglePriority(p: string) {
    activePriority = activePriority === p ? '' : p;
    emitFilter();
  }
  function toggleLane(name: string) {
    const next = new Set(collapsedLanes);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    collapsedLanes = next;
    vscode.postMessage({ type: 'navigatorLaneToggle', lane: name });
  }
  function jump(band: string) {
    vscode.postMessage({ type: 'navigatorJump', band });
  }
</script>

<div class="nav" data-testid="tree-navigator">
  <div class="nav-search">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    <input
      type="text"
      placeholder="Search tasks…"
      data-testid="nav-search"
      value={search}
      oninput={onSearchInput}
    />
  </div>

  {#if priorities.length > 0}
    <div class="nav-section">
      <div class="nav-title">Priority</div>
      <div class="nav-chips">
        {#each priorities as p (p)}
          <button
            class="nav-chip"
            class:active={activePriority === p}
            data-testid="nav-priority-{p}"
            onclick={() => togglePriority(p)}
          >
            {p}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="nav-section">
    <div class="nav-title">Lanes</div>
    {#each lanes as lane (lane.name)}
      <button
        class="nav-lane"
        class:collapsed={collapsedLanes.has(lane.name)}
        data-testid="nav-lane-{lane.name}"
        onclick={() => toggleLane(lane.name)}
        title="Toggle {lane.name}"
      >
        <span class="nav-lane-name">{lane.name}</span>
        <span class="nav-lane-count">{lane.count}</span>
      </button>
    {/each}
  </div>

  {#if bands.length > 0}
    <div class="nav-section">
      <div class="nav-title">Jump to age</div>
      <div class="nav-jumps">
        {#each bands as band (band)}
          <button class="nav-jump" data-testid="nav-jump-{band}" onclick={() => jump(band)}>{band}</button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="nav-section">
    <div class="nav-title">Minimap</div>
    <div class="nav-minimap" data-testid="nav-minimap">
      <div class="nav-minimap-grid">
        {#each bands as band (band)}
          <button class="nav-minimap-col" data-testid="nav-minimap-{band}" title={band} onclick={() => jump(band)}></button>
        {/each}
      </div>
      {#if viewport}
        <div
          class="nav-minimap-vp"
          data-testid="nav-minimap-vp"
          style="left:{viewport.x * 100}%; top:{viewport.y * 100}%; width:{viewport.w * 100}%; height:{viewport.h * 100}%;"
        ></div>
      {/if}
    </div>
  </div>
</div>

<style>
  .nav {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 8px;
    color: var(--vscode-foreground);
    font-size: 12px;
  }
  .nav-search {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 4px;
    background: var(--vscode-input-background, var(--vscode-editor-background));
  }
  .nav-search input {
    all: unset;
    flex: 1;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    font-size: 12px;
  }
  .nav-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .nav-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }
  .nav-chips,
  .nav-jumps {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .nav-chip,
  .nav-jump {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
  }
  .nav-chip.active {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .nav-lane {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 6px;
    border-radius: 4px;
  }
  .nav-lane:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .nav-lane.collapsed .nav-lane-name {
    opacity: 0.45;
    text-decoration: line-through;
  }
  .nav-lane-count {
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }
  .nav-minimap {
    position: relative;
    height: 80px;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 4px;
    overflow: hidden;
    background: var(--vscode-editor-background);
  }
  .nav-minimap-grid {
    display: flex;
    height: 100%;
  }
  .nav-minimap-col {
    all: unset;
    cursor: pointer;
    flex: 1;
    border-right: 1px solid var(--vscode-panel-border, #444);
    background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
  }
  .nav-minimap-col:hover {
    background: color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  }
  .nav-minimap-vp {
    position: absolute;
    border: 1px solid var(--vscode-focusBorder);
    background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
    pointer-events: none;
  }
</style>
```

- [ ] **Step 6: `TreeNavigatorProvider.ts`**

Create `src/providers/TreeNavigatorProvider.ts` (self-contained `WebviewViewProvider`, mirroring `TasksViewProvider`'s pattern — does not extend `BaseViewProvider`):

```ts
import * as vscode from 'vscode';
import { BacklogParser } from '../core/BacklogParser';
import type { WebviewMessage, ExtensionMessage } from '../core/types';
import { loadTreeBoardFromParser } from '../core/treeDerived';
import { resolvePriorities } from '../core/priorityOrder';

/**
 * Sidebar navigator for the tech-tree canvas (P2 spec §3). Computes lane counts /
 * bands / priorities from the parser and posts `navigatorData`; relays the user's
 * filter / lane-toggle / jump intents to the board (canvas) via an injected callback.
 */
export class TreeNavigatorProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private parser: BacklogParser | undefined,
    private readonly relayToBoard: (message: ExtensionMessage) => void
  ) {}

  setParser(parser: BacklogParser): void {
    this.parser = parser;
  }

  postMessage(message: ExtensionMessage): void {
    this._view?.webview.postMessage(message);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (message.type === 'refresh') {
        await this.refresh();
        return;
      }
      if (
        message.type === 'navigatorFilterChanged' ||
        message.type === 'navigatorLaneToggle' ||
        message.type === 'navigatorJump'
      ) {
        this.relayToBoard(message as unknown as ExtensionMessage);
      }
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.parser || !this._view) return;
    try {
      const [board, config] = await Promise.all([
        loadTreeBoardFromParser(this.parser),
        this.parser.getConfig(),
      ]);
      const counts = new Map<string, number>();
      for (const s of board.states.values()) {
        counts.set(s.layout.lane, (counts.get(s.layout.lane) ?? 0) + 1);
      }
      const lanes = board.laneOrder
        .filter((l) => counts.has(l))
        .map((name) => ({ name, count: counts.get(name) ?? 0 }));
      this.postMessage({
        type: 'navigatorData',
        lanes,
        bands: board.bandOrder,
        priorities: resolvePriorities(config),
      });
    } catch (error) {
      console.error('[Taskwright] navigator refresh failed:', error);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const uri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', f));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link href="${uri('styles.css')}" rel="stylesheet">
  <link href="${uri('tree-navigator.css')}" rel="stylesheet">
  <title>Tree Navigator</title>
</head>
<body class="tree-navigator-page">
  <div id="app"></div>
  <script type="module" src="${uri('tree-navigator.js')}"></script>
</body>
</html>`;
  }
}
```

- [ ] **Step 7: Controller — `relayNavigator`**

In `src/providers/TasksController.ts`, add a public method (place it near the other public methods like `setViewMode`):

```ts
  /** Relay a navigator-originated message (from the sidebar navigator) to this board's webview. */
  relayNavigator(message: ExtensionMessage): void {
    this.host.postMessage(message);
  }
```

- [ ] **Step 8: Expose `relayNavigator` on both board surfaces**

`src/providers/TasksViewProvider.ts` — add `ExtensionMessage` to the type import from `../core/types`, and add the delegator (next to `refresh()` at lines 79-81):

```ts
  relayNavigator(message: ExtensionMessage): void {
    this.controller.relayNavigator(message);
  }
```

`src/providers/TasksPanelProvider.ts` — add `ExtensionMessage` to its `../core/types` import and add the delegator (next to the other `this.controller?.` forwarders):

```ts
  relayNavigator(message: ExtensionMessage): void {
    this.controller?.relayNavigator(message);
  }
```

`src/extension.ts` — add `relayNavigator` to the `TasksBoardSurface` interface (lines 261-274):

```ts
interface TasksBoardSurface {
  refresh(): Promise<void>;
  setParser(parser: BacklogParser): void;
  setWorkspaceRoot(root: string): void;
  setDataSourceMode(mode: DataSourceMode, reason?: string): void;
  setActiveEditedTaskId(taskId: string | null): void;
  checkAndSendIntegrationState(): Promise<void>;
  setMergeQueueReader(reader: () => MergeQueue | undefined): void;
  relayNavigator(message: ExtensionMessage): void;
}
```

(Add `ExtensionMessage` to the `../core/types` import at the top of `extension.ts` if not already present.)

- [ ] **Step 9: Register the navigator provider + refresh wiring (extension.ts)**

Import it near the other provider imports:

```ts
import { TreeNavigatorProvider } from './providers/TreeNavigatorProvider';
```

Register it right after the `taskPreviewProvider` registration (`extension.ts:434-446`):

```ts
const treeNavigatorProvider = new TreeNavigatorProvider(context.extensionUri, parser, (message) =>
  tasksHosts.forEach((host) => host.relayNavigator(message))
);
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider('taskwright.treeNavigator', treeNavigatorProvider, {
    webviewOptions: { retainContextWhenHidden: true },
  })
);
console.log('[Taskwright] Tree navigator view provider registered');
```

Add its refresh to the fan-out helper `refreshAllViews` (`extension.ts:1025-1028`):

```ts
const refreshAllViews = (): void => {
  tasksHosts.forEach((host) => host.refresh());
  taskPreviewProvider.refresh();
  treeNavigatorProvider.refresh();
};
```

And to the debounced file-watcher handler (`extension.ts:481-489`, the block that refreshes hosts + preview + detail) add `treeNavigatorProvider.refresh();` alongside the existing refresh calls.

Finally, re-parent the navigator on a multi-root backlog switch: in `switchActiveBacklog` (`extension.ts:465`), beside the existing `taskPreviewProvider.setParser(parser);` / `taskDetailProvider.setParser(parser);` / `contentDetailProvider.setParser(parser);` calls (`extension.ts:497-500`), add:

```ts
treeNavigatorProvider.setParser(parser);
treeNavigatorProvider.refresh();
```

(Without this the navigator keeps the stale parser after a backlog switch and stops updating; single-workspace — the common case — is unaffected. `treeNavigatorProvider` is constructed above at Step 9, before `switchActiveBacklog` is ever invoked, so it is in scope.)

- [ ] **Step 10: Playwright fixture**

Create `e2e/webview-fixtures/tree-navigator.html` (mirrors `tasks.html`):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tree Navigator - Backlog.md</title>
    <link href="vscode-theme-dark-plus.css" rel="stylesheet" />
    <link href="/dist/webview/styles.css" rel="stylesheet" />
    <link href="/dist/webview/tree-navigator.css" rel="stylesheet" />
    <style>
      body {
        margin: 0;
        padding: 8px;
      }
    </style>
  </head>
  <body class="tree-navigator-page">
    <div id="app"></div>
    <script type="module" src="/dist/webview/tree-navigator.js"></script>
  </body>
</html>
```

- [ ] **Step 11: Playwright — `e2e/tree-navigator.spec.ts`**

Create `e2e/tree-navigator.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getLastPostedMessage,
} from './fixtures/vscode-mock';

async function setup(page: Parameters<typeof installVsCodeMock>[0]) {
  await page.setViewportSize({ width: 400, height: 600 });
  await installVsCodeMock(page);
  await page.goto('/tree-navigator.html');
  await page.waitForTimeout(100);
  await postMessageToWebview(page, {
    type: 'navigatorData',
    lanes: [
      { name: 'Features', count: 4 },
      { name: 'Bugs', count: 2 },
    ],
    bands: ['v1', 'Backburner'],
    priorities: ['high', 'medium', 'low'],
  });
  await page.waitForTimeout(80);
  await expect(page.locator('[data-testid="tree-navigator"]')).toBeVisible();
}

test.describe('Tree navigator', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('renders lanes with counts, priority chips, and jump buttons', async ({ page }) => {
    await expect(page.locator('[data-testid="nav-lane-Features"]')).toContainText('4');
    await expect(page.locator('[data-testid="nav-priority-high"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-jump-v1"]')).toBeVisible();
  });

  test('typing search posts navigatorFilterChanged', async ({ page }) => {
    await page.locator('[data-testid="nav-search"]').fill('login');
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'navigatorFilterChanged',
      search: 'login',
      priority: '',
    });
  });

  test('clicking a priority chip posts navigatorFilterChanged with the priority', async ({
    page,
  }) => {
    await page.locator('[data-testid="nav-priority-high"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'navigatorFilterChanged',
      priority: 'high',
    });
  });

  test('toggling a lane posts navigatorLaneToggle', async ({ page }) => {
    await page.locator('[data-testid="nav-lane-Bugs"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'navigatorLaneToggle',
      lane: 'Bugs',
    });
  });

  test('jump button posts navigatorJump', async ({ page }) => {
    await page.locator('[data-testid="nav-jump-v1"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'navigatorJump', band: 'v1' });
  });

  test('minimapViewport draws a viewport rect', async ({ page }) => {
    await postMessageToWebview(page, { type: 'minimapViewport', x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    await expect(page.locator('[data-testid="nav-minimap-vp"]')).toBeVisible();
  });
});
```

- [ ] **Step 12: svelte-autofixer + build + test**

Run the `svelte` MCP `svelte-autofixer` on `TreeNavigator.svelte` until clean. Then:

Run: `bun run build && bun run typecheck && bun run test:playwright -- tree-navigator`
Expected: PASS. `bun run build` now emits `dist/webview/tree-navigator.js` + `.css` (verify they exist). The existing kanban sidebar view is untouched.

- [ ] **Step 13: Commit**

```bash
git add src/webview/entries/tree-navigator.ts src/webview/components/navigator/TreeNavigator.svelte \
  src/providers/TreeNavigatorProvider.ts vite.webview.config.ts package.json src/core/types.ts \
  src/providers/TasksController.ts src/providers/TasksViewProvider.ts src/providers/TasksPanelProvider.ts \
  src/extension.ts e2e/webview-fixtures/tree-navigator.html e2e/tree-navigator.spec.ts
git commit -m "feat(tree P2b): sidebar Tree Navigator webview (search/priority/lanes/jump/minimap) + navigatorData

- new taskwright.treeNavigator WebviewView with its own bundle entry; kanban sidebar remains
- provider computes navigatorData; relays navigatorFilterChanged/LaneToggle/Jump to the board

House UI exception on navigator markup; behavior covered by e2e/tree-navigator.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Canvas consumes navigator — filter dimming, lane collapse, jump, minimap feed [opus-integration]

**Files:**

- Modify: `src/webview/components/tasks/Tasks.svelte`, `src/webview/components/tree/TechTreeCanvas.svelte`, `src/webview/components/tree/TreeNode.svelte`, `src/webview/components/tree/EdgeLayer.svelte`, `src/providers/TasksController.ts`, `src/extension.ts`
- Test: `e2e/tree-canvas.spec.ts`

**Behavior (directive item 5, spec §11, Q3 adjudication):** the extension relays `navigatorFilterChanged`/`navigatorLaneToggle`/`navigatorJump` to the canvas; the canvas **dims non-matching nodes in place**, **collapses a lane to a slim counts summary strip** (lane name + "N tasks · M done") drawn over its now-hidden rows — **nodes hidden, incident edges faded, and NO geometry relayout** (lane heights/positions unchanged; vertical space is not reclaimed) — and **scrolls to a band** on jump. The canvas also emits `minimapViewport` (normalized rect) which the controller relays to the navigator so its minimap draws the viewport rectangle. (Q5, accepted for v1: the jump-bar/minimap list `board.bandOrder` including empty bands; `deriveGeometry` omits empty bands, so jumping to an empty column is a silent no-op. Minimap drag-to-pan is deferred to P3.)

- [ ] **Step 1: Relay the navigator messages through `Tasks.svelte`**

Add state (near the tree vocab state):

```ts
// Navigator-driven canvas state (relayed from the sidebar navigator via the extension).
let navSearch = $state('');
let navPriority = $state('');
let collapsedLanes = $state<string[]>([]);
let jumpBand = $state('');
let jumpNonce = $state(0);
```

Add the message cases (after the `milestoneData` case from Task 6):

```ts
      case 'navigatorFilterChanged':
        navSearch = message.search;
        navPriority = message.priority;
        break;

      case 'navigatorLaneToggle':
        collapsedLanes = collapsedLanes.includes(message.lane)
          ? collapsedLanes.filter((l) => l !== message.lane)
          : [...collapsedLanes, message.lane];
        break;

      case 'navigatorJump':
        jumpBand = message.band;
        jumpNonce += 1;
        break;
```

Pass them into the canvas — the tree render branch's `<TechTreeCanvas>` gains these props (final full attribute list):

```svelte
    <TechTreeCanvas
      {tasks}
      {laneOrder}
      {bandOrder}
      warnings={treeWarnings}
      {statuses}
      {priorities}
      {taskIdDisplay}
      {crossBranch}
      {milestoneData}
      {navSearch}
      {navPriority}
      {collapsedLanes}
      {jumpBand}
      {jumpNonce}
      onSelectTask={handleSelectTask}
    />
```

- [ ] **Step 2: `TechTreeCanvas.svelte` — consume filter/collapse/jump + emit minimap**

Add to `Props`/`$props()` (after `milestoneData`):

```ts
    navSearch?: string;
    navPriority?: string;
    collapsedLanes?: string[];
    jumpBand?: string;
    jumpNonce?: number;
```

and in the destructure add:

```ts
    navSearch = '',
    navPriority = '',
    collapsedLanes = [],
    jumpBand = '',
    jumpNonce = 0,
```

Add the derived dim/hidden sets + jump + minimap feed (place after the `geometry` derived and the popover state):

```ts
const collapsedSet = $derived(new Set(collapsedLanes));
function matchesFilter(t: Task): boolean {
  const s = navSearch.trim().toLowerCase();
  if (s && !`${t.id} ${t.title}`.toLowerCase().includes(s)) return false;
  if (navPriority && (t.priority ?? '') !== navPriority) return false;
  return true;
}
const hiddenIds = $derived.by(() => {
  const set = new Set<string>();
  if (collapsedSet.size === 0) return set;
  for (const t of layoutNodes) if (t.layout && collapsedSet.has(t.layout.lane)) set.add(t.id);
  return set;
});
const dimmedIds = $derived.by(() => {
  const set = new Set<string>();
  if (!navSearch.trim() && !navPriority) return set;
  for (const t of layoutNodes) if (!matchesFilter(t)) set.add(t.id);
  return set;
});
const fadedIds = $derived(new Set<string>([...dimmedIds, ...hiddenIds]));

// Q3: per-collapsed-lane summary (name + task counts) for the overlay strip. Uses the
// existing geometry.lanes (y/height) — NO relayout; done = the last configured status.
const laneSummaries = $derived.by(() => {
  if (collapsedSet.size === 0)
    return [] as Array<{ name: string; y: number; height: number; total: number; done: number }>;
  return geometry.lanes
    .filter((l) => collapsedSet.has(l.name))
    .map((l) => {
      const inLane = layoutNodes.filter((t) => t.layout?.lane === l.name);
      const done = inLane.filter(
        (t) => t.status === doneStatus || t.folder === 'completed' || t.folder === 'archive'
      ).length;
      return { name: l.name, y: l.y, height: l.height, total: inLane.length, done };
    });
});

// Jump to a band when the navigator asks (nonce lets the same band re-trigger).
let lastJumpNonce = 0;
$effect(() => {
  if (jumpNonce === lastJumpNonce) return;
  lastJumpNonce = jumpNonce;
  const b = geometry.bands.find((bnd) => bnd.name === jumpBand);
  if (b && viewportEl) {
    setViewport({ scale: vp.scale, tx: -b.x * vp.scale + 40, ty: vp.ty });
  }
});

// Feed the navigator minimap with the current normalized viewport rect (debounced).
let minimapTimer: ReturnType<typeof setTimeout> | undefined;
$effect(() => {
  const w = geometry.width;
  const h = geometry.height;
  const s = vp.scale;
  const tx = vp.tx;
  const ty = vp.ty;
  if (!viewportEl || w <= 0 || h <= 0) return;
  const vw = viewportEl.clientWidth;
  const vh = viewportEl.clientHeight;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const rect = {
    x: clamp01(-tx / s / w),
    y: clamp01(-ty / s / h),
    w: clamp01(vw / s / w),
    h: clamp01(vh / s / h),
  };
  if (minimapTimer) clearTimeout(minimapTimer);
  minimapTimer = setTimeout(() => vscode.postMessage({ type: 'minimapViewport', ...rect }), 100);
});
```

Thread the dim/hidden state into the render. Change the `<EdgeLayer>` invocation (`TechTreeCanvas.svelte:190-198`) to add `{fadedIds}`:

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
        />
```

Change the `<TreeNode>` invocation (`TechTreeCanvas.svelte:202-215`) to add `dimmed`/`hidden`:

```svelte
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
              dimmed={dimmedIds.has(task.id)}
              hidden={hiddenIds.has(task.id)}
              onSelect={handleSelect}
              onHover={(id) => (hoveredId = id)}
            />
```

Render the Q3 **counts summary strips** inside `.tree-surface`, immediately after the `{#each layoutNodes}` block closes (before the surface's closing `</div>`). Because the strips live inside the pan/zoom-transformed surface and use raw geometry coordinates (exactly like the nodes' `left`/`top`), they track the canvas and overlay each collapsed lane's hidden rows with no relayout:

```svelte
          {/if}
        {/each}

        {#each laneSummaries as ls (ls.name)}
          <div
            class="tree-lane-collapsed"
            data-testid="tree-lane-collapsed-{ls.name}"
            style="top:{ls.y}px; left:0; width:{geometry.width}px; height:{ls.height}px;"
          >
            <span class="tree-lane-collapsed-label">{ls.name} · {ls.total} tasks · {ls.done} done</span>
          </div>
        {/each}
      </div>
```

(The `{/if}` / `{/each}` and the closing `</div>` above are the **existing** end of the `{#each layoutNodes}` block and the `.tree-surface` close — the new `{#each laneSummaries}` block slots between them.) Add the strip CSS to the `<style>` block:

```css
.tree-lane-collapsed {
  position: absolute;
  z-index: 6;
  display: flex;
  align-items: center;
  padding: 0 12px;
  box-sizing: border-box;
  border-top: 1px solid var(--vscode-panel-border, transparent);
  border-bottom: 1px solid var(--vscode-panel-border, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground));
}
.tree-lane-collapsed-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  white-space: nowrap;
}
```

- [ ] **Step 3: `TreeNode.svelte` — dim/hide classes**

Add to `Props`/`$props()` (`TreeNode.svelte:19-25`) two optional booleans:

```ts
    selected: boolean;
    hovered: boolean;
    dimmed?: boolean;
    hidden?: boolean;
    onSelect: (id: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
    onHover: (id: string | null) => void;
  }
  let {
    task, x, y, w, h, lod, statuses, taskIdDisplay, selected, hovered,
    dimmed = false, hidden = false, onSelect, onHover,
  }: Props = $props();
```

Add the classes to the node div (`TreeNode.svelte:88-94`, in the `class:` list):

```svelte
  class:selected
  class:hovered
  class:nav-dimmed={dimmed}
  class:nav-hidden={hidden}
```

Add the CSS rules to the `<style>` block (near the other state styles):

```css
.tree-node.nav-dimmed {
  opacity: 0.16;
}
.tree-node.nav-hidden {
  display: none;
}
```

- [ ] **Step 4: `EdgeLayer.svelte` — fade edges touching dimmed/hidden nodes**

Add `fadedIds` to `Props`/`$props()` (`EdgeLayer.svelte:9-14`):

```ts
    hoveredId: string | null;
    selectedId: string | null;
    fadedIds: Set<string>;
    width: number;
    height: number;
  }
  let { nodes, tasks, doneStatus, hoveredId, selectedId, fadedIds, width, height }: Props = $props();
```

Add a `class:nav-faded` to the edge path (`EdgeLayer.svelte:98-105`; the `marker-end` here is already the bug-aware 3-way ternary from Task 2 Step 2):

```svelte
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
```

Add the CSS rule (in `<style>`, near `.tree-edge.faded`):

```css
.tree-edge.nav-faded {
  opacity: 0.1;
}
```

- [ ] **Step 5: Controller + command for the minimap reverse-relay**

In `src/providers/TasksController.ts`, add the case (next to the navigator/popover cases):

```ts
      case 'minimapViewport': {
        vscode.commands.executeCommand(
          'taskwright.navigatorMinimap',
          message.x,
          message.y,
          message.w,
          message.h
        );
        break;
      }
```

In `src/extension.ts`, register the internal relay command right after the navigator provider registration (Task 8, Step 9):

```ts
context.subscriptions.push(
  vscode.commands.registerCommand(
    'taskwright.navigatorMinimap',
    (x: number, y: number, w: number, h: number) => {
      treeNavigatorProvider.postMessage({ type: 'minimapViewport', x, y, w, h });
    }
  )
);
```

(Internal command — intentionally **not** declared in `package.json` `contributes.commands`, so it stays out of the palette.)

- [ ] **Step 6: Playwright — canvas consumption tests**

Append to `e2e/tree-canvas.spec.ts` (inside `test.describe('Tech tree canvas', …)`):

```ts
test('navigatorFilterChanged dims non-matching nodes', async ({ page }) => {
  await postMessageToWebview(page, {
    type: 'navigatorFilterChanged',
    search: 'Root',
    priority: '',
  });
  await page.waitForTimeout(60);
  await expect(page.locator('[data-testid="tree-node-TASK-1"]')).not.toHaveClass(/nav-dimmed/);
  await expect(page.locator('[data-testid="tree-node-TASK-2"]')).toHaveClass(/nav-dimmed/);
});

test('navigatorLaneToggle hides the lane and shows a counts summary strip', async ({ page }) => {
  await postMessageToWebview(page, { type: 'navigatorLaneToggle', lane: 'Bugs' });
  await page.waitForTimeout(60);
  await expect(page.locator('[data-testid="tree-node-TASK-5"]')).toHaveClass(/nav-hidden/);
  // Q3: the collapsed lane renders a summary strip with counts. TASK-5 is the only
  // Bugs-lane node and it is not Done → "1 tasks · 0 done".
  const strip = page.locator('[data-testid="tree-lane-collapsed-Bugs"]');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('1 tasks · 0 done');
  // toggling again restores the nodes and removes the strip
  await postMessageToWebview(page, { type: 'navigatorLaneToggle', lane: 'Bugs' });
  await page.waitForTimeout(60);
  await expect(page.locator('[data-testid="tree-node-TASK-5"]')).not.toHaveClass(/nav-hidden/);
  await expect(page.locator('[data-testid="tree-lane-collapsed-Bugs"]')).toHaveCount(0);
});

test('navigatorJump scrolls the surface toward a populated band', async ({ page }) => {
  // `deriveGeometry` omits empty bands and the shared fixture leaves 'Backburner'
  // empty — APPEND a Backburner node to the full treeTasks() fixture. Do NOT replace
  // the fixture with a smaller one: the board must keep its three columns (content
  // width 1088px) so the zoomed surface actually overflows the 1280px viewport —
  // with a narrow 2-band board (560px), clampViewport (treeGeometry.ts:195-212) pins
  // tx to one deterministic value, the style stays byte-identical, and the
  // assertion below can never pass.
  await postMessageToWebview(page, {
    type: 'tasksUpdated',
    tasks: [
      ...treeTasks(),
      {
        id: 'TASK-9',
        title: 'Backburner node',
        status: 'To Do',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/b/tasks/task-9.md',
        category: 'Features',
        milestone: 'Backburner',
        layout: { lane: 'Features', band: 'Backburner', depth: 0, subRow: 0 },
      } as Task,
    ],
  });
  await postMessageToWebview(page, {
    type: 'treeLayoutUpdated',
    laneOrder,
    bandOrder,
    warnings: [],
  });
  await page.waitForTimeout(80);
  // Zoom in so the surface overflows the viewport; otherwise clampViewport pins the
  // translate and the jump delta is nulled.
  await page.locator('[data-testid="tree-zoom-in"]').click();
  await page.locator('[data-testid="tree-zoom-in"]').click();
  await page.waitForTimeout(40);
  const surface = page.locator('[data-testid="tree-surface"]');
  const before = await surface.getAttribute('style');
  await postMessageToWebview(page, { type: 'navigatorJump', band: 'Backburner' });
  await page.waitForTimeout(60);
  expect(await surface.getAttribute('style')).not.toBe(before);
});

test('canvas emits minimapViewport', async ({ page }) => {
  // Nudge the viewport so the debounced effect fires with a real rect.
  await page.locator('[data-testid="tree-zoom-in"]').click();
  await page.waitForTimeout(150);
  const msgs = await getPostedMessages(page);
  expect(msgs.some((m) => m.type === 'minimapViewport')).toBe(true);
});
```

(Ensure the `getPostedMessages` import is present at the top of `tree-canvas.spec.ts`; add it to the existing `./fixtures/vscode-mock` import if missing.)

- [ ] **Step 7: svelte-autofixer + build + test**

Run the `svelte` MCP `svelte-autofixer` on `TechTreeCanvas.svelte`, `TreeNode.svelte`, `EdgeLayer.svelte` until clean. Then:

Run: `bun run build && bun run typecheck && bun run test:playwright -- tree-canvas tree-navigator`
Expected: PASS. Manual sanity (not a gate): with the extension running, the sidebar navigator's search/lane/jump drive the editor-tab canvas, and the minimap rect tracks the canvas viewport.

- [ ] **Step 8: Commit**

```bash
git add src/webview/components/tasks/Tasks.svelte src/webview/components/tree/TechTreeCanvas.svelte \
  src/webview/components/tree/TreeNode.svelte src/webview/components/tree/EdgeLayer.svelte \
  src/providers/TasksController.ts src/extension.ts e2e/tree-canvas.spec.ts
git commit -m "feat(tree P2b): canvas consumes navigator — filter dimming, lane collapse, jump, minimap feed

- navigatorFilterChanged dims non-matches in place; navigatorLaneToggle hides lane nodes;
  navigatorJump scrolls to a band; canvas emits minimapViewport (relayed to the navigator)

House UI exception on rendering changes; behavior covered by e2e/tree-canvas.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Promote actions — per-node + "Promote all proposed" [haiku-transcription]

**Files:**

- Modify: `src/webview/components/tree/TreeNode.svelte`, `src/webview/components/tree/TechTreeCanvas.svelte`
- Create test: `e2e/tree-promote.spec.ts`

**Behavior (spec §15):** draft (proposed) nodes get a per-node **Promote**; the canvas gets a **Promote all proposed** control. Both reuse the existing `promoteDraft` message (`TasksController.handleMessage` already handles it) — bulk is a webview-side loop (the MCP bulk tool is P4).

- [ ] **Step 1: `TreeNode.svelte` — per-node Promote (near LOD, draft only)**

Add `onPromote` to `Props`/`$props()`:

```ts
    dimmed?: boolean;
    hidden?: boolean;
    onSelect: (id: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
    onHover: (id: string | null) => void;
    onPromote?: (id: string) => void;
  }
  let {
    task, x, y, w, h, lod, statuses, taskIdDisplay, selected, hovered,
    dimmed = false, hidden = false, onSelect, onHover, onPromote,
  }: Props = $props();
```

Inside the near-LOD `.tree-node-badges` div (`TreeNode.svelte:149-172`), add a Promote button as the first child (before the `{#if task.claimedBy}` block):

```svelte
    <div class="tree-node-badges">
      {#if isDraft}
        <button
          class="tree-node-promote"
          data-testid="tree-node-promote-{task.id}"
          title="Promote to task"
          onclick={(e) => {
            e.stopPropagation();
            onPromote?.(task.id);
          }}
        >
          Promote
        </button>
      {/if}
      {#if task.claimedBy}
```

Add the CSS (near the other badge styles):

```css
.tree-node-promote {
  all: unset;
  cursor: pointer;
  font-size: 10px;
  padding: 1px 8px;
  border-radius: 8px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
}
.tree-node-promote:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
```

> **Note (accepted, Minor 12):** `.tree-node-badges` renders only at **near** LOD, so the per-node Promote button shows only when zoomed in; at mid/far LOD use "Promote all proposed" (Step 2). The e2e fixture renders at near LOD, so `tree-node-promote-*` exists. Acceptable for v1.

- [ ] **Step 2: `TechTreeCanvas.svelte` — wire per-node + add "Promote all"**

Add `onPromote` to the `<TreeNode>` invocation (below `onHover`):

```svelte
              onHover={(id) => (hoveredId = id)}
              onPromote={(pid) => vscode.postMessage({ type: 'promoteDraft', taskId: pid })}
```

Add a derived draft list + a promote-all helper (near the other derived state):

```ts
const draftNodes = $derived(
  layoutNodes.filter((t) => t.status === 'Draft' || t.folder === 'drafts')
);
function promoteAll() {
  for (const t of draftNodes) {
    vscode.postMessage({ type: 'promoteDraft', taskId: t.id });
  }
}
```

Render the "Promote all proposed" control inside `.tree-canvas`, right after the `.tree-toolbar` (or after the `InFlightPanel` from Task 7). Add before `.tree-viewport`:

```svelte
    {#if draftNodes.length > 0}
      <button class="tree-promote-all" data-testid="tree-promote-all" onclick={promoteAll}>
        Promote all proposed ({draftNodes.length})
      </button>
    {/if}

    <div
      class="tree-viewport"
```

Add its CSS (in the `<style>` block):

```css
.tree-promote-all {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 20;
  cursor: pointer;
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 6px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
}
.tree-promote-all:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
```

- [ ] **Step 3: Playwright — `e2e/tree-promote.spec.ts`**

Create `e2e/tree-promote.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview, getPostedMessages } from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const laneOrder = ['Misc'];
const bandOrder = ['v1'];

function tasks(): Task[] {
  const base = (over: Partial<Task> & { id: string }): Task =>
    ({
      title: over.id,
      status: 'Draft',
      labels: [],
      assignee: [],
      dependencies: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: `/b/tasks/${over.id}.md`,
      category: 'Misc',
      milestone: 'v1',
      ...over,
    }) as Task;
  return [
    base({
      id: 'TASK-1',
      title: 'Idea one',
      layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-2',
      title: 'Idea two',
      layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 1 },
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
    statuses: ['Draft', 'To Do', 'In Progress', 'Done'],
  });
  await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: tasks() });
  await postMessageToWebview(page, {
    type: 'treeLayoutUpdated',
    laneOrder,
    bandOrder,
    warnings: [],
  });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(150);
}

test.describe('Promote draft nodes', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('per-node Promote posts promoteDraft', async ({ page }) => {
    await page.locator('[data-testid="tree-node-promote-TASK-1"]').click();
    const msgs = await getPostedMessages(page);
    expect(msgs).toContainEqual({ type: 'promoteDraft', taskId: 'TASK-1' });
  });

  test('Promote all posts promoteDraft for every draft', async ({ page }) => {
    await page.locator('[data-testid="tree-promote-all"]').click();
    const msgs = await getPostedMessages(page);
    const promoted = msgs.filter((m) => m.type === 'promoteDraft').map((m) => m.taskId);
    expect(promoted).toEqual(expect.arrayContaining(['TASK-1', 'TASK-2']));
  });
});
```

- [ ] **Step 4: svelte-autofixer + build + test**

Run the `svelte` MCP `svelte-autofixer` on `TreeNode.svelte` + `TechTreeCanvas.svelte` until clean. Then:

Run: `bun run build && bun run typecheck && bun run test:playwright -- tree-promote`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview/components/tree/TreeNode.svelte src/webview/components/tree/TechTreeCanvas.svelte \
  e2e/tree-promote.spec.ts
git commit -m "feat(tree P2b): promote draft nodes — per-node Promote + Promote all proposed (promoteDraft)

House UI exception on markup; behavior covered by e2e/tree-promote.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Details page rework — DoD leaves the UI, popover owns claim/dispatch/active [opus-integration]

**Files:**

- Modify: `src/webview/components/task-detail/TaskDetail.svelte`, `src/core/BacklogWriter.ts`
- Test: `e2e/task-detail.spec.ts`, `src/test/unit/BacklogWriter.test.ts`

**Behavior (directive item 8, adjudications):** remove the **claim / active-task / dispatch** banners (the popover owns them) and the **Set-active** control; remove the **Definition of Done** section from the task-detail UI (parsing/data stay for compat); stop creating a DoD section on **new** tasks. Keep the plan banner and merge-review banner. AC stays the primary checklist. The header/relationships/description order is preserved. **Converting the long-form sections (Implementation Plan / Notes / Final Summary) plus Spec (references/documentation) into attachment chips is Task 11b** (Q4 — required in P2b, lands immediately after this task); this task leaves those three sections as `MarkdownSection`s so it stays a clean, self-contained removal.

- [ ] **Step 1: `TaskDetail.svelte` — remove the three agentic banners**

Delete the whole `{#if !isDraft && !isReadOnly && !isArchived}` block's **claim-banner, active-task-banner, and dispatch-banner** children, keeping the merge-review-banner and plan-banner. Concretely, in the block that starts at `TaskDetail.svelte:345`, delete lines **346-387** (the `<div class="claim-banner" … data-testid="claim-banner">…`, the `active-task-banner` div, and the `dispatch-banner` div) so the block becomes:

```svelte
  {#if !isDraft && !isReadOnly && !isArchived}
    {#if mergeState}
      <div class="claim-banner merge-review-banner" data-testid="merge-review-banner">
```

(i.e. the `{#if mergeState}` merge-review block at `TaskDetail.svelte:389` now immediately follows the opening guard; the plan-banner at `:402` stays.)

- [ ] **Step 2: `TaskDetail.svelte` — remove the Definition of Done checklist**

Delete the DoD `<Checklist>` block (`TaskDetail.svelte:486-494`):

```svelte
  <Checklist
    title="Definition of Done"
    items={task.definitionOfDone}
    listType="definitionOfDone"
    taskId={task.id}
    onToggle={handleToggleChecklist}
    onUpdateText={handleUpdateDefinitionOfDone}
    {isReadOnly}
  />
```

(The Acceptance Criteria `<Checklist>` immediately above it stays. The `MarkdownSection` for Implementation Plan follows directly.)

- [ ] **Step 3: `TaskDetail.svelte` — remove the now-dead script members**

Delete these definitions (they are only referenced by the removed banners/DoD):

- The handler `handleUpdateDefinitionOfDone` (`TaskDetail.svelte:158-160`).
- The handlers `handleClaim` (238-242), `handleRelease` (244-248), `handleSetActive` (250-254), `handleClearActive` (256-260), `handleDispatch` (262-266).
- The derived `isClaimed` (51) and `claimedByMe` (52).
- The `$state` decls `claimedBy` (37), `claimWorktree` (38), `claimedAt` (39), `claimIdentity` (40), `isActiveTask` (41), and their assignments inside the `taskData` case (`TaskDetail.svelte:92-96`: `claimedBy = data.task.claimedBy;` … `isActiveTask = data.isActiveTask ?? false;`).

Keep `handleApproveMerge`/`handleSendBackMerge` (merge banner) and `handleAttachPlan`/`handleDetachPlan`/`handleOpenPlan` (plan banner). After the deletions, run `bun run lint && bun run typecheck` and clear any residual unused-symbol warning by removing that symbol only (do not add suppressions).

- [ ] **Step 4: `BacklogWriter.ts` — stop creating DoD on new tasks**

Remove the two config-DoD injection blocks. First, delete `BacklogWriter.ts:740-747`:

```ts
// Add Definition of Done from config defaults
if (config.definition_of_done && config.definition_of_done.length > 0) {
  body += '\n## Definition of Done\n<!-- DOD:BEGIN -->\n';
  config.definition_of_done.forEach((item, index) => {
    body += `- [ ] #${index + 1} ${item}\n`;
  });
  body += '<!-- DOD:END -->\n';
}
```

Second, delete the identical block at `BacklogWriter.ts:904-911`:

```ts
// Add Definition of Done from config defaults
if (config.definition_of_done && config.definition_of_done.length > 0) {
  body += '\n## Definition of Done\n<!-- DOD:BEGIN -->\n';
  config.definition_of_done.forEach((item, index) => {
    body += `- [ ] #${index + 1} ${item}\n`;
  });
  body += '<!-- DOD:END -->\n';
}
```

(Leave `config` in the surrounding function signatures — it is still used for other fields. Do not remove DoD parsing/serialization elsewhere; existing tasks with a DoD section still round-trip.)

- [ ] **Step 5: Update the affected tests**

`src/test/unit/BacklogWriter.test.ts` — remove/adjust any assertion that a newly created task/draft body contains `## Definition of Done` or `DOD:BEGIN` from `config.definition_of_done`. Grep: `bun run test -- BacklogWriter` and fix each failing assertion to reflect that create no longer injects DoD (the AC section and description remain). Do **not** weaken tests that verify DoD parsing/serialization of an existing DoD section.

`e2e/task-detail.spec.ts` — remove the test cases that assert the removed UI: any referencing `claim-banner`, `active-task-banner`, `dispatch-banner`, `set-active-btn`, `claim-task-btn`, `release-task-btn`, `dispatch-task-btn`, or a `Definition of Done` checklist. Keep tests for the header, description, Acceptance Criteria, merge-review banner, and plan banner. (Grep `e2e/task-detail.spec.ts` for those testids and delete the enclosing `test(...)` blocks.)

- [ ] **Step 6: svelte-autofixer + full local gate for this task**

Run the `svelte` MCP `svelte-autofixer` on `TaskDetail.svelte` until clean. Then:

Run: `bun run build && bun run typecheck && bun run test -- BacklogWriter && bun run test:playwright -- task-detail`
Expected: PASS (updated BacklogWriter unit tests; task-detail suite green after removing the obsolete UI tests).

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/task-detail/TaskDetail.svelte src/core/BacklogWriter.ts \
  src/test/unit/BacklogWriter.test.ts e2e/task-detail.spec.ts
git commit -m "feat(tree P2b): details rework — DoD leaves the task UI; popover owns claim/dispatch/active

- remove claim/active-task/dispatch banners + Set-active from the detail panel (popover owns them)
- remove the Definition of Done checklist from the UI; stop injecting DoD on new tasks
  (parsing/serialization of existing DoD sections unchanged for compat)

House UI exception on markup removal; regression covered by updated e2e/task-detail.spec.ts + BacklogWriter.test.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11b: Attachments-as-chips — Plan / Spec / Notes / Final Summary (Q4, required) [opus-integration]

**Files:**

- Create: `src/webview/components/task-detail/AttachmentChips.svelte`
- Modify: `src/webview/components/task-detail/TaskDetail.svelte`
- Test: `e2e/task-detail.spec.ts`

**Behavior (directive §P2b item 8, Q4 adjudication — REQUIRED in P2b, do not defer):** replace the three long-form `MarkdownSection`s left by Task 11 (Implementation Plan / Implementation Notes / Final Summary) plus a new **Spec** entry (the task's `references` + `documentation`) with a compact **attachment chips** row. A **filled** chip expands an inline markdown preview; each expanded body panel has an **Open in editor** affordance; an **empty** chip shows **`+ Add`**. Description stays inline and Acceptance Criteria stays the primary checklist (both above the chips); the plan banner + merge-review banner (Task 11) are untouched. The chips **reuse the existing `MarkdownSection.svelte`** for the body-section preview/edit (so its testids, the mermaid render action, and workspace-link handling all carry over) and reuse the existing `openFile` / `openWorkspaceFile` messages the detail panel already sends (parity — no new messages).

- [ ] **Step 1: Create `AttachmentChips.svelte`**

Create `src/webview/components/task-detail/AttachmentChips.svelte`:

```svelte
<script lang="ts">
  import MarkdownSection from './MarkdownSection.svelte';

  interface AttachmentSection {
    key: string;
    label: string;
    fieldName: string;
    content: string;
    contentHtml: string;
    emptyLabel: string;
    onUpdate: (value: string) => void;
  }
  interface Props {
    taskId: string;
    sections: AttachmentSection[];
    references: string[];
    documentation: string[];
    isReadOnly?: boolean;
    onOpenFile: () => void;
    onOpenWorkspaceFile: (relativePath: string, fragment: string | null) => void;
  }
  let {
    taskId,
    sections,
    references,
    documentation,
    isReadOnly = false,
    onOpenFile,
    onOpenWorkspaceFile,
  }: Props = $props();

  let expanded = $state<string | null>(null);

  const specItems = $derived([...documentation, ...references]);
  const specFilled = $derived(specItems.length > 0);

  // Collapse everything when switching tasks.
  let prevTaskId = '';
  $effect(() => {
    if (taskId !== prevTaskId) {
      prevTaskId = taskId;
      expanded = null;
    }
  });

  function toggle(key: string) {
    expanded = expanded === key ? null : key;
  }
  function isFilled(s: AttachmentSection): boolean {
    return s.content.trim().length > 0;
  }
  function onSpecLinkClick(e: MouseEvent, href: string) {
    // Relative links open in the editor (same as MarkdownSection); URL schemes use the
    // anchor's default navigation (VS Code opens them externally).
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      e.preventDefault();
      const [relativePath, fragment] = href.split('#');
      onOpenWorkspaceFile(relativePath, fragment ?? null);
    }
  }
</script>

<div class="attach" data-testid="attachments">
  <div class="attach-chips">
    {#each sections as s (s.key)}
      <button
        class="attach-chip"
        class:filled={isFilled(s)}
        class:open={expanded === s.key}
        data-testid="attach-chip-{s.key}"
        onclick={() => toggle(s.key)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
        <span class="attach-chip-label">{s.label}</span>
        {#if !isFilled(s)}<span class="attach-add" data-testid="attach-add-{s.key}">+ Add</span>{/if}
      </button>
    {/each}
    <button
      class="attach-chip"
      class:filled={specFilled}
      class:open={expanded === 'spec'}
      data-testid="attach-chip-spec"
      onclick={() => toggle('spec')}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <span class="attach-chip-label">Spec</span>
      {#if !specFilled}<span class="attach-add" data-testid="attach-add-spec">+ Add</span>{/if}
    </button>
  </div>

  {#each sections as s (s.key)}
    {#if expanded === s.key}
      <div class="attach-panel" data-testid="attach-panel-{s.key}">
        <div class="attach-panel-head">
          <button class="attach-open" data-testid="attach-open-{s.key}" onclick={onOpenFile}>
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
            Open in editor
          </button>
        </div>
        <MarkdownSection
          {taskId}
          title={s.label}
          fieldName={s.fieldName}
          content={s.content}
          contentHtml={s.contentHtml}
          emptyLabel={s.emptyLabel}
          onUpdate={s.onUpdate}
          {isReadOnly}
        />
      </div>
    {/if}
  {/each}

  {#if expanded === 'spec'}
    <div class="attach-panel" data-testid="attach-panel-spec">
      {#if specItems.length === 0}
        <div class="attach-empty">
          <span>No spec links yet.</span>
          <button class="attach-open" data-testid="attach-add-spec-open" onclick={onOpenFile}>
            + Add in editor
          </button>
        </div>
      {:else}
        <ul class="attach-spec-list">
          {#each specItems as href (href)}
            <li>
              <a
                class="attach-spec-link"
                data-testid="attach-spec-link"
                {href}
                onclick={(e) => onSpecLinkClick(e, href)}>{href}</a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .attach {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .attach-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .attach-chip {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 12px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    font-size: 12px;
  }
  .attach-chip.filled {
    color: var(--vscode-foreground);
    background: var(--vscode-badge-background, #4d4d4d);
  }
  .attach-chip.open {
    border-color: var(--vscode-focusBorder);
  }
  .attach-chip:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .attach-add {
    font-size: 11px;
    opacity: 0.7;
  }
  .attach-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .attach-panel-head {
    display: flex;
    justify-content: flex-end;
  }
  .attach-open {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--vscode-textLink-foreground, #3794ff);
  }
  .attach-open:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .attach-empty {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  }
  .attach-spec-list {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .attach-spec-link {
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
    word-break: break-all;
  }
  .attach-spec-link:hover {
    text-decoration: underline;
  }
</style>
```

Run the `svelte` MCP `svelte-autofixer` on `AttachmentChips.svelte` until clean before wiring it in.

- [ ] **Step 2: Wire `AttachmentChips` into `TaskDetail.svelte`**

Add the import beside the other detail imports (`TaskDetail.svelte:5-10`):

```ts
import AttachmentChips from './AttachmentChips.svelte';
```

Add an `openWorkspaceFile` handler next to `handleOpenFile` (`TaskDetail.svelte:198-200`):

```ts
function handleOpenWorkspaceFile(relativePath: string, fragment: string | null) {
  vscode.postMessage({ type: 'openWorkspaceFile', relativePath, fragment });
}
```

Replace the three body `MarkdownSection`s (Implementation Plan / Implementation Notes / Final Summary — the blocks left by Task 11, immediately after the Acceptance Criteria `<Checklist>`):

```svelte
  <MarkdownSection
    taskId={task.id}
    title="Implementation Plan"
    fieldName="implementationPlan"
    content={task.implementationPlan || ''}
    contentHtml={planHtml}
    emptyLabel="No plan"
    onUpdate={handleUpdatePlan}
    {isReadOnly}
  />

  <MarkdownSection
    taskId={task.id}
    title="Implementation Notes"
    fieldName="implementationNotes"
    content={task.implementationNotes || ''}
    contentHtml={notesHtml}
    emptyLabel="No notes"
    onUpdate={handleUpdateImplementationNotes}
    {isReadOnly}
  />

  {#if task.finalSummary || !isReadOnly}
    <MarkdownSection
      taskId={task.id}
      title="Final Summary"
      fieldName="finalSummary"
      content={task.finalSummary || ''}
      contentHtml={finalSummaryHtml}
      emptyLabel="No summary"
      onUpdate={handleUpdateFinalSummary}
      {isReadOnly}
    />
  {/if}
```

with the chips (Description + AC above it are unchanged; `ActionButtons` still follows):

```svelte
  <AttachmentChips
    taskId={task.id}
    sections={[
      {
        key: 'plan',
        label: 'Implementation Plan',
        fieldName: 'implementationPlan',
        content: task.implementationPlan || '',
        contentHtml: planHtml,
        emptyLabel: 'No plan',
        onUpdate: handleUpdatePlan,
      },
      {
        key: 'notes',
        label: 'Implementation Notes',
        fieldName: 'implementationNotes',
        content: task.implementationNotes || '',
        contentHtml: notesHtml,
        emptyLabel: 'No notes',
        onUpdate: handleUpdateImplementationNotes,
      },
      {
        key: 'finalSummary',
        label: 'Final Summary',
        fieldName: 'finalSummary',
        content: task.finalSummary || '',
        contentHtml: finalSummaryHtml,
        emptyLabel: 'No summary',
        onUpdate: handleUpdateFinalSummary,
      },
    ]}
    references={task.references ?? []}
    documentation={task.documentation ?? []}
    onOpenFile={handleOpenFile}
    onOpenWorkspaceFile={handleOpenWorkspaceFile}
    {isReadOnly}
  />
```

(`handleUpdatePlan` / `handleUpdateImplementationNotes` / `handleUpdateFinalSummary` / `handleOpenFile` were all **kept** by Task 11 — they are reused here, not re-added. `task.references` / `task.documentation` are already on `Task`.)

- [ ] **Step 3: svelte-autofixer**

Run the `svelte` MCP `svelte-autofixer` on `AttachmentChips.svelte` and `TaskDetail.svelte` until clean.

- [ ] **Step 4: Update + extend `e2e/task-detail.spec.ts`**

Append this describe (its own `taskData` fixture — a filled Plan + Spec, empty Notes + Final Summary):

```ts
const attachmentTaskData = {
  ...sampleTaskData,
  task: {
    ...sampleTask,
    implementationPlan: '1. Do the thing\n2. Verify it',
    implementationNotes: '',
    finalSummary: '',
    references: ['https://example.com/spec'],
    documentation: ['docs/design.md'],
  },
  planHtml: '<ol><li>Do the thing</li><li>Verify it</li></ol>',
  notesHtml: '',
  finalSummaryHtml: '',
};

test.describe('Attachment chips', () => {
  test.beforeEach(async ({ page }) => {
    // Self-contained setup (mirrors the 'Read-only cross-branch mode' describe at
    // task-detail.spec.ts:1273-1280) so this block works wherever it is placed —
    // e.g. appended at end-of-file, outside the top-level describe's beforeEach.
    await installVsCodeMock(page);
    await page.goto('/task-detail.html');
    await page.waitForTimeout(100);
    await postMessageToWebview(page, { type: 'taskData', data: attachmentTaskData });
    await page.waitForTimeout(50);
  });

  test('renders a chip for Plan / Spec / Notes / Final Summary', async ({ page }) => {
    await expect(page.locator('[data-testid="attach-chip-plan"]')).toBeVisible();
    await expect(page.locator('[data-testid="attach-chip-spec"]')).toBeVisible();
    await expect(page.locator('[data-testid="attach-chip-notes"]')).toBeVisible();
    await expect(page.locator('[data-testid="attach-chip-finalSummary"]')).toBeVisible();
  });

  test('empty sections show "+ Add"; filled ones do not', async ({ page }) => {
    await expect(page.locator('[data-testid="attach-add-notes"]')).toBeVisible();
    await expect(page.locator('[data-testid="attach-add-finalSummary"]')).toBeVisible();
    await expect(page.locator('[data-testid="attach-add-plan"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="attach-add-spec"]')).toHaveCount(0);
  });

  test('clicking a filled chip expands its preview; clicking again collapses', async ({ page }) => {
    await page.locator('[data-testid="attach-chip-plan"]').click();
    await expect(page.locator('[data-testid="attach-panel-plan"]')).toBeVisible();
    await expect(page.locator('[data-testid="implementationPlan-view"]')).toContainText(
      'Do the thing'
    );
    await page.locator('[data-testid="attach-chip-plan"]').click();
    await expect(page.locator('[data-testid="attach-panel-plan"]')).toHaveCount(0);
  });

  test('open-in-editor posts openFile', async ({ page }) => {
    await page.locator('[data-testid="attach-chip-plan"]').click();
    await clearPostedMessages(page);
    await page.locator('[data-testid="attach-open-plan"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'openFile' });
  });

  test('Spec chip lists references + documentation; a relative link opens in the editor', async ({
    page,
  }) => {
    await page.locator('[data-testid="attach-chip-spec"]').click();
    await expect(page.locator('[data-testid="attach-panel-spec"]')).toContainText('docs/design.md');
    await clearPostedMessages(page);
    await page.locator('[data-testid="attach-spec-link"]', { hasText: 'docs/design.md' }).click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'openWorkspaceFile',
      relativePath: 'docs/design.md',
    });
  });
});
```

Then update the **existing** `Implementation Plan`, `Implementation Notes`, and `Final Summary` describes (`task-detail.spec.ts:871/917/962`), whose sections now live inside collapsed chips: because `AttachmentChips` renders the same `MarkdownSection` (same `implementationPlan-section` / `implementationPlan-view` / `edit-implementationPlan-btn` testids), the mechanical fix is to **prepend a chip-expand click** to each test that asserts a section is present or edits it — e.g. `await page.locator('[data-testid="attach-chip-plan"]').click();` (or `-notes` / `-finalSummary`) as the first line after data is loaded. For the two cases that assert **absence/empty** state, rewrite to chip-level assertions instead:

- Final Summary "shows empty state when no summary" → assert `[data-testid="attach-chip-finalSummary"]` is visible and `[data-testid="attach-add-finalSummary"]` is visible (no expand).
- Final Summary "hidden when read-only and empty" → the chip row always renders, so assert the panel stays collapsed: `await expect(page.locator('[data-testid="attach-panel-finalSummary"]')).toHaveCount(0);` (and, if desired, that the read-only chip still expands to a read-only `MarkdownSection`).

Grep `implementationPlan-view`, `finalSummary-section`, `edit-implementationPlan-btn`, `edit-finalSummary-btn`, and the Implementation Notes equivalents; every remaining hit must be reached by first clicking its chip.

- [ ] **Step 5: Build + test**

Run: `bun run build && bun run typecheck && bun run test:playwright -- task-detail`
Expected: PASS (the new `Attachment chips` describe + the updated Plan/Notes/Final-Summary describes). Description + Acceptance Criteria assertions are unaffected (still above the chips).

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/task-detail/AttachmentChips.svelte \
  src/webview/components/task-detail/TaskDetail.svelte e2e/task-detail.spec.ts
git commit -m "feat(tree P2b): details attachments-as-chips (Plan / Spec / Notes / Final Summary)

- long-form sections + references/documentation collapse to a chip row; a filled chip
  expands an inline markdown preview (reuses MarkdownSection) with Open-in-editor;
  empty chips show + Add (Q4, directive §P2b item 8)
- reuses existing openFile / openWorkspaceFile messages (parity)

House UI exception on chip markup; behavior covered by e2e/task-detail.spec.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: CDP cross-view test — popover ⇒ active-task.json, quick-edit ⇒ file [opus-integration]

**Files:**

- Create: `src/test/cdp/tree-popover.test.ts`

**Behavior (directive item 10):** in a real VS Code instance, opening the popover writes `.taskwright/active-task.json`, closing clears it, and a status quick-edit propagates to the task file. Reuses the CDP library (`src/test/cdp/lib/`) and the same harness scaffold as `cross-view.test.ts`.

> **CDP notes:** these run via `bun run test:cdp` (build + `vitest run --config vitest.cdp.config.ts`, xvfb on headless Linux). The tree is the default tab, but `waitForExtensionReady` opens kanban — click the `tab-tree` tab to show the canvas. `resetTestWorkspace` does not clear `.taskwright/`, so remove it in `beforeEach`. See `docs/cdp-testing-notes.md`.

- [ ] **Step 1: Write the CDP spec**

Create `src/test/cdp/tree-popover.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { launchVsCode, closeVsCode, type VsCodeInstance } from './lib/vscode-launcher';
import {
  createTestWorkspace,
  resetTestWorkspace,
  cleanupTestWorkspace,
  taskFilePath,
} from './lib/test-workspace';
import {
  waitForExtensionReady,
  waitForWebviewContent,
  waitForFileContent,
} from './lib/wait-helpers';
import {
  clickInWebview,
  setSelectValueInWebview,
  clearWebviewSessionCache,
} from './lib/webview-helpers';
import { dismissNotifications, resetEditorState, executeCommand } from './lib/cdp-helpers';

const CDP_PORT = 9341;

function activeTaskPath(workspacePath: string): string {
  return path.join(workspacePath, '.taskwright', 'active-task.json');
}

async function waitForFileGone(filePath: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(filePath)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`File still present after ${timeoutMs}ms: ${filePath}`);
}

async function openTree(instance: VsCodeInstance): Promise<void> {
  await clickInWebview(instance.cdp, 'tasks', '[data-testid="tab-tree"]');
  await waitForWebviewContent(instance.cdp, 'tasks', 'TASK-', { timeoutMs: 10_000 });
}

describe('Tree popover cross-view (CDP)', () => {
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
    // resetTestWorkspace does not clear .taskwright — do it ourselves.
    fs.rmSync(path.join(workspacePath, '.taskwright'), { recursive: true, force: true });
    await resetEditorState(instance.cdp);
    await dismissNotifications(instance.cdp);
    await executeCommand(instance.cdp, 'taskwright.refresh');
    await waitForWebviewContent(instance.cdp, 'tasks', 'TASK-', { timeoutMs: 10_000 });
  }, 30_000);

  it('opening a node popover writes .taskwright/active-task.json', async () => {
    await openTree(instance);
    const clicked = await clickInWebview(instance.cdp, 'tasks', '[data-testid="tree-node-TASK-1"]');
    expect(clicked).toBe(true);
    const content = await waitForFileContent(activeTaskPath(workspacePath), '"taskId": "TASK-1"', {
      timeoutMs: 12_000,
    });
    expect(content).toContain('TASK-1');
  }, 45_000);

  it('closing the popover clears active-task.json', async () => {
    await openTree(instance);
    await clickInWebview(instance.cdp, 'tasks', '[data-testid="tree-node-TASK-1"]');
    await waitForFileContent(activeTaskPath(workspacePath), '"taskId": "TASK-1"', {
      timeoutMs: 12_000,
    });
    await clickInWebview(instance.cdp, 'tasks', '[data-testid="tp-close"]');
    await waitForFileGone(activeTaskPath(workspacePath));
    expect(fs.existsSync(activeTaskPath(workspacePath))).toBe(false);
  }, 45_000);

  it('status quick-edit in the popover writes the task file', async () => {
    await openTree(instance);
    await clickInWebview(instance.cdp, 'tasks', '[data-testid="tree-node-TASK-1"]');
    const changed = await setSelectValueInWebview(
      instance.cdp,
      'tasks',
      '[data-testid="tp-status"]',
      'In Progress'
    );
    expect(changed).toBe(true);
    const taskFile = taskFilePath(workspacePath, 'task-1 - Test-task-for-e2e.md');
    const content = await waitForFileContent(taskFile, 'status: In Progress', {
      timeoutMs: 15_000,
    });
    expect(content).toContain('status: In Progress');
  }, 45_000);
});
```

> **Fixture note:** the task filename in the third test (`task-1 - Test-task-for-e2e.md`) mirrors `cross-view.test.ts`. If the CDP fixture workspace uses a different `TASK-1` filename, read the actual name from `src/test/e2e/fixtures/test-workspace/backlog/tasks/` and use it. If `TASK-1` has no P1 layout (e.g. no category/milestone), it still renders in the Misc lane, so `tree-node-TASK-1` is present.

- [ ] **Step 2: Run the CDP suite**

Run: `bun run test:cdp` (or, faster during iteration, after a build: `vitest run --config vitest.cdp.config.ts src/test/cdp/tree-popover.test.ts`).
Expected: PASS. If a node click misses because fit-to-view put the node off-screen at far LOD, first `executeCommand(instance.cdp, 'taskwright.refresh')` and confirm the node is in the DOM (`clickInWebview` dispatches a synthetic event so on-screen position is not strictly required, but the element must exist). Do not weaken the disk assertions — a failure here is a real cross-view regression.

- [ ] **Step 3: Commit**

```bash
git add src/test/cdp/tree-popover.test.ts
git commit -m "test(tree P2b): CDP cross-view — popover writes/clears active-task.json; quick-edit hits the file

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Full gate + visual proof + close [opus-integration]

**Files:** none (verification + proof + merge).

- [ ] **Step 1: Full regression gate**

Run, in the worktree:

```bash
bun run test && bun run lint && bun run typecheck && bun run test:playwright
```

Expected: PASS. Unit: baseline **1360 passed / 1 skipped** + the new suites (`releaseChecklist`, `cancelDispatch`, the `TasksController` P2b enrichment **and Q1 `updateTask` priority** tests, updated `BacklogWriter`). Playwright: baseline **307 passed** + the new specs (`tree-popover`, `tree-milestone`, `tree-inflight`, `tree-navigator`, `tree-promote`, the `tree-canvas` additions incl. the lane-collapse summary strip) and the updated `task-detail` (banner/DoD removals + the new `Attachment chips` describe) / `tree-canvas` (obsolete P2a click test removed). Lint zero-warning; typecheck clean. (Windows: the ~22 known upstream POSIX-path unit failures are pre-existing and unrelated.)

- [ ] **Step 2: CDP proof**

Run: `bun run test:cdp` (headless Linux uses xvfb). Expected: the new `tree-popover` CDP tests pass alongside the existing `cross-view` suite.

- [ ] **Step 3: Visual proof**

Invoke the **`visual-proof`** skill (`.claude/skills/visual-proof/`) to produce a showboat doc capturing: the tree tab with a node popover open and its state-aware actions; the milestone popover with a release checklist; the in-flight panel; and the sidebar navigator filtering/collapsing the canvas. Prefer the CDP (real-VS-Code) path for the popover→active-task and navigator→canvas flows since they span views; the Vite-fixture path is fine for the isolated popover/panel visuals. Save under the skill's output location (git-ignored screenshots).

- [ ] **Step 4: Close the task**

When the worktree is clean and all gates pass, run **`request_merge`** from inside `.worktrees/tech-tree-p2b`. Do not merge/commit/push from the repo root.

---

## Self-Review

**1. Spec §→task mapping (P2b slice):**

- **§7 popover + state→action table + ephemeral active** → Task 1 (`claimedByMe`/`planProgress`/`prioritiesUpdated` enrichment the popover needs) + Task 4 (`DetailPopover`, `popoverActiveChanged`, action routing) + Task 5 (`cancelDispatch`). Claim ⟂ Dispatch enforced in the action table; `⤢` → `selectTask`.
- **§8 details rework** → Task 11 (remove claim/active/dispatch banners + Set-active; remove DoD from UI; keep plan + merge-review banners; stop creating DoD on new tasks) + Task 11b (attachments-as-chips: Plan / Spec / Notes / Final Summary — Q4, required in P2b). AC remains primary.
- **§9 milestone popover + release checklist (DoD's new home)** → Task 3 (`releaseChecklist` core) + Task 6 (`MilestonePopover`, `milestoneData`/`toggleReleaseChecklistItem`, `milestoneReleaseChecklist` file adapter). Notes the automated done-bar is enforced by `request_merge`.
- **§10 in-flight panel** → Task 7 (`InFlightPanel`: active + merge queue with Approve/Send back, collapsible).
- **§3/§11 navigator + filter dimming + lane collapse + jump + minimap** → Task 8 (navigator WebviewView + bundle + `navigatorData`) + Task 9 (canvas dimming/collapse/jump + `minimapViewport`). The existing sidebar kanban view remains.
- **§15 promote** → Task 10 (per-node Promote + Promote all proposed via `promoteDraft`).
- **CDP cross-view** → Task 12. **P2a review debt** → Task 2. **Board-bus plan-progress** (orchestrator adjudication) → Task 1. **Priority write-path widening (Q1)** → Task 1 (Step 6b).

**2. Locked-message compliance:** `popoverActiveChanged`, `cancelDispatch`, `milestoneData`, `toggleReleaseChecklistItem`, `navigatorFilterChanged`, `navigatorJump`, `minimapViewport` are used verbatim. `treeLayoutUpdated` (P2a) untouched. Every popover/panel action routes to the same command/core the detail panel + MCP tools use (`claimTaskForCurrentUser`, `dispatchTask`, `releaseTaskClaim`, `writeActiveTask`/`clearActiveTask`, `approveMergeInQueue`/`sendBackMerge`, `promoteDraft`, `resolvePriorities`, `loadPlanProgress`) — parity holds; no duplicated logic in the webview.

**3. Scope discipline:** No create-on-canvas, drag-to-connect, or bug intake (P3); no new MCP tools (P4); no cancellation-marker protocol (one documented TODO in `cancelDispatch.ts` for P5). The kanban/list/dashboard tabs and their data bus are untouched; the navigator is additive.

**4. No-regression checks:** New `WebviewMessage`/`ExtensionMessage` variants are additive. `relayNavigator` is additive on `TasksBoardSurface` + both providers. The one deleted P2a Playwright test (`clicking a node sends selectTask`) is replaced by `tree-popover.spec.ts`. `task-detail.spec.ts` + `BacklogWriter.test.ts` are updated for the intentional UI/behavior removals. `AgeBandHeader` band positioning is unchanged (element became a `<button>`, same `left`/`width`).

**5. Placeholder scan:** every code/test step contains complete, runnable content. The only intentional TODO is the P5 cancellation-marker hook in `cancelDispatch.ts` (documented, out of P2 scope). Task 11 Step 3/Step 5 direct a lint-guided cleanup of dead symbols — the exact symbol list is enumerated, not left open.

**6. Type consistency:** `PopoverActionKind`, `milestoneData`/`navigatorData` payload shapes, and the `{ done, total }` / `{ x, y, w, h }` shapes match across producers and consumers. `planProgress`/`claimedByMe` are added to `Task` once (Task 1) and read by `TreeNode`/`DetailPopover`.

**7. Leaves-first build integrity:** every task ends green (`bun run build` + relevant tests). Tasks 4/5 split the popover message definitions (Task 4) from the `cancelDispatch` command (Task 5) so the bundle compiles at each commit; Task 8 stands up the navigator bundle before Task 9 consumes it.

---

## Adjudications folded in

All six of the drafter's original open questions were adjudicated (see
`.superpowers/tech-tree-run/p2b-plan-adjudications.md`) and folded into the tasks above — nothing
is left open for the build:

- **Q1** (widen the `updateTask` priority write path) → **Task 1 Step 6b** (+ tests in Step 1).
- **Q2** (a `worktree` claim field ⇒ dispatched/agent, kept for v1; `dispatched_at` marker is P5) →
  documented at the P5 TODO hook in **Task 5** (`cancelDispatch.ts`).
- **Q3** (lane collapse → a slim **counts summary strip**, nodes hidden, edges faded, **no relayout**) →
  **Task 9** (`laneSummaries` derived + strip overlay + test).
- **Q4** (attachments-as-chips — **required in P2b**) → **Task 11b** (complete chip UI + tests).
- **Q5** (minimap column-jump is sufficient for v1; drag-to-pan deferred to P3) → **Task 9** behavior note.
- **Q6** (`popoverActiveChanged` full `refresh()` accepted for v1) → **Task 4** handler note.
