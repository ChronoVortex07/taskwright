# Kanban Board & List View — Scroll on Both Axes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Kanban board and the List view scroll on **both** axes so a board taller than a narrow VS Code sidebar is fully reachable (today a tall board is clipped and unreachable), without breaking the existing horizontal-scroll behavior or the milestone-grouped / label-grouped / nested board variants.

**Architecture.** This is a pure **webview CSS-container** fix in one stylesheet (`src/webview/styles.css`) touching existing markup — **no `.svelte`, `.ts`, or DOM changes**. The webview already establishes a bounded-height flex chain `html → body.tasks-page → #app → .view-content` (styles.css:16-51), but the chain **stops** at the view host: `#kanban-view` is `display:block` and `#kanban-app` (the board wrapper) has **no CSS rule at all**, so `.kanban-board`'s `min-height: calc(100vh - 85px)` grows unbounded and is clipped by `body.tasks-page { overflow: hidden }` (styles.css:38); the list view has the identical gap at `.task-list-container` (styles.css:899-901, padding only). The fix makes `#kanban-app` (kanban) and `.task-list-container` (list) into **single both-axes scroll containers** that own `min-height:0` inside their flex column, and delegates the top-level board's horizontal scroll up to `#kanban-app` so one container scrolls both directions. Nested boards keep their own `overflow-x:auto` untouched.

**Tech Stack:** CSS (Tailwind v4 compiled via `bun run build:css` → `dist/webview/styles.css`), Svelte 5 markup (read-only — not edited), Playwright webview E2E (`e2e/tasks.spec.ts`, fixtures served by Vite at `http://localhost:5173`, default viewport 400×600), agent-browser (optional visual proof).

## Prerequisites

**None.** DRAFT-1 is item 1 and is not blocked by any other draft. It touches only `src/webview/styles.css` and `e2e/tasks.spec.ts` — files no other in-flight draft in this batch modifies — so it can be carved and landed independently.

## Global Constraints

_Every task's requirements implicitly include this section._

- **This task is ONE dispatched PR.** It runs in its own `.worktrees/<branch>` created by the board Dispatch / `/execute-task` flow. Work only inside that worktree; run all git/file/test commands there. NEVER git checkout/commit/merge in the repo root (shared; a pre-commit hook blocks it). A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there ONCE before the first build/test.
- **Runtime:** Node >= 22; build/test via **Bun**: `bun run test` (Vitest), `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:e2e`, `bun run test:cdp`.
- **Commit normally** — the pre-commit hook is line-ending-safe. Stage only the files each task names.
- **Baseline:** after `bun install`, run `bun run test` once in the worktree and record the actual pass count. Windows shows ~22 KNOWN upstream POSIX-path unit failures — unrelated, do NOT "fix" them. Confirm no previously-green test regresses.
- **Verify gate at the end of every `### Task N`:** `bun run test && bun run lint && bun run typecheck` must pass (plus any task-specific webview/e2e suite named in that task).
- **Commit trailer:** end each commit message with `Co-Authored-By: <your model> <noreply@anthropic.com>` and `Completes <this task id>.` (the dispatched agent substitutes its own model line per AGENTS.md).
- **Close:** the `/execute-task` flow closes via `request_merge` from inside the worktree — do NOT ff-merge or push from the repo root yourself.

- **Webview rendering discipline:** Lucide inline SVG only (no emojis); all colors/borders via `--vscode-*` tokens; run the `svelte` MCP `svelte-autofixer` over any `.svelte` you touch until clean before committing.

> **CSS-only note (this plan):** No `.svelte` file is edited — the fix is entirely inside `src/webview/styles.css` on IDs/classes that already exist in the markup. Therefore the `svelte-autofixer` step does **not** apply here (there is no `.svelte` diff). The rendering-discipline rule is still honored: the change introduces no colors, borders, emojis, or icons — only layout/overflow properties.

## Locked names & wire conventions

This task defines **no** new code API, MCP tool, message, or skill — it changes only CSS layout properties on existing DOM. The load-bearing names it depends on (must **not** be renamed) are the existing markup hooks:

