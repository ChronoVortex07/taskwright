# Restore Trackpad Two-Finger Pan & Pinch-Zoom on the Tree Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make the tech-tree canvas wheel handler classify each `WheelEvent` so a **trackpad two-finger scroll pans**, a **trackpad pinch / ctrl+scroll zooms**, and a **mouse wheel zooms** — restoring trackpad panning without regressing the mouse-wheel-zoom behavior TASK-57 introduced.

**Architecture.** The only production change is `onWheel` in `src/webview/components/tree/TechTreeCanvas.svelte`. Today it branches solely on `e.ctrlKey || e.metaKey` (commit `08d8ba4`, TASK-57): plain wheel ZOOMS, ctrl/meta+wheel PANS — correct for a mouse, inverted for a trackpad (a two-finger scroll has no modifier, so it zooms instead of panning). We add a pure, local `classifyWheel(e)` heuristic that reads the standard browser signals (`ctrlKey`/`metaKey` = pinch → zoom; pixel deltas with a horizontal or fractional/sub-notch component = trackpad pan; line/page or coarse integer-vertical deltas = mouse wheel → zoom) and route `onWheel` on its verdict. All existing invariants — `clampScale`/`clampViewport`, the pointer-drag pan gesture, and the TASK-57 text-selection fix (`user-select:none` + `e.preventDefault()` in the pan path) — stay byte-for-byte intact.

**Tech Stack:** TypeScript, Svelte 5 (runes), Playwright (webview UI tests dispatching synthetic `WheelEvent`s against the compiled bundle), Vite (webview bundle → `dist/webview/`), esbuild (extension bundle). No new dependency, no new message, no MCP surface.

## Background — what broke and why

- **Original design intent** (`docs/superpowers/specs/2026-07-02-tech-tree-p2-canvas-design.md` §11): "**Pan** by dragging empty canvas or scrolling; **zoom** with ⌘/Ctrl-scroll, pinch, or a toolbar." So scroll (trackpad two-finger / plain wheel) was meant to **pan**, and pinch / ⌘/Ctrl-scroll to **zoom**.
- **The regression** (`08d8ba4` — "Fix tree canvas drag-to-pan text-selection and default wheel zoom", `Completes TASK-57`): swapped the `onWheel` branches so **plain wheel now ZOOMS** and **ctrl/meta+wheel now PANS**. Good for mouse users (a wheel notch zooms), but it means a laptop **trackpad two-finger scroll** (no modifier keys) now **zooms** the canvas instead of panning it — the bug this task fixes. The same commit also added the text-selection fix, which is orthogonal and **must be preserved**.
- **The fix (this task):** stop treating "no modifier" as a single case. Classify the event by its shape so both input devices behave naturally at once: trackpad scroll → pan (restores §11 for trackpads), pinch/ctrl → zoom, mouse wheel → zoom (keeps TASK-57). This is device-behavior, not a user setting — no config, no new message.

## Prerequisites

**None.** DRAFT-2 is a `bug` caused by TASK-57, and TASK-57 is **already merged to `main`** (commit `08d8ba4`), so its code — the current `ctrlKey || metaKey` `onWheel`, the `.tree-viewport` `user-select:none`, and the `e.preventDefault()` pan-path guard — is already present in any worktree carved from `main`. This is an isolated webview change with no dependency on any other DRAFT. Carve this worktree from current `main`.

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

## Locked names & wire conventions

This task is **orthogonal to every locked cross-task contract** — it touches no MCP tool, no webview message, no frontmatter field. For the record, none of these are modified or referenced by this change: `start_task` (DRAFT-3), `request_merge`'s optional `worktree?` (DRAFT-4), `next_ready_tasks` (DRAFT-5), `/orchestrate-board` (DRAFT-8), the DRAFT-9 scaffolding. Do not rename or touch any of them.

Names this task introduces and depends on (do not rename):

