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
      id: 'TASK-1',
      title: 'Unlocked todo',
      status: 'To Do',
      category: 'Features',
      milestone: 'v1',
      layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-2',
      title: 'Locked todo',
      status: 'To Do',
      category: 'Features',
      milestone: 'v1',
      dependencies: ['TASK-1'],
      locked: true,
      blockedBy: ['TASK-1'],
      layout: { lane: 'Features', band: 'v1', depth: 1, subRow: 0 },
    }),
    base({
      id: 'TASK-3',
      title: 'Mine in progress',
      status: 'In Progress',
      category: 'Misc',
      milestone: 'v1',
      claimedBy: 'me',
      claimedByMe: true,
      layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 0 },
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
  await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: tasks() });
  await postMessageToWebview(page, { type: 'treeLayoutUpdated', laneOrder, bandOrder, warnings: [] });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(150);
  await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
}

test.describe('Tree detail popover', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('clicking a node opens the popover and posts popoverActiveChanged', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await expect(page.locator('[data-testid="tree-popover"]')).toBeVisible();
    const msgs = await getPostedMessages(page);
    expect(msgs).toContainEqual({ type: 'popoverActiveChanged', taskId: 'TASK-1' });
  });

  test('closing the popover posts popoverActiveChanged null', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await clearPostedMessages(page);
    await page.locator('[data-testid="tp-close"]').click();
    await expect(page.locator('[data-testid="tree-popover"]')).toHaveCount(0);
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'popoverActiveChanged', taskId: null });
  });

  test('unlocked To Do offers Claim + Dispatch', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await expect(page.locator('[data-testid="tp-action-claim"]')).toBeVisible();
    await expect(page.locator('[data-testid="tp-action-dispatch"]')).toBeVisible();
    await page.locator('[data-testid="tp-action-claim"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'claimTask', taskId: 'TASK-1' });
  });

  test('Dispatch posts dispatchTask', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await page.locator('[data-testid="tp-action-dispatch"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'dispatchTask', taskId: 'TASK-1' });
  });

  test('locked To Do offers only Force claim', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-2"]').click();
    await expect(page.locator('[data-testid="tp-action-forceClaim"]')).toBeVisible();
    await expect(page.locator('[data-testid="tp-action-claim"]')).toHaveCount(0);
    await page.locator('[data-testid="tp-action-forceClaim"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'forceClaimTask', taskId: 'TASK-2' });
  });

  test('my in-progress task offers Mark done + Release', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-3"]').click();
    await page.locator('[data-testid="tp-action-markDone"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'updateTask',
      taskId: 'TASK-3',
      updates: { status: 'Done' },
    });
  });

  test('Release claim posts releaseTask', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-3"]').click();
    await page.locator('[data-testid="tp-action-release"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'releaseTask', taskId: 'TASK-3' });
  });

  test('status quick-edit posts updateTask', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await page.locator('[data-testid="tp-status"]').selectOption('In Progress');
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'updateTask',
      taskId: 'TASK-1',
      updates: { status: 'In Progress' },
    });
  });

  test('expand posts selectTask', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await clearPostedMessages(page);
    await page.locator('[data-testid="tp-expand"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'selectTask', taskId: 'TASK-1' });
  });
});
