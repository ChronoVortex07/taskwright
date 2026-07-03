import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getPostedMessages,
  clearPostedMessages,
} from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

// Multi-lane (Features / Backend / Bugs) × multi-band (v1 / v2) so nodes sit in
// distinct cells that page.mouse can drag between. Node centers are read from the
// rendered bounding boxes (post fit-to-view), so drags are robust to the surface
// transform — assert on the posted message SHAPE, not pixel positions.
const laneOrder = ['Features', 'Backend', 'Bugs'];
const bandOrder = ['v1', 'v2'];

const mk = (over: Partial<Task> & { id: string }): Task =>
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

function tasks(): Task[] {
  return [
    mk({ id: 'TASK-1', title: 'Root', category: 'Features', milestone: 'v1', layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 } }),
    mk({ id: 'TASK-2', title: 'Backend thing', category: 'Backend', milestone: 'v1', layout: { lane: 'Backend', band: 'v1', depth: 0, subRow: 0 } }),
    mk({ id: 'TASK-3', title: 'Later', category: 'Features', milestone: 'v2', layout: { lane: 'Features', band: 'v2', depth: 0, subRow: 0 } }),
    // Bug node (M2 coverage): bugs anchor at band '' on the Bugs lane and are reorder-only.
    mk({ id: 'TASK-4', title: 'A bug', type: 'bug', layout: { lane: 'Bugs', band: '', depth: 0, subRow: 0 } }),
  ];
}

type Pg = Parameters<typeof installVsCodeMock>[0];

async function setup(page: Pg) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVsCodeMock(page);
  await page.goto('/tasks.html');
  await page.waitForTimeout(100);
  await postMessageToWebview(page, { type: 'statusesUpdated', statuses: ['To Do', 'In Progress', 'Done'] });
  await postMessageToWebview(page, { type: 'prioritiesUpdated', priorities: ['high', 'medium', 'low'] });
  await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [{ id: 'v1', name: 'v1' }, { id: 'v2', name: 'v2' }] });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: tasks() });
  await postMessageToWebview(page, { type: 'treeLayoutUpdated', laneOrder, bandOrder, warnings: [] });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(150);
  await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
  await settle(page);
}

/**
 * Fit the board and wait for the surface transform to STOP changing. The initial
 * auto-fit runs on rAF while the webview is still laying out (the viewport height
 * settles from a smaller value to full size), so node screen positions drift for a
 * beat after mount. Reading a node center before that settles — then pressing — lands
 * the press on empty canvas (a background pan) instead of the node. Clicking fit at the
 * final viewport size + polling for a stable transform makes the geometry deterministic.
 */
async function settle(page: Pg) {
  await page.locator('[data-testid="tree-zoom-fit"]').click();
  const surface = page.locator('[data-testid="tree-surface"]');
  let prev: string | null = null;
  for (let i = 0; i < 25; i++) {
    const cur = await surface.getAttribute('style');
    if (cur !== null && cur === prev) return;
    prev = cur;
    await page.waitForTimeout(60);
  }
}

/** Center of a node in page (screen) coordinates. */
async function nodeCenter(page: Pg, id: string) {
  const box = await page.locator(`[data-testid="tree-node-${id}"]`).boundingBox();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/**
 * Hover the node so its connect handle mounts, then return a press point ON the handle.
 * Handles sit at the node edge (left/right:-7px) and the node clips overflow, so only the
 * handle half toward the node CENTER is hittable — pressing the geometric center lands on
 * the node body (a reslot) or empty surface. Nudge inward by `dir`.
 */
async function handleCenter(page: Pg, id: string, dir: 'needs' | 'unlocks') {
  const sel = `[data-testid="tree-connect-${dir}-${id}"]`;
  await page.locator(`[data-testid="tree-node-${id}"]`).hover();
  await expect(page.locator(sel)).toBeVisible();
  const box = await page.locator(sel).boundingBox();
  const cx = dir === 'unlocks' ? box!.x + box!.width / 2 - 4 : box!.x + box!.width / 2 + 4;
  return { x: cx, y: box!.y + box!.height / 2 };
}

/** Drag from a→b with intermediate steps so movement crosses DRAG_THRESHOLD (6px). */
async function drag(page: Pg, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

/** Same as `drag` but leaves the pointer DOWN at `to` so mid-gesture UI can be asserted. */
async function dragHold(page: Pg, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
}

/**
 * Last posted message of a given type. Filter by type (never bare "last message"):
 * the canvas emits a debounced `minimapViewport` that can otherwise race ahead of the
 * gesture message we care about.
 */
async function lastOfType(page: Pg, type: string) {
  const msgs = await getPostedMessages(page);
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].type === type) return msgs[i];
  return undefined;
}

async function hasType(page: Pg, type: string) {
  return (await getPostedMessages(page)).some((m) => m.type === type);
}

