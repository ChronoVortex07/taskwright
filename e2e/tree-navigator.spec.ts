import { test, expect } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview, getLastPostedMessage } from './fixtures/vscode-mock';

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

  test('clicking a priority chip posts navigatorFilterChanged with the priority', async ({ page }) => {
    await page.locator('[data-testid="nav-priority-high"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'navigatorFilterChanged',
      priority: 'high',
    });
  });

  test('toggling a lane posts navigatorLaneToggle', async ({ page }) => {
    await page.locator('[data-testid="nav-lane-Bugs"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'navigatorLaneToggle', lane: 'Bugs' });
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