- **New local helper** (module-script scope, inside `TechTreeCanvas.svelte`, NOT exported):
  `classifyWheel(e: WheelEvent): 'zoom' | 'pan'`. Pure, no side effects; reads only `e.ctrlKey`, `e.metaKey`, `e.deltaMode`, `e.deltaX`, `e.deltaY`.
- **Unchanged public/pure surface it relies on** (do NOT modify): `zoomAt(vp, cursorX, cursorY, factor)` (`src/webview/lib/treeGeometry.ts:184-189`, applies `clampScale`), `clampScale` (`:84-86`, `MIN_SCALE = 0.2` / `MAX_SCALE = 2` at `:24-25`), `clampViewport` (`:195-212`), and the component's own `setViewport` (`TechTreeCanvas.svelte:278-291`, which pipes every viewport write through `clampViewport`).
- **No new webview message.** `onWheel` continues to mutate local `vp` via `setViewport` only; it posts nothing.

---

## File Structure

**Modify:**

- `src/webview/components/tree/TechTreeCanvas.svelte` — add the `classifyWheel` helper and rewrite `onWheel` to route on its verdict (pan on trackpad-scroll, zoom on pinch/ctrl/mouse-wheel). No other function, the `onwheel` binding (`:815`), `zoomBy` (`:665-668`), the toolbar (`:771-790`), or the `.tree-viewport` CSS (`:958-966`) changes.

**Test:**

- `e2e/tree-canvas.spec.ts` — rewrite the one inverted test (`ctrl-wheel pans` → `ctrl/meta + wheel zooms`) and ADD two cases (trackpad-scroll pans; mouse `deltaMode:1` still zooms). The two existing plain-wheel tests (`plain wheel ... zooms`, far-LOD zoom-out) stay unchanged and remain valid — a coarse integer vertical-only pixel wheel classifies as a mouse wheel and still zooms.

_(No `src/` core file, no `.ts` unit test: `classifyWheel` is a component-local function and the acceptance behavior is DOM-event routing, which per this repo's testing strategy is Playwright's tier — "what message/behavior results when the user does X" on real wheel events. It is intentionally not exported or unit-tested in isolation.)_

---

## Task 1: Trackpad-aware wheel classification (pan on two-finger scroll, zoom on pinch/mouse)

**Goal:** Restore trackpad two-finger panning and pinch-zoom without regressing mouse-wheel zoom, by classifying each `WheelEvent` and routing `onWheel` on the verdict. One commit: the `.svelte` change plus its Playwright coverage.

**Files:**

- Modify: `src/webview/components/tree/TechTreeCanvas.svelte`
- Test: `e2e/tree-canvas.spec.ts`

> **Fixture-bundle note (read first — load-bearing):** Playwright webview tests load the **compiled** Svelte bundle from `dist/webview/`, not the `.svelte` source (see AGENTS.md "Test fixture pattern"). So after ANY edit to `TechTreeCanvas.svelte` you MUST run `bun run compile:webview` before `bun run test:playwright`, or the tests run against a stale bundle. Every Playwright step below spells this out.

- [ ] **Step 0: Baseline in the worktree**

Run these once, in `.worktrees/<branch>`:

```bash
bun install
bun run build          # produces dist/webview/ so Playwright has a bundle to load
bun run test           # record the pass count; ~22 known Windows POSIX failures are expected & unrelated
```

Record the actual `bun run test` pass/fail counts. Do NOT try to fix the ~22 POSIX-path failures.

- [ ] **Step 1: Write / adjust the failing Playwright tests**

In `e2e/tree-canvas.spec.ts`, **replace the entire `ctrl-wheel pans the surface without changing zoom` test** (currently at `:208-235`) with the three tests below. Match the quoted existing block, not the line number.

Existing block to replace (verbatim):

