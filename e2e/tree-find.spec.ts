import { test, expect, type Page } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview, getPostedMessages } from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

/**
 * e2e coverage for the tree find bar (TreeFindBar.svelte + the find wiring in
 * TechTreeCanvas.svelte). Consumes the same fixture/mock harness as
 * tree-canvas.spec.ts — see that file for the general pattern.
 *
 * Layout is deliberately deterministic:
 *   - TASK-1 "Add login form"                  — lane Features, band v1, depth 0
 *   - TASK-2 "Fix parser" (desc "the login parser") — lane Features, band v1, depth 1
 *   - TASK-3 "Unrelated"                        — lane Misc,     band v1, depth 0
 *   - TASK-D1 "Proposed idea" (Draft)           — lane Misc,     band v1, depth 1
 *   - TASK-9 "Spacer"                           — lane Features, band v2, depth 0
 *
 * A query for "login" therefore matches TASK-1 (title) and TASK-2 (description) but
 * not TASK-3, and TASK-1.x < TASK-2.x guarantees cycle order TASK-1 -> TASK-2.
 *
 * TASK-9 ("Spacer", never a find match) exists purely to inflate the geometry's total
 * width with a second band — without it, this 3-4 node board is small enough to fit
 * entirely inside the 1280x800 test viewport even at max zoom, so clampViewport
 * (treeGeometry.ts) pins tx/ty to one deterministic centered value no matter which node
 * centerOn() targets, and the "Enter re-centers the viewport" test could never observe a
 * transform change (the same gotcha tree-canvas.spec's navigatorJump test documents).
 */

const laneOrder = ['Features', 'Misc'];
const bandOrder = ['v1', 'v2'];

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
      title: 'Add login form',
      category: 'Features',
      milestone: 'v1',
      layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-2',
      title: 'Fix parser',
      description: 'the login parser',
      category: 'Features',
      milestone: 'v1',
      layout: { lane: 'Features', band: 'v1', depth: 1, subRow: 0 },
    }),
    base({
      id: 'TASK-3',
      title: 'Unrelated',
      category: 'Misc',
      milestone: 'v1',
      layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-D1',
      title: 'Proposed idea',
      status: 'Draft',
      category: 'Misc',
      milestone: 'v1',
      layout: { lane: 'Misc', band: 'v1', depth: 1, subRow: 0 },
    }),
    base({
      id: 'TASK-9',
      title: 'Spacer',
      category: 'Features',
      milestone: 'v2',
      layout: { lane: 'Features', band: 'v2', depth: 0, subRow: 0 },
    }),
    // Ring-layering probe (see the box-shadow test below). Neither of these matches "login",
    // so every other test's counts/cycle order are untouched; they match "crash" — TASK-5
    // (lane Features, above) before TASK-4 (lane Misc) in reading order, so a "crash" query
    // leaves TASK-4 a plain match first and Enter promotes it to the current match.
    base({
      id: 'TASK-5',
      title: 'Crash log viewer',
      category: 'Features',
      milestone: 'v2',
      layout: { lane: 'Features', band: 'v2', depth: 1, subRow: 0 },
    }),
    base({
      id: 'TASK-4',
      title: 'Crash on save',
      // An active bug on this node → TreeNode's `.has-active-bug` red ring.
      activeBugIds: ['TASK-7'],
      category: 'Misc',
      milestone: 'v2',
      layout: { lane: 'Misc', band: 'v2', depth: 1, subRow: 0 },
    }),
  ];
}

/** Parsed `box-shadow` layer: computed style order is `<color> <x> <y> <blur> <spread>`. */
type Shadow = { color: string; blur: number; spread: number };

