import { test, expect } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview, getLastPostedMessage } from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const laneOrder = ['Features'];
const bandOrder = ['v1'];

function tasks(): Task[] {
  const base = (over: Partial<Task> & { id: string }): Task =>
    ({
      title: over.id, status: 'In Progress', labels: [], assignee: [], dependencies: [],
      acceptanceCriteria: [], definitionOfDone: [], filePath: `/b/tasks/${over.id}.md`,
      category: 'Features', milestone: 'v1',
      layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 }, ...over,
    }) as Task;
  return [
    base({ id: 'TASK-1', title: 'Active one', isActiveTask: true } as Partial<Task> & { id: string }),
    base({
      id: 'TASK-2',
      title: 'Pending review',
      layout: { lane: 'Features', band: 'v1', depth: 1, subRow: 0 },
      mergeState: { position: 2, approved: false, mode: 'manual-review' },
    } as unknown as Partial<Task> & { id: string }),
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

test.describe('In-flight panel', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('lists active tasks and merge-queue entries', async ({ page }) => {
    await expect(page.locator('[data-testid="inflight-active-TASK-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="inflight-queue-TASK-2"]')).toBeVisible();
  });

  test('Approve posts approveMerge', async ({ page }) => {
    await page.locator('[data-testid="inflight-approve-TASK-2"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'approveMerge', taskId: 'TASK-2' });
  });

  test('collapses to reclaim width', async ({ page }) => {
    await page.locator('[data-testid="inflight-toggle"]').click();
    await expect(page.locator('[data-testid="inflight-active-TASK-1"]')).toHaveCount(0);
  });
});
