import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getLastPostedMessage,
  getPostedMessages,
  clearPostedMessages,
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
    tasks: [
      {
        id: 'TASK-1',
        title: 'Add login page',
        status: 'In Progress',
        priority: 'high',
        lane: 'Features',
        band: 'v1',
      },
      {
        id: 'TASK-2',
        title: 'Fix sidebar crash',
        status: 'To Do',
        priority: 'medium',
        lane: 'Bugs',
        band: 'Backburner',
      },
      {
        id: 'TASK-3',
        title: 'Update docs',
        status: 'Done',
        priority: 'low',
        lane: 'Features',
        band: 'v1',
      },
    ],
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

  test('shows task list section with task entries', async ({ page }) => {
    await expect(page.locator('[data-testid="nav-tasks-section"]')).toBeVisible();
    // Task entries should be visible (default filter: In Progress and To Do)
    await expect(page.locator('[data-testid="nav-task-TASK-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-task-TASK-2"]')).toBeVisible();
    // Done task should be hidden by default
    await expect(page.locator('[data-testid="nav-task-TASK-3"]')).not.toBeVisible();
  });

  test('clicking a task entry posts navigatorJumpToTask', async ({ page }) => {
    await clearPostedMessages(page);
    await page.locator('[data-testid="nav-task-TASK-1"]').click();
    const msg = await getLastPostedMessage(page);
    expect(msg).toMatchObject({ type: 'navigatorJumpToTask', taskId: 'TASK-1' });
  });

  test('status filter toggles show/hide tasks', async ({ page }) => {
    // Toggle "Done" filter on — should now show the Done task
    await page.locator('[data-testid="nav-status-filter-Done"]').click();
    await expect(page.locator('[data-testid="nav-task-TASK-3"]')).toBeVisible();

    // Toggle "In Progress" off — should hide In Progress task
    await page.locator('[data-testid="nav-status-filter-In Progress"]').click();
    await expect(page.locator('[data-testid="nav-task-TASK-1"]')).not.toBeVisible();
  });

  test('task entry shows id, title, status, and lane', async ({ page }) => {
    const entry = page.locator('[data-testid="nav-task-TASK-1"]');
    await expect(entry).toContainText('TASK-1');
    await expect(entry).toContainText('Add login page');
    await expect(entry).toContainText('In Progress');
    await expect(entry).toContainText('Features');
  });

  test('task list respects search text filter', async ({ page }) => {
    // Search for "login" — only TASK-1 should be visible
    await page.locator('[data-testid="nav-search"]').fill('login');
    await expect(page.locator('[data-testid="nav-task-TASK-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-task-TASK-2"]')).not.toBeVisible();
  });
});
