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

/**
 * 95 characters, mirroring the real overflow seen on the board (TASK-91's
 * claim). Deliberately has no '/<task-id>' core so shortClaimIdentity cannot
 * collapse it — the badge must survive on CSS containment alone (TASK-89 AC #5/#7).
 */
const LONG_CLAIM_IDENTITY =
  '@agent-task-91-hidden-worktree-board-home-resolution-and-cross-session-claim-identity-stability';

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
  {
    id: 'TASK-4',
    title: 'Claimed with a 95-char identity',
    status: 'In Progress',
    labels: [],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: '/dummy/backlog/tasks/task-4.md',
    claimedBy: LONG_CLAIM_IDENTITY,
    worktree: 'task-91-hidden-worktree-board-home',
    claimedAt: '2026-06-30 15:05',
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

  test('TASK-89: 95-char claim identity stays within the card and ellipsizes', async ({ page }) => {
    expect(LONG_CLAIM_IDENTITY).toHaveLength(95);

    const badge = page.locator('[data-testid="claim-indicator-TASK-4"]');
    await expect(badge).toBeVisible();

    // The tooltip keeps the FULL identity (and the worktree).
    const title = await badge.getAttribute('title');
    expect(title).toContain(LONG_CLAIM_IDENTITY);
    expect(title).toContain('task-91-hidden-worktree-board-home');

    // The clientWidth assertion: nothing spills out of the badge box.
    const badgeOverflow = await badge.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(badgeOverflow).toBeLessThanOrEqual(0);

    // The label is clipped with a CSS ellipsis instead of pushing the badge open.
    const label = badge.locator('.claim-indicator-label');
    const metrics = await label.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      textOverflow: getComputedStyle(el).textOverflow,
    }));
    expect(metrics.textOverflow).toBe('ellipsis');
    expect(metrics.clientWidth).toBeGreaterThan(0);
    // The (already JS-shortened) label is still wider than the badge allows,
    // so CSS truncation must actually be engaged.
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);

    // And the badge (label included) stays within the card bounds.
    const cardBox = await page.locator('[data-testid="task-TASK-4"]').boundingBox();
    const labelBox = await label.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(labelBox).not.toBeNull();
    expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 0.5);

    await page.screenshot({ path: `${SHOTS}/02-long-claim-identity.png`, fullPage: true });
  });
});
