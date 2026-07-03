import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getLastPostedMessage,
  getPostedMessages,
  clearPostedMessages,
} from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const laneOrder = ['Features', 'Misc', 'Bugs'];
const bandOrder = ['v1', 'Backburner'];

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
  return [
    base({
      id: 'TASK-1', title: 'Root feature', status: 'To Do',
      category: 'Features', milestone: 'v1',
      layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
    }),
  ];
}

async function setup(page: Parameters<typeof installVsCodeMock>[0]) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVsCodeMock(page);
  await page.goto('/tasks.html');
  await page.waitForTimeout(100);
  await postMessageToWebview(page, { type: 'statusesUpdated', statuses: ['To Do', 'In Progress', 'Done'] });
  await postMessageToWebview(page, { type: 'prioritiesUpdated', priorities: ['high', 'medium', 'low'] });
  await postMessageToWebview(page, {
    type: 'milestonesUpdated',
    milestones: [{ id: 'v1', name: 'v1' }],
  });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: tasks() });
  await postMessageToWebview(page, { type: 'treeLayoutUpdated', laneOrder, bandOrder, warnings: [] });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(150);
  await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
}

test.describe('Tree authoring — create form', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('TabBar + opens the full form and creates a task on Enter', async ({ page }) => {
    await page.locator('[data-testid="action-create"]').click();
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    await clearPostedMessages(page);
    const title = page.locator('[data-testid="cf-title"]');
    await title.fill('Write the docs');
    await title.press('Enter');
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'createTask', title: 'Write the docs', openAfter: false });
    await expect(page.locator('[data-testid="create-form"]')).toHaveCount(0);
  });

  test('Shift+Enter sets openAfter', async ({ page }) => {
    await page.locator('[data-testid="action-create"]').click();
    await clearPostedMessages(page);
    const title = page.locator('[data-testid="cf-title"]');
    await title.fill('Open me after');
    await title.press('Shift+Enter');
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'createTask', title: 'Open me after', openAfter: true });
  });

  test('full form sends category (non-Misc) and milestone (non-Backburner)', async ({ page }) => {
    await page.locator('[data-testid="action-create"]').click();
    await page.locator('[data-testid="cf-title"]').fill('Feature X');
    await page.locator('[data-testid="cf-category"]').selectOption('Features');
    await page.locator('[data-testid="cf-priority"]').selectOption('high');
    await page.locator('[data-testid="cf-milestone"]').selectOption('v1');
    await clearPostedMessages(page);
    await page.locator('[data-testid="cf-submit"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'createTask', title: 'Feature X', category: 'Features', priority: 'high', milestone: 'v1',
    });
  });

  test('Misc category is omitted (no category)', async ({ page }) => {
    await page.locator('[data-testid="action-create"]').click();
    await page.locator('[data-testid="cf-title"]').fill('Uncategorized');
    // category defaults to Misc
    await clearPostedMessages(page);
    await page.locator('[data-testid="cf-submit"]').click();
    const msg = await getLastPostedMessage(page);
    expect(msg).toMatchObject({ type: 'createTask', title: 'Uncategorized' });
    expect((msg as Record<string, unknown>).category).toBeUndefined();
    expect((msg as Record<string, unknown>).milestone).toBeUndefined();
  });

  test('quick capture (openCreateForm quick) is title-only', async ({ page }) => {
    await postMessageToWebview(page, { type: 'openCreateForm', mode: 'quick' });
    await page.waitForTimeout(60);
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="cf-category"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="cf-description"]')).toHaveCount(0);
    const title = page.locator('[data-testid="cf-title"]');
    await title.fill('Just a title');
    await clearPostedMessages(page);
    await title.press('Enter');
    const msg = await getLastPostedMessage(page);
    expect(msg).toMatchObject({ type: 'createTask', title: 'Just a title' });
    expect((msg as Record<string, unknown>).category).toBeUndefined();
  });

  test('bug mode relabels priority to Severity and sends taskType:bug + causedBy', async ({ page }) => {
    await postMessageToWebview(page, { type: 'openCreateForm', mode: 'full', bugMode: true, causedBy: 'TASK-1' });
    await page.waitForTimeout(60);
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    // caused_by pre-filled; category/milestone hidden; priority relabeled in bug mode.
    await expect(page.locator('[data-testid="cf-causedby"]')).toHaveValue('TASK-1');
    await expect(page.locator('[data-testid="cf-category"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="cf-milestone"]')).toHaveCount(0);
    // N1: hard assertion — the relabel renders in the priority label's <span> ({priorityLabel}),
    // so assert on the form container, not the Task|Bug toggle row.
    await expect(page.locator('[data-testid="create-form"]')).toContainText('Severity');
    await page.locator('[data-testid="cf-title"]').fill('It crashes');
    await page.locator('[data-testid="cf-priority"]').selectOption('high');
    await clearPostedMessages(page);
    await page.locator('[data-testid="cf-submit"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'createTask', title: 'It crashes', taskType: 'bug', causedBy: 'TASK-1', priority: 'high',
    });
  });

  test('Report bug from a node opens the form in bug mode with caused_by prefilled', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await expect(page.locator('[data-testid="tree-popover"]')).toBeVisible();
    await page.locator('[data-testid="tp-action-reportBug"]').click();
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="cf-causedby"]')).toHaveValue('TASK-1');
    await page.locator('[data-testid="cf-title"]').fill('Regression from TASK-1');
    await clearPostedMessages(page);
    await page.locator('[data-testid="cf-submit"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'createTask', title: 'Regression from TASK-1', taskType: 'bug', causedBy: 'TASK-1',
    });
  });

  test('Escape closes the form without posting', async ({ page }) => {
    await page.locator('[data-testid="action-create"]').click();
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    await clearPostedMessages(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="create-form"]')).toHaveCount(0);
    expect((await getPostedMessages(page)).some((m) => m.type === 'createTask')).toBe(false);
  });

  test('open form suppresses bare single-key shortcuts behind the modal', async ({ page }) => {
    await page.locator('[data-testid="action-create"]').click();
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    // Focus a non-INPUT element in the form (the submit button) — without the
    // `if (createForm) return;` guard, bare keys like `t`/`z` would fall through the
    // INPUT/TEXTAREA target filter and switch the tab behind the modal (posting setViewMode).
    await page.locator('[data-testid="cf-submit"]').focus();
    await clearPostedMessages(page);
    await page.keyboard.press('t');
    await page.keyboard.press('z');
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
    expect((await getPostedMessages(page)).some((m) => m.type === 'setViewMode')).toBe(false);
  });

  test('clicking empty canvas opens the create form (click-in-place)', async ({ page }) => {
    // A single click on empty viewport space (no node) opens the full form.
    const viewport = page.locator('[data-testid="tree-viewport"]');
    const box = (await viewport.boundingBox())!;
    // Bottom-right corner is empty in the single-node fixture.
    await page.mouse.click(box.x + box.width - 20, box.y + box.height - 20);
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
  });
});