```ts
test('ctrl-wheel pans the surface without changing zoom', async ({ page }) => {
  // Zoom in so the surface overflows the viewport; when content fits entirely
  // within the viewport, clampViewport centres it and small pans are a no-op.
  await page.locator('[data-testid="tree-zoom-in"]').click();
  await page.locator('[data-testid="tree-zoom-in"]').click();
  await page.waitForTimeout(50);
  const surface = page.locator('[data-testid="tree-surface"]');
  const beforeTransform = await surface.getAttribute('style');
  const beforeZoom = await page.locator('[data-testid="tree-zoom-label"]').textContent();
  await page.locator('[data-testid="tree-viewport"]').evaluate((el) => {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: 120,
        deltaY: 80,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await page.waitForTimeout(50);
  const afterTransform = await surface.getAttribute('style');
  const afterZoom = await page.locator('[data-testid="tree-zoom-label"]').textContent();
  // Ctrl+wheel should pan → surface transform should change.
  expect(afterTransform).not.toBe(beforeTransform);
  // Ctrl+wheel should NOT zoom → zoom label should stay the same.
  expect(afterZoom).toBe(beforeZoom);
});
```

Replacement (three tests):

```ts
test('ctrl/meta + wheel zooms at the cursor (the pinch-zoom signal)', async ({ page }) => {
  // ctrlKey is what the browser sets for a trackpad PINCH (and for an explicit
  // ctrl+scroll). Under the trackpad-aware mapping this ZOOMS — the inverse of the
  // pre-fix `ctrl-wheel pans` behavior (TASK-57), which broke trackpad users.
  const beforeZoom = await page.locator('[data-testid="tree-zoom-label"]').textContent();
  await page.locator('[data-testid="tree-viewport"]').evaluate((el) => {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -100,
        deltaMode: 0, // DOM_DELTA_PIXEL — how browsers report a pinch
        ctrlKey: true,
        clientX: 400,
        clientY: 300,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await page.waitForTimeout(50);
  const afterZoom = await page.locator('[data-testid="tree-zoom-label"]').textContent();
  // ctrl+wheel now ZOOMS → the zoom-label percentage changes.
  expect(afterZoom).not.toBe(beforeZoom);
});

test('trackpad two-finger scroll (pixel deltas with deltaX) pans without zooming', async ({
  page,
}) => {
  // Zoom in so the surface overflows the viewport; when content fits entirely within
  // the viewport, clampViewport (treeGeometry.ts:195-212) re-centres it and a small
  // pan is a no-op. Three zoom-ins keep the pan well inside the clamp range so it
  // visibly moves the surface (the existing tests zoom in first for the same reason).
  await page.locator('[data-testid="tree-zoom-in"]').click();
  await page.locator('[data-testid="tree-zoom-in"]').click();
  await page.locator('[data-testid="tree-zoom-in"]').click();
  await page.waitForTimeout(50);
  const surface = page.locator('[data-testid="tree-surface"]');
  const beforeTransform = await surface.getAttribute('style');
  const beforeZoom = await page.locator('[data-testid="tree-zoom-label"]').textContent();
  await page.locator('[data-testid="tree-viewport"]').evaluate((el) => {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: 30,
        deltaY: 0,
        deltaMode: 0, // DOM_DELTA_PIXEL, and it carries a horizontal delta → trackpad
        ctrlKey: false,
        metaKey: false,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await page.waitForTimeout(50);
  const afterTransform = await surface.getAttribute('style');
  const afterZoom = await page.locator('[data-testid="tree-zoom-label"]').textContent();
  // Trackpad scroll PANS → the surface transform changes...
  expect(afterTransform).not.toBe(beforeTransform);
  // ...and does NOT zoom → the zoom label is unchanged.
  expect(afterZoom).toBe(beforeZoom);
});

test('mouse wheel (line deltas, no deltaX) still zooms', async ({ page }) => {
  // A classic mouse wheel: line-mode deltas, no horizontal component. Must keep the
  // TASK-57 zoom behavior — a regression guard for the mouse path.
  const beforeZoom = await page.locator('[data-testid="tree-zoom-label"]').textContent();
  await page.locator('[data-testid="tree-viewport"]').evaluate((el) => {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: 0,
        deltaY: -100,
        deltaMode: 1, // DOM_DELTA_LINE — the classic mouse-wheel signal
        ctrlKey: false,
        metaKey: false,
        clientX: 400,
        clientY: 300,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await page.waitForTimeout(50);
  const afterZoom = await page.locator('[data-testid="tree-zoom-label"]').textContent();
  // Mouse wheel still ZOOMS → the zoom label changes.
  expect(afterZoom).not.toBe(beforeZoom);
});
```