test.describe('Tree drag — connect / reslot / edge removal', () => {
  test.beforeEach(async ({ page }) => setup(page));

  // --- connect (green valid, red cycle, both directions) --------------------

  test('right (unlocks) handle onto a valid node shows a green ring and posts addDependency (target depends on origin)', async ({ page }) => {
    const target = await nodeCenter(page, 'TASK-2');
    const from = await handleCenter(page, 'TASK-1', 'unlocks');
    await clearPostedMessages(page);
    await dragHold(page, from, target);
    // Mid-gesture: hovering a valid target renders a green (valid) connect ring.
    const ring = page.locator('[data-testid="drag-connect-ring"]');
    await expect(ring).toHaveClass(/\bvalid\b/);
    await page.mouse.up();
    // unlocks: origin unlocks target ⇒ target depends on origin.
    expect(await lastOfType(page, 'addDependency')).toMatchObject({
      type: 'addDependency',
      taskId: 'TASK-2',
      dependsOn: 'TASK-1',
    });
  });

  test('left (needs) handle onto a valid node posts addDependency (origin depends on target)', async ({ page }) => {
    const target = await nodeCenter(page, 'TASK-2');
    const from = await handleCenter(page, 'TASK-1', 'needs');
    await clearPostedMessages(page);
    await drag(page, from, target);
    // needs: origin needs target ⇒ origin depends on target.
    expect(await lastOfType(page, 'addDependency')).toMatchObject({
      type: 'addDependency',
      taskId: 'TASK-1',
      dependsOn: 'TASK-2',
    });
  });

  test('a cycle/dupe-forming connect shows a red ring and posts no addDependency', async ({ page }) => {
    // Pre-wire TASK-1 depends on TASK-2, then try to wire TASK-1↔TASK-2 again (dupe/cycle).
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: tasks().map((t) => (t.id === 'TASK-1' ? { ...t, dependencies: ['TASK-2'] } : t)),
    });
    await page.waitForTimeout(80);
    const target = await nodeCenter(page, 'TASK-1');
    const from = await handleCenter(page, 'TASK-2', 'unlocks');
    await clearPostedMessages(page);
    await dragHold(page, from, target);
    // Mid-gesture: an invalid target renders a red (invalid) connect ring.
    const ring = page.locator('[data-testid="drag-connect-ring"]');
    await expect(ring).toHaveClass(/\binvalid\b/);
    await page.mouse.up();
    expect(await hasType(page, 'addDependency')).toBe(false);
  });

  // --- reslot (lane → category, band → milestone, in-cell → reorder) ---------

  test('dragging a node to another lane posts reslotTask with the new category', async ({ page }) => {
    const from = await nodeCenter(page, 'TASK-1');
    const to = await nodeCenter(page, 'TASK-2'); // Features → Backend lane
    await clearPostedMessages(page);
    await drag(page, from, to);
    expect(await lastOfType(page, 'reslotTask')).toMatchObject({
      type: 'reslotTask',
      taskId: 'TASK-1',
      category: 'Backend',
    });
  });

  test('dragging a node to another band posts reslotTask with the new milestone', async ({ page }) => {
    const from = await nodeCenter(page, 'TASK-1');
    const to = await nodeCenter(page, 'TASK-3'); // v1 → v2 band
    await clearPostedMessages(page);
    await drag(page, from, to);
    expect(await lastOfType(page, 'reslotTask')).toMatchObject({
      type: 'reslotTask',
      taskId: 'TASK-1',
      milestone: 'v2',
    });
  });

  test('a cross-band reslot drag emphasizes the target band strip (band-expand)', async ({ page }) => {
    const from = await nodeCenter(page, 'TASK-1');
    const to = await nodeCenter(page, 'TASK-3'); // hover into the v2 band
    await dragHold(page, from, to);
    // Mid-gesture: the drag layer paints a target-band strip and the band header emphasizes.
    await expect(page.locator('[data-testid="drag-band-target"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="tree-band-v2"]')).toHaveClass(/emphasized/);
    await page.mouse.up();
  });

  test('dragging a node onto a same-cell sibling posts reorderTasks', async ({ page }) => {
    // Two nodes stacked in the SAME cell (Features / v1, subRow 0 & 1) so the drop is
    // an in-cell ordinal reorder (no lane/band change).
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: [
        mk({ id: 'TASK-1', title: 'Top', category: 'Features', milestone: 'v1', ordinal: 1000, layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 } }),
        mk({ id: 'TASK-2', title: 'Bottom', category: 'Features', milestone: 'v1', ordinal: 2000, layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 1 } }),
      ],
    });
    await postMessageToWebview(page, { type: 'treeLayoutUpdated', laneOrder: ['Features'], bandOrder: ['v1'], warnings: [] });
    await page.waitForTimeout(80);
    await settle(page);
    const from = await nodeCenter(page, 'TASK-2'); // bottom sibling
    const to = await nodeCenter(page, 'TASK-1'); // drop above the top sibling
    await clearPostedMessages(page);
    await drag(page, from, to);
    const reorder = await lastOfType(page, 'reorderTasks');
    expect(reorder).toMatchObject({ type: 'reorderTasks' });
    expect(Array.isArray((reorder as Record<string, unknown>).updates)).toBe(true);
    expect(((reorder as { updates: unknown[] }).updates).length).toBeGreaterThan(0);
    // Never a reslotTask for an in-cell move.
    expect(await hasType(page, 'reslotTask')).toBe(false);
  });

  // --- M2 bug reorder-only ---------------------------------------------------

  test('a bug dragged horizontally posts NO reslotTask (reorder-only, M2)', async ({ page }) => {
    const from = await nodeCenter(page, 'TASK-4');
    // Horizontal target: the v2 band's x-range (TASK-3's column) at the bug's own y, so
    // the cursor stays in the Bugs lane. Bugs (band '') anchor under the FIRST populated
    // band (v1), so v2 is genuinely a non-origin band.
    const v2 = await nodeCenter(page, 'TASK-3');
    await clearPostedMessages(page);
    await dragHold(page, from, { x: v2.x, y: from.y });
    // Positive control (anti-vacuity): BEFORE releasing, prove the reslot drag genuinely
    // engaged on the bug node — the ghost is up and the hovered band target is v2, not
    // the origin band. A missed press (background pan) would render none of these, and
    // this "no message" test would otherwise pass without exercising the bug at all.
    await expect(page.locator('[data-testid="drag-ghost"]')).toBeVisible();
    await expect(page.locator('[data-testid="drag-band-target"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="tree-band-v2"]')).toHaveClass(/emphasized/);
    await page.mouse.up();
    // Never a reslotTask for a bug — no milestone can be assigned by a drag. (With a
    // single bug in the lane there are no siblings, so no reorderTasks either.)
    expect(await hasType(page, 'reslotTask')).toBe(false);
    expect(await hasType(page, 'reorderTasks')).toBe(false);
  });

  // --- dependency removal (edge ✕ + popover prereq ✕) ------------------------

  test('hovering an edge shows a ✕ that posts removeDependency', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: tasks().map((t) => (t.id === 'TASK-2' ? { ...t, dependencies: ['TASK-1'] } : t)),
    });
    await page.waitForTimeout(80);
    // The edge is a bezier; its bounding-box center is off-stroke, so `.hover()` on the
    // hit path is unreliable. The anchors' midpoint (dependency right-center → dependent
    // left-center) is exactly the curve at t=0.5 — and where the ✕ is placed — so moving
    // the pointer there lands on the fat hit stroke and reveals the ✕.
    const c1 = (await page.locator('[data-testid="tree-node-TASK-1"]').boundingBox())!;
    const c2 = (await page.locator('[data-testid="tree-node-TASK-2"]').boundingBox())!;
    const mid = {
      x: (c1.x + c1.width + c2.x) / 2,
      y: (c1.y + c1.height / 2 + (c2.y + c2.height / 2)) / 2,
    };
    await page.mouse.move(mid.x, mid.y);
    await expect(page.locator('[data-testid="tree-edge-remove-TASK-1-TASK-2"]')).toBeVisible();
    await clearPostedMessages(page);
    await page.locator('[data-testid="tree-edge-remove-TASK-1-TASK-2"]').click();
    expect(await lastOfType(page, 'removeDependency')).toMatchObject({
      type: 'removeDependency',
      taskId: 'TASK-2',
      dependsOn: 'TASK-1',
    });
  });

  test('popover prereq ✕ posts removeDependency', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: tasks().map((t) => (t.id === 'TASK-2' ? { ...t, dependencies: ['TASK-1'] } : t)),
    });
    await page.waitForTimeout(80);
    await page.locator('[data-testid="tree-node-TASK-2"]').click();
    await expect(page.locator('[data-testid="tree-popover"]')).toBeVisible();
    await clearPostedMessages(page);
    await page.locator('[data-testid="tp-prereq-remove-TASK-1"]').click();
    expect(await lastOfType(page, 'removeDependency')).toMatchObject({
      type: 'removeDependency',
      taskId: 'TASK-2',
      dependsOn: 'TASK-1',
    });
  });

  // --- drop-on-empty → pre-linked create form --------------------------------

  test('dropping a connect on empty canvas opens the create form pre-linked', async ({ page }) => {
    const from = await handleCenter(page, 'TASK-1', 'unlocks');
    const vp = (await page.locator('[data-testid="tree-viewport"]').boundingBox())!;
    await drag(page, from, { x: vp.x + vp.width - 20, y: vp.y + vp.height - 20 });
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    // Submitting posts createTask with linkTo (origin TASK-1, direction unlocks).
    await page.locator('[data-testid="cf-title"]').fill('Linked node');
    await clearPostedMessages(page);
    await page.locator('[data-testid="cf-submit"]').click();
    expect(await lastOfType(page, 'createTask')).toMatchObject({
      type: 'createTask',
      title: 'Linked node',
      linkTo: { taskId: 'TASK-1', direction: 'unlocks' },
    });
  });
});
