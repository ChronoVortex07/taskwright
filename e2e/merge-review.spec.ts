/**
 * Merge-review banner (Approve & merge / Send back) — TaskDetail Playwright
 * coverage, modeled on e2e/dispatch.spec.ts. Also covers the kanban card's
 * merge-queue badge (Task 5) for a task carrying `mergeState`.
 */
import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getLastPostedMessage,
  clearPostedMessages,
} from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

// A dummy, fully-editable task so the merge-review banner renders alongside
// the other agentic banners — gated on !isDraft && !isReadOnly && !isArchived.
const dummyTask: Task = {
  id: 'TASK-7',
  title: 'Add user login',
  status: 'In Progress',
  priority: 'high',
  description: 'Let users sign in with email and password.',
  labels: ['feature', 'auth'],
  assignee: [],
  dependencies: [],
  acceptanceCriteria: [],
  definitionOfDone: [],
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
  planHtml: '',
  notesHtml: '',
  finalSummaryHtml: '',
  claimIdentity: '@me',
};

test.describe('Detail-panel merge-review banner', () => {
  test.beforeEach(async ({ page }) => {
    await installVsCodeMock(page);
    await page.goto('/task-detail.html');
    await page.waitForTimeout(100);
  });

  test('manual-review shows Approve & Send back and posts the right messages', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'taskData',
      data: {
        ...baseData,
        mergeMode: 'manual-review',
        mergeState: {
          queued: true,
          position: 1,
          approved: false,
          active: false,
          mode: 'manual-review',
        },
      },
    });
    await page.waitForTimeout(80);

    const banner = page.locator('[data-testid="merge-review-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('merge queue');
    await expect(banner).toContainText('#1');

    const approveBtn = page.locator('[data-testid="approve-merge-btn"]');
    const sendBackBtn = page.locator('[data-testid="send-back-merge-btn"]');
    await expect(approveBtn).toBeVisible();
    await expect(sendBackBtn).toBeVisible();

    await clearPostedMessages(page);
    await approveBtn.click();
    expect(await getLastPostedMessage(page)).toEqual({ type: 'approveMerge', taskId: 'TASK-7' });

    await clearPostedMessages(page);
    await sendBackBtn.click();
    expect(await getLastPostedMessage(page)).toEqual({ type: 'sendBackMerge', taskId: 'TASK-7' });
  });

  test('approved manual-review task shows read-only status and no buttons', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'taskData',
      data: {
        ...baseData,
        mergeMode: 'manual-review',
        mergeState: {
          queued: true,
          position: 1,
          approved: true,
          active: false,
          mode: 'manual-review',
        },
      },
    });
    await page.waitForTimeout(80);

    const banner = page.locator('[data-testid="merge-review-banner"]');
    await expect(banner).toContainText('Approved');
    await expect(page.locator('[data-testid="approve-merge-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="send-back-merge-btn"]')).toHaveCount(0);
  });

  test('auto-merge mode shows a read-only queue indicator with no buttons', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'taskData',
      data: {
        ...baseData,
        mergeMode: 'auto-merge',
        mergeState: {
          queued: true,
          position: 2,
          approved: false,
          active: false,
          mode: 'auto-merge',
        },
      },
    });
    await page.waitForTimeout(80);

    const banner = page.locator('[data-testid="merge-review-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('#2');
    await expect(page.locator('[data-testid="approve-merge-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="send-back-merge-btn"]')).toHaveCount(0);
  });

  test('active (merging) task shows "Merging…" with no buttons', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'taskData',
      data: {
        ...baseData,
        mergeMode: 'manual-review',
        mergeState: {
          queued: true,
          position: 1,
          approved: true,
          active: true,
          mode: 'manual-review',
        },
      },
    });
    await page.waitForTimeout(80);

    const banner = page.locator('[data-testid="merge-review-banner"]');
    await expect(banner).toContainText('Merging');
    await expect(page.locator('[data-testid="approve-merge-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="send-back-merge-btn"]')).toHaveCount(0);
  });

  test('no banner when the task is not in the merge queue', async ({ page }) => {
    await postMessageToWebview(page, { type: 'taskData', data: baseData });
    await page.waitForTimeout(80);

    await expect(page.locator('[data-testid="merge-review-banner"]')).toHaveCount(0);
  });
});

test.describe('Kanban merge-queue badge', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await installVsCodeMock(page);
    await page.goto('/tasks.html');
    await page.waitForTimeout(100);
  });

  test('renders merge-indicator for a task carrying mergeState', async ({ page }) => {
    const boardTask: Task & {
      mergeState?: {
        queued: boolean;
        position: number;
        approved: boolean;
        active: boolean;
        mode: string;
      };
    } = {
      ...dummyTask,
      mergeState: {
        queued: true,
        position: 1,
        approved: false,
        active: false,
        mode: 'manual-review',
      },
    };

    await postMessageToWebview(page, { type: 'viewModeChanged', viewMode: 'kanban' });
    await postMessageToWebview(page, {
      type: 'statusesUpdated',
      statuses: ['To Do', 'In Progress', 'Done'],
    });
    await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
    await postMessageToWebview(page, { type: 'tasksUpdated', tasks: [boardTask] });
    await page.waitForTimeout(100);

    const indicator = page.locator('[data-testid="merge-indicator-TASK-7"]');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('#1');
  });
});