/** Read a node's computed box-shadow and split it into its layers, in paint order. */
async function ringsOf(page: Page, taskId: string): Promise<Shadow[]> {
  const raw = await page
    .getByTestId(`tree-node-${taskId}`)
    .evaluate((el) => getComputedStyle(el).boxShadow);
  if (!raw || raw === 'none') return [];
  // Split on commas that are not inside an rgb()/rgba()/color() function.
  return raw
    .split(/,(?![^(]*\))/)
    .map((layer) => layer.trim())
    .map((layer) => {
      const color = (layer.match(/^(rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+)/i) ?? [''])[0];
      const px = layer.match(/-?[\d.]+px/g) ?? [];
      // x, y, blur, spread — blur/spread default to 0 when omitted.
      const n = (i: number) => parseFloat(px[i] ?? '0');
      return { color, blur: n(2), spread: n(3) };
    });
}

async function setupTreeView(page: Page) {
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

/** Click empty canvas (away from any node) so the click focuses the viewport, not a node. */
async function clickEmptyCanvas(page: Page) {
  const viewport = page.getByTestId('tree-viewport');
  const box = await viewport.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width - 40, box!.y + box!.height - 40);
}

async function surfaceTransform(page: Page): Promise<string> {
  return (await page.getByTestId('tree-surface').getAttribute('style')) ?? '';
}

/** Focus the canvas, open find with `/`, and type `query` via real keydown events. */
async function openFind(page: Page, query: string) {
  await clickEmptyCanvas(page);
  await page.keyboard.press('/');
  await expect(page.getByTestId('tree-search-input')).toBeFocused();
  await page.getByTestId('tree-search-input').pressSequentially(query);
  await page.waitForTimeout(50);
}

