import { test, expect, type Page } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview } from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

/**
 * TASK-112 — host→canvas command nonces across a Tree-tab remount.
 *
 * The nonce props (`jumpNonce`, `jumpTaskNonce`, `minimapPanNonce`, `findRequestNonce`) live in
 * Tasks.svelte and survive for the whole webview session, while TechTreeCanvas is rendered inside
 * `{:else if activeTab === 'tree'}` and is therefore destroyed and re-created on every tab switch.
 * A guard seeded to 0 on each mount sees the stale, non-zero nonce and re-fires the command with
 * no user input. All four now route through one idiom, `onCommandNonce`
 * (src/webview/lib/commandNonce.svelte.ts), which seeds its guard from the prop's mount-time value.
 *
 * ---------------------------------------------------------------------------------------------
 * READ THIS BEFORE ADDING A "PROVES THE REPLAY" ASSERTION HERE — one is not possible for the
 * viewport commands, and a test that looks like one is VACUOUS.
 *
 * TechTreeCanvas declares its `restored` effect (vp = the persisted `treeViewport`) AFTER the
 * command effects, and Svelte runs effects in creation order. So on a remount the command effects
 * flush first and the restore OVERWRITES `vp` in the same flush. A replayed jump / minimap-pan is
 * therefore clobbered before it can ever paint — which is exactly why TASK-112 describes these
 * three nonces as "benign today: they replay an invisible viewport recenter". Verified, not
 * assumed: reintroducing the `= 0` seed and rebuilding leaves every assertion in this file green.
 *
 * The no-replay guarantee is therefore proved where it IS observable:
 *   - src/test/unit/commandNonce.test.ts — the `onCommandNonce` idiom itself (nonce-agnostic, so
 *     it covers all four commands), RED-verified against the buggy `= 0` seed, plus a contract
 *     test that every nonce prop the canvas declares is routed through it. That is what fails if
 *     someone hand-rolls a `let lastFooNonce = 0` guard again.
 *   - e2e/tree-find.spec.ts — the find bar, the one command whose replay IS user-visible (it
 *     reopens the bar and steals keyboard focus), which is why that bug shipped in 1.8.0.
 *
 * What THIS file is for, and what it genuinely catches:
 *   1. The commands still FIRE after a remount — the fix must not disable them. Not masked: the
 *      restore effect runs once per mount, so a command issued later is not clobbered.
 *   2. A Tree-tab round-trip leaves the viewport where the user left it. This is the user-facing
 *      property the whole task is about, and it is the assertion that would start failing if the
 *      masking above ever went away (e.g. the restore effect is reordered, or a future command
 *      prop does something the restore cannot clobber).
 *
 * FIXTURE WIDTH IS LOAD-BEARING: `clampViewport` (treeGeometry.ts) pins tx to one deterministic
 * value when the scaled content is narrower than `viewportW - 2*margin`, at which point a pan
 * cannot move anything and even the assertions above go vacuous. The board is deliberately WIDE
 * and SHORT (8 single-column bands, 2 lanes). Do not shrink it — the `expect(panned).not.toBe(...)`
 * sanity check in each test is what guards that.
 */

const laneOrder = ['Features', 'Misc'];
const bandOrder = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'];

function wideTasks(): Task[] {
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

  const tasks = bandOrder.map((band, i) =>
    base({
      id: `TASK-${i + 1}`,
      title: `Feature ${i + 1}`,
      category: 'Features',
      milestone: band,
      layout: { lane: 'Features', band, depth: 0, subRow: 0 },
    })
  );
  tasks.push(
    base({
      id: 'TASK-90',
      title: 'Misc one',
      category: 'Misc',
      milestone: 'v1',
      layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-91',
      title: 'Misc two',
      category: 'Misc',
      milestone: 'v8',
      layout: { lane: 'Misc', band: 'v8', depth: 0, subRow: 0 },
    })
  );
  return tasks;
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
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: wideTasks() });
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

const surfaceStyle = (page: Page) =>
  page.locator('[data-testid="tree-surface"]').getAttribute('style');

/**
 * Park the viewport at the fit-to-view pose via the toolbar (NOT a nonce command) and let the
 * debounced `persist()` (120ms) write it to webview state, so the next mount restores THIS pose.
 */
async function fitAndPersist(page: Page): Promise<string | null> {
  await page.getByTestId('tree-zoom-fit').click();
  await page.waitForTimeout(250);
  return surfaceStyle(page);
}

