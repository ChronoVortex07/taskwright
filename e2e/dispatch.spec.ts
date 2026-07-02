/**
 * Plan-banner controls Webview E2E + visual proof.
 *
 * Exercises the Taskwright plan banner in the TaskDetail component against
 * dummy task data, and captures screenshots into e2e/__screenshots__/dispatch/
 * as visual proof. (The claim / set-active / dispatch banners moved out of the
 * detail panel to the board popover in tech-tree P2b; the plan banner stays.)
 * Run on demand with:
 *
 *   bun run proof
 *
 * (or the whole suite with `bun run test:playwright`). The screenshot directory
 * is git-ignored — re-running regenerates fresh proof images.
 */
import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getLastPostedMessage,
  clearPostedMessages,
} from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const SHOTS = 'e2e/__screenshots__/dispatch';

// A dummy, fully-editable task so the plan banner renders — it is gated on
// !isDraft && !isReadOnly && !isArchived.
const dummyTask: Task = {
  id: 'TASK-7',
  title: 'Add user login',
  status: 'To Do',
  priority: 'high',
  description: 'Let users sign in with email and password.',
  labels: ['feature', 'auth'],
  assignee: [],
  dependencies: [],
  acceptanceCriteria: [
    { id: 1, text: 'Login form validates email', checked: false },
    { id: 2, text: 'Session persists across reloads', checked: false },
  ],
  definitionOfDone: [],
  implementationPlan: '1. Build the form\n2. Wire the backend',
  filePath: '/dummy/backlog/tasks/TASK-7 - Add-user-login.md',
};

const baseData = {
  task: dummyTask,
  statuses: ['To Do', 'In Progress', 'Done'],
  priorities: ['high', 'medium', 'low'],
  uniqueLabels: ['feature', 'auth', 'bug'],
  uniqueAssignees: ['@me'],
  milestones: [],
  blocksTaskIds: [],
  linkableTasks: [],
  isBlocked: false,
  descriptionHtml: '<p>Let users sign in with email and password.</p>',
  planHtml: '<ol><li>Build the form</li><li>Wire the backend</li></ol>',
  notesHtml: '',
  finalSummaryHtml: '',
  claimIdentity: '@me',
};

test.describe('Agentic controls', () => {
  test.beforeEach(async ({ page }) => {
    await installVsCodeMock(page);
    await page.goto('/task-detail.html');
    await page.waitForTimeout(100);
  });

  test('unattached task offers Attach plan', async ({ page }) => {
    await postMessageToWebview(page, { type: 'taskData', data: baseData });
    await page.waitForTimeout(80);

    await expect(page.locator('[data-testid="plan-banner"]')).toContainText('No plan attached');
    await expect(page.locator('[data-testid="attach-plan-btn"]')).toBeVisible();
  });

  test('attached plan shows progress bar, Open, and Detach', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'taskData',
      data: {
        ...baseData,
        task: { ...dummyTask, plan: 'docs/superpowers/plans/2026-06-30-login.md' },
        planProgress: { total: 4, done: 3, percent: 75, exists: true },
      },
    });
    await page.waitForTimeout(80);

    const planBanner = page.locator('[data-testid="plan-banner"]');
    await expect(planBanner).toContainText('2026-06-30-login.md');
    await expect(planBanner).toContainText('3/4 steps');
    await expect(planBanner).toContainText('75%');
    await expect(page.locator('[data-testid="open-plan-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="detach-plan-btn"]')).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/03-plan-progress.png`, fullPage: true });
  });

  test('plan banner warns when the linked file is missing', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'taskData',
      data: {
        ...baseData,
        task: { ...dummyTask, plan: 'docs/superpowers/plans/gone.md' },
        planProgress: { total: 0, done: 0, percent: 0, exists: false },
      },
    });
    await page.waitForTimeout(80);

    await expect(page.locator('[data-testid="plan-missing"]')).toContainText('not found');
  });

  test('Attach / Detach / Open plan buttons post their messages', async ({ page }) => {
    await postMessageToWebview(page, { type: 'taskData', data: baseData });
    await page.waitForTimeout(80);
    await clearPostedMessages(page);
    await page.locator('[data-testid="attach-plan-btn"]').click();
    expect(await getLastPostedMessage(page)).toEqual({ type: 'attachPlan', taskId: 'TASK-7' });

    await postMessageToWebview(page, {
      type: 'taskData',
      data: {
        ...baseData,
        task: { ...dummyTask, plan: 'docs/p.md' },
        planProgress: { total: 1, done: 0, percent: 0, exists: true },
      },
    });
    await page.waitForTimeout(80);

    await clearPostedMessages(page);
    await page.locator('[data-testid="open-plan-btn"]').click();
    expect(await getLastPostedMessage(page)).toEqual({ type: 'openPlan', taskId: 'TASK-7' });

    await clearPostedMessages(page);
    await page.locator('[data-testid="detach-plan-btn"]').click();
    expect(await getLastPostedMessage(page)).toEqual({ type: 'detachPlan', taskId: 'TASK-7' });
  });
});
