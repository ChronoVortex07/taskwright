import { test, expect } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview } from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

/**
 * TASK-107: hovering a node must not rewrite every edge in the board.
 *
 * The dim-the-rest highlight is a CSS consequence of ONE ancestor class on the
 * edge group — not a per-path class write — so the cost of a hover is bounded by
 * the hovered node's degree, not by the board's edge count. These tests pin that
 * with a large synthetic board: the naive implementation touched every path
 * (adding `.faded` to each), which on a 100+ node board repainted the whole
 * canvas on every pointer enter AND leave.
 */

const LANES = ['Features', 'Platform', 'Misc'];
const BANDS = ['v1', 'Backburner'];
const CHAIN = 40; // nodes per lane → 3 lanes, 39 dependency edges each

/** A wide board: 120 nodes, ~117 dependency edges. */
function bigBoard(): Task[] {
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

  const tasks: Task[] = [];
  LANES.forEach((lane, laneIdx) => {
    for (let depth = 0; depth < CHAIN; depth++) {
      const id = `TASK-${laneIdx * 100 + depth + 1}`;
      const prev = `TASK-${laneIdx * 100 + depth}`;
      tasks.push(
        base({
          id,
          title: `${lane} step ${depth}`,
          category: lane,
          milestone: 'v1',
          dependencies: depth === 0 ? [] : [prev],
          layout: { lane, band: 'v1', depth, subRow: 0 },
        })
      );
    }
  });
  return tasks;
}

async function setupBigTree(page: Parameters<typeof installVsCodeMock>[0]) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVsCodeMock(page);
  await page.goto('/tasks.html');
  await page.waitForTimeout(100);
  await postMessageToWebview(page, {
    type: 'statusesUpdated',
    statuses: ['To Do', 'In Progress', 'Done'],
  });
  await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: bigBoard() });
  await postMessageToWebview(page, {
    type: 'treeLayoutUpdated',
    laneOrder: LANES,
    bandOrder: BANDS,
    warnings: [],
  });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(200);
  await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
}

/**
 * Hover a node by dispatching the pointer event the component listens for. The
 * board is deliberately wider than the viewport here (that is the point of the
 * test), so a real mouse hover cannot reach a mid-chain node — and hit-testing
 * is not what we are measuring.
 */
async function hoverNode(
  page: Parameters<typeof installVsCodeMock>[0],
  nodeTestId: string
): Promise<void> {
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)!;
    el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
  }, nodeTestId);
  await page.waitForTimeout(100);
}

/**
 * Count the elements the edge layer MUTATES while the pointer enters a node.
 * A MutationObserver on the SVG subtree records every attribute write Svelte
 * makes; we count distinct target elements so a single element rewritten twice
 * is not double-charged.
 */
async function mutatedEdgeElementsOnHover(
  page: Parameters<typeof installVsCodeMock>[0],
  nodeTestId: string
): Promise<number> {
  await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="edge-layer"]')!;
    const touched = new Set<Node>();
    const obs = new MutationObserver((records) => {
      for (const r of records) touched.add(r.target);
    });
    obs.observe(svg, { attributes: true, subtree: true, childList: true });
    (window as unknown as Record<string, unknown>).__twTouched = touched;
    (window as unknown as Record<string, unknown>).__twObs = obs;
  });

  await hoverNode(page, nodeTestId);

  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    (w.__twObs as MutationObserver).disconnect();
    return (w.__twTouched as Set<Node>).size;
  });
}

test.describe('Tech tree hover cost', () => {
  test.beforeEach(async ({ page }) => {
    await setupBigTree(page);
  });

  test('renders the full synthetic board', async ({ page }) => {
    await expect(page.locator('.tree-node')).toHaveCount(LANES.length * CHAIN);
    // 39 dependency edges per lane.
    await expect(page.locator('.edge-layer .tree-edge')).toHaveCount(
      LANES.length * (CHAIN - 1)
    );
  });

  test('hovering a node mutates only a bounded number of edge elements', async ({ page }) => {
    // TASK-2 is mid-chain: degree 2 (one inbound prereq edge, one outbound).
    const mutated = await mutatedEdgeElementsOnHover(page, 'tree-node-TASK-2');

    // Bound: the hovered node's incident edges (2), the edge-group whose class
    // carries the dim state (1), and a little slack for the hit-path groups.
    // The pre-fix implementation wrote `.faded` to all 117 edges.
    expect(mutated).toBeLessThanOrEqual(8);
  });

  test('dimming the non-incident edges costs no per-edge DOM write', async ({ page }) => {
    await hoverNode(page, 'tree-node-TASK-2');

    // The dim state lives on ONE ancestor; individual non-incident paths are not
    // given a `.faded` class.
    const group = page.locator('[data-testid="tree-edge-group"]');
    await expect(group).toHaveClass(/has-active/);
    await expect(page.locator('.edge-layer .tree-edge.faded')).toHaveCount(0);

    // …and it still actually dims: a non-incident edge renders at low opacity.
    const nonIncident = page.locator('[data-testid="tree-edge-TASK-101-TASK-102"]');
    const opacity = await nonIncident.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeLessThan(0.5);

    // The incident edge is re-drawn opaque by the highlight overlay.
    const incident = page.locator('[data-testid="tree-edge-hl-TASK-1-TASK-2"]');
    await expect(incident).toHaveClass(/incident/);
    const incidentOpacity = await incident.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(incidentOpacity)).toBe(1);
  });

  test('edges do not carry a board-wide opacity transition', async ({ page }) => {
    const edge = page.locator('[data-testid="tree-edge-TASK-1-TASK-2"]');
    const transition = await edge.evaluate(
      (el) => getComputedStyle(el).transitionProperty
    );
    // A transition on every path animates the whole board on each hover in/out.
    expect(transition).not.toContain('opacity');
  });
});
