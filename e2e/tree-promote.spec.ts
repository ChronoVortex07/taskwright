import { test, expect } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview, getPostedMessages } from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const laneOrder = ['Misc'];
const bandOrder = ['v1'];

function tasks(): Task[] {
  const base = (over: Partial<Task> & { id: string }): Task =>
    ({
      title: over.id,
      status: 'Draft',
      labels: [],
      assignee: [],
      dependencies: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: `/b/tasks/${over.id}.md`,
      category: 'Misc',
      milestone: 'v1',
      ...over,
    }) as Task;
  return [
    base({
      id: 'TASK-1',
      title: 'Idea one',
      layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 0 },
    }),
    base({
      id: 'TASK-2',
      title: 'Idea two',
      layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 1 },
    }),
  ];
}

async function setup(page: Parameters<typeof installVsCodeMock>[0]) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVsCodeMock(page);
  await page.goto('/tasks.html');
  await page.waitForTimeout(100);
  await postMessageToWebview(page, {
    type: 'statusesUpdated',
    statuses: ['Draft', 'To Do', 'In Progress', 'Done'],
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
}

test.describe('Promote draft nodes', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('per-node Promote posts promoteDraft', async ({ page }) => {
    await page.locator('[data-testid="tree-node-promote-TASK-1"]').click();
    const msgs = await getPostedMessages(page);
    expect(msgs).toContainEqual({ type: 'promoteDraft', taskId: 'TASK-1' });
  });

  test('Promote all posts promoteDraft for every draft', async ({ page }) => {
    await page.locator('[data-testid="tree-promote-all"]').click();
    const msgs = await getPostedMessages(page);
    const promoted = msgs.filter((m) => m.type === 'promoteDraft').map((m) => m.taskId);
    expect(promoted).toEqual(expect.arrayContaining(['TASK-1', 'TASK-2']));
  });
});
