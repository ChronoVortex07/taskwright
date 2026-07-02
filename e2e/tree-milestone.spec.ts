import { test, expect } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview, getLastPostedMessage } from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const laneOrder = ['Features', 'Bugs'];
const bandOrder = ['v1', 'Backburner'];

function tasks(): Task[] {
  return [
    {
      id: 'TASK-1', title: 'A', status: 'Done', category: 'Features', milestone: 'v1',
      labels: [], assignee: [], dependencies: [], acceptanceCriteria: [], definitionOfDone: [],
      filePath: '/b/tasks/task-1.md', layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
    } as Task,
  ];
}

async function setup(page: Parameters<typeof installVsCodeMock>[0]) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVsCodeMock(page);
  await page.goto('/tasks.html');
  await page.waitForTimeout(100);
  await postMessageToWebview(page, { type: 'statusesUpdated', statuses: ['To Do', 'In Progress', 'Done'] });
  await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: tasks() });
  await postMessageToWebview(page, { type: 'treeLayoutUpdated', laneOrder, bandOrder, warnings: [] });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(150);
}

test.describe('Milestone popover', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('clicking a band header requests milestone data and renders the popover', async ({ page }) => {
    await page.locator('[data-testid="tree-band-v1"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'requestMilestoneData', milestone: 'v1' });

    await postMessageToWebview(page, {
      type: 'milestoneData',
      milestone: 'v1',
      total: 4,
      done: 1,
      lanes: [{ name: 'Features', total: 3, done: 1 }],
      checklist: [
        { id: 1, text: 'Update changelog', checked: false },
        { id: 2, text: 'Smoke test', checked: true },
      ],
    });
    await expect(page.locator('[data-testid="milestone-popover"]')).toBeVisible();
    await expect(page.locator('[data-testid="ms-overall"]')).toContainText('1/4');
    await expect(page.locator('[data-testid="rc-item-1"]')).toBeVisible();
  });

  test('toggling a release-checklist item posts toggleReleaseChecklistItem', async ({ page }) => {
    await page.locator('[data-testid="tree-band-v1"]').click();
    await postMessageToWebview(page, {
      type: 'milestoneData', milestone: 'v1', total: 1, done: 0,
      lanes: [], checklist: [{ id: 1, text: 'Update changelog', checked: false }],
    });
    await page.locator('[data-testid="rc-toggle-1"]').check();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'toggleReleaseChecklistItem', milestone: 'v1', itemId: 1,
    });
  });
});
