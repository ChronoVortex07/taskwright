import { test, expect } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview } from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';
import { deriveGeometry, type GeometryNode } from '../src/webview/lib/treeGeometry';

const laneOrder = ['Features', 'Misc', 'Bugs'];
const bandOrder = ['v1', 'Backburner'];

// A graph exercising: satisfied edge (TASK-1 Done → TASK-2), blocking edge
// (TASK-2 not done → TASK-3 locked), a draft node (TASK-4), and a bug with a
// cause (TASK-5 caused by TASK-1).
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
      title: 'Root feature',
      status: 'Done',
      category: 'Features',
      milestone: 'v1',
      priority: 'high',
      // Controller-side enrichment: TASK-1 caused active bug TASK-5. The webview
      // does not re-derive backlinks, so the fixture must carry these directly or
      // the `has-active-bug` halo assertion below cannot pass.
      activeBugIds: ['TASK-5'],
      bugs: ['TASK-5'],
      layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-2',
      title: 'Child feature',
      status: 'In Progress',
      category: 'Features',
      milestone: 'v1',
      dependencies: ['TASK-1'],
      layout: { lane: 'Features', band: 'v1', depth: 1, subRow: 0 },
    }),
    base({
      id: 'TASK-3',
      title: 'Grandchild (locked)',
      status: 'To Do',
      category: 'Features',
      milestone: 'v1',
      dependencies: ['TASK-2'],
      locked: true,
      blockedBy: ['TASK-2'],
      layout: { lane: 'Features', band: 'v1', depth: 2, subRow: 0 },
    }),
    base({
      id: 'TASK-4',
      title: 'Proposed idea',
      status: 'Draft',
      category: 'Misc',
      milestone: 'v1',
      layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-5',
      title: 'Crash on save',
      status: 'To Do',
      type: 'bug',
      causedBy: 'TASK-1',
      layout: { lane: 'Bugs', band: '', depth: 0, subRow: 0 },
    }),
  ];
}

async function setupTreeView(page: Parameters<typeof installVsCodeMock>[0]) {
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
  await postMessageToWebview(page, { type: 'treeLayoutUpdated', laneOrder, bandOrder, warnings: [] });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(150);
  await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
}

test.describe('Tech tree canvas', () => {
  test.beforeEach(async ({ page }) => {
    await setupTreeView(page);
  });

  test('renders one node per layout task at the geometry positions', async ({ page }) => {
    await expect(page.locator('.tree-node')).toHaveCount(5);

    const geoNodes: GeometryNode[] = treeTasks().map((t) => ({ id: t.id, layout: t.layout! }));
    const geometry = deriveGeometry(geoNodes, laneOrder, bandOrder);

    for (const [id, box] of geometry.nodes) {
      const el = page.locator(`[data-testid="tree-node-${id}"]`);
      await expect(el).toHaveAttribute('data-node-x', String(box.x));
      await expect(el).toHaveAttribute('data-node-y', String(box.y));
    }
  });

  test('nodes carry state styling classes', async ({ page }) => {
    await expect(page.locator('[data-testid="tree-node-TASK-1"]')).toHaveClass(/done/);
    await expect(page.locator('[data-testid="tree-node-TASK-3"]')).toHaveClass(/locked/);
    await expect(page.locator('[data-testid="tree-node-TASK-4"]')).toHaveClass(/proposed/);
    await expect(page.locator('[data-testid="tree-node-TASK-5"]')).toHaveClass(/bug-node/);
    // TASK-1 caused an active bug (TASK-5) → halo class.
    await expect(page.locator('[data-testid="tree-node-TASK-1"]')).toHaveClass(/has-active-bug/);
  });

  test('edges use solid (satisfied) and dashed-amber (blocking) classes', async ({ page }) => {
    await expect(page.locator('[data-testid="tree-edge-TASK-1-TASK-2"]')).toHaveClass(
      /tree-edge-satisfied/
    );
    await expect(page.locator('[data-testid="tree-edge-TASK-2-TASK-3"]')).toHaveClass(
      /tree-edge-blocking/
    );
  });

  test('bug→cause edge is hidden until the bug is hovered', async ({ page }) => {
    const bugEdge = page.locator('[data-testid="tree-edge-TASK-5-TASK-1"]');
    await expect(bugEdge).toHaveCount(0);
    await page.locator('[data-testid="tree-node-TASK-5"]').hover();
    await expect(bugEdge).toHaveCount(1);
    await expect(bugEdge).toHaveClass(/tree-edge-bug/);
  });

  test('hovering a node highlights incident edges and fades the rest', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-2"]').hover();
    await expect(page.locator('[data-testid="tree-edge-TASK-1-TASK-2"]')).toHaveClass(/incident/);
    await expect(page.locator('[data-testid="tree-edge-TASK-2-TASK-3"]')).toHaveClass(/incident/);
  });

  test('clicking a node sends selectTask (no popover in P2a)', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-2"]').click();
    const last = await page.evaluate(() =>
      (window as any).__vscodeTestHelpers.getLastPostedMessage()
    );
    expect(last).toMatchObject({ type: 'selectTask', taskId: 'TASK-2' });
  });

  test('ctrl-wheel zooms and switches LOD tiers', async ({ page }) => {
    const surface = page.locator('[data-testid="tree-surface"]');
    const beforeTransform = await surface.getAttribute('style');

    // Zoom out hard with ctrl-wheel → far LOD.
    await page.locator('[data-testid="tree-viewport"]').evaluate((el) => {
      for (let i = 0; i < 20; i++) {
        el.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, clientX: 400, clientY: 300, bubbles: true, cancelable: true })
        );
      }
    });
    await page.waitForTimeout(50);
    await expect(page.locator('[data-testid="tree-node-TASK-1"]')).toHaveAttribute('data-lod', 'far');
    const afterTransform = await surface.getAttribute('style');
    expect(afterTransform).not.toBe(beforeTransform);
  });

  test('plain wheel pans (updates the surface transform)', async ({ page }) => {
    const surface = page.locator('[data-testid="tree-surface"]');
    const before = await surface.getAttribute('style');
    await page.locator('[data-testid="tree-viewport"]').evaluate((el) => {
      el.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 120, deltaY: 80, ctrlKey: false, bubbles: true, cancelable: true })
      );
    });
    await page.waitForTimeout(50);
    expect(await surface.getAttribute('style')).not.toBe(before);
  });

  test('fit-to-view resets the zoom toward 100% or below', async ({ page }) => {
    // Zoom in first.
    await page.locator('[data-testid="tree-zoom-in"]').click();
    await page.locator('[data-testid="tree-zoom-in"]').click();
    await page.waitForTimeout(30);
    await page.locator('[data-testid="tree-zoom-fit"]').click();
    await page.waitForTimeout(50);
    const label = await page.locator('[data-testid="tree-zoom-label"]').textContent();
    const pct = parseInt((label ?? '0').replace('%', ''), 10);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  test('cross-branch / no-layout renders the empty-state notice, not a crash', async ({ page }) => {
    // Tasks with no layout + empty laneOrder (cross-branch mode).
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: [
        {
          id: 'X-1',
          title: 'Cross-branch task',
          status: 'To Do',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/b/tasks/x-1.md',
        } as Task,
      ],
    });
    await postMessageToWebview(page, { type: 'treeLayoutUpdated', laneOrder: [], bandOrder: [], warnings: [] });
    await page.waitForTimeout(80);
    await expect(page.locator('[data-testid="tree-empty-state"]')).toBeVisible();
  });
});