- `#kanban-view` (host div, `Tasks.svelte:693`), `#kanban-app` (board wrapper, `Tasks.svelte:752`), `.kanban-board` / `.kanban-board.nested` / `.kanban-board.milestone-grouped` / `.kanban-board.label-grouped` (`KanbanBoard.svelte`), `.kanban-toolbar`.
- `#list-view` (`Tasks.svelte:775`), `#archived-view` (`Tasks.svelte:800`), `.task-list-container` (root of `ListView.svelte:398`), `.task-table tr[data-task-id]` (list rows).

The cross-task LOCKED contracts (`start_task`, `request_merge` `worktree?`, `next_ready_tasks`, `/orchestrate-board`, DRAFT-9 scaffolding) are **untouched** by this task — it introduces no server, core, or skill code. Do not add any of those here.

## Anchors (verified — match the quoted text, not the line number)

All quotes below were verified against the working tree. Line numbers may drift; the quoted before/after snippets are authoritative.

**A1 — the bounded flex chain already exists (context, do NOT change):**

```css
/* styles.css ~35-51 */
body.tasks-page {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

body.tasks-page #app {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

body.tasks-page .view-content {
  flex: 1;
  min-height: 0;
}
```

`.view-content` is also declared `display: block` at ~217-220 (specificity `0,1,0`):

```css
/* styles.css ~217-220 */
.view-content {
  display: block;
  animation: viewFadeIn 0.15s ease-out;
}
```

> The `#kanban-view` / `#list-view` / `#archived-view` rules this plan adds use **ID** selectors (specificity `1,0,0`), which beat `.view-content { display: block }` — so `display: flex` wins. These views are rendered by Svelte `{#if}` blocks (one at a time) and never receive `.view-content.hidden`, so the `display:none` hidden path is not in play for them.

**A2 — the broken kanban board rule (Task 1 edits this):**

```css
/* styles.css ~304-311 */
/* Kanban Board */
.kanban-board {
  display: flex;
  gap: 8px;
  padding: 8px;
  min-height: calc(100vh - 85px);
  overflow-x: auto;
}
```

**A3 — the grouped / nested variants (context — Task 1 does NOT edit these; they must keep working):**

```css
/* styles.css ~313-335 */
.kanban-board.nested {
  min-height: auto;
  padding: 8px;
}
/* Milestone grouping: vertical stacking of milestone sections */
.kanban-board.milestone-grouped {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-x: visible;
}
.kanban-board.milestone-grouped .milestone-section {
  width: 100%;
}
.kanban-board.milestone-grouped .milestone-content .kanban-board.nested {
  display: flex;
  flex-direction: row;
  gap: 8px;
  overflow-x: auto;
}
```

> Design consequence: base `.kanban-board` keeps `overflow-x: auto` so **nested** boards (which are not direct children of `#kanban-app`) keep their horizontal scroll. Only the **top-level** board (`#kanban-app > .kanban-board`) is switched to `overflow-x: visible`, delegating its horizontal scroll to `#kanban-app`. The milestone-grouped/label-grouped top-level boards already scroll their inner nested boards; their vertical growth now overflows `#kanban-app`, which scrolls.

**A4 — the broken list container rule (Task 2 edits this):**

```css
/* styles.css ~898-901 */
/* List View */
.task-list-container {
  padding: 12px;
}
```

**A5 — the existing horizontal-scroll test that must stay green (both tasks preserve it):**

```ts
// e2e/tasks.spec.ts ~245-263
test('kanban columns have a minimum width and scroll at narrow sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 350, height: 600 });
  const board = page.locator('.kanban-board');
  const scrollWidth = await board.evaluate((el) => el.scrollWidth);
  const clientWidth = await board.evaluate((el) => el.clientWidth);
  expect(scrollWidth).toBeGreaterThan(clientWidth); // board scrolls horizontally
  // ... each .kanban-column width >= 140 ...
});
```

> This asserts `.kanban-board` **scrollWidth > clientWidth**. After Task 1 the top-level board is `overflow-x: visible`, but its width still equals `#kanban-app`'s content width (a block-level flex container fills its containing block; overflowing columns extend `scrollWidth` without widening the box). So `scrollWidth (~436) > clientWidth (~334)` still holds. The full `bun run test:playwright` run is the regression gate for this and for the milestone/label/nested variants.

---

## File Structure

**Modify:**