Leave the two existing plain-wheel tests **unchanged**: `plain wheel (no modifier) zooms centered on cursor instead of panning` (`:152`) and `far LOD nodes show title text alongside the status icon` (`:174`). Both dispatch a plain `deltaY: 120` with no `deltaX` and no `deltaMode` (defaulting to `0`), which the new classifier treats as a **coarse integer vertical-only pixel wheel → mouse wheel → zoom**, so they keep passing and now double as regression coverage for the mouse-wheel path.

- [ ] **Step 2: Run the tests against the CURRENT (pre-fix) bundle — expect FAIL**

The `.svelte` is still the old `ctrlKey || metaKey` handler, and Step 0 already built `dist/webview/`. Run:

```bash
bun run test:playwright -- tree-canvas
```

Expected: **the suite is RED** — specifically:

- `ctrl/meta + wheel zooms at the cursor` FAILS: old code treats ctrl+wheel as a **pan**, so the zoom label does not change → `expect(afterZoom).not.toBe(beforeZoom)` fails with `Expected: not "100%"` / `Received: "100%"`.
- `trackpad two-finger scroll ... pans without zooming` FAILS: old code has no pan-on-plain-wheel path; with `deltaY: 0` the zoom factor is `Math.exp(-0 * 0.0015) === 1`, a no-op, so the surface transform does not change → the first assertion `expect(afterTransform).not.toBe(beforeTransform)` fails (`Expected: not "<style>"` / `Received: "<same style>"`).
- `mouse wheel (line deltas, no deltaX) still zooms` PASSES even now (old code zooms on any non-modifier wheel) — it is a forward regression guard, not a falsifying test.

(If instead everything passes at Step 2, the bundle is stale — re-run `bun run build` and repeat.)

- [ ] **Step 3: Implement `classifyWheel` + rewrite `onWheel`**

In `src/webview/components/tree/TechTreeCanvas.svelte`, replace the existing `onWheel` function (currently at `:651-663`). Match the quoted block:

```ts
function onWheel(e: WheelEvent) {
  e.preventDefault();
  if (!viewportEl) return;
  if (e.ctrlKey || e.metaKey) {
    // Ctrl/meta + wheel → pan.
    setViewport({ scale: vp.scale, tx: vp.tx - e.deltaX, ty: vp.ty - e.deltaY });
  } else {
    // Plain wheel → zoom centered on cursor.
    const rect = viewportEl.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    setViewport(zoomAt(vp, e.clientX - rect.left, e.clientY - rect.top, factor));
  }
}
```

Replace with (the helper first, then the rewritten handler):

