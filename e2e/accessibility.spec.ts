/**
 * Accessibility E2E coverage (TASK-103)
 *
 * Locks in the accessibility fixes made across the webview: clickable controls
 * expose accessible names + appropriate roles, dialogs/menus are labelled and
 * closeable with Escape, form controls are named, and a keyboard focus indicator
 * is present. These assertions guard against regressions of the corrected
 * behavior — they intentionally use role/name queries (getByRole) rather than
 * data-testid so they fail if the accessible name is dropped.
 */
import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getLastPostedMessage,
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

async function setupBoard(page: Parameters<typeof installVsCodeMock>[0]) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVsCodeMock(page);
  await page.goto('/tasks.html');
  await page.waitForTimeout(100);
  await postMessageToWebview(page, {
    type: 'statusesUpdated',
    statuses: ['To Do', 'In Progress', 'Done'],
  });
  await postMessageToWebview(page, {
    type: 'prioritiesUpdated',
    priorities: ['high', 'medium', 'low'],
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
  await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
}

test.describe('Accessibility — board (tasks.html)', () => {
  test.beforeEach(async ({ page }) => setupBoard(page));

  test('tree toolbar and tab actions expose accessible names', async ({ page }) => {
    // Icon-only buttons must be reachable by their accessible name.
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom out' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fit to view' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Task' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Board Config' })).toBeVisible();
  });

  test('the pan/zoom canvas is a labelled application region', async ({ page }) => {
    const viewport = page.locator('[data-testid="tree-viewport"]');
    await expect(viewport).toHaveAttribute('role', 'application');
    await expect(viewport).toHaveAttribute('aria-label', 'Tech tree canvas');
  });

  test('a keyboard focus indicator is defined for buttons and role widgets', async ({ page }) => {
    // The global stylesheet must define an outline on :focus-visible so keyboard
    // users get a visible focus ring even on `all: unset` controls.
    const hasFocusVisibleOutline = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; // cross-origin — skip
        }
        for (const rule of Array.from(rules)) {
          const text = (rule as CSSStyleRule).cssText ?? '';
          if (
            /:focus-visible/.test((rule as CSSStyleRule).selectorText ?? '') &&
            /outline/.test(text) &&
            /button/.test((rule as CSSStyleRule).selectorText ?? '')
          ) {
            return true;
          }
        }
      }
      return false;
    });
    expect(hasFocusVisibleOutline).toBe(true);
  });

  test('node detail popover is a labelled dialog closeable via Escape', async ({ page }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    const dialog = page.getByRole('dialog', { name: /Task\s+TASK-1/ });
    await expect(dialog).toBeVisible();
    // Close control has an accessible name.
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
    await clearPostedMessages(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="tree-popover"]')).toHaveCount(0);
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'popoverActiveChanged',
      taskId: null,
    });
  });

  test('canvas context menu opens as a labelled menu, focuses its item, and Escape closes it', async ({
    page,
  }) => {
    const viewport = page.locator('[data-testid="tree-viewport"]');
    const box = (await viewport.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height - 60;
    // Dispatch contextmenu directly — page.mouse right-click does not reliably
    // fire contextmenu in a webview context (mirrors tree-authoring.spec).
    await viewport.evaluate(
      (el, { x, y }) => {
        el.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 2,
          })
        );
      },
      { x: cx, y: cy }
    );
    const menu = page.getByRole('menu', { name: 'Canvas context menu' });
    await expect(menu).toBeVisible();
    const item = menu.getByRole('menuitem', { name: 'Create task here' });
    await expect(item).toBeVisible();
    // Focus is moved into the menu on open.
    await expect(item).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="context-menu"]')).toHaveCount(0);
  });

  test('config editor is a modal dialog with named controls, Escape closes it', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Edit Board Config' }).click();
    // The component requests config data; supply it (no extension host in fixtures).
    await postMessageToWebview(page, {
      type: 'configData',
      config: {
        project_name: 'Test',
        default_status: 'To Do',
        statuses: ['To Do', 'In Progress', 'Done'],
        priorities: ['high', 'medium', 'low'],
        labels: ['bug'],
        milestones: [{ id: 'v1', name: 'v1' }],
        definition_of_done: ['Tests pass'],
        auto_commit: false,
        check_active_branches: false,
        active_branch_days: 30,
        remote_operations: false,
        bypass_git_hooks: false,
      },
    });
    const dialog = page.getByRole('dialog', { name: 'Edit Board Config' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Named form control (was placeholder-only).
    await expect(dialog.getByRole('textbox', { name: 'New status name' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="config-editor-modal"]')).toHaveCount(0);
  });

  test('list view search and filters expose accessible names', async ({ page }) => {
    await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'list' });
    await postMessageToWebview(page, { type: 'viewModeChanged', viewMode: 'list' });
    await page.waitForTimeout(150);
    await expect(page.getByRole('textbox', { name: 'Search tasks' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Filter by status' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Filter by milestone' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Filter by priority' })).toBeVisible();
  });
});

const sampleTask: Task = {
  id: 'TASK-1',
  title: 'Sample Task Title',
  status: 'In Progress',
  priority: 'medium',
  description: 'A description.',
  labels: ['bug'],
  assignee: ['@alice'],
  milestone: 'v1.0',
  dependencies: ['TASK-2'],
  acceptanceCriteria: [{ id: 1, text: 'First criterion', checked: true }],
  definitionOfDone: [{ id: 1, text: 'Tests pass', checked: false }],
  filePath: '/test/backlog/tasks/task-1.md',
};

const sampleTaskData = {
  task: sampleTask,
  statuses: ['To Do', 'In Progress', 'Done'],
  priorities: ['high', 'medium', 'low'],
  uniqueLabels: ['bug', 'feature'],
  uniqueAssignees: ['@alice', '@bob'],
  milestones: [
    { id: 'v1.0', label: 'v1.0' },
    { id: 'v2.0', label: 'v2.0' },
  ],
  blocksTaskIds: ['TASK-3'],
  isBlocked: true,
  linkableTasks: [{ id: 'TASK-2', title: 'Existing dependency', status: 'To Do' }],
  descriptionHtml: '<p>A description.</p>',
  planHtml: '',
  notesHtml: '',
  finalSummaryHtml: '',
};

test.describe('Accessibility — task detail (task-detail.html)', () => {
  test.beforeEach(async ({ page }) => {
    await installVsCodeMock(page);
    await page.goto('/task-detail.html');
    await page.waitForTimeout(100);
    await postMessageToWebview(page, { type: 'taskData', data: sampleTaskData });
    await page.waitForTimeout(150);
  });

  test('title, status, priority, and milestone controls expose accessible names', async ({
    page,
  }) => {
    await expect(page.getByRole('textbox', { name: 'Task title' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Status' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Priority' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Milestone' })).toBeVisible();
  });

  test('checklist toggle and remove controls expose descriptive names', async ({ page }) => {
    // Acceptance-criteria toggle carries the item text in its accessible name.
    await expect(page.getByRole('button', { name: /Toggle:\s*First criterion/ })).toBeVisible();
    // Add-item input is named (was placeholder-only).
    await expect(page.getByRole('textbox', { name: 'Add checklist item' }).first()).toBeVisible();
  });
});