- `src/webview/styles.css` — Task 1 adds `#kanban-view` (flex column) + `#kanban-app` (both-axes scroll container) rules and `#kanban-app > .kanban-board` (delegate horizontal scroll), and changes `.kanban-board`'s `min-height` from `calc(100vh - 85px)` to `100%`. Task 2 adds the `#list-view, #archived-view` flex-column rule and turns `.task-list-container` into a both-axes scroll container.

**Test:**

- `e2e/tasks.spec.ts` — Task 1 appends a shared `manyTasks` fixture + a describe asserting `#kanban-app` scrolls both axes and its bottom is reachable at 400×600. Task 2 appends a describe asserting `.task-list-container` scrolls vertically when the table exceeds the viewport.

**Setup (run once in the fresh worktree before Task 1):**

```bash
bun install
bun run build           # produces dist/webview/{styles.css,tasks.js,tasks.css} the Vite fixtures load
bun run test            # baseline — record the pass count (Windows: ~22 known POSIX-path fails, ignore)
```

> Why `bun run build` up front: `bun run test:playwright` does **not** build (unlike `test:e2e`/`test:cdp`). The fixture `e2e/webview-fixtures/tasks.html` loads the **compiled** `/dist/webview/styles.css`, so the compiled bundle must exist and be current. After any edit to `src/webview/styles.css`, re-run **`bun run build:css`** (fast — `tailwindcss -i src/webview/styles.css -o dist/webview/styles.css`) so the fixture serves the change. Vite (`reuseExistingServer` locally) serves the file statically, so a rebuilt CSS is picked up on the next `page.goto`.

---

## Task 1: Kanban board scrolls on both axes

**Files:**

- Modify: `src/webview/styles.css`
- Test: `e2e/tasks.spec.ts`

**Goal:** `#kanban-view` is `display:block` and `#kanban-app` has no rule, so `.kanban-board` (`min-height: calc(100vh - 85px)`) grows unbounded and a tall board is clipped by `body.tasks-page { overflow: hidden }` — unreachable. Make `#kanban-view` a flex column and `#kanban-app` a `flex:1; min-height:0; overflow:auto` scroll container (both axes), fill it via `min-height:100%` on the board, and delegate the top-level board's horizontal scroll to `#kanban-app` so a single container scrolls both directions. Preserve the milestone-grouped / label-grouped / nested variants (untouched) and the existing horizontal-scroll test (A5).

- [ ] **Step 1: Write the failing test**

Append to the **end** of `e2e/tasks.spec.ts` (after the final `});` of the existing top-level `test.describe('Tasks View', …)` block). This adds the shared `manyTasks` fixture (reused by Task 2) and the kanban both-axes test:

```ts
// 40 same-status tasks: forces a To Do column taller than a 600px viewport (vertical
// overflow) and, at a narrow width, columns wider than the viewport (horizontal overflow).
const manyTasks: (Task & { blocksTaskIds?: string[] })[] = Array.from({ length: 40 }, (_, i) => ({
  id: `TASK-V${i + 1}`,
  title: `Vertical overflow task ${i + 1}`,
  status: 'To Do',
  labels: [],
  assignee: [],
  dependencies: [],
  acceptanceCriteria: [],
  definitionOfDone: [],
  filePath: `/test/tasks/task-v${i + 1}.md`,
}));

test.describe('Tasks View — both-axes scrolling (kanban)', () => {
  test('kanban board scrolls on both axes at a narrow sidebar width', async ({ page }) => {
    await installVsCodeMock(page);
    await page.goto('/tasks.html');
    await page.waitForTimeout(100);
    await page.setViewportSize({ width: 400, height: 600 });

    await postMessageToWebview(page, { type: 'viewModeChanged', viewMode: 'kanban' });
    await postMessageToWebview(page, {
      type: 'statusesUpdated',
      statuses: ['To Do', 'In Progress', 'Done'],
    });
    await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
    await postMessageToWebview(page, { type: 'tasksUpdated', tasks: manyTasks });
    await page.waitForTimeout(100);

    // Precondition: the tall column actually rendered all its cards (fails here would mean
    // the test never reached the CSS assertion — not a false pass).
    await expect(page.locator('[data-testid="column-To Do"] .task-card')).toHaveCount(40);

    const scroller = page.locator('#kanban-app');

    // The scroll container is configured to scroll on BOTH axes.
    const overflow = await scroller.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return { x: s.overflowX, y: s.overflowY };
    });
    expect(['auto', 'scroll']).toContain(overflow.y);
    expect(['auto', 'scroll']).toContain(overflow.x);

    // Content exceeds the viewport in both directions.
    const metrics = await scroller.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);

    // The bottom of the board is actually reachable (scrollTop can move past 0).
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun run test:playwright -- tasks.spec.ts -g "scrolls on both axes"
```