test.describe('Tree find bar', () => {
  test.beforeEach(async ({ page }) => {
    await setupTreeView(page);
  });

  test('/ opens the find bar and focuses it', async ({ page }) => {
    await clickEmptyCanvas(page);
    await page.keyboard.press('/');
    await expect(page.getByTestId('tree-find-bar')).toBeVisible();
    await expect(page.getByTestId('tree-search-input')).toBeFocused();
  });

  test('Ctrl+F opens the find bar', async ({ page }) => {
    await clickEmptyCanvas(page);
    await page.keyboard.press('Control+f');
    await expect(page.getByTestId('tree-find-bar')).toBeVisible();
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
    // Zoom in first so the surface overflows the viewport. With this small fixture, content
    // fits entirely inside the 1280x800 viewport at 100%, and clampViewport (treeGeometry.ts)
    // pins tx/ty to one deterministic centered value regardless of which node centerOn()
    // targets — the same gotcha tree-canvas.spec's navigatorJump test documents. Zooming in
    // makes the content overflow so a re-center actually moves the surface.
    await page.getByTestId('tree-zoom-in').click();
    await page.getByTestId('tree-zoom-in').click();
    await page.getByTestId('tree-zoom-in').click();
    await page.waitForTimeout(50);

    await openFind(page, 'login');
    await expect(page.getByTestId('tree-node-TASK-1')).toHaveClass(/find-current/);
    const before = await surfaceTransform(page);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tree-node-TASK-2')).toHaveClass(/find-current/);
    await expect(page.getByTestId('tree-find-count')).toHaveText('2 / 2');
    expect(await surfaceTransform(page)).not.toBe(before);
  });

  test('Enter past the last match wraps to the first', async ({ page }) => {
    await openFind(page, 'login');
    await page.keyboard.press('Enter'); // -> 2 / 2
    await page.keyboard.press('Enter'); // wrap -> 1 / 2
    await expect(page.getByTestId('tree-find-count')).toHaveText('1 / 2');
    await expect(page.getByTestId('tree-node-TASK-1')).toHaveClass(/find-current/);
  });

  test('Enter never opens a popover, even across several cycles (regression)', async ({
    page,
  }) => {
    // Enter deliberately does NOT call handleSelect() — opening the popover posts
    // popoverActiveChanged, which would rewrite the ephemeral active task on every
    // keypress while cycling matches. Cycle several times (past a full wrap) and assert
    // the popover never appears and the message is never posted.
    await openFind(page, 'login');
    await page.keyboard.press('Enter'); // -> TASK-2
    await expect(page.getByTestId('tree-popover')).not.toBeVisible();
    await page.keyboard.press('Enter'); // wrap -> TASK-1
    await expect(page.getByTestId('tree-popover')).not.toBeVisible();
    await page.keyboard.press('Enter'); // -> TASK-2 again
    await expect(page.getByTestId('tree-popover')).not.toBeVisible();

    const posted = await getPostedMessages(page);
    expect(posted.filter((m) => m.type === 'popoverActiveChanged')).toHaveLength(0);
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

  // --- Required regression tests (guard defects found and fixed during Tasks 1-6 review) ---

  test('typing a query containing j and k does not trigger node navigation (Critical regression)', async ({
    page,
  }) => {
    // Bare j/k are node-navigation keybindings on the canvas (onCanvasKeydown). Before the
    // fix (the INPUT/TEXTAREA/contenteditable bail-out at the top of onCanvasKeydown), these
    // keydowns were swallowed by the canvas handler before reaching the input — you could
    // not type a query containing j or k into the find box.
    await clickEmptyCanvas(page);
    await page.keyboard.press('/');
    const input = page.getByTestId('tree-search-input');
    await expect(input).toBeFocused();

    await input.pressSequentially('kanban junk');

    await expect(input).toHaveValue('kanban junk');
    const activeTestId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    expect(activeTestId).toBe('tree-search-input');
    // No tree node stole focus via the j/k node-nav binding.
    expect(activeTestId).not.toMatch(/^tree-node-/);
  });

  test('a node dimmed by the navigator filter is not a find candidate (I2 regression, half A)', async ({
    page,
  }) => {
    // Filter down to only TASK-3 ("Unrelated") — TASK-1 and TASK-2 get nav-dimmed.
    await postMessageToWebview(page, {
      type: 'navigatorFilterChanged',
      search: 'Unrelated',
      priority: '',
    });
    await page.waitForTimeout(60);
    await expect(page.getByTestId('tree-node-TASK-1')).toHaveClass(/nav-dimmed/);
    await expect(page.getByTestId('tree-node-TASK-2')).toHaveClass(/nav-dimmed/);

    // A query that would otherwise match TASK-1/TASK-2 must find nothing: both are filtered
    // out by the navigator and so are excluded from find's own candidate set.
    await openFind(page, 'login');
    await expect(page.getByTestId('tree-find-count')).toHaveText('No results');
    await expect(page.getByTestId('tree-node-TASK-1')).not.toHaveClass(/find-match/);
    await expect(page.getByTestId('tree-node-TASK-2')).not.toHaveClass(/find-match/);
  });

  test('an active find never narrows the Promote-all payload (I2 regression, half B)', async ({
    page,
  }) => {
    // TASK-D1 ("Proposed idea") does not match "login", so find dims it — but find is not
    // filter, and must never gate a write. Promote-all must still include it.
    await openFind(page, 'login');
    await expect(page.getByTestId('tree-node-TASK-D1')).not.toHaveClass(/find-match/);
    await expect(page.getByTestId('tree-node-TASK-D1')).toHaveClass(/nav-dimmed/);

    await page.getByTestId('tree-promote-all').click();
    const msgs = await getPostedMessages(page);
    const bulk = msgs.filter((m) => m.type === 'promoteDrafts');
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({ type: 'promoteDrafts', taskIds: ['TASK-D1'] });
  });

  test('Escape returns focus to the viewport so canvas key bindings keep working (I1 regression)', async ({
    page,
  }) => {
    // .tree-viewport carries tabindex="-1" precisely so closeFind()'s programmatic
    // viewportEl?.focus() lands focus somewhere real (not <body>), keeping the canvas's own
    // key bindings alive after the find bar closes.
    await openFind(page, 'login');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('tree-find-bar')).not.toBeVisible();

    const activeTestId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    expect(activeTestId).toBe('tree-viewport');

    // And the canvas binding actually still fires — no re-click needed to reopen find.
    await page.keyboard.press('/');
    await expect(page.getByTestId('tree-find-bar')).toBeVisible();
    await expect(page.getByTestId('tree-search-input')).toBeFocused();
  });

  test('the next/prev/close buttons work the same as their keyboard equivalents', async ({
    page,
  }) => {
    // Same button testids exercised by TreeFindBar.svelte:85 (prev), :96 (next), :107
    // (close). Prior coverage only drove these via Enter/Shift-Enter/Escape — click them
    // directly here so a regression in the button's onclick wiring (as opposed to the
    // shared stepFind/closeFind logic) would actually be caught.
    await openFind(page, 'login');
    await expect(page.getByTestId('tree-find-count')).toHaveText('1 / 2');
    await expect(page.getByTestId('tree-node-TASK-1')).toHaveClass(/find-current/);

    // Click "next" advances the current match and updates the counter.
    await page.getByTestId('tree-find-next').click();
    await expect(page.getByTestId('tree-find-count')).toHaveText('2 / 2');
    await expect(page.getByTestId('tree-node-TASK-2')).toHaveClass(/find-current/);
    await expect(page.getByTestId('tree-node-TASK-1')).not.toHaveClass(/find-current/);

    // Click "prev" moves back to the previous match.
    await page.getByTestId('tree-find-prev').click();
    await expect(page.getByTestId('tree-find-count')).toHaveText('1 / 2');
    await expect(page.getByTestId('tree-node-TASK-1')).toHaveClass(/find-current/);
    await expect(page.getByTestId('tree-node-TASK-2')).not.toHaveClass(/find-current/);

    // Click "close" hides the bar and clears the match/dim treatment, same as Escape.
    await page.getByTestId('tree-find-close').click();
    await expect(page.getByTestId('tree-find-bar')).not.toBeVisible();
    await expect(page.getByTestId('tree-node-TASK-1')).not.toHaveClass(/find-match/);
    await expect(page.getByTestId('tree-node-TASK-1')).not.toHaveClass(/find-current/);
    await expect(page.getByTestId('tree-node-TASK-3')).not.toHaveClass(/nav-dimmed/);
  });

  test('Ctrl+F opens the find bar on a cold tab that was never clicked (focus-mount fix)', async ({
    page,
  }) => {
    // Regression coverage for a real gap found while writing this suite: before
    // TechTreeCanvas mounted with a one-time `viewportEl.focus()` effect, a Tree tab that
    // had never been clicked left `document.activeElement` at <body>. onCanvasKeydown is
    // attached directly to `.tree-viewport` (not `window`), so a keydown targeting <body>
    // never reached it; Tasks.svelte's own window-level Ctrl/Cmd-F handler only focuses an
    // *already-rendered* find/search input, which doesn't exist until openFind() runs — so
    // the very first Ctrl+F on a cold tab silently did nothing. No click here at all.
    await page.keyboard.press('Control+f');
    await expect(page.getByTestId('tree-find-bar')).toBeVisible();
    await expect(page.getByTestId('tree-search-input')).toBeFocused();
  });

  // --- The keystroke must reach find from ANYWHERE on the board, not just the viewport ---

  test('/ opens the find bar after a toolbar button took focus (Critical regression)', async ({
    page,
  }) => {
    // onCanvasKeydown is bound to `.tree-viewport`; the toolbar is its SIBLING. Clicking a
    // toolbar button focuses that <button>, so the next keydown bubbles button → .tree-toolbar
    // → .tree-canvas → window and never traverses .tree-viewport. Find therefore cannot rely
    // on the canvas handler alone: Tasks.svelte's window-level handler bumps findRequestNonce,
    // which the canvas answers with openFind().
    await page.getByTestId('tree-zoom-in').click();
    await expect(page.getByTestId('tree-zoom-in')).toBeFocused();

    await page.keyboard.press('/');
    await expect(page.getByTestId('tree-find-bar')).toBeVisible();
    await expect(page.getByTestId('tree-search-input')).toBeFocused();
  });

  test('Ctrl+F opens the find bar after a toolbar button took focus (Critical regression)', async ({
    page,
  }) => {
    await page.getByTestId('tree-zoom-fit').click();
    await expect(page.getByTestId('tree-zoom-fit')).toBeFocused();

    await page.keyboard.press('Control+f');
    await expect(page.getByTestId('tree-find-bar')).toBeVisible();
    await expect(page.getByTestId('tree-search-input')).toBeFocused();
  });

  test('/ opens the find bar after a popover was dismissed via its ✕ (Critical regression)', async ({
    page,
  }) => {
    // Closing the popover REMOVES the focused ✕ button from the DOM, so document.activeElement
    // falls back to <body> — again outside .tree-viewport.
    await page.getByTestId('tree-node-TASK-1').click();
    await expect(page.getByTestId('tree-popover')).toBeVisible();
    await page.getByTestId('tp-close').click();
    await expect(page.getByTestId('tree-popover')).not.toBeVisible();

    await page.keyboard.press('/');
    await expect(page.getByTestId('tree-find-bar')).toBeVisible();
    await expect(page.getByTestId('tree-search-input')).toBeFocused();
  });

  // --- Ring layering (the has-active-bug + find ring occlusion fix) ---

  test('a bug node keeps a distinct bug ring beyond the find ring (occlusion regression)', async ({
    page,
  }) => {
    // The fix this guards: in a box-shadow list the FIRST layer paints on TOP, so listing the
    // bug ring first (or at a nesting spread) silently destroys the find ring — and vice
    // versa. Previously proven only by committed screenshots; assert the computed style so an
    // edit to TreeNode.svelte's shadow lists cannot re-occlude a ring with zero test signal.
    const node = page.getByTestId('tree-node-TASK-4');

    // Baseline: with no find open, the node's only ring is the bug ring — capture its color.
    const bugOnly = await ringsOf(page, 'TASK-4');
    expect(bugOnly).toHaveLength(1);
    expect(bugOnly[0].spread).toBe(3);
    const bugColor = bugOnly[0].color;

    // "crash" matches TASK-5 (first, reading order) and TASK-4 → TASK-4 is a plain match.
    await openFind(page, 'crash');
    await expect(page.getByTestId('tree-find-count')).toHaveText('1 / 2');
    await expect(node).toHaveClass(/find-match/);
    await expect(node).not.toHaveClass(/find-current/);

    let rings = (await ringsOf(page, 'TASK-4')).filter((s) => s.blur === 0);
    expect(rings).toHaveLength(2);
    // Two DISTINCT, non-nesting spreads, smaller (the find ring) listed FIRST so it paints on
    // top and the bug ring shows in the band beyond it.
    expect(rings.map((r) => r.spread)).toEqual([2, 5]);
    expect(rings[0].color).not.toBe(rings[1].color);
    expect(rings[1].color).toBe(bugColor); // the bug ring survived, outermost

    // Enter promotes TASK-4 to the CURRENT match — the same must hold for that heavier state.
    await page.keyboard.press('Enter');
    await expect(node).toHaveClass(/find-current/);

    rings = (await ringsOf(page, 'TASK-4')).filter((s) => s.blur === 0);
    expect(rings).toHaveLength(2);
    expect(rings.map((r) => r.spread)).toEqual([3, 6]);
    expect(rings[0].color).not.toBe(rings[1].color);
    expect(rings[1].color).toBe(bugColor);
    // …and the find-current glow (a blurred layer) is still there, painted behind both rings.
    expect((await ringsOf(page, 'TASK-4')).some((s) => s.blur > 0)).toBe(true);
  });

  test('the mount-time focus effect does not steal focus from the create-task form on an empty board (Important regression)', async ({
    page,
  }) => {
    // Reproduces the reviewer's failure scenario directly, without reusing setupTreeView
    // (which seeds a populated board): start from an EMPTY board so `hasLayout` is false
    // and TechTreeCanvas renders tree-empty-state (TechTreeCanvas.svelte:936) instead of
    // `.tree-viewport` — the mount-time focus effect has nothing to focus yet.
    await page.setViewportSize({ width: 1280, height: 800 });
    await installVsCodeMock(page);
    await page.goto('/tasks.html');
    await page.waitForTimeout(100);
    await postMessageToWebview(page, {
      type: 'statusesUpdated',
      statuses: ['To Do', 'In Progress', 'Done'],
    });
    await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
    await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
    await page.waitForTimeout(150);
    await expect(page.getByTestId('tree-empty-state')).toBeVisible();

    // Open the create-task form with a bare `n` (Tasks.svelte's window-level keydown
    // handler; CreateTaskForm is hosted at the Tasks.svelte root, a sibling of the tab
    // branch, so it renders regardless of activeTab) and start typing a title.
    // CreateTaskForm.svelte autofocuses cf-title exactly once, on its own mount effect —
    // it will not re-grab focus later, so this test is only meaningful if TechTreeCanvas's
    // effect is the one that could steal it back.
    await page.keyboard.press('n');
    const titleInput = page.getByTestId('cf-title');
    await expect(titleInput).toBeVisible();
    await expect(titleInput).toBeFocused();
    // fill() (not pressSequentially) because the `n` keydown that opens the form and
    // CreateTaskForm's own mount-time autofocus both land within the same physical
    // keystroke — the browser's default "insert n" can land in the freshly-focused input
    // and leak a stray leading "n" into a typed sequence. That leak is unrelated to the
    // focus-stealing behavior under test, so set the value directly.
    await titleInput.fill('New feature idea');

    // Now the board's first real data lands late — the initial refresh landing after the
    // user started typing, or a concurrent agent/worktree writing the first task (this is
    // Taskwright's own core workflow). tasksUpdated + treeLayoutUpdated flip `hasLayout`
    // true, `.tree-viewport` mounts for the first time, and the mount-time focus effect
    // (TechTreeCanvas.svelte ~365) fires. Before the fix it called `viewportEl.focus()`
    // unconditionally and yanked focus out of the title input; after the fix it checks
    // `document.activeElement` first and backs off because the title input already has it.
    await postMessageToWebview(page, { type: 'tasksUpdated', tasks: treeTasks() });
    await postMessageToWebview(page, {
      type: 'treeLayoutUpdated',
      laneOrder,
      bandOrder,
      warnings: [],
    });
    await page.waitForTimeout(150);
    await expect(page.getByTestId('tree-canvas')).toBeVisible();

    await expect(titleInput).toBeFocused();
    await expect(titleInput).toHaveValue('New feature idea');
  });

  // --- Stale-nonce replay on remount (Important regression) ---

  test('a tab round-trip does not reopen the find bar by itself (stale-nonce regression)', async ({
    page,
  }) => {
    // findRequestNonce lives in Tasks.svelte and persists for the whole webview session,
    // but TechTreeCanvas is destroyed and re-created on every tab switch ({:else if
    // activeTab === 'tree'}). Before the fix, TechTreeCanvas seeded its own
    // lastFindRequestNonce guard from 0 on every mount, so a prior `/` press (nonce bumped
    // to 1, then closed with Escape) looked like a fresh bump on the NEXT mount — the find
    // bar reopened and stole keyboard focus with no keystroke from the user.
    await openFind(page, 'login');
    await expect(page.getByTestId('tree-find-bar')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('tree-find-bar')).not.toBeVisible();

    // Switch away from Tree (unmounts TechTreeCanvas) and back (remounts it) without
    // touching find at all.
    await page.getByTestId('tab-kanban').click();
    await expect(page.getByTestId('tab-kanban')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('tab-tree').click();
    await expect(page.getByTestId('tree-canvas')).toBeVisible();
    await page.waitForTimeout(150);

    // The bar must NOT have reopened on its own, and focus must not have been pulled into
    // the search input.
    await expect(page.getByTestId('tree-find-bar')).not.toBeVisible();
    const activeTestId = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid')
    );
    expect(activeTestId).not.toBe('tree-search-input');

    // Prove the fix didn't just disable the feature: a REAL `/` press after the round-trip
    // still opens the bar.
    await clickEmptyCanvas(page);
    await page.keyboard.press('/');
    await expect(page.getByTestId('tree-find-bar')).toBeVisible();
    await expect(page.getByTestId('tree-search-input')).toBeFocused();
  });
});
