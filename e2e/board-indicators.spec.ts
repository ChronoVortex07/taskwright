/**
 * Board-level agentic indicators (active task / claim / stale claim) on kanban
 * cards — behavior + visual proof. Screenshots land in
 * e2e/__screenshots__/board/. Run with `bun run proof` (or the whole suite).
 */
import { test, expect } from '@playwright/test';
import { installVsCodeMock, postMessageToWebview } from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const SHOTS = 'e2e/__screenshots__/board';

type BoardTask = Task & { isActiveTask?: boolean; claimStale?: boolean };

const tasks: BoardTask[] = [
  {
    id: 'TASK-1',
    title: 'Active + claimed by you',
    status: 'In Progress',
    labels: [],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: '/dummy/backlog/tasks/task-1.md',
    claimedBy: '@me',
    worktree: 'task-1-active',
    claimedAt: '2026-06-30 15:00',
    isActiveTask: true,
  },
  {
    id: 'TASK-2',
    title: 'Freshly claimed by a teammate',
    status: 'In Progress',
    labels: [],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: '/dummy/backlog/tasks/task-2.md',
    claimedBy: '@bob',
    claimedAt: '2026-06-30 14:55',
  },
  {
    id: 'TASK-3',
    title: 'Stale claim (abandoned)',
    status: 'To Do',
    labels: [],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: '/dummy/backlog/tasks/task-3.md',
    claimedBy: '@carol',
    claimedAt: '2026-06-01 09:00',
    claimStale: true,
  },
];

test.describe('Board agentic indicators', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await installVsCodeMock(page);
    await page.goto('/tasks.html');
    await page.waitForTimeout(100);
    await postMessageToWebview(page, { type: 'viewModeChanged', viewMode: 'kanban' });
    await postMessageToWebview(page, {
      type: 'statusesUpdated',
      statuses: ['To Do', 'In Progress', 'Done'],
    });
    await postMessageToWebview(page, { type: 'milestonesUpdated', milestones: [] });
    await postMessageToWebview(page, { type: 'tasksUpdated', tasks });
    await page.waitForTimeout(100);
  });

  test('shows active, claimed, and stale-claim indicators on cards', async ({ page }) => {
    await expect(page.locator('[data-testid="active-indicator-TASK-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="claim-indicator-TASK-1"]')).toContainText('@me');

    const teammateClaim = page.locator('[data-testid="claim-indicator-TASK-2"]');
    await expect(teammateClaim).toContainText('@bob');
    await expect(teammateClaim).not.toHaveClass(/stale/);
    await expect(page.locator('[data-testid="active-indicator-TASK-2"]')).toHaveCount(0);

    const staleClaim = page.locator('[data-testid="claim-indicator-TASK-3"]');
    await expect(staleClaim).toHaveClass(/stale/);
    await expect(staleClaim).toContainText('stale');

    await page.screenshot({ path: `${SHOTS}/01-indicators.png`, fullPage: true });
  });
});
