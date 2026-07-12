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
  ];
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
});