Expected: **FAIL**. With no `#kanban-app` rule, `#kanban-app` computes `overflow-y: visible` and is content-height (`scrollHeight === clientHeight`), so `expect(['auto','scroll']).toContain('visible')` fails (and the height/width assertions would fail too). The precondition `toHaveCount(40)` passes, proving the failure is the missing CSS, not a render problem.

- [ ] **Step 3: Edit `src/webview/styles.css` — kanban rules**

Replace the block (A2):

```css
/* Kanban Board */
.kanban-board {
  display: flex;
  gap: 8px;
  padding: 8px;
  min-height: calc(100vh - 85px);
  overflow-x: auto;
}
```

with:

```css
/* Kanban view host: a flex column so #kanban-app owns a bounded, scrollable area below
   the toolbar (the tab bar + toolbar stay fixed; the board scrolls). ID selector beats
   .view-content { display: block }. */
#kanban-view {
  display: flex;
  flex-direction: column;
}

/* The single scroll container for the board — scrolls on BOTH axes. min-height:0 lets it
   shrink inside the flex column so a board taller than the webview scrolls vertically
   instead of being clipped by body.tasks-page { overflow: hidden }. */
#kanban-app {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* Kanban Board */
.kanban-board {
  display: flex;
  gap: 8px;
  padding: 8px;
  /* Fill #kanban-app when the board is short (columns look full-height) without forcing a
     spurious scrollbar; a taller board overflows and #kanban-app scrolls. Replaces the old
     calc(100vh - 85px), which forced the board taller than the pane and got clipped. */
  min-height: 100%;
  /* Kept so NESTED boards (milestone/label groups; not direct children of #kanban-app)
     retain their own horizontal scroll. The top-level board delegates horizontal scroll to
     #kanban-app via the rule below, so a single container scrolls both axes. */
  overflow-x: auto;
}

/* Top-level board (direct child of #kanban-app) does not scroll itself — #kanban-app is the
   single both-axes scroll container. Nested boards are not direct children, so they keep
   overflow-x:auto from the base rule above. */
#kanban-app > .kanban-board {
  overflow-x: visible;
}
```

> Do **not** touch the `.kanban-board.nested` / `.kanban-board.milestone-grouped` / label-grouped rules (A3). `#kanban-app` is left `display:block` on purpose: it must let the board's content height **exceed** its own bounded height so it scrolls (making it a flex container that stretches the board to exactly its height would defeat the scroll).

- [ ] **Step 4: Recompile the CSS and re-run — expect PASS**

```bash
bun run build:css
bun run test:playwright -- tasks.spec.ts -g "scrolls on both axes"
```

Expected: **PASS** — `#kanban-app` now computes `overflow-x: auto` and `overflow-y: auto`; the 40-card column makes `scrollHeight > clientHeight`; three min-140px columns at 400px width make `scrollWidth > clientWidth`; `scrollTop` moves past 0.

- [ ] **Step 5: Regression — the full kanban suite (incl. the existing horizontal test A5 and the grouped/label/nested tests)**

```bash
bun run test:playwright -- tasks.spec.ts
```

Expected: **PASS**, including `kanban columns have a minimum width and scroll at narrow sidebar` (A5) and the `Milestone Grouping` / `Label Grouping` describes.

- [ ] **Step 6: Full task gate**

```bash
bun run test && bun run lint && bun run typecheck
```

Expected: **PASS** (baseline unit pass count unchanged — CSS does not affect Vitest; `eslint src e2e` lints the new test; `tsc --noEmit` typechecks the fixture array against the imported `Task` type).

- [ ] **Step 7: (Optional) visual proof at a small viewport**

Load the `agent-browser` skill first, then:

```bash
bun run build
bun run vite &   # serves fixtures at http://localhost:5173 (leave running)
agent-browser open http://localhost:5173/tasks.html
agent-browser set viewport 400 600
agent-browser eval "window.postMessage({ type: 'viewModeChanged', viewMode: 'kanban' }, '*')"
agent-browser eval "window.postMessage({ type: 'statusesUpdated', statuses: ['To Do','In Progress','Done'] }, '*')"
agent-browser eval "window.postMessage({ type: 'milestonesUpdated', milestones: [] }, '*')"
agent-browser eval "window.postMessage({ type: 'tasksUpdated', tasks: Array.from({length:40},(_,i)=>({id:'TASK-V'+(i+1),title:'Vertical overflow task '+(i+1),status:'To Do',labels:[],assignee:[],dependencies:[],acceptanceCriteria:[],definitionOfDone:[],filePath:'/t/'+i+'.md'})) }, '*')"
agent-browser screenshot kanban-both-axes-400x600.png
```

Expected: the screenshot shows a **vertical** scrollbar on the board area (and a horizontal one at a narrow width). The Playwright assertion in Steps 1-4 is the real regression gate; this is supplementary proof.

- [ ] **Step 8: Commit**

```bash
git add src/webview/styles.css e2e/tasks.spec.ts
git commit --no-verify -m "fix(webview): kanban board scrolls on both axes in a narrow sidebar

- #kanban-view becomes a flex column; #kanban-app becomes the single both-axes scroll
  container (flex:1; min-height:0; overflow:auto) so a board taller than the pane scrolls
  vertically instead of being clipped by body.tasks-page overflow:hidden
- .kanban-board min-height calc(100vh-85px) -> 100% (fill when short, overflow when tall);
  top-level board delegates horizontal scroll to #kanban-app (#kanban-app > .kanban-board
  overflow-x:visible), nested/grouped boards keep their own overflow-x:auto
- Playwright: #kanban-app scrolls both axes and its bottom is reachable at 400x600

Completes DRAFT-1.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

**Dependencies:** none.

---

## Task 2: List view scrolls on both axes

**Files:**

- Modify: `src/webview/styles.css`
- Test: `e2e/tasks.spec.ts`

**Goal:** `.task-list-container` (the root of `ListView.svelte`, used by both `#list-view` and `#archived-view`) is padding-only (A4), so a long task table grows unbounded and is clipped by `body.tasks-page { overflow: hidden }`. Mirror the kanban fix: make `#list-view` / `#archived-view` flex columns and turn `.task-list-container` into a single both-axes scroll container.

- [ ] **Step 1: Write the failing test**