/** Tab away from Tree (unmounts TechTreeCanvas) and back (remounts it), touching nothing else. */
async function tabRoundTrip(page: Page) {
  await page.getByTestId('tab-kanban').click();
  await expect(page.getByTestId('tab-kanban')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-testid="tree-canvas"]')).toHaveCount(0);
  await page.getByTestId('tab-tree').click();
  await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
  await page.waitForTimeout(200);
}

test.describe('Host→canvas commands survive a Tree-tab remount', () => {
  test.beforeEach(async ({ page }) => {
    await setupTreeView(page);
  });

  test('minimap pan: a round-trip leaves the viewport put, and a real pan still works after', async ({
    page,
  }) => {
    const initial = await surfaceStyle(page);

    // The user drags the navigator minimap to the far right of the board.
    await postMessageToWebview(page, { type: 'navigatorMinimapPan', x: 0.95, y: 0.5 });
    await page.waitForTimeout(80);
    const panned = await surfaceStyle(page);
    // Sanity: the command is observable at all (guards the fixture width — if clampViewport
    // pinned tx, every assertion below would be vacuous).
    expect(panned).not.toBe(initial);

    // Park the viewport somewhere the command did NOT put it, via a non-nonce route.
    const fit = await fitAndPersist(page);
    expect(fit).not.toBe(panned);

    await tabRoundTrip(page);

    // The remount restores where the user left it. (See the header: a replayed pan would be
    // clobbered by the restore effect anyway, so this assertion is a guard on the user-facing
    // property, not a proof of the nonce guard — that lives in src/test/unit/commandNonce.test.ts.)
    expect(await surfaceStyle(page)).toBe(fit);

    // NOT MASKED, and the real point of this test: the fix must not DISABLE the command. A
    // genuine pan issued after the remount still pans.
    await postMessageToWebview(page, { type: 'navigatorMinimapPan', x: 0.95, y: 0.5 });
    await page.waitForTimeout(80);
    expect(await surfaceStyle(page)).not.toBe(fit);
  });

  test('band jump: a round-trip leaves the viewport put, and a real jump still works after', async ({
    page,
  }) => {
    const initial = await surfaceStyle(page);

    await postMessageToWebview(page, { type: 'navigatorJump', band: 'v8' });
    await page.waitForTimeout(80);
    const jumped = await surfaceStyle(page);
    expect(jumped).not.toBe(initial);

    const fit = await fitAndPersist(page);
    expect(fit).not.toBe(jumped);

    await tabRoundTrip(page);
    expect(await surfaceStyle(page)).toBe(fit);

    await postMessageToWebview(page, { type: 'navigatorJump', band: 'v8' });
    await page.waitForTimeout(80);
    expect(await surfaceStyle(page)).not.toBe(fit);
  });

  test('jump-to-task: a round-trip leaves the viewport put, and a real jump still works after', async ({
    page,
  }) => {
    const initial = await surfaceStyle(page);

    await postMessageToWebview(page, { type: 'navigatorJumpToTask', taskId: 'TASK-8' });
    await page.waitForTimeout(80);
    const jumped = await surfaceStyle(page);
    expect(jumped).not.toBe(initial);

    const fit = await fitAndPersist(page);
    expect(fit).not.toBe(jumped);

    await tabRoundTrip(page);
    expect(await surfaceStyle(page)).toBe(fit);

    await postMessageToWebview(page, { type: 'navigatorJumpToTask', taskId: 'TASK-8' });
    await page.waitForTimeout(80);
    expect(await surfaceStyle(page)).not.toBe(fit);
  });

  test('commands issued while the Tree tab is CLOSED leave the next mount where the user left it', async ({
    page,
  }) => {
    // The nonce props are bumped by Tasks.svelte regardless of which tab is showing, so a canvas
    // can mount with an already-non-zero nonce it never saw bumped. Seeding the guard from the
    // mount-time value covers that too.
    const fit = await fitAndPersist(page);

    await page.getByTestId('tab-kanban').click();
    await expect(page.locator('[data-testid="tree-canvas"]')).toHaveCount(0);

    await postMessageToWebview(page, { type: 'navigatorMinimapPan', x: 0.95, y: 0.5 });
    await postMessageToWebview(page, { type: 'navigatorJump', band: 'v8' });
    await postMessageToWebview(page, { type: 'navigatorJumpToTask', taskId: 'TASK-8' });
    await page.waitForTimeout(80);

    await page.getByTestId('tab-tree').click();
    await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
    await page.waitForTimeout(200);

    // The canvas restores where the user left it — it must not act on the three commands that
    // were queued into the props while it did not exist.
    expect(await surfaceStyle(page)).toBe(fit);
  });
});