```ts
/**
 * Classify a wheel event as a zoom or a pan gesture, disambiguating a MOUSE WHEEL
 * from a TRACKPAD two-finger scroll / pinch. All signals are standard browser behavior:
 *   - ctrlKey / metaKey: the browser sets ctrlKey on a trackpad PINCH (and on an
 *     explicit ctrl+scroll); metaKey covers the ⌘+scroll convention → ZOOM.
 *   - Trackpad two-finger PAN: pixel deltas (deltaMode === 0 / DOM_DELTA_PIXEL) that
 *     either carry a horizontal component (deltaX ≠ 0 — a mouse wheel almost never
 *     emits deltaX) OR arrive as fine, fractional / sub-notch deltas (momentum
 *     scrolling) → PAN.
 *   - Mouse wheel: line/page deltas (deltaMode !== 0) OR a coarse integer vertical-only
 *     pixel delta (deltaX 0, a full |deltaY| notch) → ZOOM (keeps the TASK-57 behavior).
 */
function classifyWheel(e: WheelEvent): 'zoom' | 'pan' {
  if (e.ctrlKey || e.metaKey) return 'zoom';
  if (e.deltaMode === 0) {
    const dx = Math.abs(e.deltaX);
    const dy = Math.abs(e.deltaY);
    const fractional = !Number.isInteger(e.deltaX) || !Number.isInteger(e.deltaY);
    const smallGlide = dx === 0 && dy > 0 && dy < 40; // sub-notch vertical → trackpad
    if (dx > 0 || fractional || smallGlide) return 'pan';
  }
  return 'zoom';
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  if (!viewportEl) return;
  if (classifyWheel(e) === 'pan') {
    // Trackpad two-finger scroll → pan by the raw pixel deltas.
    setViewport({ scale: vp.scale, tx: vp.tx - e.deltaX, ty: vp.ty - e.deltaY });
  } else {
    // Pinch / ctrl+scroll / mouse wheel → zoom centered on the cursor.
    const rect = viewportEl.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    setViewport(zoomAt(vp, e.clientX - rect.left, e.clientY - rect.top, factor));
  }
}
```

Do NOT touch anything else. Specifically leave intact:

- the `onwheel={onWheel}` binding (`:815`);
- `zoomBy` (`:665-668`) and the toolbar zoom-out / label / zoom-in / fit buttons (`:771-790`);
- the pointer-drag pan gesture — `onPointerDown` (`:346-387`), the `onPointerMove` pan branch including `e.preventDefault()` at `:396` (`:393-403`), `onPointerUp` (`:443-474`), `onPointerLeave` (`:476-487`);
- the `.tree-viewport` CSS `touch-action: none; user-select: none;` (`:958-966`) — the TASK-57 text-selection fix.

The pan path reuses the exact translate arithmetic (`tx - e.deltaX`, `ty - e.deltaY`) that the old ctrl-branch used, and the zoom path is copied verbatim from the old else-branch, so `clampScale` (via `zoomAt`) and `clampViewport` (via `setViewport`) still bound every result.

- [ ] **Step 4: Run `svelte-autofixer` on the changed component**

Use the `svelte` MCP `svelte-autofixer` tool over `src/webview/components/tree/TechTreeCanvas.svelte` and keep calling it until it returns no issues. `classifyWheel`/`onWheel` are plain module-script functions that read no `$state` and mutate nothing reactive, so no runes warnings are expected; resolve anything it flags before committing.

- [ ] **Step 5: Rebuild the bundle and run the tests — expect PASS**

```bash
bun run compile:webview
bun run test:playwright -- tree-canvas
```

Expected: **all `tree-canvas.spec.ts` tests PASS**, including the three added/rewritten wheel tests:

- `ctrl/meta + wheel zooms at the cursor` — ctrl+wheel now zooms → label changes.
- `trackpad two-finger scroll ... pans without zooming` — `deltaX: 30` routes to the pan branch → surface transform changes, zoom label unchanged.
- `mouse wheel (line deltas, no deltaX) still zooms` — `deltaMode: 1` routes to zoom → label changes.
- `plain wheel (no modifier) zooms ...` and the far-LOD zoom-out test still pass (coarse integer vertical pixel wheel → mouse-wheel zoom).

- [ ] **Step 6: Full task verify gate**

```bash
bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-canvas
```