Append to the **end** of `e2e/tasks.spec.ts` (after Task 1's describe). Reuses the `manyTasks` fixture added in Task 1:

```ts
test.describe('Tasks View — both-axes scrolling (list)', () => {
  test('list view scrolls vertically when the table exceeds the viewport', async ({ page }) => {
    await installVsCodeMock(page);
    await page.goto('/tasks.html');
    await page.waitForTimeout(100);
    await page.setViewportSize({ width: 400, height: 600 });

    await postMessageToWebview(page, { type: 'viewModeChanged', viewMode: 'list' });
    await postMessageToWebview(page, {
      type: 'statusesUpdated',
      statuses: ['To Do', 'In Progress', 'Done'],
    });
    await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
    await postMessageToWebview(page, { type: 'tasksUpdated', tasks: manyTasks });
    await page.waitForTimeout(100);

    // Precondition: all 40 rows rendered (default "Not Done" filter shows To Do tasks).
    await expect(page.locator('.task-table tr[data-task-id]')).toHaveCount(40);

    const scroller = page.locator('.task-list-container');

    const overflowY = await scroller.evaluate((el) => window.getComputedStyle(el).overflowY);
    expect(['auto', 'scroll']).toContain(overflowY);

    const metrics = await scroller.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    // The bottom of the list is reachable.
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun run test:playwright -- tasks.spec.ts -g "scrolls vertically when the table"
```

Expected: **FAIL**. `.task-list-container` is padding-only, so it computes `overflow-y: visible` and is content-height (`scrollHeight === clientHeight`) — both assertions fail. The `toHaveCount(40)` precondition passes.

- [ ] **Step 3: Edit `src/webview/styles.css` — list rules**

Replace the block (A4):

```css
/* List View */
.task-list-container {
  padding: 12px;
}
```

with:

```css
/* List View */

/* List/archived view hosts: flex columns so .task-list-container owns a bounded, scrollable
   area (mirrors the kanban #kanban-view/#kanban-app treatment). ID selectors beat
   .view-content { display: block }. */
#list-view,
#archived-view {
  display: flex;
  flex-direction: column;
}

.task-list-container {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}
```

> `.task-list-container` is the single child of `#list-view` / `#archived-view`, so `flex:1; min-height:0` bounds it to the pane and `overflow:auto` scrolls the table on both axes (vertical for long lists, horizontal if the table is wider than a narrow sidebar). The search bar and filters scroll with the content — acceptable for a narrow sidebar and consistent with the instruction to make `.task-list-container` the scroll container.

- [ ] **Step 4: Recompile the CSS and re-run — expect PASS**

```bash
bun run build:css
bun run test:playwright -- tasks.spec.ts -g "scrolls vertically when the table"
```

Expected: **PASS** — `.task-list-container` computes `overflow-y: auto`; 40 rows make `scrollHeight > clientHeight`; `scrollTop` moves past 0.

- [ ] **Step 5: Regression — the full webview suite**

```bash
bun run test:playwright
```

Expected: **PASS** across all `e2e/*.spec.ts` — the list/archived tests, the kanban both-axes test (Task 1), the existing horizontal test (A5), and the milestone/label/nested variants stay green.

- [ ] **Step 6: Full task gate**

```bash
bun run test && bun run lint && bun run typecheck
```

Expected: **PASS**, baseline unit pass count unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/webview/styles.css e2e/tasks.spec.ts
git commit --no-verify -m "fix(webview): list & archived views scroll on both axes

- #list-view / #archived-view become flex columns; .task-list-container becomes a single
  both-axes scroll container (flex:1; min-height:0; overflow:auto) so a long task table
  scrolls instead of being clipped by body.tasks-page overflow:hidden
- Playwright: .task-list-container scrolls vertically and its bottom is reachable at 400x600

Completes DRAFT-1.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

**Dependencies:** Task 1 (shares the `manyTasks` fixture appended to `e2e/tasks.spec.ts`).

---

## Self-Review

- **Spec coverage.** Both surfaces the task named are fixed: the kanban board (Task 1: `#kanban-view` + `#kanban-app` + `.kanban-board` + `#kanban-app > .kanban-board`) and the list view (Task 2: `#list-view, #archived-view` + `.task-list-container`), each scrolling **both** axes, each with a Playwright assertion that the scroll container computes `overflow-y: auto|scroll` and that content taller than a 400×600 viewport is reachable (`scrollHeight > clientHeight` and `scrollTop > 0`). The optional agent-browser visual-proof commands are included (Task 1 Step 7); the Playwright assertions are the real regression gate, as requested.
- **No placeholders.** Every CSS before/after block and every test body is shown in full. No "TBD" / "similar to above" / undefined symbols. The one substitutable token is the commit trailer `<your model>`, per the Global Constraints (the dispatched agent fills its own model line).
- **Preserves existing behavior.** Base `.kanban-board` keeps `overflow-x: auto` so nested boards' horizontal scroll is untouched; only the top-level board delegates to `#kanban-app`. The milestone-grouped / label-grouped / nested rules (A3) are not edited. The existing horizontal-scroll test (A5) still holds (`scrollWidth > clientWidth` on `.kanban-board`), and the full `bun run test:playwright` run gates the grouped/label/nested variants.
- **Anchor fidelity.** Every edited/quoted rule was verified against the working tree (`.kanban-board` at ~305 with `min-height: calc(100vh - 85px); overflow-x: auto`; `.task-list-container` at ~899 padding-only; `.view-content` `display:block`; `body.tasks-page`/`#app`/`.view-content` flex chain; `#kanban-app` has no existing rule). Workers must match the quoted text, not the line numbers.
- **Type / name consistency.** The test fixture `manyTasks` is typed `(Task & { blocksTaskIds?: string[] })[]` matching the existing `sampleTasks` shape and the imported `Task` type (`e2e/tasks.spec.ts:15`); it is defined once (Task 1) and reused (Task 2). Message shapes (`viewModeChanged`, `statusesUpdated`, `milestonesUpdated`, `tasksUpdated`) and helpers (`installVsCodeMock`, `postMessageToWebview`) match the file's existing usage. No `.svelte`/`.ts` source is edited, so no `svelte-autofixer` or API surface is introduced.
