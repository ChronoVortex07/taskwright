import { test, expect } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview } from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

/**
 * TASK-108: node text must rasterize crisply at zoom.
 *
 * `.tree-surface` carries the pan/zoom `transform: scale()`. A PERMANENT
 * `will-change: transform` on it promotes the surface to its own composited
 * layer and tells the compositor the transform keeps animating, so Chromium
 * rasterizes the layer once and then SCALES THAT BITMAP for later transforms
 * instead of re-rasterizing text at the new scale — zooming in magnifies a
 * texture rendered at the old scale, i.e. blurry glyphs.
 *
 * The hint is worth having *during* a gesture and harmful at rest, so it must be
 * gesture-scoped: absent when the viewport is settled, present while panning or
 * wheeling, gone again once the gesture stops (which is when the browser
 * re-rasterizes at the settled scale).
 */

const laneOrder = ['Features'];
const bandOrder = ['v1'];

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

  return [0, 1, 2, 3].map((depth) =>
    base({
      id: `TASK-${depth + 1}`,
      title: `Legible node title ${depth + 1}`,
      category: 'Features',
      milestone: 'v1',
      dependencies: depth === 0 ? [] : [`TASK-${depth}`],
      layout: { lane: 'Features', band: 'v1', depth, subRow: 0 },
    })
  );
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
  await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
}

const willChange = (page: Parameters<typeof installVsCodeMock>[0]) =>
  page
    .locator('[data-testid="tree-surface"]')
    .evaluate((el) => getComputedStyle(el).willChange);

/** Zoom in with the wheel (a plain wheel zooms — see classifyWheel). */
async function wheelZoom(page: Parameters<typeof installVsCodeMock>[0], ticks: number) {
  await page.locator('[data-testid="tree-viewport"]').evaluate((el, n) => {
    for (let i = 0; i < n; i++) {
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -120, // negative → zoom IN
          clientX: 400,
          clientY: 300,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }, ticks);
}

test.describe('Tech tree zoom rasterization', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('the surface is NOT permanently promoted to a composited layer', async ({ page }) => {
    // At rest the compositor must be free to re-rasterize text at the current
    // scale. A standing `will-change: transform` is exactly what stops it.
    expect(await willChange(page)).not.toContain('transform');
  });

  test('the layer hint is applied only while a gesture is in flight', async ({ page }) => {
    await wheelZoom(page, 3);
    // Mid-gesture: the hint pays for itself (the transform really is animating).
    expect(await willChange(page)).toContain('transform');

    // …and is dropped once the viewport settles, so the text re-rasterizes crisp.
    await page.waitForTimeout(400);
    expect(await willChange(page)).not.toContain('transform');
  });

  test('a pan gesture promotes the layer and releases it on pointerup', async ({ page }) => {
    const viewport = page.locator('[data-testid="tree-viewport"]');
    const box = (await viewport.boundingBox())!;

    // Bottom-right corner is empty canvas (away from nodes, headers and toolbar)
    // — the same anchor the existing drag-to-pan coverage uses.
    const startX = box.x + box.width - 60;
    const startY = box.y + box.height - 60;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 80, startY - 40, { steps: 5 });
    expect(await willChange(page)).toContain('transform');

    await page.mouse.up();
    await page.waitForTimeout(400);
    expect(await willChange(page)).not.toContain('transform');
  });

  test('zooming in still actually scales the surface', async ({ page }) => {
    const before = await page.locator('[data-testid="tree-zoom-label"]').textContent();
    await wheelZoom(page, 5);
    await page.waitForTimeout(50);
    const after = await page.locator('[data-testid="tree-zoom-label"]').textContent();
    expect(parseInt(after!, 10)).toBeGreaterThan(parseInt(before!, 10));
  });
});
