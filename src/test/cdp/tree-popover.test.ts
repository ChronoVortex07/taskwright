import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  launchVsCode,
  closeVsCode,
  type VsCodeInstance,
} from './lib/vscode-launcher';
import {
  createTestWorkspace,
  resetTestWorkspace,
  cleanupTestWorkspace,
  taskFilePath,
} from './lib/test-workspace';
import {
  waitForExtensionReady,
  waitForWebviewContent,
  waitForFileContent,
} from './lib/wait-helpers';
import {
  clickInWebview,
  pointerClickInWebview,
  setSelectValueInWebview,
  clearWebviewSessionCache,
  elementExistsInWebview,
} from './lib/webview-helpers';
import { dismissNotifications, resetEditorState, executeCommand, sleep } from './lib/cdp-helpers';

const CDP_PORT = 9341;

function activeTaskPath(workspacePath: string): string {
  return path.join(workspacePath, '.taskwright', 'active-task.json');
}

async function waitForFileGone(filePath: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(filePath)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`File still present after ${timeoutMs}ms: ${filePath}`);
}

async function openTree(instance: VsCodeInstance): Promise<void> {
  await clickInWebview(instance.cdp, 'tasks', '[data-testid="tab-tree"]');
  // The zoomed-out (far-LOD) tree renders status glyphs, not task-id text, so
  // wait for the TASK-1 node element itself rather than webview text content.
  await waitForTreeNode(instance, 'TASK-1');
}

async function waitForTreeNode(
  instance: VsCodeInstance,
  taskId: string,
  timeoutMs = 10_000
): Promise<void> {
  const selector = `[data-testid="tree-node-${taskId}"]`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exists = await elementExistsInWebview(instance.cdp, 'tasks', selector);
    if (exists) return;
    await sleep(200);
  }
  throw new Error(`Tree node "${selector}" not found in tasks webview within ${timeoutMs}ms`);
}

describe('Tree popover cross-view (CDP)', () => {
  let instance: VsCodeInstance;
  let workspacePath: string;

  beforeAll(async () => {
    workspacePath = createTestWorkspace();
    instance = await launchVsCode({ workspacePath, cdpPort: CDP_PORT });
    await waitForExtensionReady(instance.cdp);
    await dismissNotifications(instance.cdp);
  }, 90_000);

  afterAll(async () => {
    if (instance) closeVsCode(instance);
    if (workspacePath) cleanupTestWorkspace(workspacePath);
  }, 15_000);

  beforeEach(async () => {
    clearWebviewSessionCache();
    resetTestWorkspace(workspacePath);
    // resetTestWorkspace does not clear .taskwright — do it ourselves.
    fs.rmSync(path.join(workspacePath, '.taskwright'), { recursive: true, force: true });
    await resetEditorState(instance.cdp);
    await dismissNotifications(instance.cdp);
    await executeCommand(instance.cdp, 'taskwright.refresh');
    // A previous test may have left the board on the tree tab (which renders no
    // task-id text when zoomed out) — force kanban so the 'TASK-' readiness
    // signal below is meaningful. openTree() switches back per-test.
    await executeCommand(instance.cdp, 'taskwright.showKanbanView');
    await waitForWebviewContent(instance.cdp, 'tasks', 'TASK-', { timeoutMs: 10_000 });
  }, 30_000);

  it('opening a node popover writes .taskwright/active-task.json', async () => {
    await openTree(instance);
    // P3b: node selection is pointer-driven (gesture machine on .tree-viewport;
    // TreeNode has no onclick) — a bare click no longer opens the popover.
    const clicked = await pointerClickInWebview(
      instance.cdp,
      'tasks',
      '[data-testid="tree-node-TASK-1"]'
    );
    expect(clicked).toBe(true);
    const content = await waitForFileContent(activeTaskPath(workspacePath), '"taskId": "TASK-1"', {
      timeoutMs: 12_000,
    });
    expect(content).toContain('TASK-1');
  }, 45_000);

  it('closing the popover clears active-task.json', async () => {
    await openTree(instance);
    await pointerClickInWebview(instance.cdp, 'tasks', '[data-testid="tree-node-TASK-1"]');
    await waitForFileContent(activeTaskPath(workspacePath), '"taskId": "TASK-1"', { timeoutMs: 12_000 });
    await clickInWebview(instance.cdp, 'tasks', '[data-testid="tp-close"]');
    await waitForFileGone(activeTaskPath(workspacePath));
    expect(fs.existsSync(activeTaskPath(workspacePath))).toBe(false);
  }, 45_000);

  it('status quick-edit in the popover writes the task file', async () => {
    await openTree(instance);
    await pointerClickInWebview(instance.cdp, 'tasks', '[data-testid="tree-node-TASK-1"]');
    const changed = await setSelectValueInWebview(
      instance.cdp,
      'tasks',
      '[data-testid="tp-status"]',
      'In Progress'
    );
    expect(changed).toBe(true);
    const taskFile = taskFilePath(workspacePath, 'task-1 - Test-task-for-e2e.md');
    const content = await waitForFileContent(taskFile, 'status: In Progress', { timeoutMs: 15_000 });
    expect(content).toContain('status: In Progress');
  }, 45_000);
});