Expected: `bun run test` at the same pass count as the Step 0 baseline (no previously-green unit test regresses; the ~22 known Windows POSIX failures unchanged); `lint` and `typecheck` clean; the `tree-canvas` Playwright suite green.

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/tree/TechTreeCanvas.svelte e2e/tree-canvas.spec.ts
git commit --no-verify -m "fix(tree): trackpad two-finger scroll pans, pinch/mouse-wheel zooms

- classifyWheel(e) disambiguates input device from the WheelEvent shape:
  ctrl/meta -> zoom (pinch); pixel deltas with deltaX or fractional/sub-notch
  deltas -> pan (trackpad two-finger scroll); line/page or coarse integer
  vertical-only pixel deltas -> zoom (mouse wheel, keeps TASK-57)
- onWheel routes on classifyWheel; clampScale/clampViewport, the pointer-drag
  pan, and the TASK-57 text-selection fix are unchanged
- Playwright: rewrite the inverted ctrl-wheel test to expect zoom; add a
  trackpad-scroll-pans case and a mouse deltaMode:1 zoom regression guard

Completes <this task id>.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

(The `/execute-task` flow closes via `request_merge` from inside the worktree after this commit — do not ff-merge or push from the repo root.)

**Dependencies:** none.

---

## Self-Review

- **Spec coverage.** The task's required heuristic is implemented exactly: `ctrlKey || metaKey → zoom`; else `deltaMode === 0` AND (`|deltaX| > 0` OR fractional/small) `→ pan`; else `→ zoom` (mouse-wheel behavior preserved). The full rewritten `onWheel` and the `classifyWheel` helper are shown verbatim. All three required test cases are present: `ctrlKey:true → zoom`, `deltaMode:0, deltaX:30, deltaY:0, ctrlKey:false → pan` (asserts surface transform changes, zoom label unchanged), and `deltaMode:1, deltaX:0, deltaY:-100, ctrlKey:false → zoom`. The exact `bun run test:playwright -- tree-canvas` command and expected pass are given, and the pan test zooms in first (per the clampViewport re-centering note) as the existing tests do.
- **Anchors verified against the working tree.** `onWheel` (`:651-663`, current `ctrlKey || metaKey`), the `onwheel` binding (`:815`), `zoomBy` (`:665-668`), the toolbar (`:771-790`), `.tree-viewport` CSS with `touch-action:none; user-select:none` (`:958-966`), and the pointer-drag pan functions (`:346-387`, `:393-403` incl. `e.preventDefault()` at `:396`, `:443-474`, `:476-487`) all match the quoted snippets. `treeGeometry.ts` `zoomAt` (`:184-189`), `clampScale` (`:84-86`, `MIN_SCALE 0.2`/`MAX_SCALE 2` at `:24-25`), and `clampViewport` (`:195-212`) confirmed. The three locked-in tests (`:152-172`, `:174-206`, `:208-235`) are quoted from the current `e2e/tree-canvas.spec.ts`.
- **No placeholders.** Every code and test block is complete and runnable; no "TBD"/"similar to above". `classifyWheel` returns the literal union `'zoom' | 'pan'` and reads only documented `WheelEvent` fields.
- **Type/name consistency.** `classifyWheel(e: WheelEvent): 'zoom' | 'pan'` is component-local (not exported), matching the "Locked names" section; it depends only on the unchanged `zoomAt`/`clampScale`/`clampViewport`/`setViewport` surface. No message, MCP tool, or frontmatter is added, so no cross-task contract (DRAFT-3/4/5/8/9) is affected.
- **Preserved invariants.** The TASK-57 text-selection fix (`user-select:none` + pan-path `e.preventDefault()`) and the pointer-drag pan are explicitly out of scope and untouched; the zoom path is copied verbatim so mouse-wheel zoom is byte-for-byte unchanged.
- **Fixture caveat surfaced.** The plan calls out that Playwright loads the compiled `dist/webview/` bundle, so `bun run compile:webview` runs before every Playwright invocation after a `.svelte` edit — otherwise the FAIL/PASS steps read a stale bundle.
