import { test, expect } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview, getPostedMessages } from './fixtures/vscode-mock';
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

  test('ctrl-wheel zooms and switches LOD tiers', async ({ page }) => {
    const surface = page.locator('[data-testid="tree-surface"]');
    const beforeTransform = await surface.getAttribute('style');

    // Zoom out hard with ctrl-wheel → far LOD.
    await page.locator('[data-testid="tree-viewport"]').evaluate((el) => {
      for (let i = 0; i < 20; i++) {
        el.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: 120,
            ctrlKey: true,
            clientX: 400,
            clientY: 300,
            bubbles: true,
            cancelable: true,
          })
        );
      }
    });
    await page.waitForTimeout(50);
    await expect(page.locator('[data-testid="tree-node-TASK-1"]')).toHaveAttribute(
      'data-lod',
      'far'
    );
    const afterTransform = await surface.getAttribute('style');
    expect(afterTransform).not.toBe(beforeTransform);
  });

  test('far LOD nodes show title text alongside the status icon', async ({ page }) => {
    // Zoom out hard with ctrl-wheel → far LOD.
    await page.locator('[data-testid="tree-viewport"]').evaluate((el) => {
      for (let i = 0; i < 20; i++) {
        el.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: 120,
            ctrlKey: true,
            clientX: 400,
            clientY: 300,
            bubbles: true,
            cancelable: true,
          })
        );
      }
    });
    await page.waitForTimeout(50);

    // Confirm we're at far LOD.
    await expect(page.locator('[data-testid="tree-node-TASK-1"]')).toHaveAttribute(
      'data-lod',
      'far'
    );

    // Every far-LOD node pill should contain readable text (not just an SVG icon).
    for (const id of ['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5']) {
      const pill = page.locator(`[data-testid="tree-node-pill-${id}"]`);
      await expect(pill).toBeVisible();
      const text = (await pill.textContent())?.trim() ?? '';
      expect(text.length, `Pill for ${id} should show title text`).toBeGreaterThan(0);
    }
  });

  test('plain wheel pans (updates the surface transform)', async ({ page }) => {
    // Zoom in so the surface overflows the viewport; when content fits entirely
    // within the viewport, clampViewport centres it and small pans are a no-op.
    await page.locator('[data-testid="tree-zoom-in"]').click();
    await page.locator('[data-testid="tree-zoom-in"]').click();
    await page.waitForTimeout(50);
    const surface = page.locator('[data-testid="tree-surface"]');
    const before = await surface.getAttribute('style');
    await page.locator('[data-testid="tree-viewport"]').evaluate((el) => {
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: 120,
          deltaY: 80,
          ctrlKey: false,
          bubbles: true,
          cancelable: true,
        })
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
    await postMessageToWebview(page, {
      type: 'treeLayoutUpdated',
      laneOrder: [],
      bandOrder: [],
      warnings: [],
    });
    await page.waitForTimeout(80);
    await expect(page.locator('[data-testid="tree-empty-state"]')).toBeVisible();
  });

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
    await expect(page.locator('[data-testid="tree-empty-state"]')).toContainText(
      'No tasks to plot'
    );
  });

  test('arrow key moves focus to the next node', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').focus();
    await page.locator('[data-testid="tree-viewport"]').press('ArrowRight');
    const focusedId = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid')
    );
    expect(focusedId).toMatch(/^tree-node-/);
  });

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

  test('cross-branch mode shows the cross-branch empty-state copy (11c)', async ({ page }) => {
    await postMessageToWebview(page, { type: 'dataSourceChanged', mode: 'cross-branch' });
    await postMessageToWebview(page, { type: 'tasksUpdated', tasks: [] });
    await postMessageToWebview(page, {
      type: 'treeLayoutUpdated',
      laneOrder: [],
      bandOrder: [],
      warnings: [],
    });
    await page.waitForTimeout(80);
    await expect(page.locator('[data-testid="tree-empty-state"]')).toContainText(
      "isn't available in cross-branch mode"
    );
  });

  test('Promote-all counts only non-filtered drafts (11b)', async ({ page }) => {
    // Two drafts; a search filter that matches only one → the button shows (1) and
    // promotes only the visible draft.
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: [
        {
          id: 'TASK-D1',
          title: 'Alpha draft',
          status: 'Draft',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/b/tasks/task-d1.md',
          category: 'Features',
          milestone: 'v1',
          layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
        } as Task,
        {
          id: 'TASK-D2',
          title: 'Beta draft',
          status: 'Draft',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/b/tasks/task-d2.md',
          category: 'Features',
          milestone: 'v1',
          layout: { lane: 'Features', band: 'v1', depth: 1, subRow: 0 },
        } as Task,
      ],
    });
    await postMessageToWebview(page, {
      type: 'treeLayoutUpdated',
      laneOrder: ['Features'],
      bandOrder: ['v1'],
      warnings: [],
    });
    await postMessageToWebview(page, {
      type: 'navigatorFilterChanged',
      search: 'Alpha',
      priority: '',
    });
    await page.waitForTimeout(80);
    await expect(page.locator('[data-testid="tree-promote-all"]')).toContainText('(1)');

    // Promote-all now posts ONE promoteDrafts message with only the visible (filtered) draft.
    await page.locator('[data-testid="tree-promote-all"]').click();
    const msgs = await getPostedMessages(page);
    const bulk = msgs.filter((m) => m.type === 'promoteDrafts');
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({ type: 'promoteDrafts', taskIds: ['TASK-D1'] });
    // No per-node promoteDraft messages from the bulk button:
    expect(msgs.some((m) => m.type === 'promoteDraft')).toBe(false);
  });

  test('a draft node renders as a proposed tree node (GAP-1 visible)', async ({ page }) => {
    // treeTasks() includes TASK-4 (status 'Draft'); the tree tab shows it as a proposed node.
    await expect(page.locator('[data-testid="tree-node-TASK-4"]')).toBeVisible();
    await expect(page.locator('[data-testid="tree-node-TASK-4"]')).toHaveClass(/draft|proposed/);
  });

  test('tree canvas fills available panel height, not collapsed to min-height', async ({
    page,
  }) => {
    // The canvas must fill the webview height, not collapse to its 400px min-height.
    const canvas = page.locator('[data-testid="tree-canvas"]');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    // With a 1280×800 viewport, the canvas height should comfortably exceed the
    // 400px min-height guard once the ancestor height chain is fixed.
    expect(box!.height).toBeGreaterThan(500);
    // Width should fill the viewport (full width).
    expect(box!.width).toBeGreaterThan(1000);
  });

  test('tree canvas reflows on viewport resize (responsive height)', async ({ page }) => {
    const canvas = page.locator('[data-testid="tree-canvas"]');
    const before = await canvas.boundingBox();
    expect(before).not.toBeNull();

    // Shrink the viewport.
    await page.setViewportSize({ width: 800, height: 500 });
    await page.waitForTimeout(150); // let layout settle

    const after = await canvas.boundingBox();
    expect(after).not.toBeNull();
    // Canvas should shrink with the viewport, not stay at a fixed size.
    expect(after!.height).toBeLessThan(before!.height);
    expect(after!.width).toBeLessThan(before!.width);
    // Still above the min-height guard.
    expect(after!.height).toBeGreaterThan(300);
  });

  test('a drafts-folder node carrying a REAL status still renders provisional via the folder clause (P6/D2)', async ({
    page,
  }) => {
    // Positive control for the P6 draft model: a promoted-era draft carries a REAL status, so
    // `status === 'Draft'` is FALSE. Such a node is provisional ONLY via the `folder === 'drafts'`
    // clause of the consumer guard (TreeNode/TechTreeCanvas/DetailPopover). Both a Done and a To-Do
    // drafts-folder node must still get the `proposed` treatment — dropping the `folder === 'drafts'`
    // clause regresses this (isDraft would be false for a non-'Draft' status → no proposed class).
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: [
        {
          id: 'TASK-DFD',
          title: 'Done draft',
          status: 'Done',
          folder: 'drafts',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/b/drafts/task-dfd.md',
          category: 'Features',
          milestone: 'v1',
          layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
        } as Task,
        {
          id: 'TASK-DFT',
          title: 'To-Do draft',
          status: 'To Do',
          folder: 'drafts',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
          filePath: '/b/drafts/task-dft.md',
          category: 'Features',
          milestone: 'v1',
          layout: { lane: 'Features', band: 'v1', depth: 1, subRow: 0 },
        } as Task,
      ],
    });
    await postMessageToWebview(page, {
      type: 'treeLayoutUpdated',
      laneOrder: ['Features'],
      bandOrder: ['v1'],
      warnings: [],
    });
    await page.waitForTimeout(80);
    await expect(page.locator('[data-testid="tree-node-TASK-DFD"]')).toBeVisible();
    await expect(page.locator('[data-testid="tree-node-TASK-DFD"]')).toHaveClass(/proposed/);
    await expect(page.locator('[data-testid="tree-node-TASK-DFT"]')).toHaveClass(/proposed/);
  });
});
